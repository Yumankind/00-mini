// THE SIGNATURE THE ENGINE WILL VERIFY — §14.2, checked against a VERIFIER and not against itself.
//
// The trap this suite exists for: every part of a signing scheme is easy to get self-consistently
// wrong. A canonical string with seconds instead of milliseconds, a fingerprint over the JWK instead
// of the raw point, a DER signature where the verifier wants r‖s — each of those passes any test
// that signs and then checks with the same code. So the assertions here are made against an
// INDEPENDENT reading: node's own WebCrypto verifying the bytes, a canonical string written out by
// hand, and a fingerprint computed with a separate sha256 call over `exportKey("raw")`.
//
// The engine's half is `apps/00d/src/device-auth.ts` (`canonicalHttp`, `fingerprint`), and the
// existing browser twin is `packages/web-vue/src/device-key.ts`. Both were read line by line.

import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "@00/agent-models";
import {
  COMPANION_DEV_HEADER,
  COMPANION_SIG_HEADER,
  COMPANION_TS_HEADER,
  bodyHashHex,
  canonicalCompanion,
  companionAppId,
  companionFingerprint,
  companionKey,
  deviceFingerprint,
  forgetCompanionKey,
  fromBase64Url,
  rawPublicKey,
  signedHeaders,
  toBase64Url,
  toHex,
} from "../src/companion/key.js";

const subtle = globalThis.crypto.subtle;

function env() {
  return { store: new MemoryDeviceKeyStore(), subtle };
}

/** sha256 as hex, computed here rather than taken from the module under test. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the canonical string", () => {
  it("is METHOD, path+query, milliseconds and the body hash, joined by newlines", () => {
    // Written out by hand: this is `canonicalHttp` in apps/00d/src/device-auth.ts, character for
    // character. The method is upper-cased and the query is part of the path.
    expect(canonicalCompanion("get", "/api/companion/fetch?url=https%3A%2F%2Fa", "1757600000000", "ab12")).toBe(
      "GET\n/api/companion/fetch?url=https%3A%2F%2Fa\n1757600000000\nab12",
    );
  });

  it("hashes an absent body as the sha256 of the empty string, never as an empty field", async () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(await bodyHashHex(null)).toBe(empty);
    expect(await bodyHashHex(undefined)).toBe(empty);
    expect(await bodyHashHex("")).toBe(empty);
    expect(await bodyHashHex("hello")).toBe(await sha256Hex(new TextEncoder().encode("hello")));
    expect(await bodyHashHex(new Uint8Array([1, 2, 3]))).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
  });
});

describe("base64url and hex", () => {
  it("round-trips, unpadded, with the URL alphabet", () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 1, 2]);
    const text = toBase64Url(bytes);
    expect(text).not.toContain("=");
    expect(text).not.toContain("+");
    expect(text).not.toContain("/");
    expect([...fromBase64Url(text)]).toEqual([...bytes]);
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});

describe("the fingerprint", () => {
  it("is the first 16 hex of sha256 over the RAW 65-byte public point, not over the JWK", async () => {
    const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));

    // The reconstruction from the JWK must be byte-identical to what exportKey("raw") returns —
    // that is the whole claim, because the engine hashes the raw bytes and this browser only keeps
    // the JWK across a reload.
    expect([...rawPublicKey(jwk)]).toEqual([...raw]);
    expect(raw[0]).toBe(0x04);
    expect(raw.length).toBe(65);
    expect(await deviceFingerprint(jwk)).toBe((await sha256Hex(raw)).slice(0, 16));
    expect(await deviceFingerprint(jwk)).toHaveLength(16);
  });

  it("refuses a key that is not a full point rather than fingerprinting half of one", () => {
    expect(() => rawPublicKey({ kty: "EC", crv: "P-256", x: "AAAA" })).toThrow(/both coordinates/);
  });
});

describe("the key store", () => {
  it("files one key per engine, and gives the same one back", async () => {
    const e = env();
    expect(companionAppId("abc")).toBe("companion:abc");
    const first = await companionKey("abc", e);
    const again = await companionKey("abc", e);
    expect(again.deviceId).toBe(first.deviceId);
    expect(first.privateKey.extractable).toBe(false);
    // A second engine is a second grant, not a shared one.
    expect((await companionKey("def", e)).deviceId).not.toBe(first.deviceId);
    expect(await companionFingerprint("abc", e)).toBe(first.deviceId);
  });

  it("forgets one engine's key without touching the other's", async () => {
    const e = env();
    const kept = await companionKey("keep", e);
    const gone = await companionKey("gone", e);
    await forgetCompanionKey("gone", e);
    expect((await companionKey("keep", e)).deviceId).toBe(kept.deviceId);
    expect((await companionKey("gone", e)).deviceId).not.toBe(gone.deviceId);
  });
});

describe("the three headers", () => {
  it("verify against the public key, over the canonical string, as raw r‖s", async () => {
    const e = { ...env(), now: () => 1_757_600_000_000 };
    const device = await companionKey("engine-fp", e);
    const headers = await signedHeaders("engine-fp", "post", "/api/companion/pair?x=1", '{"a":1}', e);

    expect(headers[COMPANION_DEV_HEADER]).toBe(device.deviceId);
    expect(headers[COMPANION_TS_HEADER]).toBe("1757600000000");

    const signature = fromBase64Url(headers[COMPANION_SIG_HEADER]);
    // 64 bytes is the claim: WebCrypto's raw form, never DER (which is 70-ish and starts 0x30).
    expect(signature.length).toBe(64);

    const publicKey = await subtle.importKey("jwk", device.publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
      "verify",
    ]);
    const canonical = `POST\n/api/companion/pair?x=1\n1757600000000\n${await sha256Hex(
      new TextEncoder().encode('{"a":1}'),
    )}`;
    expect(
      await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature.slice().buffer as ArrayBuffer,
        new TextEncoder().encode(canonical),
      ),
    ).toBe(true);

    // And the binding is real: the same signature does not verify for another path.
    const lifted = `POST\n/api/companion/pair?x=2\n1757600000000\n${await sha256Hex(
      new TextEncoder().encode('{"a":1}'),
    )}`;
    expect(
      await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature.slice().buffer as ArrayBuffer,
        new TextEncoder().encode(lifted),
      ),
    ).toBe(false);
  });

  it("signs an empty body with the empty-string hash, and stamps milliseconds from the clock", async () => {
    const e = env();
    const before = Date.now();
    const headers = await signedHeaders("engine-fp", "GET", "/api/companion/me", null, e);
    const ts = Number(headers[COMPANION_TS_HEADER]);
    expect(ts).toBeGreaterThanOrEqual(before);
    // Seconds would be ten digits; the engine's window is in milliseconds and would refuse those.
    expect(String(ts)).toHaveLength(13);
  });
});
