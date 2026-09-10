/**
 * The two keypairs this browser holds for mobile connect, and the only file that stores them.
 *
 * ── WHAT IS STORED, AND WHY IT IS SAFE TO STORE IT ──────────────────────────────────────────────
 *
 * A `CryptoKey` generated non-extractable goes into IndexedDB as a `CryptoKey` — the structured-clone
 * algorithm carries it as a handle, not as bytes. The private half is never readable by this app, by
 * a script that reaches this database, or by anything that reads a crash report; it can only be
 * handed back to `crypto.subtle.sign`. That is the whole reason the key can live in a browser at all,
 * and it is why nothing here has a "export the seed" path: there is no seed to export.
 *
 * If you are editing this file and find yourself calling `exportKey` on a private half, stop.
 *
 * ── WHY ITS OWN DATABASE ────────────────────────────────────────────────────────────────────────
 *
 * `lib/kv.ts` is the origin's small store and it names every key it holds, deliberately, "so two
 * modules cannot invent the same string differently". These are not small settings and they are not
 * the origin's: they are two identities with different lifetimes (the client key is for the life of
 * the browser profile; the engine key is for the life of ONE 24-hour session and is destroyed with
 * it). A separate database keeps "forget this session" a single `delete` that cannot take a person's
 * connection settings with it.
 *
 * ── TWO IDENTITIES, NOT ONE ─────────────────────────────────────────────────────────────────────
 *
 * `ph-…` is this browser AS A CLIENT — the phone-shaped device the operator admits at their Mac. It
 * is long-lived, because re-keying means re-enrolling and being admitted again.
 * `mc-…` is this browser AS AN ENGINE — a per-session key, exactly as the Mac mints one per session,
 * so a leaked session key is worth one session for at most twenty-four hours.
 */
import { createIdentity, identityFor, type WireIdentity } from "./wire.js";

const DB_NAME = "00-infinite-mac";
const STORE = "keys";
const CLIENT_KEY = "client.v1";
const ENGINE_KEY = "engine.v1";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB refused to open"));
  });
}

async function read<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise<T | null>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function write(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function drop(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * A stored pair. `CryptoKeyPair` is what goes in and comes out; the identity is re-derived on read
 * rather than stored beside it, so a `dev` can never name a key this database no longer holds.
 */
async function loadOrCreate(slot: string, prefix: "ph" | "mc"): Promise<WireIdentity> {
  const stored = await read<CryptoKeyPair>(slot);
  if (stored?.privateKey && stored?.publicKey) return identityFor(stored, prefix);
  const { identity, keyPair } = await createIdentity(prefix);
  // Written BEFORE the identity is returned, so a crash between generating and enrolling leaves a key
  // the next load finds — rather than a `dev` the relay knows and a private half nobody holds, which
  // is unrecoverable from this side.
  await write(slot, keyPair);
  return identity;
}

/** This browser as a client. Stable for the life of the profile — re-keying means being admitted again. */
export function clientIdentity(): Promise<WireIdentity> {
  return loadOrCreate(CLIENT_KEY, "ph");
}

/** This browser as an engine, for ONE session. `sessionId` is the `dev`, exactly as on the Mac. */
export function engineIdentity(): Promise<WireIdentity> {
  return loadOrCreate(ENGINE_KEY, "mc");
}

/**
 * Throw the engine identity away. Called when the operator ends the session or when it expires —
 * the next `engineIdentity()` mints a fresh key and therefore a fresh session id, deliberately, so a
 * session the relay still remembers can never be answered by a key nobody holds.
 */
export function forgetEngineIdentity(): Promise<void> {
  return drop(ENGINE_KEY);
}

/** Forget this browser's client identity. The next call mints a new `dev`, which must be enrolled and
 *  admitted again; there is no way to re-attach to the old one, and there should not be. */
export function forgetClientIdentity(): Promise<void> {
  return drop(CLIENT_KEY);
}
