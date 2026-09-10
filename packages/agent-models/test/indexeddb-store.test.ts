/**
 * The browser device-key store, driven against a hand-rolled IndexedDB.
 *
 * A fake rather than a shim library, for the reason this package may not add a dependency and for a
 * better one: what is being tested is the four calls this store actually makes — open, upgrade,
 * objectStore, and one request per operation — and a fake that implements exactly those fails loudly
 * the day the store starts making a fifth.
 */
import { describe, expect, it } from "vitest";
import { generateDeviceKeypair, IndexedDbDeviceKeyStore } from "../src/device-key.js";
import type { IndexedDbFactoryLike, StoredDevice } from "../src/device-key.js";

interface FakeRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

/** Fires a request's handler on the next microtask, the way a real one resolves after assignment. */
function settle<T>(request: FakeRequest<T>, run: () => T, fail?: unknown): void {
  queueMicrotask(() => {
    if (fail !== undefined) {
      request.error = fail;
      request.onerror?.();
      return;
    }
    request.result = run();
    request.onsuccess?.();
  });
}

function fakeIndexedDb(options: { failWrites?: boolean } = {}): IndexedDbFactoryLike & { data: Map<string, unknown>; stores: Set<string> } {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  const factory = {
    data,
    stores,
    open(_name: string, _version?: number) {
      const request: FakeRequest<unknown> = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      const db = {
        objectStoreNames: { contains: (name: string) => stores.has(name) },
        createObjectStore: (name: string) => {
          stores.add(name);
          return {};
        },
        transaction: (name: string) => ({
          objectStore: () => ({
            get: (key: string) => {
              const r: FakeRequest<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
              settle(r, () => data.get(`${name}:${key}`));
              return r;
            },
            put: (value: StoredDevice) => {
              const r: FakeRequest<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
              settle(r, () => data.set(`${name}:${value.appId}`, value), options.failWrites ? new Error("QuotaExceeded") : undefined);
              return r;
            },
            delete: (key: string) => {
              const r: FakeRequest<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
              settle(r, () => data.delete(`${name}:${key}`));
              return r;
            },
          }),
        }),
      };
      request.result = db;
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request as unknown as IDBOpenDBRequest;
    },
  };
  return factory as unknown as IndexedDbFactoryLike & { data: Map<string, unknown>; stores: Set<string> };
}

async function device(appId: string): Promise<StoredDevice> {
  const pair = await generateDeviceKeypair();
  return {
    appId,
    deviceId: "dev_1",
    privateKey: pair.privateKey,
    publicKeyJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

describe("IndexedDbDeviceKeyStore against a fake IndexedDB", () => {
  it("creates its object store on upgrade and round-trips a record", async () => {
    const idb = fakeIndexedDb();
    const store = new IndexedDbDeviceKeyStore({ indexedDB: idb });
    const record = await device("app_7f3k");

    await expect(store.get("app_7f3k")).resolves.toBeNull();
    await store.put(record);
    expect(idb.stores.has("devices")).toBe(true);

    const back = await store.get("app_7f3k");
    // The private key comes back as a CryptoKey, still non-extractable — the reason this store is
    // IndexedDB and not localStorage: a `CryptoKey` cannot be serialised, only cloned.
    expect(back?.privateKey).toBe(record.privateKey);
    expect(back?.privateKey.extractable).toBe(false);
    expect(back?.deviceId).toBe("dev_1");

    await store.delete("app_7f3k");
    await expect(store.get("app_7f3k")).resolves.toBeNull();
  });

  it("keeps one record per app", async () => {
    const store = new IndexedDbDeviceKeyStore({ indexedDB: fakeIndexedDb() });
    await store.put(await device("app_a"));
    await store.put(await device("app_b"));
    await expect(store.get("app_a")).resolves.toMatchObject({ appId: "app_a" });
    await expect(store.get("app_b")).resolves.toMatchObject({ appId: "app_b" });
  });

  it("reports a refused write, and reads it back as no device rather than an exception", async () => {
    const idb = fakeIndexedDb({ failWrites: true });
    const store = new IndexedDbDeviceKeyStore({ indexedDB: idb, dbName: "custom", storeName: "keys" });
    await expect(store.put(await device("app_a"))).rejects.toThrow(/QuotaExceeded/);
    await expect(store.get("app_a")).resolves.toBeNull();
    expect(idb.stores.has("keys")).toBe(true);
  });
});
