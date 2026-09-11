/**
 * The origin's own key/value store — §3.1's "IndexedDB holds what the engine keeps in
 * `~/Library/Application Support/00`: settings, the vault, permissions, push subscription."
 *
 * WHY IT IS ITS OWN MODULE AND NOT A DEPENDENCY. Three operations over one object store is not worth
 * a library, and it is not worth being private to the runtime bootstrap either: the move receipt of
 * §7 has to survive a reload and therefore has to live exactly where the connection settings live —
 * beside them, in this store, on this origin. Two implementations of "remember this small thing"
 * would drift into two databases and one of them would be the one a person's browser cleared.
 *
 * EVERY FAILURE IS SILENT AND MEANS "NOT REMEMBERED". A private window with storage blocked, a
 * browser that refuses to open a database, a quota that is full: none of those are a reason to stop
 * running the session in front of the person. A read answers `null` and a write does nothing, which
 * is exactly what a browser with no memory looks like from the outside.
 */

const DB_NAME = "00-infinite";
const KV_STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB refused to open"));
  });
}

export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(KV_STORE, "readonly").objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(KV_STORE, "readwrite").objectStore(KV_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* a browser that refuses to remember still runs the session in front of it */
  }
}

export async function kvDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(KV_STORE, "readwrite").objectStore(KV_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* same rule as kvSet: forgetting a thing that was never remembered is not an error */
  }
}

/** The keys this origin holds. Named here so two modules cannot invent the same string differently. */
export const AGENT_ID_KEY = "agentId";
export const SETTINGS_KEY = "connections";
export const CREDENTIAL_KEY = "vaultCredentialId";
export const MOVE_RECEIPT_KEY = "moveReceipt";
/** The mirror's model catalogue, with the stamp its five-minute freshness is measured from (§12.7). */
export const LITERT_CATALOG_KEY = "litertCatalog";
/** §5.1's public ref, minted offline and never minted twice — it is in the page source of every site. */
export const REGISTRY_REF_KEY = "agentRef";
/** What a site's registration turned that ref into: the app id, its status, its origin (§5.3–5.4). */
export const REGISTRY_APP_KEY = "registryApp";
/** §14's companion grant: which engine on this computer, at which base, and who this browser is to
 *  it. Three strings and no secret — the key itself is a non-extractable CryptoKey in another store. */
export const COMPANION_KEY = "companion";
