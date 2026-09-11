import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Hash, Hmac, cryptoModule, md5, sha1, randomBytes, bytesToHex, hexToBytes, bytesToBase64, base64ToBytes, HASH_BUFFER_LIMIT } from "../src/modules/crypto.js";
import { compress, decompress, sniffFormat, zlibModule } from "../src/modules/zlib.js";

const api = cryptoModule() as Record<string, (...args: never[]) => unknown>;

describe("crypto digests", () => {
  it("md5 and sha1 match Node's, including the multi-block and empty cases", () => {
    const cases = ["", "a", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "the quick brown fox".repeat(40)];
    for (const input of cases) {
      const bytes = new TextEncoder().encode(input);
      expect(bytesToHex(md5(bytes)), `md5 ${input.length}`).toBe(createHash("md5").update(input).digest("hex"));
      expect(bytesToHex(sha1(bytes)), `sha1 ${input.length}`).toBe(createHash("sha1").update(input).digest("hex"));
    }
  });

  it("createHash answers synchronously for md5/sha1 and asynchronously for the WebCrypto ones", async () => {
    const hash = new Hash("md5");
    expect(hash.update("a").update("bc").digest("hex")).toBe(createHash("md5").update("abc").digest("hex"));
    expect(new Hash("sha1").update("abc").digest("base64")).toBe(createHash("sha1").update("abc").digest("base64"));
    expect(await new Hash("md5").update("abc").digestAsync("hex")).toBe(createHash("md5").update("abc").digest("hex"));
    expect(await new Hash("sha1").update("abc").digestAsync("hex")).toBe(createHash("sha1").update("abc").digest("hex"));

    for (const algorithm of ["sha256", "sha384", "sha512"]) {
      const ours = new Hash(algorithm).update("abc");
      expect(await ours.digestAsync("hex")).toBe(createHash(algorithm).update("abc").digest("hex"));
      expect(() => new Hash(algorithm).update("abc").digest("hex")).toThrow(/asynchronous here/);
    }
    // No encoding means a Buffer, exactly as Node's does.
    expect(await new Hash("sha256").update("abc").digestAsync()).toBeInstanceOf(Uint8Array);
    expect(new Hash("SHA-1").algorithm).toBe("sha1");
    expect(() => new Hash("whirlpool")).toThrow(/WebCrypto/);
  });

  it("update accepts strings, hex, base64, buffers and views", async () => {
    const expected = createHash("sha256").update("abc").digest("hex");
    expect(await new Hash("sha256").update("616263", "hex").digestAsync("hex")).toBe(expected);
    expect(await new Hash("sha256").update("YWJj", "base64").digestAsync("hex")).toBe(expected);
    expect(await new Hash("sha256").update(new TextEncoder().encode("abc")).digestAsync("hex")).toBe(expected);
    expect(await new Hash("sha256").update(new TextEncoder().encode("abc").buffer).digestAsync("hex")).toBe(expected);
    // An Int8Array is a view but not a Uint8Array — the branch that reaches for byteOffset/byteLength.
    expect(await new Hash("sha256").update(new Int8Array(new TextEncoder().encode("abc").buffer)).digestAsync("hex")).toBe(expected);
    expect(await new Hash("sha256").update(123).digestAsync("hex")).toBe(createHash("sha256").update("123").digest("hex"));
  });

  it("refuses to buffer more than it says it will", () => {
    const hash = new Hash("sha256");
    const chunk = new Uint8Array(1024 * 1024);
    expect(() => {
      for (let i = 0; i <= HASH_BUFFER_LIMIT / chunk.byteLength; i++) hash.update(chunk);
    }).toThrow(/buffers what it hashes/);
  });

  it("createHmac matches Node's for every digest WebCrypto has", async () => {
    for (const algorithm of ["sha1", "sha256", "sha384", "sha512"]) {
      const ours = new Hmac(algorithm, "key").update("a").update("bc");
      expect(await ours.digestAsync("hex"), algorithm).toBe(createHmac(algorithm, "key").update("abc").digest("hex"));
    }
    expect(await new Hmac("sha256", new TextEncoder().encode("key")).update("abc").digestAsync("base64")).toBe(
      createHmac("sha256", "key").update("abc").digest("base64"),
    );
    expect(await new Hmac("sha256", "key").update("abc").digestAsync()).toBeInstanceOf(Uint8Array);
    expect(() => new Hmac("sha256", "key").digest()).toThrow(/asynchronous here/);
    expect(() => new Hmac("md5", "key")).toThrow(/HMAC covers/);
  });
});

describe("crypto randomness and helpers", () => {
  it("randomBytes fills past the 65536-byte getRandomValues limit", () => {
    const bytes = randomBytes(70000);
    expect(bytes.byteLength).toBe(70000);
    expect(bytes.subarray(65536).some((b) => b !== 0)).toBe(true);
    expect(randomBytes(0).byteLength).toBe(0);
  });

  it("the module's randomBytes has both the sync and the callback shape", async () => {
    expect((api.randomBytes as (n: number) => Uint8Array)(8).byteLength).toBe(8);
    const seen = await new Promise<Uint8Array>((resolve) => {
      (api.randomBytes as unknown as (n: number, cb: (e: unknown, b: Uint8Array) => void) => void)(4, (_e, b) => resolve(b));
    });
    expect(seen.byteLength).toBe(4);
    const target = new Uint8Array(4);
    expect((api.randomFillSync as (b: Uint8Array) => Uint8Array)(target)).toBe(target);
    (api.getRandomValues as (b: Uint8Array) => unknown)(new Uint8Array(2));
  });

  it("randomInt stays inside its range and refuses an empty one", () => {
    for (let i = 0; i < 200; i++) {
      const value = (api.randomInt as (a: number, b?: number) => number)(5, 9);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(9);
    }
    const single = (api.randomInt as (a: number) => number)(1000);
    expect(single).toBeGreaterThanOrEqual(0);
    expect(single).toBeLessThan(1000);
    expect(() => (api.randomInt as (a: number, b: number) => number)(5, 5)).toThrow(/greater than min/);
  });

  it("randomUUID is a v4 UUID", () => {
    const uuid = (api.randomUUID as () => string)();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("timingSafeEqual compares without a length shortcut and refuses mismatched lengths", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect((api.timingSafeEqual as (x: Uint8Array, y: Uint8Array) => boolean)(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect((api.timingSafeEqual as (x: Uint8Array, y: Uint8Array) => boolean)(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(() => (api.timingSafeEqual as (x: Uint8Array, y: Uint8Array) => boolean)(a, new Uint8Array(2))).toThrow(/same byte length/);
  });

  it("hex and base64 round-trip", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(hexToBytes("de:ad:be:ef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(base64ToBytes(bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_"))).toEqual(bytes);
  });

  it("the ciphers and key generators refuse by name and point at WebCrypto", () => {
    for (const name of ["createCipheriv", "createDecipheriv", "createSign", "createVerify", "generateKeyPair", "generateKeyPairSync", "pbkdf2Sync", "scryptSync", "createDiffieHellman"]) {
      expect(() => (api[name] as () => unknown)(), name).toThrow(/not implemented in this runtime/);
    }
    expect((api.getHashes as () => string[])()).toContain("sha512");
    expect((api as unknown as { webcrypto: unknown }).webcrypto).toBeDefined();
    expect((api.createHash as (a: string) => Hash)("sha256")).toBeInstanceOf(Hash);
    expect((api.createHmac as (a: string, k: string) => Hmac)("sha256", "k")).toBeInstanceOf(Hmac);
  });
});

describe("zlib", () => {
  const body = new TextEncoder().encode("the same sentence, ".repeat(500));

  it("round-trips every format the platform's streams offer", async () => {
    for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
      const packed = await compress(format, body);
      expect(packed.byteLength, format).toBeLessThan(body.byteLength);
      expect(await decompress(format, packed), format).toEqual(body);
    }
  });

  it("sniffs gzip from zlib from raw", async () => {
    expect(sniffFormat(await compress("gzip", body))).toBe("gzip");
    expect(sniffFormat(await compress("deflate", body))).toBe("deflate");
    expect(sniffFormat(new Uint8Array([1, 2, 3]))).toBe("deflate-raw");
  });

  it("the module's callback forms answer, and unzip sniffs for itself", async () => {
    const zlib = zlibModule() as Record<string, (...args: never[]) => unknown>;
    const roundTrip = async (name: string, back: string): Promise<Uint8Array> => {
      const packed = await new Promise<Uint8Array>((resolve, reject) => {
        (zlib[name] as unknown as (d: Uint8Array, cb: (e: Error | null, r?: Uint8Array) => void) => void)(body, (e, r) =>
          e ? reject(e) : resolve(r as Uint8Array),
        );
      });
      return await new Promise<Uint8Array>((resolve, reject) => {
        (zlib[back] as unknown as (d: Uint8Array, o: unknown, cb: (e: Error | null, r?: Uint8Array) => void) => void)(packed, {}, (e, r) =>
          e ? reject(e) : resolve(r as Uint8Array),
        );
      });
    };
    expect(await roundTrip("gzip", "gunzip")).toEqual(body);
    expect(await roundTrip("deflate", "inflate")).toEqual(body);
    expect(await roundTrip("deflateRaw", "inflateRaw")).toEqual(body);
    expect(await roundTrip("gzip", "unzip")).toEqual(body);
    // A string is accepted the way Node accepts one.
    const fromString = await new Promise<Uint8Array>((resolve) => {
      (zlib.gzip as unknown as (d: string, cb: (e: Error | null, r?: Uint8Array) => void) => void)("hello", (_e, r) => resolve(r as Uint8Array));
    });
    expect(sniffFormat(fromString)).toBe("gzip");
    // A failure reaches the callback rather than becoming an unhandled rejection.
    const failure = await new Promise<Error | null>((resolve) => {
      (zlib.gunzip as unknown as (d: Uint8Array, cb: (e: Error | null) => void) => void)(new Uint8Array([1, 2, 3]), (e) => resolve(e));
    });
    expect(failure).toBeInstanceOf(Error);
  });

  it("the promise forms and the stream constructors are there", async () => {
    const zlib = zlibModule() as Record<string, unknown> & { promises: Record<string, (d: Uint8Array) => Promise<Uint8Array>> };
    expect(await zlib.promises.gunzip(await zlib.promises.gzip(body))).toEqual(body);
    expect(await zlib.promises.inflate(await zlib.promises.deflate(body))).toEqual(body);
    expect((zlib.createGzip as () => unknown)()).toBeInstanceOf(CompressionStream);
    expect((zlib.createGunzip as () => unknown)()).toBeInstanceOf(DecompressionStream);
    expect((zlib.createDeflate as () => unknown)()).toBeInstanceOf(CompressionStream);
    expect((zlib.createInflate as () => unknown)()).toBeInstanceOf(DecompressionStream);
    expect((zlib.constants as { Z_FINISH: number }).Z_FINISH).toBe(4);
  });

  it("the sync forms refuse by name, and stop refusing when a host supplies a compressor", () => {
    const zlib = zlibModule() as Record<string, (d: Uint8Array) => Uint8Array>;
    for (const name of ["gzipSync", "gunzipSync", "deflateSync", "inflateSync", "deflateRawSync", "inflateRawSync", "unzipSync"]) {
      expect(() => zlib[name]!(body), name).toThrow(/CompressionStream is a stream/);
    }
    const marker = new Uint8Array([9]);
    const withSync = zlibModule({ compress: () => marker, decompress: () => body }) as Record<string, (d: Uint8Array) => Uint8Array>;
    expect(withSync.gzipSync!(body)).toBe(marker);
    expect(withSync.gunzipSync!(marker)).toBe(body);
  });

  it("brotli says why it is not here", () => {
    const zlib = zlibModule() as Record<string, () => unknown>;
    expect(() => zlib.brotliCompress!()).toThrow(/no browser exposes a Brotli compressor/);
    expect(() => zlib.brotliDecompress!()).toThrow(/not exposed to script/);
  });
});
