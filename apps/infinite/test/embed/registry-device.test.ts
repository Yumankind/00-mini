/**
 * The visitor's device key, and the five lines it signs (§6.2, §5.6).
 *
 * WHY THE VECTORS COME FROM THE WORKER ITSELF. A canonical string is a contract between two
 * programs in two repositories, and the only way to be sure they agree is to ask BOTH. So the
 * expected strings here are produced by moltworker's own `worker/src/infinite/signed-request.ts`,
 * imported by path from the sibling checkout — the day either side edits a line, or adds a sixth,
 * this file fails and says which. When the sibling is not checked out the vectors are skipped and
 * everything else still runs, because a machine without moltworker is a normal machine.
 *
 * The signature itself is checked the way the worker checks it: decode the base64url, insist on 64
 * bytes (raw `r‖s`, never DER), import the public JWK we would have registered, and verify over the
 * canonical string. If that passes here it passes there.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_HEADER,
  DEVICE_HEADER,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalString,
  devicePublicJwk,
  ensureDeviceKey,
  newNonce,
  sha256Hex,
  signedHeaders,
  signedPath,
} from "../../embed/src/registry/device.js";
import { MemoryStore, type Store } from "../../embed/src/index/store.js";

const WORKER_SIGNED_REQUEST =
  "/Users/brunosilva/Documents/GitHub/moltworker/worker/src/infinite/signed-request.ts";
const hasSibling = existsSync(WORKER_SIGNED_REQUEST);

interface WorkerSignedRequest {
  canonicalForRequest(method: string, url: string, timestamp: string, body: string, nonce: string): Promise<string>;
}

/** A `Store` that keeps references, which is what IndexedDB's structured clone does for a CryptoKey. */
function cloneStore(): Store & { size(): number } {
  const map = new Map<string, unknown>();
  return {
    size: () => map.size,
    async get<T>(key: string) {
      return (map.get(key) ?? null) as T | null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async del(key) {
      map.delete(key);
    },
    async keys(prefix = "") {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

const fromBase64Url = (raw: string): Uint8Array => {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64"));
};

describe("the canonical string, against the worker's own", () => {
  const cases: { method: string; url: string; body: string; nonce: string }[] = [
    { method: "POST", url: "https://api.test/infinite/apps/iaa_x/inbox", body: '{"kind":"lead","text":"call me"}', nonce: "nonce-one-1234" },
    // A bodyless GET carries the hash of the EMPTY STRING, never an empty field.
    { method: "GET", url: "https://api.test/infinite/apps/iaa_x/devices/me/messages", body: "", nonce: "abcd1234" },
    // The query is part of the PATH: a signature for `?since=0` must not be liftable onto another.
    { method: "GET", url: "https://api.test/infinite/apps/iaa_x/devices/me/messages?since=2026-09-10T00%3A00%3A00Z", body: "", nonce: "abcd12345678" },
    // A unicode body, so the hash is over UTF-8 bytes on both sides and not code units.
    { method: "POST", url: "https://api.test/infinite/apps/iaa_x/inbox", body: '{"text":"héllo — 😀"}', nonce: "unicode-nonce-1" },
  ];

  it.runIf(hasSibling)("agrees with worker/src/infinite/signed-request.ts on every vector", async () => {
    const worker = (await import(/* @vite-ignore */ WORKER_SIGNED_REQUEST)) as WorkerSignedRequest;
    for (const c of cases) {
      const timestamp = "1757500000";
      const theirs = await worker.canonicalForRequest(c.method, c.url, timestamp, c.body, c.nonce);
      const ours = canonicalString(c.method, signedPath(c.url), timestamp, await sha256Hex(c.body), c.nonce);
      expect(ours, `${c.method} ${c.url}`).toBe(theirs);
      expect(ours.split("\n")).toHaveLength(5);
    }
  });

  it.skipIf(hasSibling)("skips the vectors when the moltworker checkout is absent", () => {
    expect(hasSibling).toBe(false);
  });

  it("hashes the empty body to sha256(\"\") and never to an empty field", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const line = canonicalString("get", "/x", "1", await sha256Hex(""), "n".repeat(8)).split("\n");
    expect(line[0]).toBe("GET");
    expect(line[3]).toHaveLength(64);
  });

  it("signs the query, not only the path", () => {
    expect(signedPath("https://api.test/a/b?since=7#frag")).toBe("/a/b?since=7");
    expect(signedPath("https://api.test/a/b")).toBe("/a/b");
  });

  it("mints a nonce inside the worker's 8–64 character band, and a different one each time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("the keypair", () => {
  it("mints one non-extractable pair and keeps it", async () => {
    const store = cloneStore();
    const first = await ensureDeviceKey(store, "https://shop.example", "ia_test");
    const again = await ensureDeviceKey(store, "https://shop.example", "ia_test");
    expect(again).toBe(first);
    expect(first.privateKey.extractable).toBe(false);
    expect(store.size()).toBe(1);
    // Two sites, two identities: a device is a customer, never a person (§6.2).
    await ensureDeviceKey(store, "https://other.example", "ia_test");
    expect(store.size()).toBe(2);
  });

  it("starts over rather than throwing when the store cannot hold a CryptoKey", async () => {
    // The MemoryStore round-trips through JSON, which is exactly what a store that cannot carry a
    // key looks like. A fresh pair costs one row against a cap of five a day; an exception would
    // cost a stranger's website a red console.
    const store = new MemoryStore();
    const first = await ensureDeviceKey(store, "https://shop.example", "ia_test");
    const second = await ensureDeviceKey(store, "https://shop.example", "ia_test");
    expect(second).not.toBe(first);
  });

  it("exports the four fields that ARE the key, and nothing else", async () => {
    const pair = await ensureDeviceKey(cloneStore(), "https://shop.example", "ia_test");
    const jwk = await devicePublicJwk(pair);
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    // 32 bytes of base64url is 43 characters — the worker refuses any other length by name.
    expect(jwk.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwk.y).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("one signed request", () => {
  it("carries the five headers and a 64-byte raw signature that verifies", async () => {
    const pair = await ensureDeviceKey(cloneStore(), "https://shop.example", "ia_test");
    const url = "https://api.test/infinite/apps/iaa_x/inbox";
    const body = '{"kind":"message","text":"hello"}';
    const headers = await signedHeaders({
      pair,
      appId: "iaa_x",
      deviceId: "iad_y",
      method: "POST",
      url,
      body,
      nowMs: 1_757_500_000_000,
      nonce: "a-fixed-nonce",
    });

    expect(headers[APP_HEADER]).toBe("iaa_x");
    expect(headers[DEVICE_HEADER]).toBe("iad_y");
    expect(headers[TIMESTAMP_HEADER]).toBe("1757500000");
    expect(headers[NONCE_HEADER]).toBe("a-fixed-nonce");

    const signature = fromBase64Url(headers[SIGNATURE_HEADER]!);
    expect(signature.byteLength, "raw r‖s, never DER").toBe(64);

    // Verified exactly as the worker verifies it: the stored JWK, imported for ECDSA/SHA-256.
    const jwk = await devicePublicJwk(pair);
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const message = canonicalString("POST", "/infinite/apps/iaa_x/inbox", "1757500000", await sha256Hex(body), "a-fixed-nonce");
    const verify = (msg: string): Promise<boolean> =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature as unknown as BufferSource,
        new TextEncoder().encode(msg) as unknown as BufferSource,
      );
    expect(await verify(message)).toBe(true);

    // And a body that was not the one signed does not verify — the point of the fourth line.
    const tampered = canonicalString("POST", "/infinite/apps/iaa_x/inbox", "1757500000", await sha256Hex('{"text":"other"}'), "a-fixed-nonce");
    expect(await verify(tampered)).toBe(false);
  });

  it("puts unix SECONDS on the wire, not milliseconds", async () => {
    const pair = await ensureDeviceKey(cloneStore(), "https://shop.example", "ia_test");
    const headers = await signedHeaders({
      pair,
      appId: "iaa_x",
      deviceId: "iad_y",
      method: "GET",
      url: "https://api.test/infinite/apps/iaa_x/devices/me/messages",
      body: "",
      nowMs: 1_757_500_123_456,
    });
    expect(headers[TIMESTAMP_HEADER]).toBe("1757500123");
  });
});
