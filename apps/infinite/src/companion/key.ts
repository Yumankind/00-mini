/**
 * THIS BROWSER'S IDENTITY TO THE COMPANION — the engine's own signing scheme, with the one algorithm
 * §14.2 adds.
 *
 * The engine (`apps/00d/src/device-auth.ts`) authenticates a remote client by SIGNATURE, not by
 * token: headers `x-00-dev` (a fingerprint), `x-00-ts` (ms) and `x-00-sig` over
 *
 *     METHOD \n pathWithQuery \n ts \n sha256hex(body)
 *
 * ±120 s, with a replay cache on the signature itself. Its existing devices are Ed25519 via @noble
 * (a phone on plain LAN http has no `crypto.subtle` at all); a BROWSER device here is ECDSA P-256
 * via WebCrypto, because the whole point of this key is that it is NON-EXTRACTABLE — a `CryptoKey`
 * the page can hand to `sign` and can never read, copy or leak — and WebCrypto's Ed25519 is not
 * everywhere yet. That is the `alg: "p256"` of §14.2, and the engine verifies it with the same
 * canonical string.
 *
 * ── THE FOUR DETAILS THAT MUST AGREE BYTE FOR BYTE WITH THE ENGINE ───────────────────────────────
 *
 * Checked against `apps/00d/src/device-auth.ts` and `packages/web-vue/src/device-key.ts` line by
 * line, because every one of them is a silent 401 if it drifts:
 *
 *   · METHOD is upper case; `pathWithQuery` is the path AND the query, never the origin — a
 *     signature for `?url=https://a` must not lift onto `?url=https://b`.
 *   · `ts` is MILLISECONDS (`Date.now()`), not seconds. The sponsoredtokens scheme in
 *     @00/agent-models uses seconds; this is a different verifier and they do not mix.
 *   · the body hash is LOWERCASE HEX of sha256, and an empty body hashes to the sha256 of the empty
 *     string (`e3b0c442…`), never to an empty field.
 *   · the fingerprint is the first 16 hex of sha256 OF THE RAW PUBLIC KEY BYTES. For Ed25519 that is
 *     32 bytes; for P-256 it is the 65-byte uncompressed point (`0x04 ‖ x ‖ y`) that
 *     `exportKey("raw")` returns — which is what `rawPublicKey()` below reconstructs from the JWK,
 *     so the fingerprint survives a reload with only the JWK in the store.
 *   · the signature is base64URL (`-`/`_`, no padding) of the RAW 64-byte `r‖s` WebCrypto produces,
 *     never DER.
 *
 * The keypair lives in `IndexedDbDeviceKeyStore` (the one store that can hold a non-extractable
 * `CryptoKey` as a value) under `companion:<engineFp>` — per ENGINE, so two computers paired from
 * the same browser are two grants, and a revoked one is forgotten on its own.
 */
import {
  DEVICE_SIGN_PARAMS,
  IndexedDbDeviceKeyStore,
  generateDeviceKeypair,
  type DeviceKeyStore,
  type StoredDevice,
} from "@00/agent-models";

export const COMPANION_DEV_HEADER = "x-00-dev";
export const COMPANION_TS_HEADER = "x-00-ts";
export const COMPANION_SIG_HEADER = "x-00-sig";

/** One grant per engine. A second computer is a second key, and a revoked one is deleted by name. */
export function companionAppId(engineFp: string): string {
  return `companion:${engineFp}`;
}

// ── Bytes, hex, base64url ────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** base64url, unpadded — the spelling `Buffer.from(s, "base64url")` on the engine reads back. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The 65 raw bytes of a P-256 public key, rebuilt from its JWK: `0x04 ‖ x ‖ y`, each coordinate
 * left-padded to 32 bytes. This is byte-for-byte what `crypto.subtle.exportKey("raw", publicKey)`
 * returns, and it is what the engine hashes to get the fingerprint — so it must be rebuilt exactly,
 * including the padding of a coordinate whose base64url happened to be short.
 */
export function rawPublicKey(jwk: JsonWebKey): Uint8Array {
  if (!jwk.x || !jwk.y) throw new Error("a P-256 public key needs both coordinates");
  const x = fromBase64Url(jwk.x);
  const y = fromBase64Url(jwk.y);
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 33 - x.length);
  out.set(y, 65 - y.length);
  return out;
}

/** The engine's `fingerprint()`: sha256 of the raw public key, first 16 hex characters. */
export async function deviceFingerprint(
  jwk: JsonWebKey,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const raw = rawPublicKey(jwk);
  const digest = await subtle.digest("SHA-256", raw.slice().buffer as ArrayBuffer);
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

/** `METHOD\npathWithQuery\nts\nsha256hex(body)` — `canonicalHttp` in apps/00d/src/device-auth.ts. */
export function canonicalCompanion(method: string, pathWithQuery: string, ts: string, bodyHashHex: string): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${bodyHashHex}`;
}

export type SignableBody = string | Uint8Array | null | undefined;

export function bodyBytes(body: SignableBody): Uint8Array {
  if (body === null || body === undefined) return new Uint8Array();
  return typeof body === "string" ? encoder.encode(body) : body;
}

/** sha256 of the body in lowercase hex. No body hashes to the sha256 of the empty string. */
export async function bodyHashHex(
  body: SignableBody,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const bytes = bodyBytes(body);
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

// ── The key itself ───────────────────────────────────────────────────────────────────────────────

export interface CompanionKeyEnv {
  store?: DeviceKeyStore;
  subtle?: SubtleCrypto;
  now?: () => number;
}

let defaultStore: DeviceKeyStore | null = null;

function storeFor(env: CompanionKeyEnv): DeviceKeyStore {
  if (env.store) return env.store;
  // One IndexedDB handle for the tab. Built lazily so a node test that injects a store never opens
  // a database that is not there.
  defaultStore ??= new IndexedDbDeviceKeyStore();
  return defaultStore;
}

/**
 * The key for this engine, made on first use.
 *
 * `deviceId` is the fingerprint, so the record answers "who am I to that engine" without a second
 * derivation — and `publicKeyJwk` is what the pairing call sends. The private half is a
 * non-extractable `CryptoKey` from the moment it exists.
 */
export async function companionKey(engineFp: string, env: CompanionKeyEnv = {}): Promise<StoredDevice> {
  const store = storeFor(env);
  const appId = companionAppId(engineFp);
  const existing = await store.get(appId);
  if (existing) return existing;
  const subtle = env.subtle ?? globalThis.crypto.subtle;
  const pair = await generateDeviceKeypair(subtle);
  const publicKeyJwk = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const device: StoredDevice = {
    appId,
    deviceId: await deviceFingerprint(publicKeyJwk, subtle),
    privateKey: pair.privateKey,
    publicKeyJwk,
    createdAt: new Date(env.now?.() ?? Date.now()).toISOString(),
  };
  await store.put(device);
  return device;
}

/** Forget this engine's key. Called when the person disconnects, or the engine says it is gone. */
export async function forgetCompanionKey(engineFp: string, env: CompanionKeyEnv = {}): Promise<void> {
  await storeFor(env).delete(companionAppId(engineFp));
}

/** The key's fingerprint — the `x-00-dev` this browser sends, and the id the engine filed. */
export async function companionFingerprint(engineFp: string, env: CompanionKeyEnv = {}): Promise<string> {
  return (await companionKey(engineFp, env)).deviceId;
}

export interface SignedRequest {
  [COMPANION_DEV_HEADER]: string;
  [COMPANION_TS_HEADER]: string;
  [COMPANION_SIG_HEADER]: string;
}

/**
 * The three headers, for one request.
 *
 * `pathWithQuery` is what goes in the URL after the origin — the caller passes it rather than the
 * full URL, because that is what is signed and a function that took a URL would have to be trusted
 * to strip the origin the same way the engine does.
 */
export async function signedHeaders(
  engineFp: string,
  method: string,
  pathWithQuery: string,
  body: SignableBody = null,
  env: CompanionKeyEnv = {},
): Promise<Record<string, string>> {
  const subtle = env.subtle ?? globalThis.crypto.subtle;
  const device = await companionKey(engineFp, env);
  const ts = String(env.now?.() ?? Date.now());
  const canonical = canonicalCompanion(method, pathWithQuery, ts, await bodyHashHex(body, subtle));
  const signature = await subtle.sign(
    DEVICE_SIGN_PARAMS,
    device.privateKey,
    encoder.encode(canonical).slice().buffer as ArrayBuffer,
  );
  return {
    [COMPANION_DEV_HEADER]: device.deviceId,
    [COMPANION_TS_HEADER]: ts,
    [COMPANION_SIG_HEADER]: toBase64Url(new Uint8Array(signature)),
  };
}
