/**
 * `crypto` over WebCrypto — the part of Node's crypto a browser can actually honour.
 *
 * DOES: `randomBytes` (callback and sync — `getRandomValues` is synchronous, so this one sync
 * function needs no isolation), `randomInt`, `randomUUID`, `randomFillSync`, `createHash` for
 * `sha1`/`sha256`/`sha384`/`sha512` and `md5`, `createHmac` for the same digests,
 * `timingSafeEqual`, `getHashes`, and `webcrypto` itself for anything modern.
 *
 * DOES NOT: any of it synchronously at the digest. `crypto.subtle.digest` is a PROMISE, and
 * `hash.digest()` in Node is not — so `createHash` BUFFERS what you `update()` and hashes it in one
 * call. That is honest for the sizes this runtime sees (a tarball integrity check, an etag, a
 * content hash) and dishonest for a 4 GB stream, which is why the buffer is capped and says so.
 * `digest()` therefore has two faces: `digestAsync()` returns the promise, and `digest()` throws
 * unless the value is already resolved — EXCEPT for md5, sha1 and sha256, which are implemented here
 * in JS precisely so the synchronous Node shape keeps working where npm needs it (`npm` itself
 * hashes with sha512 and awaits, so the async road is the one that matters). sha384 and sha512 need
 * 64-bit words and stay on WebCrypto.
 *
 * Also absent: `createCipheriv`/`createDecipheriv` (WebCrypto has AES-GCM, Node's default is
 * AES-256-CBC with a different padding story, and a half-right cipher is worse than none),
 * `createSign`/`createVerify`, `generateKeyPair`, `pbkdf2Sync`, `scrypt`, `createDiffieHellman`.
 * Each refuses by name and points at `crypto.webcrypto`.
 */

import { Buffer } from "buffer/index.js";
import { NodeCompatError } from "../errors.js";

const webcrypto = (globalThis as { crypto?: Crypto }).crypto;

function subtleOrFail(): SubtleCrypto {
  if (!webcrypto?.subtle) {
    throw new NodeCompatError(
      "ERR_NO_WEBCRYPTO",
      "crypto.subtle is missing — a page only gets it in a secure context (https or localhost), and this runtime's hashing is built on it",
    );
  }
  return webcrypto.subtle;
}

const SUBTLE_NAMES: Record<string, string> = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" };

/** The buffer a `createHash` may accumulate before it says so. 64 MB covers every tarball npm sends. */
export const HASH_BUFFER_LIMIT = 64 * 1024 * 1024;

const encoder = new TextEncoder();

function toBytes(data: unknown, encoding?: string): Uint8Array {
  if (typeof data === "string") {
    if (encoding === "hex") return hexToBytes(data);
    if (encoding === "base64") return base64ToBytes(data);
    return encoder.encode(data);
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

/** WebCrypto refuses a view backed by a SharedArrayBuffer; a copy on a plain buffer ends the argument. */
function plain(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const encode = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (encode) return encode(binary);
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(text: string): Uint8Array {
  const decode = (globalThis as { atob?: (s: string) => string }).atob;
  if (!decode) return new Uint8Array(Buffer.from(text, "base64"));
  const binary = decode(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── md5 and sha1 in JS, so the synchronous Node shape survives where it must ───────────────────────

/** RFC 1321. Here because `createHash("md5").digest("hex")` is synchronous in a hundred packages. */
export function md5(input: Uint8Array): Uint8Array {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const bitLength = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 8, bitLength >>> 0, true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const view = new DataView(padded.buffer);
  const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getInt32(chunk + i * 4, true);
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + (K[i] as number) + (M[g] as number)) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[((i >> 4) << 2) | (i & 3)] as number)) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, a0, true);
  dv.setInt32(4, b0, true);
  dv.setInt32(8, c0, true);
  dv.setInt32(12, d0, true);
  return out;
}

/**
 * FIPS 180-4, sha256, in JS. Here for two reasons, both of them "Node's shape is synchronous":
 * `createHash("sha256").digest("hex")` is written that way in more packages than any other digest,
 * and the loader's transform cache keys transformed output by the sha256 of its source from inside a
 * synchronous `require`. sha384 and sha512 need 64-bit words and stay on the WebCrypto road.
 */
export function sha256(input: Uint8Array): Uint8Array {
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  const ml = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, ml >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(ml / 4294967296), false);
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const rotr = (x: number, c: number): number => (x >>> c) | (x << (32 - c));
  const w = new Int32Array(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(chunk + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = [
      h[0] as number,
      h[1] as number,
      h[2] as number,
      h[3] as number,
      h[4] as number,
      h[5] as number,
      h[6] as number,
      h[7] as number,
    ];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    const add = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (add[i] as number)) | 0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setInt32(i * 4, h[i] as number, false);
  return out;
}

/** FIPS 180-1. Same reason as md5: `sha1` is the etag of a thousand build tools. */
export function sha1(input: Uint8Array): Uint8Array {
  const ml = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, ml >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(ml / 4294967296), false);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));
  const w = new Int32Array(80);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(chunk + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number), 1);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + (w[i] as number)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => dv.setInt32(i * 4, h, false));
  return out;
}

/** The HMAC block size of each digest we can compute in JS. RFC 2104's B. */
const BLOCK_BYTES: Record<string, number> = { md5: 64, sha1: 64, sha256: 64 };

/**
 * RFC 2104 HMAC over the three digests written out above, so `hmac.digest()` is synchronous for
 * them. WebCrypto's `sign` is a promise and nothing can unwrap one, but HMAC is not a primitive —
 * it is two hashes and two XORs — so the digests that are synchronous here make their HMAC
 * synchronous too. That covers the sha256 half of every JWT library on npm.
 */
export function hmacInJs(algorithm: string, key: Uint8Array, message: Uint8Array): Uint8Array | null {
  const block = BLOCK_BYTES[algorithm];
  const hash = (bytes: Uint8Array): Uint8Array => digestInJs(algorithm, bytes) as Uint8Array;
  if (!block) return null;
  const padded = new Uint8Array(block);
  padded.set(key.byteLength > block ? hash(key) : key);
  const inner = new Uint8Array(block + message.byteLength);
  const outer = new Uint8Array(block + (algorithm === "md5" ? 16 : algorithm === "sha1" ? 20 : 32));
  for (let i = 0; i < block; i++) {
    inner[i] = (padded[i] as number) ^ 0x36;
    outer[i] = (padded[i] as number) ^ 0x5c;
  }
  inner.set(message, block);
  outer.set(hash(inner), block);
  return hash(outer);
}

/**
 * RFC 2898 PBKDF2, over the JS HMAC above. Present because `pbkdf2Sync` is what a dozen packages
 * call at import time and refusing it stopped them dead; absent for sha384/sha512, which have no
 * synchronous hash here and therefore no synchronous HMAC. It is JS, so it is slower than Node's
 * OpenSSL by roughly the factor you would guess — a 600k-iteration key derivation is seconds, not
 * milliseconds, and a caller that wants speed should use `subtle.deriveBits` and await it.
 */
export function pbkdf2InJs(password: Uint8Array, salt: Uint8Array, iterations: number, keylen: number, digest: string): Uint8Array {
  const algorithm = digest.toLowerCase().replace(/-/g, "");
  if (!BLOCK_BYTES[algorithm]) {
    throw new NodeCompatError(
      "ERR_CRYPTO_UNSUPPORTED_DIGEST",
      `crypto.pbkdf2('${digest}'): only md5, sha1 and sha256 derive synchronously here (they are the digests written out in JS) — for ${digest}, use crypto.webcrypto.subtle.deriveBits with PBKDF2 and await it`,
    );
  }
  const hLen = (hmacInJs(algorithm, password, new Uint8Array(0)) as Uint8Array).byteLength;
  const out = new Uint8Array(keylen);
  const blocks = Math.ceil(keylen / hLen);
  for (let i = 1; i <= blocks; i++) {
    const input = new Uint8Array(salt.byteLength + 4);
    input.set(salt);
    new DataView(input.buffer).setUint32(salt.byteLength, i, false);
    let u = hmacInJs(algorithm, password, input) as Uint8Array;
    const acc = new Uint8Array(u);
    for (let round = 1; round < iterations; round++) {
      u = hmacInJs(algorithm, password, u) as Uint8Array;
      for (let k = 0; k < acc.length; k++) acc[k] = (acc[k] as number) ^ (u[k] as number);
    }
    out.set(acc.subarray(0, Math.min(hLen, keylen - (i - 1) * hLen)), (i - 1) * hLen);
  }
  return out;
}

// ── createHash / createHmac ───────────────────────────────────────────────────────────────────────

export type DigestEncoding = "hex" | "base64" | "buffer" | undefined;

function encodeDigest(bytes: Uint8Array, encoding: DigestEncoding): string | Uint8Array {
  if (encoding === "hex") return bytesToHex(bytes);
  if (encoding === "base64") return bytesToBase64(bytes);
  return Buffer.from(bytes);
}

/** The three digests written out in JS above, so Node's synchronous shape survives. */
function digestInJs(algorithm: string, body: Uint8Array): Uint8Array | null {
  if (algorithm === "md5") return md5(body);
  if (algorithm === "sha1") return sha1(body);
  if (algorithm === "sha256") return sha256(body);
  return null;
}

export class Hash {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  constructor(readonly algorithm: string) {
    const name = algorithm.toLowerCase().replace(/-/g, "");
    if (!SUBTLE_NAMES[name] && name !== "md5") {
      throw new NodeCompatError(
        "ERR_CRYPTO_UNSUPPORTED_DIGEST",
        `crypto.createHash('${algorithm}'): this runtime hashes with WebCrypto, which offers sha1, sha256, sha384 and sha512 (md5 is here in JS); everything else has no implementation in a browser`,
      );
    }
    this.algorithm = name;
  }

  update(data: unknown, encoding?: string): this {
    const bytes = toBytes(data, encoding);
    this.size += bytes.byteLength;
    if (this.size > HASH_BUFFER_LIMIT) {
      throw new NodeCompatError(
        "ERR_HASH_TOO_LARGE",
        `crypto.createHash: this runtime buffers what it hashes (WebCrypto's digest is one call, not a stream) and ${HASH_BUFFER_LIMIT / 1e6} MB is the limit — hash in pieces yourself, or do the work on a machine with real streams`,
      );
    }
    this.chunks.push(bytes);
    return this;
  }

  private body(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  /** The road WebCrypto can take: everything, including sha256 and sha512. */
  async digestAsync(encoding?: DigestEncoding): Promise<string | Uint8Array> {
    const body = this.body();
    const direct = digestInJs(this.algorithm, body);
    if (direct) return encodeDigest(direct, encoding);
    const digest = await subtleOrFail().digest(SUBTLE_NAMES[this.algorithm] as string, plain(body));
    return encodeDigest(new Uint8Array(digest), encoding);
  }

  /** Node's shape. md5, sha1 and sha256 answer synchronously; sha384/512 name the async road. */
  digest(encoding?: DigestEncoding): string | Uint8Array {
    const direct = digestInJs(this.algorithm, this.body());
    if (direct) return encodeDigest(direct, encoding);
    throw new NodeCompatError(
      "ERR_CRYPTO_ASYNC_ONLY",
      `hash.digest() for ${this.algorithm} is asynchronous here: WebCrypto's subtle.digest returns a promise and no polyfill can unwrap one — call hash.digestAsync() and await it (md5, sha1 and sha256 answer synchronously)`,
    );
  }
}

export class Hmac {
  private readonly chunks: Uint8Array[] = [];
  private readonly key: Uint8Array;
  constructor(
    readonly algorithm: string,
    key: unknown,
  ) {
    const name = algorithm.toLowerCase().replace(/-/g, "");
    // md5 is not one of WebCrypto's HMACs, and it is here anyway: HMAC is two hashes and two XORs
    // over a digest, and md5 is one of the digests written out in JS above.
    if (!SUBTLE_NAMES[name] && !BLOCK_BYTES[name]) {
      throw new NodeCompatError(
        "ERR_CRYPTO_UNSUPPORTED_DIGEST",
        `crypto.createHmac('${algorithm}'): the digests here are md5, sha1, sha256 (in JS) and sha384/sha512 (WebCrypto, asynchronous)`,
      );
    }
    this.algorithm = name;
    this.key = toBytes(key);
  }

  update(data: unknown, encoding?: string): this {
    this.chunks.push(toBytes(data, encoding));
    return this;
  }

  async digestAsync(encoding?: DigestEncoding): Promise<string | Uint8Array> {
    const body = this.body();
    const direct = hmacInJs(this.algorithm, this.key, body);
    if (direct) return encodeDigest(direct, encoding);
    const subtle = subtleOrFail();
    const key = await subtle.importKey(
      "raw",
      plain(this.key),
      { name: "HMAC", hash: SUBTLE_NAMES[this.algorithm] as string },
      false,
      ["sign"],
    );
    return encodeDigest(new Uint8Array(await subtle.sign("HMAC", key, plain(body))), encoding);
  }

  private body(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.byteLength;
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    return body;
  }

  /** Node's shape. md5, sha1 and sha256 answer here; sha384/512 name the async road. */
  digest(encoding?: DigestEncoding): string | Uint8Array {
    const direct = hmacInJs(this.algorithm, this.key, this.body());
    if (direct) return encodeDigest(direct, encoding);
    throw new NodeCompatError(
      "ERR_CRYPTO_ASYNC_ONLY",
      `hmac.digest() for ${this.algorithm} is asynchronous here: WebCrypto signs with a promise and no polyfill can unwrap one — call hmac.digestAsync() and await it (md5, sha1 and sha256 answer synchronously)`,
    );
  }
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  if (!webcrypto?.getRandomValues) {
    throw new NodeCompatError("ERR_NO_WEBCRYPTO", "crypto.getRandomValues is missing, so this runtime has no source of randomness it will vouch for");
  }
  // getRandomValues fills at most 65536 bytes per call, which npm's tarball paths do exceed.
  for (let at = 0; at < size; at += 65536) webcrypto.getRandomValues(out.subarray(at, Math.min(size, at + 65536)));
  return out;
}

function refuse(name: string, instead: string): () => never {
  return () => {
    throw new NodeCompatError(
      "ERR_CRYPTO_UNSUPPORTED",
      `crypto.${name}: not implemented in this runtime — ${instead}`,
    );
  };
}

export function cryptoModule(): Record<string, unknown> {
  const api = {
    webcrypto,
    subtle: webcrypto?.subtle,
    getRandomValues: (array: ArrayBufferView) => webcrypto?.getRandomValues(array as unknown as Uint8Array),
    randomBytes: (size: number, cb?: (err: Error | null, bytes: Uint8Array) => void) => {
      const bytes = Buffer.from(randomBytes(size));
      if (cb) {
        queueMicrotask(() => cb(null, bytes));
        return undefined;
      }
      return bytes;
    },
    randomFillSync: (buffer: Uint8Array) => {
      buffer.set(randomBytes(buffer.byteLength));
      return buffer;
    },
    randomInt: (a: number, b?: number): number => {
      const [min, max] = b === undefined ? [0, a] : [a, b];
      const range = max - min;
      if (range <= 0) throw new NodeCompatError("ERR_OUT_OF_RANGE", "crypto.randomInt: max must be greater than min");
      // Rejection sampling, so the low values are not favoured the way a plain modulo favours them.
      const bytes = Math.ceil(Math.log2(range) / 8) || 1;
      const ceiling = 256 ** bytes;
      const limit = ceiling - (ceiling % range);
      for (;;) {
        const draw = randomBytes(bytes).reduce((acc, byte) => acc * 256 + byte, 0);
        if (draw < limit) return min + (draw % range);
      }
    },
    randomUUID: (): string =>
      webcrypto?.randomUUID?.() ??
      // Every browser this runtime targets has randomUUID; the fallback exists for a non-secure
      // context, where `crypto.randomUUID` is absent but `getRandomValues` is not.
      (() => {
        const b = randomBytes(16);
        b[6] = ((b[6] as number) & 0x0f) | 0x40;
        b[8] = ((b[8] as number) & 0x3f) | 0x80;
        const hex = bytesToHex(b);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      })(),
    createHash: (algorithm: string) => new Hash(algorithm),
    createHmac: (algorithm: string, key: unknown) => new Hmac(algorithm, key),
    getHashes: () => ["md5", "sha1", "sha256", "sha384", "sha512"],
    timingSafeEqual: (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.byteLength !== b.byteLength) {
        throw new NodeCompatError("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length");
      }
      let diff = 0;
      for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
      return diff === 0;
    },
    constants: { RSA_PKCS1_OAEP_PADDING: 4 },
    createCipheriv: refuse("createCipheriv", "use crypto.webcrypto.subtle with AES-GCM; Node's default CBC padding is not something to half-implement"),
    createDecipheriv: refuse("createDecipheriv", "use crypto.webcrypto.subtle with AES-GCM"),
    createSign: refuse("createSign", "use crypto.webcrypto.subtle.sign"),
    createVerify: refuse("createVerify", "use crypto.webcrypto.subtle.verify"),
    generateKeyPair: refuse("generateKeyPair", "use crypto.webcrypto.subtle.generateKey"),
    generateKeyPairSync: refuse("generateKeyPairSync", "use crypto.webcrypto.subtle.generateKey and await it"),
    pbkdf2Sync: (password: unknown, salt: unknown, iterations: number, keylen: number, digest = "sha1") =>
      Buffer.from(pbkdf2InJs(toBytes(password), toBytes(salt), iterations, keylen, digest)),
    pbkdf2: (
      password: unknown,
      salt: unknown,
      iterations: number,
      keylen: number,
      digest: string | ((err: Error | null, key?: Uint8Array) => void),
      cb?: (err: Error | null, key?: Uint8Array) => void,
    ) => {
      // Node lets `digest` be omitted, in which case the fifth argument is the callback.
      const [name, done] = typeof digest === "function" ? ["sha1", digest] : [digest, cb as (err: Error | null, key?: Uint8Array) => void];
      try {
        const key = Buffer.from(pbkdf2InJs(toBytes(password), toBytes(salt), iterations, keylen, name));
        queueMicrotask(() => done(null, key));
      } catch (err) {
        queueMicrotask(() => done(err as Error));
      }
    },
    // Honest and empty: there is no cipher here, and `getCiphers()` is how a package asks.
    getCiphers: () => [],
    scryptSync: refuse("scryptSync", "scrypt has no WebCrypto equivalent; the vault uses argon2 on the host side instead"),
    createDiffieHellman: refuse("createDiffieHellman", "use crypto.webcrypto.subtle.deriveKey with ECDH"),
  };
  return { ...api, default: api };
}
