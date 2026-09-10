/**
 * The key of a live transfer — docs/HANDOFF-infinite-agent.md §7.1.
 *
 * WHY THIS KEY IS THE WHOLE PROTECTION. The bytes go over a Cloudflare Realtime DataChannel, and
 * **DTLS ends at the SFU**: the edge terminates the transport encryption, forwards the payload to the
 * other peer, and could read every byte in between. That is not a flaw of the SFU, it is what an SFU
 * IS — it is a relay, not a wire. So the transfer does not rely on the transport at all: the bundle
 * is the same AES-256-GCM `.00agent` the file road produces (bundle.ts), and its secret is derived
 * HERE, on both devices, from the six-word code the person carries between the two screens. The SFU,
 * the room service and anything on the path see ciphertext and nothing else.
 *
 * WHY HKDF AND NOT "USE THE CODE AS THE PASSPHRASE". The code is six words of a 256-word list: 48
 * bits, readable, and typed by a human — which is enough entropy to admit a peer to a one-shot room
 * that lives ten minutes, and NOT the shape of an encryption key. HKDF-SHA256 with the room's random
 * salt turns it into 32 uniform bytes, binds the key to THAT room (the same code in a later room
 * derives a different key), and gives a second, independent output for the confirmation below.
 *
 * WHAT THE CONFIRMATION IS FOR. Four characters, derived from the same key material and shown on
 * both screens. The person compares them, so a peer that joined with a DIFFERENT code — the only way
 * a stranger reaches this room — shows different characters and the transfer is stopped by a human
 * before any agent moves. It is the SAS of every pairing protocol, sized so it can be read across a
 * desk.
 *
 * THE HONEST CAVEAT, stated where the key is made: in §7.1's shape the ROOM SERVICE mints the code
 * and the salt, so a dishonest room service knows both and could derive this key. The transfer is
 * therefore protected against the SFU, the network and every other peer — but not against the room
 * service itself. Closing that needs the code to be minted on the sending device and the room to be
 * indexed by its hash; the wire here does not change when it is.
 */

import { detach } from "../bytes.js";
import { fail } from "../errors.js";

/** Separate labels, so the bundle key and the confirmation cannot be each other. */
export const SECRET_INFO = "00/infinite/transfer/1/bundle-secret";
export const CONFIRM_INFO = "00/infinite/transfer/1/confirmation";

/** Crockford-ish: no 0/O, no 1/I/L, so a person reading it aloud cannot produce a different string. */
export const CONFIRM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Four characters of a 32-symbol alphabet: 20 bits, which is the SAS size of §7.1. */
export const CONFIRM_LENGTH = 4;

export interface TransferKeys {
  /** Handed verbatim to `exportBundle`/`importBundleInto` as their `secret`. */
  secret: string;
  /** Shown on both screens; compared by the person, never by the room service. */
  confirmation: string;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this host");
  return c.subtle;
}

const encoder = new TextEncoder();

/** base64url, no padding — the shape the room service's salt arrives in, and the secret leaves in. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Tolerant of padding and of standard base64, because a salt is somebody else's string. */
export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9\-_+/]+={0,2}$/.test(value)) fail("transfer_salt_invalid", "the room's salt is not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hkdf(code: string, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", detach(encoder.encode(code)), "HKDF", false, ["deriveBits"]);
  const derived = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: detach(salt), info: detach(encoder.encode(info)) },
    key,
    bytes * 8,
  );
  return new Uint8Array(derived);
}

/** 20 bits of the confirmation output, five at a time. Deterministic, and independent of the secret. */
function confirmationOf(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  let at = 0;
  while (out.length < CONFIRM_LENGTH) {
    if (bits < 5) {
      acc = (acc << 8) | bytes[at++];
      bits += 8;
    }
    bits -= 5;
    out += CONFIRM_ALPHABET[(acc >> bits) & 31];
  }
  return out;
}

/**
 * The one derivation both devices run. Same code, same salt ⇒ same secret and same four characters;
 * a different code on either side ⇒ neither matches, which is what the person is looking at.
 */
export async function deriveTransferKeys(code: string, salt: Uint8Array | string): Promise<TransferKeys> {
  if (typeof code !== "string" || code.length === 0) fail("transfer_code_required", "a transfer needs its code");
  const saltBytes = typeof salt === "string" ? fromBase64Url(salt) : salt;
  if (saltBytes.length < 8) fail("transfer_salt_invalid", "the room's salt is too short to bind a key to");
  const [secret, confirm] = await Promise.all([
    hkdf(code, saltBytes, SECRET_INFO, 32),
    hkdf(code, saltBytes, CONFIRM_INFO, 4),
  ]);
  return { secret: toBase64Url(secret), confirmation: confirmationOf(confirm) };
}

/** Lowercase hex SHA-256 of the encrypted bundle — the digest of §7.1's "and a final sha256". */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", detach(bytes)));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Constant-time-ish comparison of two digests or two confirmations.
 *
 * Not because a timing attack on a hex string is a realistic threat here, but because the same
 * function is used for the confirmation, and `===` on secrets is a habit worth not having.
 */
export function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
