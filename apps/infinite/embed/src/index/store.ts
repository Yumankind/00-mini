/**
 * Where the index lives: IndexedDB in the visitor's browser, keyed by `origin + ref` (§5.2.1).
 *
 * WHY an interface with two implementations: the storage rules — what is written, what is refused,
 * what is deleted on a logout — are the part that must be provable, and they are provable only in a
 * test runner with no IndexedDB. So everything above this file talks to `Store`, the browser gets
 * `IdbStore`, and the tests get `MemoryStore`.
 *
 * Nothing here is ever uploaded. Browsers partition storage per top-level site, so an index built
 * on one site is not readable from another, and a logged-in visitor's view of a site never leaves
 * the device that saw it.
 */

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** Every key under a prefix — the purge and the "clear memory" button need it. */
  keys(prefix?: string): Promise<string[]>;
}

export class MemoryStore implements Store {
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    // Round-tripped through JSON like the real store, so a test cannot accidentally rely on
    // sharing an object reference with what was "persisted".
    this.map.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(prefix = ""): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

const DB_NAME = "infinite-embed";
const DB_STORE = "kv";

/** One object store, string keys, structured-clone values. No schema to migrate later. */
export function createIdbStore(dbName = DB_NAME): Store {
  let open: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    open ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    });
    return open;
  };

  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const conn = await db();
    return new Promise<T>((resolve, reject) => {
      const t = conn.transaction(DB_STORE, mode);
      const req = fn(t.objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    });
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        return ((await tx<T | undefined>("readonly", (s) => s.get(key))) ?? null) as T | null;
      } catch {
        // A browser in private mode, or one that evicted us, is a cold start — never a crash.
        return null;
      }
    },
    async set(key, value) {
      try {
        await tx("readwrite", (s) => s.put(value, key));
      } catch {
        /* storage refused; the index stays in memory for this tab */
      }
    },
    async del(key) {
      try {
        await tx("readwrite", (s) => s.delete(key));
      } catch {
        /* nothing to do: it is already unreachable */
      }
    },
    async keys(prefix = "") {
      try {
        const all = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
        return all.map(String).filter((k) => k.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}
