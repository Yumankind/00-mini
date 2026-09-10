/**
 * `00mc` in the browser — the curve half. The protocol half is `@00/shared`.
 *
 * WHY THIS FILE IS SO SMALL. Everything that decides what gets signed — the ten LF-joined lines, the
 * closed set of kinds, the charset rule, the order of the seven checks, the glance derivation — lives
 * in `packages/shared/src/mobile-connect-wire.ts`, which the engine imports too. A signature is
 * agreement about a string; the moment the browser builds that string from its own copy, the two
 * halves of a symmetric scheme are free to drift and the only symptom is a signature that verifies on
 * one side. So this module adds exactly what `@00/shared` cannot carry (it has no dependencies and is
 * bundled into browsers): sha256 and Ed25519, taken from WebCrypto.
 *
 * WHY WEBCRYPTO AND NOT `@noble`. The engine signs with `@noble/curves`, which is not a dependency of
 * this app and cannot become one without an install. WebCrypto's Ed25519 is the same RFC 8032 curve —
 * a signature made here verifies with `@noble` and vice versa, which `test/mac-wire.test.ts` proves
 * against a vector produced by the engine's own module rather than asserting it.
 *
 * WHERE ED25519 IS MISSING (older Safari, older Firefox) THIS FEATURE REFUSES BY NAME. There is no
 * fallback: signing a command to someone's Mac with a curve we rolled ourselves, or with a key held
 * as raw bytes in a variable, would be worse than telling the person their browser cannot do this
 * yet. `ed25519Available()` is the check, and every entry point that needs a key goes through
 * `requireEd25519()`.
 */
import {
  EMPTY_PAYLOAD_HASH,
  MOBILE_CONNECT_VERSION,
  glanceFromSha256Hex,
  glanceString,
  postSignatureFailure,
  preSignatureFailure,
  signingString,
  type Frame,
  type FrameKind,
  type VerifyFailure,
} from "@00/shared";

export type { Frame, FrameDir, FrameKind, VerifyFailure } from "@00/shared";

const enc = new TextEncoder();

// ── Encoding, byte for byte what the other three implementations do ──────────────────────────────

/** base64url, UNPADDED — the engine and the Flutter app both strip `=`, so we do too rather than
 *  lean on the far end being tolerant. */
export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes padded or unpadded base64url, and standard base64 too: the worker re-encodes blobs
 *  canonically but a hand-written engine build may not, and a `+` is not worth a failed session. */
export function b64uDecode(value: string): Uint8Array {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `bytes.buffer` is deliberately not passed: a view into a larger buffer would hash the whole
  // buffer, and every payload here arrives as a view at some point.
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

/** The hash a frame signs for these bytes. Absent, null and empty are ONE case — the constant the
 *  protocol pins — because three cases is how one end signs the empty hash and another signs a hash
 *  of `"null"`. */
export async function payloadHash(payload: Uint8Array | string | undefined): Promise<string> {
  if (payload === undefined) return EMPTY_PAYLOAD_HASH;
  const bytes = typeof payload === "string" ? enc.encode(payload) : payload;
  if (bytes.length === 0) return EMPTY_PAYLOAD_HASH;
  return sha256Hex(bytes);
}

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────

/** An Ed25519 pair as this app holds one: the private half is a `CryptoKey` that never leaves
 *  WebCrypto, the public half is bytes because both the relay and the glance code need them. */
export interface WireIdentity {
  /** The wire's `dev`. `ph-<12 hex>` for the client half, `mc-<12 hex>` for the engine half. */
  dev: string;
  publicKeyB64u: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export function ed25519Available(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

export class Ed25519Unavailable extends Error {
  readonly code = "ed25519_unavailable";
  constructor() {
    super("This browser has no WebCrypto Ed25519, so it cannot sign a command to your Mac.");
    this.name = "Ed25519Unavailable";
  }
}

async function generatePair(): Promise<CryptoKeyPair> {
  if (!ed25519Available()) throw new Ed25519Unavailable();
  try {
    // NON-EXTRACTABLE. The private half is generated inside WebCrypto and can never be read back out
    // — not by this app, not by a script that reaches its IndexedDB, not by a crash report. The
    // public half is extractable regardless (the spec says so for asymmetric generateKey), which is
    // what lets `dev` be derived from it.
    return (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  } catch (err) {
    throw err instanceof Ed25519Unavailable ? err : new Ed25519Unavailable();
  }
}

/**
 * The device id, MINTED FROM THE PUBLIC KEY. A cross-repo agreement, not a local style choice:
 *
 *   * DERIVED FROM THE KEY, so a browser that re-keys necessarily gets a NEW `dev` and can never
 *     silently reuse an enrolment row that now names a key nobody holds.
 *   * THE PREFIX is how the far side tells a client's frames from its own — the engine compares
 *     `dev` against a session id that starts `mc-`.
 *
 * Lowercase hex of the RAW 32 public-key bytes (not a hash of them, not the base64url form),
 * truncated to 12 characters. 15 characters total, comfortably inside the wire's field charset.
 */
export function devIdForPublicKey(raw: Uint8Array, prefix: "ph" | "mc"): string {
  if (raw.length !== 32) throw new Error(`mobile-connect: an Ed25519 public key is 32 bytes; got ${raw.length}`);
  return `${prefix}-${toHex(raw).slice(0, 12)}`;
}

export async function createIdentity(prefix: "ph" | "mc"): Promise<{ identity: WireIdentity; keyPair: CryptoKeyPair }> {
  const keyPair = await generatePair();
  const identity = await identityFor(keyPair, prefix);
  return { identity, keyPair };
}

export async function identityFor(keyPair: CryptoKeyPair, prefix: "ph" | "mc"): Promise<WireIdentity> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return {
    dev: devIdForPublicKey(raw, prefix),
    publicKey: raw,
    publicKeyB64u: b64u(raw),
    privateKey: keyPair.privateKey,
  };
}

async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, { name: "Ed25519" }, true, ["verify"]);
}

// ── Signing and verifying ────────────────────────────────────────────────────────────────────────

export async function signFrame(
  frame: Frame,
  payload: Uint8Array | string | undefined,
  privateKey: CryptoKey,
  version: string = MOBILE_CONNECT_VERSION,
): Promise<string> {
  const message = enc.encode(signingString(frame, await payloadHash(payload), version));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message as unknown as ArrayBuffer);
  return b64u(new Uint8Array(sig));
}

export interface VerifyInput {
  frame: Frame;
  /** The bytes as they arrived — inline or pulled. Both are checked identically. */
  payload: Uint8Array | string | undefined;
  signatureB64u: string;
  /** The public key the sender's `dev` names, as this side knows it for THIS session. */
  senderPublicKey: Uint8Array | undefined;
  now: number;
  seen: boolean;
  session: { active: boolean; startedAt: number } | undefined;
  /** The version the sender signed over. Absent = this build's own. */
  version?: string;
}

/**
 * The seven checks, in the shared module's order, none conditional. `null` means good; anything else
 * is the NAMED reason, because "rejected" tells a person nothing about whether to wait, reconnect,
 * or walk to their Mac.
 */
export async function verifyFrame(v: VerifyInput): Promise<VerifyFailure | null> {
  const early = preSignatureFailure(v.frame, !!v.senderPublicKey);
  if (early) return early;
  if (!(await verifySignature(v.frame, v.payload, v.signatureB64u, v.senderPublicKey!, v.version))) {
    return "signature";
  }
  return postSignatureFailure({ frame: v.frame, now: v.now, seen: v.seen, session: v.session });
}

/**
 * Check three on its own, because the CLIENT needs it without checks four to seven.
 *
 * A result pulled minutes after it was written is not stale and its session's start is something the
 * client never held; re-applying the freshness window and the 24-hour rule to an ANSWER would reject
 * a perfectly good one for the crime of having been waited for. The Flutter app draws the same line
 * for the same reason — see `verifyResult` there — so the split is the contract's, not a shortcut.
 */
export async function verifySignature(
  frame: Frame,
  payload: Uint8Array | string | undefined,
  signatureB64u: string,
  senderPublicKey: Uint8Array,
  version?: string,
): Promise<boolean> {
  try {
    // `signingString` is called INSIDE the try on purpose: a `ts` that is finite but not a positive
    // integer passes the shape check and throws here, and reads as a bad signature — a frame whose
    // bytes cannot be built is a frame whose signature cannot be right.
    const message = enc.encode(signingString(frame, await payloadHash(payload), version ?? MOBILE_CONNECT_VERSION));
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      await importPublicKey(senderPublicKey),
      b64uDecode(signatureB64u) as unknown as ArrayBuffer,
      message as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** Derived at both ends, NEVER sent. A code the relay chooses proves nothing — it can show both
 *  screens the same number while swapping its own keys underneath. */
export async function glanceCode(
  sessionId: string,
  enginePublicKeyB64u: string,
  phonePublicKeyB64u: string,
): Promise<string> {
  const digest = await sha256Hex(enc.encode(glanceString(sessionId, enginePublicKeyB64u, phonePublicKeyB64u)));
  return glanceFromSha256Hex(digest);
}

// ── The frame as it travels ──────────────────────────────────────────────────────────────────────

/**
 * `Frame` deliberately has no `v` and no `payloadSha256`: the version is a constant of the protocol
 * and the hash is derived from the bytes, so neither is a value a caller could get wrong. On the
 * wire both are explicit, because the relay reads them without holding our types — and the INBOUND
 * `payloadSha256` is checked against the bytes rather than ignored, since a field that can be
 * anything is a field two stacks will eventually disagree about while both look correct.
 */
export interface WireFrame extends Frame {
  v: string;
  payloadSha256: string;
  sig: string;
}

export async function toWireFrame(
  frame: Frame,
  payload: Uint8Array | string | undefined,
  privateKey: CryptoKey,
): Promise<{ frame: WireFrame; payloadB64u: string }> {
  const sig = await signFrame(frame, payload, privateKey);
  const bytes = payload === undefined ? new Uint8Array() : typeof payload === "string" ? enc.encode(payload) : payload;
  return {
    frame: { ...frame, v: MOBILE_CONNECT_VERSION, payloadSha256: await payloadHash(payload), sig },
    // Absent, null and "" are ONE case on this wire; the empty string is what the worker reads as
    // zero bytes and hashes to the empty-string sha256 we just signed.
    payloadB64u: bytes.length === 0 ? "" : b64u(bytes),
  };
}

/** Shape a `frame` object off the wire. SHAPES ONLY — nothing here trims, lower-cases or defaults a
 *  field, because a sanitised field is a different signing string. */
export function parseWireFrame(raw: unknown): WireFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const str = (k: string): string => (typeof f[k] === "string" ? (f[k] as string) : "");
  if (typeof f.ts !== "number" || typeof f.sig !== "string") return null;
  return {
    v: str("v") || MOBILE_CONNECT_VERSION,
    dir: f.dir === "res" ? "res" : "req",
    dev: str("dev"),
    sessionId: str("sessionId"),
    frameId: str("frameId"),
    engineFp: str("engineFp"),
    agentId: str("agentId"),
    kind: str("kind") as FrameKind,
    payloadSha256: str("payloadSha256"),
    ts: f.ts,
    sig: f.sig as string,
  };
}

/** The payload as it arrived. Absent, null and "" are the same zero bytes. */
export function decodePayload(raw: unknown): Uint8Array | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return b64uDecode(String(raw));
}

/** `f-` + 24 hex, the shape the Flutter client mints. Random, never a counter: a counter would leak
 *  how much has been sent and collide across two tabs of the same browser. */
export function mintFrameId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return `f-${toHex(random(12))}`;
}
