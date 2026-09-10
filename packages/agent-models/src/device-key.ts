/**
 * A DEVICE KEY THAT NEVER LEAVES THE DEVICE — the sponsoredtokens frontend-caller credential
 * (moltworker `docs/sponsoredtokens/HANDOFF-developer-apps.md` §24, built 2026-09-08).
 *
 * The browser holds no platform key: that is the same invariant containers run under, and §6.2 of
 * the Infinite Agent plan restates it for the embed. An app key in a browser bundle is an app key in
 * a repository, in a CDN cache and in every visitor's devtools, and `X-Sponsoredtokens-End-User`
 * saves nothing because a header a browser sets is a header a browser can lie about. So the page
 * generates an ECDSA P-256 keypair it CANNOT READ — non-extractable, filed in IndexedDB as a
 * `CryptoKey` — registers only the public half, and signs every request.
 *
 * ── THE CANONICAL STRING IS A CONTRACT WITH TWO OTHER FILES ─────────────────────────────────────
 *
 *     METHOD \n PATH \n TIMESTAMP \n sha256(body)
 *
 * The twins are moltworker's `worker/src/sponsored/app-devices.ts::canonicalDeviceString` (the
 * verifier) and its `sponsoredtokens-site/src/lib/device-key.ts` (the reference signer). This is a
 * THIRD copy because that repo's code cannot be imported into a browser package here, and a copy
 * that drifts is a package that cannot talk to the pool. The four details that must agree byte for
 * byte, each of which the verifier refuses on:
 *
 *   · METHOD is upper case.
 *   · PATH is the pathname AND the query string. A signature for `/api/v1/models?tier=0` must not
 *     be liftable onto `?tier=3` — the query is part of what the request asks for.
 *   · TIMESTAMP is unix SECONDS as a decimal string (the verifier's window is five minutes).
 *   · sha256(body) is LOWERCASE HEX, and a request with no body carries the hash OF THE EMPTY
 *     STRING (`e3b0c442…`) rather than an empty field, so "no body" and "the field is missing" are
 *     different strings and neither can be substituted for the other.
 *
 * And the signature header is base64 of the RAW 64-byte `r‖s` form `subtle.sign` produces, never
 * DER: the verifier refuses anything else by length. `test/device-key.test.ts` pins all of it
 * against Node's own WebCrypto, which is the only check worth having — a hand-rolled fake could
 * never tell us whether what a browser produces verifies against what the worker stores.
 */

/** The four headers a signed call carries, and no bearer at all. */
export const HEADER_APP = "X-Sponsoredtokens-App";
export const HEADER_DEVICE = "X-Sponsoredtokens-Device";
export const HEADER_TIMESTAMP = "X-Sponsoredtokens-Timestamp";
export const HEADER_SIGNATURE = "X-Sponsoredtokens-Signature";

/** The pool's own origin. The popup and every signed call are against this host and no other. */
export const SPONSOREDTOKENS_ORIGIN = "https://sponsoredtokens.com";

/** The popup's page, on THEIR origin — which is the point of it: Turnstile runs there, not here. */
export const CONNECT_DEVICE_PATH = "/apps/connect/device";

/** The message kinds the popup and the opener exchange. Namespaced, so nothing else answers. */
export const DEVICE_MESSAGE = Object.freeze({
  /** popup → opener: "I am open, send me your public key." */
  ready: "sponsoredtokens:device:ready",
  /** opener → popup: the public half, as a JWK. */
  key: "sponsoredtokens:device:key",
  /** popup → opener: registered, and this is the id. */
  registered: "sponsoredtokens:device:registered",
  /** popup → opener: refused, with the worker's own code. */
  error: "sponsoredtokens:device:error",
} as const);

export const DEVICE_KEY_PARAMS: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
export const DEVICE_SIGN_PARAMS: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

// ── The pure half: no DOM, no storage, testable in plain Node ────────────────────────────────────

/** What a signature covers: the pathname and the query, never the origin. */
export function requestPath(url: string, base = SPONSOREDTOKENS_ORIGIN): string {
  const parsed = new URL(url, base);
  return `${parsed.pathname}${parsed.search}`;
}

/** `METHOD\nPATH\nTIMESTAMP\nsha256(body)`. See this file's header for why each line is in it. */
export function canonicalRequest(method: string, path: string, timestamp: number | string, bodyHashHex: string): string {
  return [String(method).toUpperCase(), path, String(timestamp), bodyHashHex].join("\n");
}

/** Bytes as base64. Chunked: `String.fromCharCode(...bigArray)` blows the argument limit. */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Bytes as lowercase hex — the spelling the verifier's canonical string uses. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** The body a signature covers, as bytes. `undefined` and `null` are both the empty string. */
export function bodyBytes(body: string | Uint8Array | null | undefined): Uint8Array {
  if (body === null || body === undefined) return new TextEncoder().encode("");
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/** `sha256(body)` in lowercase hex. The empty body hashes to the sha256 of the empty string. */
export async function bodyHashHex(
  body: string | Uint8Array | null | undefined,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const bytes = bodyBytes(body);
  // A fresh copy, because `digest` wants an ArrayBuffer and a view into a larger one would hash the
  // whole buffer rather than the slice a caller handed us.
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return toHex(digest);
}

export interface SignedHeaderInput {
  appId: string;
  deviceId: string;
  /** The non-extractable private half. It can sign and do nothing else. */
  privateKey: CryptoKey;
  method: string;
  /** A full URL or a path; only the pathname and query are signed. */
  url: string;
  body?: string | Uint8Array | null;
  /** Unix SECONDS. Injected so a test pins the string rather than the clock. */
  timestamp?: number;
  subtle?: SubtleCrypto;
}

/** The four headers, assembled. A signed request carries NO `Authorization` — the key IS the id. */
export async function signedHeaders(input: SignedHeaderInput): Promise<Record<string, string>> {
  const subtle = input.subtle ?? globalThis.crypto.subtle;
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const path = requestPath(input.url);
  const hash = await bodyHashHex(input.body ?? null, subtle);
  const canonical = canonicalRequest(input.method, path, timestamp, hash);
  const signature = await subtle.sign(
    DEVICE_SIGN_PARAMS,
    input.privateKey,
    new TextEncoder().encode(canonical).slice().buffer as ArrayBuffer,
  );
  return {
    [HEADER_APP]: input.appId,
    [HEADER_DEVICE]: input.deviceId,
    [HEADER_TIMESTAMP]: String(timestamp),
    [HEADER_SIGNATURE]: toBase64(signature),
  };
}

/**
 * A fresh non-extractable P-256 keypair.
 *
 * `extractable: false` is the whole security claim: the private half cannot be read back by the
 * page that made it, by a script that gets onto the page later, or by anything in devtools. It can
 * only be handed to `crypto.subtle.sign`.
 */
export async function generateDeviceKeypair(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<CryptoKeyPair> {
  return (await subtle.generateKey(DEVICE_KEY_PARAMS, false, ["sign", "verify"])) as CryptoKeyPair;
}

// ── Storage, behind an interface ────────────────────────────────────────────────────────────────

/** What one browser holds for one app. The private key is a `CryptoKey` and stays one. */
export interface StoredDevice {
  appId: string;
  deviceId: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  createdAt: string;
}

/**
 * Where a device key lives.
 *
 * An interface rather than a hard IndexedDB call for one reason worth stating: IndexedDB is the only
 * store that can hold a `CryptoKey` AS a key (structured-clonable, still non-extractable), so the
 * browser implementation cannot be anything else — and that same fact makes the signing logic
 * untestable in Node unless the store is swappable. `MemoryDeviceKeyStore` is the swap.
 */
export interface DeviceKeyStore {
  get(appId: string): Promise<StoredDevice | null>;
  put(device: StoredDevice): Promise<void>;
  delete(appId: string): Promise<void>;
}

/** For tests and for a page that deliberately forgets its device when the tab closes. */
export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private readonly devices = new Map<string, StoredDevice>();

  async get(appId: string): Promise<StoredDevice | null> {
    return this.devices.get(appId) ?? null;
  }

  async put(device: StoredDevice): Promise<void> {
    this.devices.set(device.appId, device);
  }

  async delete(appId: string): Promise<void> {
    this.devices.delete(appId);
  }
}

/** Minimal `indexedDB` surface, so the store can be handed a fake without pulling in a DOM shim. */
export interface IndexedDbFactoryLike {
  open(name: string, version?: number): IDBOpenDBRequest;
}

/**
 * The browser store. One record per app, keyed on `appId`.
 *
 * Never throws on a read: a browser in private mode, with storage blocked, or with the database
 * evicted has NO DEVICE, which is a state `registerDevice` already knows how to leave — turning it
 * into an exception would make a first visit look like a bug.
 */
export class IndexedDbDeviceKeyStore implements DeviceKeyStore {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly factory: () => IndexedDbFactoryLike | undefined;

  constructor(options: { dbName?: string; storeName?: string; indexedDB?: IndexedDbFactoryLike } = {}) {
    this.dbName = options.dbName ?? "00-agent-devices";
    this.storeName = options.storeName ?? "devices";
    this.factory = () => options.indexedDB ?? (globalThis as { indexedDB?: IndexedDbFactoryLike }).indexedDB;
  }

  private open(): Promise<IDBDatabase> {
    const idb = this.factory();
    if (!idb) return Promise.reject(new Error("This browser has no IndexedDB, so it cannot hold a device key."));
    return new Promise((resolve, reject) => {
      const request = idb.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: "appId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB refused to open"));
    });
  }

  private tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const request = run(db.transaction(this.storeName, mode).objectStore(this.storeName));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("indexedDB refused the write"));
        }),
    );
  }

  async get(appId: string): Promise<StoredDevice | null> {
    try {
      return (await this.tx<StoredDevice | undefined>("readonly", (store) => store.get(appId))) ?? null;
    } catch {
      return null;
    }
  }

  async put(device: StoredDevice): Promise<void> {
    await this.tx("readwrite", (store) => store.put(device));
  }

  async delete(appId: string): Promise<void> {
    try {
      await this.tx("readwrite", (store) => store.delete(appId));
    } catch {
      /* nothing stored is the state the caller asked for */
    }
  }
}
