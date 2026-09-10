/**
 * The canonical string is a CONTRACT WITH THE WORKER (`worker/src/sponsored/app-devices.ts`), so
 * these tests do what that repo's own do: sign with a real keypair and verify with real WebCrypto.
 * A hand-rolled fake could never tell us whether what a browser produces verifies against what the
 * verifier stores — which is the only question worth asking here.
 */
import { describe, expect, it } from "vitest";
import {
  bodyHashHex,
  canonicalRequest,
  DEVICE_SIGN_PARAMS,
  generateDeviceKeypair,
  HEADER_APP,
  HEADER_DEVICE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  IndexedDbDeviceKeyStore,
  MemoryDeviceKeyStore,
  requestPath,
  signedHeaders,
  toBase64,
  toHex,
} from "../src/device-key.js";

/** sha256 of the empty string — what a request with no body carries, never an empty field. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function base64ToBytes(raw: string): Uint8Array {
  const normalised = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("the canonical string", () => {
  it("upper-cases the method and puts one field per line", () => {
    expect(canonicalRequest("post", "/api/v1/chat/completions", 1757340000, EMPTY_SHA256)).toBe(
      `POST\n/api/v1/chat/completions\n1757340000\n${EMPTY_SHA256}`,
    );
  });

  it("signs the pathname AND the query, so a signature cannot be lifted onto another tier", () => {
    expect(requestPath("https://sponsoredtokens.com/api/v1/models?tier=0")).toBe("/api/v1/models?tier=0");
    expect(requestPath("/api/v1/models?tier=3")).toBe("/api/v1/models?tier=3");
    expect(requestPath("https://sponsoredtokens.com/api/v1/models")).toBe("/api/v1/models");
  });

  it("hashes a missing body as the sha256 of the empty string, in lowercase hex", async () => {
    await expect(bodyHashHex(null)).resolves.toBe(EMPTY_SHA256);
    await expect(bodyHashHex(undefined)).resolves.toBe(EMPTY_SHA256);
    await expect(bodyHashHex("")).resolves.toBe(EMPTY_SHA256);
    await expect(bodyHashHex('{"a":1}')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a Uint8Array body the same as its string", async () => {
    const text = '{"model":"x"}';
    expect(await bodyHashHex(new TextEncoder().encode(text))).toBe(await bodyHashHex(text));
  });
});

describe("encoders", () => {
  it("base64s bytes, chunked, without blowing the argument limit", () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    const big = new Uint8Array(0x10001).fill(65);
    expect(base64ToBytes(toBase64(big))).toHaveLength(big.length);
  });

  it("hexes bytes in lowercase, zero-padded", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});

describe("signedHeaders", () => {
  it("produces a signature the verifier's own algorithm accepts", async () => {
    const pair = await generateDeviceKeypair();
    const url = "https://sponsoredtokens.com/api/v1/chat/completions";
    const body = JSON.stringify({ model: "sponsored/x", messages: [] });
    const headers = await signedHeaders({
      appId: "app_7f3k",
      deviceId: "dev_9q2m",
      privateKey: pair.privateKey,
      method: "post",
      url,
      body,
      timestamp: 1757340000,
    });

    expect(headers[HEADER_APP]).toBe("app_7f3k");
    expect(headers[HEADER_DEVICE]).toBe("dev_9q2m");
    expect(headers[HEADER_TIMESTAMP]).toBe("1757340000");

    // Base64 of the RAW 64-byte r‖s form, never DER — the worker refuses anything else by length.
    const signature = base64ToBytes(headers[HEADER_SIGNATURE] ?? "");
    expect(signature).toHaveLength(64);

    // Verify exactly the way `verifyDeviceRequest` does: re-derive the canonical string from the
    // parts, import the exported public JWK, and check.
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const verifyKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const canonical = canonicalRequest("POST", "/api/v1/chat/completions", "1757340000", await bodyHashHex(body));
    await expect(
      crypto.subtle.verify(DEVICE_SIGN_PARAMS, verifyKey, signature as unknown as ArrayBuffer, new TextEncoder().encode(canonical) as unknown as ArrayBuffer),
    ).resolves.toBe(true);
  });

  it("does not verify against a different query string", async () => {
    const pair = await generateDeviceKeypair();
    const headers = await signedHeaders({
      appId: "a",
      deviceId: "d",
      privateKey: pair.privateKey,
      method: "GET",
      url: "https://sponsoredtokens.com/api/v1/models?tier=0",
      timestamp: 1757340000,
    });
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const verifyKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const lifted = canonicalRequest("GET", "/api/v1/models?tier=3", "1757340000", EMPTY_SHA256);
    await expect(
      crypto.subtle.verify(
        DEVICE_SIGN_PARAMS,
        verifyKey,
        base64ToBytes(headers[HEADER_SIGNATURE] ?? "") as unknown as ArrayBuffer,
        new TextEncoder().encode(lifted) as unknown as ArrayBuffer,
      ),
    ).resolves.toBe(false);
  });

  it("uses the clock when no timestamp is injected", async () => {
    const pair = await generateDeviceKeypair();
    const headers = await signedHeaders({ appId: "a", deviceId: "d", privateKey: pair.privateKey, method: "GET", url: "/x" });
    const seconds = Number(headers[HEADER_TIMESTAMP]);
    expect(Math.abs(seconds - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });
});

describe("generateDeviceKeypair", () => {
  it("makes a private half that cannot be read back — the whole security claim", async () => {
    const pair = await generateDeviceKeypair();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toBeTruthy();
    // The public half is exportable by construction: it is what gets registered.
    await expect(crypto.subtle.exportKey("jwk", pair.publicKey)).resolves.toMatchObject({ kty: "EC", crv: "P-256" });
  });
});

describe("MemoryDeviceKeyStore", () => {
  it("holds one record per app and forgets on demand", async () => {
    const store = new MemoryDeviceKeyStore();
    const pair = await generateDeviceKeypair();
    const record = { appId: "app_1", deviceId: "dev_1", privateKey: pair.privateKey, publicKeyJwk: {}, createdAt: "now" };
    await expect(store.get("app_1")).resolves.toBeNull();
    await store.put(record);
    await expect(store.get("app_1")).resolves.toBe(record);
    await expect(store.get("app_2")).resolves.toBeNull();
    await store.delete("app_1");
    await expect(store.get("app_1")).resolves.toBeNull();
  });
});

describe("IndexedDbDeviceKeyStore", () => {
  it("reads as 'no device' rather than throwing when there is no IndexedDB at all", async () => {
    const store = new IndexedDbDeviceKeyStore();
    await expect(store.get("app_1")).resolves.toBeNull();
    // A delete against a store that cannot open is the state the caller asked for, not an error.
    await expect(store.delete("app_1")).resolves.toBeUndefined();
  });

  it("refuses a write it cannot make, by name", async () => {
    const store = new IndexedDbDeviceKeyStore();
    const pair = await generateDeviceKeypair();
    await expect(
      store.put({ appId: "app_1", deviceId: "dev_1", privateKey: pair.privateKey, publicKeyJwk: {}, createdAt: "now" }),
    ).rejects.toThrow(/IndexedDB/);
  });
});
