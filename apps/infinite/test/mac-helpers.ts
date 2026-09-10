/**
 * A relay that records instead of routing, and the two identities a `00mc` exchange needs.
 *
 * The seam is the same one the engine keeps (`__setRelayTransportForTests`) and for the same reason:
 * what these tests pin is what the two halves do with a FRAME — a rewritten payload, a forged
 * signature, a retry, a busy runtime — and none of that is about how a bearer token is found.
 */
import type { Relay, RelayResponse } from "../src/mac/relay.js";
import { createIdentity, type WireIdentity } from "../src/mac/wire.js";

export interface RecordedCall {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

export interface FakeRelay {
  relay: Relay;
  calls: RecordedCall[];
  /** Answer the next call whose path starts with `prefix`. Later routes win, so a test can override. */
  route(method: "GET" | "POST", match: string, answer: RelayResponse | ((call: RecordedCall) => RelayResponse)): void;
  last(match: string): RecordedCall | undefined;
}

export function fakeRelay(): FakeRelay {
  const calls: RecordedCall[] = [];
  const routes: { method: string; match: string; answer: RelayResponse | ((c: RecordedCall) => RelayResponse) }[] = [];
  const relay: Relay = async (method, path, body) => {
    const call: RecordedCall = { method, path, ...(body === undefined ? {} : { body: body as Record<string, unknown> }) };
    calls.push(call);
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (r.method === method && path.includes(r.match)) {
        return typeof r.answer === "function" ? r.answer(call) : r.answer;
      }
    }
    return { ok: true, status: 200, json: {} };
  };
  return {
    relay,
    calls,
    route: (method, match, answer) => routes.push({ method, match, answer }),
    last: (match) => [...calls].reverse().find((c) => c.path.includes(match)),
  };
}

export const ok = (json: Record<string, unknown> = {}): RelayResponse => ({ ok: true, status: 200, json });
export const refused = (status: number, code: string, error = code): RelayResponse => ({
  ok: false,
  status,
  json: { code, error },
});

export async function twoIdentities(): Promise<{ phone: WireIdentity; engine: WireIdentity }> {
  const phone = (await createIdentity("ph")).identity;
  const engine = (await createIdentity("mc")).identity;
  return { phone, engine };
}

/**
 * The smallest IndexedDB that `src/mac/keys.ts` can actually use.
 *
 * WHY NOT A LIBRARY. No installs, and this needs three operations on one object store — the same
 * reasoning `src/lib/kv.ts` gives for not taking a dependency to store three values. What it must get
 * right is the SHAPE: requests that settle asynchronously with `onsuccess`, an upgrade callback on
 * first open, and structured values held by reference so a non-extractable `CryptoKey` survives a
 * round trip exactly as it does in a browser.
 */
export function installFakeIndexedDb(): () => void {
  const stores = new Map<string, Map<string, unknown>>();
  const settle = <T>(value: T) => {
    const req: Record<string, unknown> = { result: value, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => (req.onsuccess as (() => void) | null)?.call(req));
    return req;
  };
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction: (name: string) => ({
      objectStore: (store: string) => ({
        get: (key: string) => settle(stores.get(store)?.get(key)),
        put: (value: unknown, key: string) => settle(stores.get(store)?.set(key, value)),
        delete: (key: string) => settle(stores.get(store)?.delete(key)),
      }),
      // `name` is accepted and ignored: this shim has one store, and pretending otherwise would be a
      // second implementation of scoping that the code under test never exercises.
      name,
    }),
  };
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = { result: db, error: null, onsuccess: null, onupgradeneeded: null, onerror: null };
      queueMicrotask(() => {
        (req.onupgradeneeded as (() => void) | null)?.call(req);
        (req.onsuccess as (() => void) | null)?.call(req);
      });
      return req;
    },
  };
  return () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = previous;
  };
}
