// The bundle's encryption, in WebCrypto — the browser half of `encryptFile`/`decryptFile` in
// apps/00d/src/burst-bundle.ts.
//
// The one thing that matters here is that the key rule and the byte layout are copied EXACTLY, not
// re-derived: `SHA-256(utf8(secret + ":enc"))` and `iv(12) || ciphertext || tag(16)`, no header, no
// framing, no version byte. A `.00agent` written in a browser is opened by a Mac engine that has
// never heard of this file, and a single differing byte of layout makes every bundle a stranger.
// WebCrypto's AES-GCM already appends the tag to the ciphertext, which is why the concatenation
// below looks like it is missing a step and is not.

import { detach } from "./bytes.js";
import { assertSecret } from "./errors.js";

const encoder = new TextEncoder();

/** Bytes 0..11 of every bundle. */
export const IV_BYTES = 12;
/** The GCM tag WebCrypto appends to the ciphertext. */
export const TAG_BYTES = 16;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this host");
  return c.subtle;
}

/** `SHA-256(utf8(secret + ":enc"))`, as an AES-GCM key. Exported for tests that pin the rule. */
export async function bundleKey(secret: string): Promise<CryptoKey> {
  assertSecret(secret);
  const digest = await subtle().digest("SHA-256", detach(encoder.encode(`${secret}:enc`)));
  return subtle().importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptBundle(plain: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await bundleKey(secret);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, detach(plain)));
  const out = new Uint8Array(iv.byteLength + sealed.byteLength);
  out.set(iv, 0);
  out.set(sealed, iv.byteLength);
  return out;
}

/** Throws `bundle_too_short` or `bundle_decrypt_failed` — a torn, altered or wrongly-keyed bundle
 *  must fail loudly, never extract partially. */
export async function decryptBundle(bytes: Uint8Array, secret: string): Promise<Uint8Array> {
  if (bytes.byteLength < IV_BYTES + TAG_BYTES) {
    throw named("bundle_too_short", "bundle too short to be valid");
  }
  const key = await bundleKey(secret);
  const iv = detach(bytes.subarray(0, IV_BYTES));
  const body = bytes.subarray(IV_BYTES);
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, key, detach(body)));
  } catch {
    throw named("bundle_decrypt_failed", "could not decrypt this bundle — wrong secret, or the file is damaged");
  }
}

function named(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
