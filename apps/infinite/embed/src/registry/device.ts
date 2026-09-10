/**
 * THE VISITOR'S DEVICE KEY — a non-extractable P-256 keypair, and the five lines it signs (§6.2).
 *
 * §5.6 names this exactly: "the visitor's device key is the sponsoredtokens one (§6.2); before the
 * app is linked to one, a per-site P-256 key registered here with the same Origin check and the
 * same per-IP cap". This file is the browser half of the worker's `devices.ts`.
 *
 * WHY NON-EXTRACTABLE. `generateKey(…, false, ["sign"])` gives back a private key that no script —
 * ours, the host page's, an injected one — can ever read out. It lives in IndexedDB as a
 * `CryptoKey`, which the structured clone algorithm carries and JSON cannot: the identity is the
 * key, there is no secret to leak, and there is nothing to steal but the ability to use it from
 * inside this one origin's storage partition. The public half is always exportable regardless of
 * that flag (WebCrypto says so for generated key pairs), which is what makes registration possible
 * at all.
 *
 * WHY THE CANONICAL STRING IS FIVE LINES AND NOT FOUR. The worker's `signed-request.ts` sets out
 * the argument: §24 latched replays on the signature itself, which is unique by construction for
 * ECDSA but NOT for ed25519, which is deterministic — so the owner's link key and this device key
 * both carry a caller-chosen nonce, it is the fifth line, and the latch is keyed on it. One
 * canonical string, two key kinds. `test/embed/registry-device.test.ts` generates its vectors by
 * importing the worker's own module, so the day either side edits a line the other one fails.
 *
 *     METHOD \n PATH \n TIMESTAMP \n sha256hex(body) \n NONCE
 *
 * PATH is the pathname AND the query — a signature for `?since=0` must not be liftable onto
 * `?since=999999`. TIMESTAMP is unix SECONDS, decimal, and must be inside ±5 minutes. The body hash
 * is lower-case hex, and a bodyless call carries the hash of the EMPTY STRING, never an empty field.
 */

import type { Store } from "../index/store.js";

/** The five headers of the wire, spelled as the worker's `config.ts` spells them. */
export const APP_HEADER = "X-Infinite-App";
export const DEVICE_HEADER = "X-Infinite-Device";
export const TIMESTAMP_HEADER = "X-Infinite-Timestamp";
export const SIGNATURE_HEADER = "X-Infinite-Signature";
export const NONCE_HEADER = "X-Infinite-Nonce";

/** The four fields that ARE an EC P-256 public key; the worker refuses anything else by name. */
export interface DeviceJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

const subtle = (): SubtleCrypto => crypto.subtle;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Lower-case hex sha256 — the fourth line. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** Pathname AND query, exactly as the worker's `signedPath` builds it from the request it received. */
export function signedPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

export function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  bodyHash: string,
  nonce: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}\n${nonce}`;
}

/**
 * A fresh nonce: 16 random bytes, base64url, 22 characters — inside the worker's 8–64 band, and far
 * enough from a collision that two tabs of the same site signing in the same second cannot latch
 * each other out.
 */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// ── The keypair ─────────────────────────────────────────────────────────────────────────────────

/** `registry:key:<origin>:<ref>` — its own key, so nothing that reads the state record sees it. */
export function deviceKeyKey(origin: string, ref: string): string {
  return `registry:key:${origin}:${ref}`;
}

const isKeyPair = (v: unknown): v is CryptoKeyPair => {
  const pair = v as { privateKey?: unknown; publicKey?: unknown } | null;
  return (
    !!pair &&
    typeof pair === "object" &&
    typeof (pair.privateKey as { algorithm?: unknown } | undefined)?.algorithm === "object" &&
    typeof (pair.publicKey as { algorithm?: unknown } | undefined)?.algorithm === "object"
  );
};

/**
 * The keypair for this site's app, minted once and kept.
 *
 * A store that cannot hold a `CryptoKey` — private browsing, an evicted database, a `Store` that
 * round-trips through JSON — yields a fresh pair rather than an error, and the caller registers it
 * as a new device. That costs one row against a cap of five a day, and it is the difference between
 * "this browser starts over" and "this browser throws on a website that is not ours".
 */
export async function ensureDeviceKey(store: Store, origin: string, ref: string): Promise<CryptoKeyPair> {
  const key = deviceKeyKey(origin, ref);
  const held = await store.get<CryptoKeyPair>(key);
  if (isKeyPair(held)) return held;
  const pair = (await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  await store.set(key, pair);
  return pair;
}

/** The public half, trimmed to the four fields the worker stores. */
export async function devicePublicJwk(pair: CryptoKeyPair): Promise<DeviceJwk> {
  const jwk = (await subtle().exportKey("jwk", pair.publicKey)) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("this browser produced a key that is not EC P-256");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

// ── Signing one request ─────────────────────────────────────────────────────────────────────────

export interface SignInput {
  pair: CryptoKeyPair;
  appId: string;
  deviceId: string;
  method: string;
  url: string;
  /** The exact body text that will be sent; `""` for a GET. */
  body: string;
  /** Injectable for the tests; the wire wants unix SECONDS. */
  nowMs?: number;
  nonce?: string;
}

/**
 * The five headers, ready to spread into `fetch`.
 *
 * The signature is base64url of the RAW 64-byte `r‖s` that `subtle.sign` produces, never DER: the
 * worker refuses anything that is not 64 bytes, by length, rather than trying to decode it, and
 * says so — which is how a client that has gone its own way finds out in one request instead of an
 * afternoon.
 */
export async function signedHeaders(input: SignInput): Promise<Record<string, string>> {
  const timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const nonce = input.nonce ?? newNonce();
  const message = canonicalString(
    input.method,
    signedPath(input.url),
    timestamp,
    await sha256Hex(input.body),
    nonce,
  );
  const raw = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.pair.privateKey,
    new TextEncoder().encode(message),
  );
  return {
    [APP_HEADER]: input.appId,
    [DEVICE_HEADER]: input.deviceId,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: toBase64Url(new Uint8Array(raw)),
  };
}
