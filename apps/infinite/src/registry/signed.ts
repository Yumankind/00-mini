/**
 * THE SIGNED REQUEST — five lines, four headers, one signature (moltworker `docs/infinite/API.md` §1).
 *
 * Every owner call to the registry carries a signature over its OWN method, path, timestamp, body
 * and nonce. There are no cookies and no bearer tokens on that surface at all, which is what lets
 * the worker answer any origin's preflight without granting anything: a hostile page may SEND a
 * request and still cannot produce one.
 *
 * ```
 * METHOD \n PATH \n TIMESTAMP \n sha256hex(body) \n NONCE
 * ```
 *
 * Five details are a contract, and every one of them has a refusal behind it:
 *
 *   · METHOD upper case.
 *   · PATH is the pathname AND THE QUERY STRING. A signature for `?since=0` must not be liftable
 *     onto `?since=999999`, so the inbox drain signs the cursor it asked for.
 *   · TIMESTAMP is unix SECONDS as a decimal string, and must be inside ±5 minutes
 *     (`stale_signature`). Milliseconds here look like a clock 50,000 years fast.
 *   · sha256(body) is LOWER-CASE HEX, and a bodyless call carries the hash OF THE EMPTY STRING
 *     (`e3b0c442…`) rather than an empty field, so "no body" and "the field is missing" are
 *     different strings and neither substitutes for the other.
 *   · NONCE is ours, 8–64 characters, single-use per app inside the window (`replayed_signature`).
 *
 * ── THE FIFTH LINE IS WHY THIS FILE IS NOT §24'S ───────────────────────────────────────────────
 *
 * sponsoredtokens' developer-apps §24 latches replays on the signature itself, arguing it is unique
 * by construction because ECDSA's `k` is random. That is true of P-256 and FALSE of ed25519, which
 * is deterministic by design (RFC 8032): this key signing the same method, path, timestamp and body
 * produces the same 64 bytes every time, so a signature latch would refuse an owner's second
 * identical request inside one second — two panel refreshes, a retry after a dropped connection — as
 * a replay. Hence a caller-chosen nonce, hence a fifth line, hence `X-Infinite-Nonce`.
 *
 * ── BINARY BODIES ──────────────────────────────────────────────────────────────────────────────
 *
 * Only `PUT …/public-bundle` sends bytes. The worker hashes them by decoding as UTF-8 first
 * (`routes.ts`: `new TextDecoder('utf-8', { fatal: false }).decode(bytes)`), so this side must do
 * exactly the same thing to the same `Uint8Array` it is about to send. `bodyHashForBytes` is that,
 * and it is the only correct way to hash a binary body for this wire.
 */

/** The header names, from the worker's `config.ts`. `X-Infinite-*` so a set lifted from
 *  sponsoredtokens cannot be replayed here even though the canonical string is the same shape. */
export const APP_HEADER = "X-Infinite-App";
export const TIMESTAMP_HEADER = "X-Infinite-Timestamp";
export const NONCE_HEADER = "X-Infinite-Nonce";
export const SIGNATURE_HEADER = "X-Infinite-Signature";

/** 8–64 characters, or the worker answers `signature_headers_incomplete` rather than a bad signature. */
export const NONCE_MIN_LENGTH = 8;
export const NONCE_MAX_LENGTH = 64;

/** sha256 of the empty string, lower-case hex — the fourth line of every bodyless call. */
export const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const enc = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** LOWER-CASE hex sha256. The worker's `refs.ts::sha256Hex`, character for character. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text) as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

/** The hash of a BINARY body, decoded as UTF-8 first exactly as the worker does before hashing. */
export async function bodyHashForBytes(bytes: Uint8Array): Promise<string> {
  return sha256Hex(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/** `METHOD\nPATH\nTIMESTAMP\nsha256hex(body)\nNONCE`. */
export function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  bodyHash: string,
  nonce: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}\n${nonce}`;
}

/** Pathname AND query, exactly as the worker's `signedPath` rebuilds it from the request it got. */
export function signedPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** 22 base64url characters from 16 random bytes: inside the band, and not colliding in five minutes. */
export function newNonce(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(16);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SignInput {
  appId: string;
  method: string;
  /** The absolute URL, query included — the signature covers what the fetch will actually ask for. */
  url: string;
  /** A JSON string, or bytes for the public bundle. Absent means the empty body's hash. */
  body?: string | Uint8Array;
  sign(message: string): Promise<string>;
  now?: () => number;
  nonce?: string;
}

/**
 * The four headers, built and signed. Nothing else authenticates a call, so nothing else is added:
 * a header this app invents is a header the worker ignores and a person debugs for an afternoon.
 */
export async function signedHeaders(input: SignInput): Promise<Record<string, string>> {
  const timestamp = String(Math.floor((input.now?.() ?? Date.now()) / 1000));
  const nonce = input.nonce ?? newNonce();
  const bodyHash =
    input.body === undefined
      ? EMPTY_BODY_HASH
      : typeof input.body === "string"
        ? await sha256Hex(input.body)
        : await bodyHashForBytes(input.body);
  const message = canonicalString(input.method, signedPath(input.url), timestamp, bodyHash, nonce);
  return {
    [APP_HEADER]: input.appId,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: await input.sign(message),
  };
}

/**
 * THE CLAIM MESSAGE, which is NOT a signed request (§5.4).
 *
 * `appId ‖ origin ‖ nonce`, plain concatenation, no separators — `registry.ts::claimApp` builds
 * `` `${app.id}${origin}${nonce}` `` and verifies against that string and no other. Two things about
 * it catch people out, and both are checked in the tests beside this file:
 *
 *   · `origin` is the app's REGISTRATION origin — the site being claimed — and not the origin this
 *     browser is signing from. The claim is completed here, at the product origin, so this window's
 *     own origin says nothing about the site.
 *   · `nonce` is the `claimNonce` minted at registration and held in KV for 30 days, not a
 *     request nonce. The claim route is unauthenticated: this signature IS the credential.
 */
export function claimMessage(appId: string, origin: string, nonce: string): string {
  return `${appId}${origin}${nonce}`;
}
