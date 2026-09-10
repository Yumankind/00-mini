/**
 * THE LINK KEY — one ed25519 keypair per owned agent, and the only credential this app ever holds
 * for the registry (§5.1).
 *
 * There is no account, no password and no bearer token anywhere in Phase 3. Claiming an app,
 * publishing its public bundle, editing its origins, draining its inbox, replying to a visitor and
 * subscribing to push are all ONE thing: a signature under this key. So the private half is the
 * agent, and it is stored the only way a private half may be stored in a browser.
 *
 * ── NON-EXTRACTABLE WEBCRYPTO. THERE IS NO VAULT PATH, AND HERE IS WHY ─────────────────────────
 *
 * `crypto.subtle.generateKey({ name: "Ed25519" }, false, …)` produces a `CryptoKey` whose private
 * half cannot be read back out — not by this app, not by a script that reaches this database, not by
 * a crash report — and structured clone stores it in IndexedDB as a HANDLE, not as bytes. That is
 * strictly better than sealing a seed in the vault, and it is what `src/mac/keys.ts` already does
 * for the mobile-connect identities, for the same reason and in the same shape.
 *
 * The brief allowed "sealed in the vault otherwise". That fallback is NOT implemented, and the
 * honest reason is worth writing down rather than leaving as a gap: sealing a seed in the vault only
 * helps if something can then SIGN with those bytes, and signing ed25519 from raw bytes needs either
 * WebCrypto's Ed25519 (the thing we would be falling back FROM) or a userland curve implementation.
 * `@noble/curves` is not in this workspace and adding it is an install, which this repo does not do
 * casually. A vault-sealed seed with no signer is a secret stored for nothing. So a browser without
 * WebCrypto Ed25519 is REFUSED BY NAME — `link_key_unavailable`, the same shape `mac/wire.ts`'s
 * `Ed25519Unavailable` takes — and the panel says the sentence rather than showing a button that
 * cannot work. The day `@noble/curves` is installed for another reason, this is the file to revisit.
 *
 * ── WHY ITS OWN DATABASE ───────────────────────────────────────────────────────────────────────
 *
 * `lib/kv.ts` holds the origin's small settings and names every key it holds; `mac/keys.ts` holds
 * the mobile-connect identities in a database of its own. This is a third lifetime again: the link
 * key lives as long as the AGENT does and travels with nothing — it is not in the `.00agent` bundle,
 * because §7's rule is one live residence and a moved agent that could still sign its old app would
 * be two owners of one website. Keeping it in its own store makes "forget this agent's registry
 * identity" one delete that cannot take a person's connection settings with it.
 */

const DB_NAME = "00-infinite-registry";
const STORE = "keys";
const LINK_KEY = "link.v1";

/** Base64url of raw bytes — the encoding `refs.ts::isLinkPub` and `verifyLinkSignature` expect. */
export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Padded or unpadded, base64 or base64url: the worker re-encodes canonically, a hand-written client may not. */
export function b64uDecode(value: string): Uint8Array {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class LinkKeyUnavailable extends Error {
  readonly code = "link_key_unavailable";
  constructor() {
    super("This browser has no WebCrypto Ed25519, so it cannot hold an agent's link key.");
    this.name = "LinkKeyUnavailable";
  }
}

/** Cheap and synchronous: whether WebCrypto is here at all. The real answer is `generateKey` failing. */
export function linkKeyPossible(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

/** The pair as this app holds one: the public half as bytes and base64url, the private half as a handle. */
export interface LinkIdentity {
  /** Raw 32 bytes, base64url — what `POST /apps/register` carries as `linkPub`. */
  publicKeyB64u: string;
  publicKey: Uint8Array;
  /** Never readable. Only `crypto.subtle.sign` may have it. */
  privateKey: CryptoKey;
}

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

async function generatePair(): Promise<CryptoKeyPair> {
  if (!linkKeyPossible()) throw new LinkKeyUnavailable();
  try {
    // NON-EXTRACTABLE, deliberately. The public half stays extractable regardless — the spec says so
    // for asymmetric `generateKey` — which is what lets the ref's snippet carry a `linkPub` at all.
    return (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  } catch (err) {
    throw err instanceof LinkKeyUnavailable ? err : new LinkKeyUnavailable();
  }
}

async function identityFor(pair: CryptoKeyPair): Promise<LinkIdentity> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 32) throw new Error(`link key: an ed25519 public key is 32 bytes; got ${raw.length}`);
  return { publicKey: raw, publicKeyB64u: b64u(raw), privateKey: pair.privateKey };
}

/**
 * This agent's link key: the stored one, or a fresh pair written before it is returned.
 *
 * Written FIRST for the reason `mac/keys.ts` gives: a crash between generating and registering must
 * leave a key the next load finds, not a `linkPub` the worker knows and a private half nobody holds,
 * which is unrecoverable from this side — the app can never be claimed and the ref is spent.
 */
export async function linkIdentity(): Promise<LinkIdentity> {
  const stored = await read<CryptoKeyPair>(LINK_KEY);
  if (stored?.privateKey && stored?.publicKey) return identityFor(stored);
  const pair = await generatePair();
  await write(LINK_KEY, pair);
  return identityFor(pair);
}

/** Has this browser minted one yet? Asked before a screen offers to show a snippet. */
export async function hasLinkKey(): Promise<boolean> {
  try {
    const stored = await read<CryptoKeyPair>(LINK_KEY);
    return !!(stored?.privateKey && stored?.publicKey);
  } catch {
    return false;
  }
}

/**
 * Sign a message with the link key. base64url of the RAW 64 bytes — never DER, never hex.
 *
 * `verifyLinkSignature` refuses anything that does not decode to exactly 64 bytes, so a client that
 * went its own way is refused as `bad_signature` with no clue as to why. This is the one encoder.
 */
export async function signWithLinkKey(message: string | Uint8Array, identity?: LinkIdentity): Promise<string> {
  const id = identity ?? (await linkIdentity());
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, id.privateKey, bytes as unknown as ArrayBuffer);
  return b64u(new Uint8Array(sig));
}

/**
 * Throw this agent's link key away.
 *
 * There is no undo and no recovery: the app it claimed can never be signed for again. It exists for
 * the one case that needs it — the agent left this browser (§7) — and the panel asks twice.
 */
export function forgetLinkKey(): Promise<void> {
  return drop(LINK_KEY);
}
