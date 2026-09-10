// MOBILE CONNECT — THE WIRE, minus the crypto. The one copy the hosts share.
//
// WHY THIS FILE EXISTS AT ALL. `00mc` is a symmetric scheme, and a symmetric scheme fails at exactly
// one place: the bytes that get signed. There are now FOUR implementations of it — the engine
// (`apps/00d/src/mobile-connect-wire.ts`), the worker (`moltworker/worker/src/social/…`), the Flutter
// app (`flutter_app/lib/services/mobile_connect/mobile_connect_wire.dart`) and the browser runtime
// (`apps/infinite/src/mac/wire.ts`) — and two of those four live in THIS repo. Two copies in one repo
// is one copy too many: they drift, both look correct on review, and the only symptom is a signature
// that verifies on one side. So the canonical string, the closed set of kinds, the charset rule and
// the order of the checks live here, once, and each host adds only the part it cannot share.
//
// WHY THE CRYPTO IS *NOT* HERE. `@00/shared` has no dependencies and is imported by the engine (Node),
// by web-vue and by the browser runtime. `@noble/curves` is not resolvable from this package, and
// `node:crypto` would break every bundler that pulls this barrel into a browser. Ed25519 and sha256
// therefore stay with the host: the engine signs with `@noble`, the browser with WebCrypto, and both
// sign the string this file builds. That is the whole contract — agreement about a string, not about
// a library.
//
// FIVE PROPERTIES, each earned by a specific attack found in review, restated here because this is
// now where they are enforced:
//   1. BOTH DIRECTIONS SIGNED. Signing only phone→engine leaves the relay able to invent ANSWERS.
//   2. `dir` IS SIGNED, so a captured request can never be replayed as a response.
//   3. THE PAYLOAD HASH IS COVERED, never the bytes — and it is checked unconditionally by the host.
//   4. FIELDS ARE CHARSET-VALIDATED BEFORE SIGNING AND VERIFYING, never sanitised. An LF inside a
//      field would shift every field after it and let two different frames sign identically.
//   5. THE GLANCE CODE IS 64 BITS AND DERIVED, NEVER TRANSMITTED.
//
// THE NAMES ARE DELIBERATELY UNPREFIXED (`Frame`, `FRAME_KINDS`, `signingString`). They are the
// protocol's own words, and all four implementations spell them the same way; renaming them for
// barrel hygiene would make the four files stop reading as one thing.

export const MOBILE_CONNECT_VERSION = "00mc/3";

/**
 * The versions a receiver VERIFIES. A frame is signed over its own version (line one of the signing
 * string), so a phone still on 00mc/1 is checked against what it signed rather than refused as a bad
 * signature. What v2 adds is one kind, `sessions.list`; v3 adds two, `skill-ui.list` and
 * `skill-ui.open` — an older sender never sends what its own version does not name.
 */
export const SUPPORTED_VERSIONS: readonly string[] = ["00mc/1", "00mc/2", "00mc/3"];

/** How long a session lives, from the ENGINE's start. Never extended by activity — a session that
 *  renewed itself on use would quietly become the standing capability this deliberately is not. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How far a frame's timestamp may sit from now. Bounds replay to a window the cache can cover. */
export const TS_WINDOW_MS = 120_000;

/**
 * The kinds a frame may carry. A closed set: adding one is a version bump, not a patch — which is
 * exactly what `skill-ui.list`/`skill-ui.open` are here for. A v2 receiver refuses them BY NAME
 * (its own kind check), and that is the designed failure rather than a silent no-op: a phone that
 * asks a Mac too old to answer must be told, not left waiting.
 */
export const FRAME_KINDS = [
  "session.open",
  "prompt",
  "approve",
  "session.close",
  "sessions.list",
  "skill-ui.list",
  "skill-ui.open",
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

export type FrameDir = "req" | "res";

/** Every free-form field. Rejected, never sanitised — sanitising is how two implementations build
 *  different strings from one input. Exported because it is a cross-repo agreement: the worker's
 *  `WIRE_FIELD_RE` and Flutter's `kWireFieldRe` are the same pattern, and a host that narrowed it
 *  locally would refuse frames the other three consider legal. */
export const WIRE_FIELD_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** The payload hash, checked for SHAPE as well as value. A malformed hash signs and verifies
 *  perfectly — both sides just agree on nonsense — so the shape check is what keeps the payload
 *  check meaningful rather than tautological. */
export const WIRE_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * sha256 of the empty string — what a payload-less frame signs, so there is no third case.
 *
 * A LITERAL, not a computation, for the same reason Flutter's `kEmptySha256` is: this package holds
 * no hash function, and the value is a constant of the protocol that a test can pin against a real
 * sha256 (`apps/infinite/test/mac-wire.test.ts` does exactly that). "Absent", "null" and "empty"
 * are ONE case on this wire; three cases is how one end signs this and another signs a hash of
 * `"null"`.
 */
export const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Frame {
  dir: FrameDir;
  /** The SENDER's fingerprint. Signed, not merely implied: explicit binding stays sound even if
   *  something later verifies against a set of keys rather than one. */
  dev: string;
  sessionId: string;
  frameId: string;
  engineFp: string;
  agentId: string;
  kind: FrameKind;
  /** Milliseconds since the epoch. */
  ts: number;
}

/** True when every field is shaped as the protocol allows. Checked before signing AND verifying. */
export function fieldsValid(f: Frame): boolean {
  return (
    (f.dir === "req" || f.dir === "res") &&
    (FRAME_KINDS as readonly string[]).includes(f.kind) &&
    Number.isFinite(f.ts) &&
    [f.dev, f.sessionId, f.frameId, f.engineFp, f.agentId].every((v) => WIRE_FIELD_RE.test(v))
  );
}

/**
 * THE SIGNING STRING. Frozen. UTF-8, LF-joined, no trailing newline.
 * Changing a single byte here breaks every signature all four implementations ever produce, which is
 * the point: there is one answer, and it is this one.
 */
export function signingString(
  f: Frame,
  payloadSha256Hex: string,
  version: string = MOBILE_CONNECT_VERSION,
): string {
  if (!fieldsValid(f)) throw new Error("mobile-connect: frame fields are not protocol-shaped");
  // `ts` is already required finite by fieldsValid; a NON-INTEGER or negative one would still sign
  // and verify on both sides while making the ±120s window meaningless, so it is pinned here too.
  if (!Number.isInteger(f.ts) || f.ts <= 0) throw new Error("mobile-connect: ts must be a positive integer");
  if (!WIRE_SHA256_RE.test(payloadSha256Hex)) throw new Error("mobile-connect: payload hash is not sha256 hex");
  return [
    version,
    f.dir,
    f.dev,
    f.sessionId,
    f.frameId,
    f.engineFp,
    f.agentId,
    f.kind,
    payloadSha256Hex,
    String(f.ts),
  ].join("\n");
}

/**
 * THE SESSION-OPEN PAYLOAD. `startedAt` is what the worker's 24h backstop anchors on, so it must be
 * covered by the signature — it is, twice over, and deliberately: it sits in this payload (hashed
 * into the signing string) AND must equal the frame's own signed `ts` within a small tolerance.
 * The second rule is what makes the backstop cheap to enforce: the worker can anchor on the `ts`
 * it already verified, without parsing a payload it is not supposed to read.
 */
export interface SessionOpenPayload {
  startedAt: number;
  expiresAt: number;
  agentId: string;
  enginePublicKey: string;
}

/** How far `startedAt` may sit from the session-open frame's `ts`. Small: they are written in the
 *  same breath, and a gap would be someone backdating a session to buy more than a day. */
export const SESSION_OPEN_SKEW_MS = 5_000;

export function sessionOpenValid(p: SessionOpenPayload, frameTs: number): boolean {
  return (
    Number.isFinite(p.startedAt) &&
    Math.abs(p.startedAt - frameTs) <= SESSION_OPEN_SKEW_MS &&
    p.expiresAt === p.startedAt + SESSION_TTL_MS
  );
}

// ── THE GLANCE CODE ──────────────────────────────────────────────────────────────────────────────
//
// Computed independently at both ends from material the relay cannot forge, and NEVER sent: a code
// the relay chooses proves nothing, since it can show both screens the same number while swapping
// its own keys underneath. 64 bits, because at 24 the relay grinds a collision offline in minutes.
//
// Split in two here only because this package cannot hash: the host sha256s `glanceString(...)` and
// formats the digest with `glanceFromSha256Hex(...)`. Neither half is a decision a host may make
// differently — the domain tag, the field order and the four-groups-of-four grouping are all part of
// the contract, the last one because an operator comparing `9F2C71A04E18BD35` against
// `9F2C 71A0 4E18 BD35` is squinting at spacing instead of at a substituted key.

/** The glance code's own domain tag. Deliberately NOT the frame version — different string, different use. */
export const GLANCE_VERSION = "00mc-glance/1";

export function glanceString(
  sessionId: string,
  enginePublicKeyB64u: string,
  phonePublicKeyB64u: string,
): string {
  return [GLANCE_VERSION, sessionId, enginePublicKeyB64u, phonePublicKeyB64u].join("\n");
}

/** The first 8 bytes of the digest, UPPERCASE, four groups of four. */
export function glanceFromSha256Hex(digestHex: string): string {
  if (!WIRE_SHA256_RE.test(digestHex)) throw new Error("mobile-connect: glance digest is not sha256 hex");
  const h = digestHex.slice(0, 16).toUpperCase();
  return `${h.slice(0, 4)} ${h.slice(4, 8)} ${h.slice(8, 12)} ${h.slice(12, 16)}`;
}

// ── THE CHECKS ───────────────────────────────────────────────────────────────────────────────────
//
// Seven checks, in order, none conditional. The signature is check three and needs a curve, so the
// order is expressed as the two halves that surround it: a host calls `preSignatureFailure`, then
// verifies, then calls `postSignatureFailure`. Splitting it this way rather than passing a verifier
// callback keeps the failure NAMES and their ORDER in one file while leaving each host free to use
// the crypto it actually has.

export type VerifyFailure =
  | "fields"
  | "signature"
  | "unknown-device"
  | "stale"
  | "replay"
  | "payload-mismatch"
  | "session-gone"
  | "session-expired";

export interface FrameStateChecks {
  frame: Frame;
  now: number;
  /** Has (dev, dir, frameId) been seen? A repeat returns the first result; it never re-executes. */
  seen: boolean;
  session: { active: boolean; startedAt: number } | undefined;
}

/**
 * Checks 1 and 2: shape, then "do we hold a key for this sender at all".
 *
 * `hasSenderKey` rather than the key itself, because this package never touches key material — and
 * because the check is about knowing the device, not about the bytes.
 */
export function preSignatureFailure(frame: Frame, hasSenderKey: boolean): VerifyFailure | null {
  if (!fieldsValid(frame)) return "fields";
  if (!hasSenderKey) return "unknown-device";
  return null;
}

/**
 * Checks 4 through 7, run only once the signature has verified. Freshness, replay, and the session's
 * own life — evaluated on READ so a session cannot be alive merely because no sweeper has run.
 *
 * The payload check is NOT here and is not optional: the hash is inside the signing string, so bytes
 * that disagree with what was signed fail the signature above. A host that PULLS bytes after
 * verifying a frame must re-verify with those bytes; that is the only way through.
 */
export function postSignatureFailure(c: FrameStateChecks): VerifyFailure | null {
  if (Math.abs(c.now - c.frame.ts) > TS_WINDOW_MS) return "stale";
  if (c.seen) return "replay";
  if (!c.session) return "session-gone";
  if (!c.session.active) return "session-gone";
  if (c.now >= c.session.startedAt + SESSION_TTL_MS) return "session-expired";
  return null;
}
