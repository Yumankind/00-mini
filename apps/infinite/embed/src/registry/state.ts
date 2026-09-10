/**
 * WHAT THIS BROWSER KNOWS ABOUT THIS APP, ON THIS SITE — and nothing about any other site.
 *
 * WHY it is keyed on `origin + ref` and not on either alone: the same ref legitimately runs on
 * `example.com`, `www.example.com` and a staging host (§5.3's allow-list), and those are three
 * different app standings — one `allowed`, one `requested`, one never seen. And a browser that
 * visits two sites running two different snippets must keep two device identities apart, because
 * "a device is a customer, never a person: no cookie, no fingerprint, no cross-site identity"
 * (§6.2). Browsers partition storage per top-level site anyway; this key means the code does not
 * rely on that for its correctness.
 *
 * WHY IT IS RE-TYPED ON THE WAY OUT. What comes back from IndexedDB is whatever was there — an
 * older shape, a half-written record, a value another script on the page put in a store of the same
 * name. So `readState` builds a fresh object field by field, exactly as `site-config.ts` does for
 * the owner's document, and an unrecognisable record reads as "nothing known yet".
 *
 * NOTHING SECRET IS HERE. The device's private key is a non-extractable `CryptoKey` under its own
 * key (see `device.ts`); the app id, the status and the claim nonce are all public by design — the
 * ref is in the page source, and the claim nonce grants nothing without the owner's link key.
 */

import type { Store } from "../index/store.js";

/** The four the worker's `infinite_apps.status` column can hold, as a visitor may see them. */
export type AppStatus = "dev" | "unclaimed" | "claimed";

/** This origin's standing in the app's allow-list, as `GET /infinite/apps/:id` reports it. */
export type OriginStanding = "allowed" | "requested" | "verified" | "blocked" | "unknown";

export interface RegistryState {
  /** `iaa_…`, once this browser has registered or learned it. */
  appId: string | null;
  status: AppStatus | null;
  /**
   * The nonce the claim signature is taken over (§5.4). Issued ONCE, at registration, to the
   * browser that registered — so a browser that merely learned the app id has `null` here and the
   * admin flow says so rather than opening a claim link that cannot be signed.
   */
  claimNonce: string | null;
  /**
   * The app's REGISTRATION origin, as the worker echoed it (§5.3's answer, §5.4's re-issue).
   *
   * It is NOT this page's origin: an app registered at `shop.example` legitimately answers
   * `www.shop.example` too, and the claim signature is over the origin the worker stores. Null until
   * a worker has said which it is, and then `claimUrl` carries that one.
   */
  claimOrigin: string | null;
  /** `iad_…` — this browser's device of this app (§5.6). */
  deviceId: string | null;
  originStanding: OriginStanding;
  /** True when the worker says a public bundle has been published (§5.5). */
  hasPublicBundle: boolean;
  /** When any of the above was last written, so a stale record can be recognised as one. */
  at: number;
}

export const EMPTY_STATE: RegistryState = {
  appId: null,
  status: null,
  claimNonce: null,
  claimOrigin: null,
  deviceId: null,
  originStanding: "unknown",
  hasPublicBundle: false,
  at: 0,
};

const STATUSES: AppStatus[] = ["dev", "unclaimed", "claimed"];
const STANDINGS: OriginStanding[] = ["allowed", "requested", "verified", "blocked", "unknown"];

/** `registry:<origin>:<ref>` — the one key the whole of Phase 3 hangs off in this browser. */
export function registryKey(origin: string, ref: string): string {
  return `registry:${origin}:${ref}`;
}

const id = (v: unknown, prefix: string): string | null =>
  typeof v === "string" && v.startsWith(prefix) && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v) ? v : null;

/** Re-type one record. Never throws, and never returns a field it did not recognise. */
export function toState(input: unknown): RegistryState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ...EMPTY_STATE };
  const raw = input as Record<string, unknown>;
  return {
    appId: id(raw.appId, "iaa_"),
    status: STATUSES.includes(raw.status as AppStatus) ? (raw.status as AppStatus) : null,
    claimNonce:
      typeof raw.claimNonce === "string" && raw.claimNonce.length > 0 && raw.claimNonce.length <= 128
        ? raw.claimNonce
        : null,
    // Re-typed as an ORIGIN, not as a string: this one is put in a link and then signed, so a
    // record carrying `javascript:…` or a bare word reads as "nothing known" like any other.
    claimOrigin:
      typeof raw.claimOrigin === "string" && /^https?:\/\/[^\s/?#]+$/.test(raw.claimOrigin) ? raw.claimOrigin : null,
    deviceId: id(raw.deviceId, "iad_"),
    originStanding: STANDINGS.includes(raw.originStanding as OriginStanding)
      ? (raw.originStanding as OriginStanding)
      : "unknown",
    hasPublicBundle: raw.hasPublicBundle === true,
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0,
  };
}

export interface RegistryStateStore {
  read(): Promise<RegistryState>;
  /** Merge a patch and persist. Returns what is now in force. */
  write(patch: Partial<RegistryState>): Promise<RegistryState>;
  clear(): Promise<void>;
  /** The last value read or written, with no round trip — the loader reads this on every turn. */
  current(): RegistryState;
}

export interface StateOptions {
  store: Store;
  origin: string;
  ref: string;
  now?: () => number;
}

/**
 * The state, cached in memory after the first read.
 *
 * The cache is why `current()` exists: the panel asks "is this registered?" on every keystroke that
 * could reach `send_to_owner`, and an IndexedDB round trip per question would be a promise in a
 * hot path for a fact that only this tab can change.
 */
export function createRegistryState(opts: StateOptions): RegistryStateStore {
  const key = registryKey(opts.origin, opts.ref);
  const now = opts.now ?? Date.now;
  let cached: RegistryState = { ...EMPTY_STATE };

  return {
    current: () => cached,
    async read() {
      cached = toState(await opts.store.get(key));
      return cached;
    },
    async write(patch) {
      const next: RegistryState = { ...cached, ...patch, at: now() };
      cached = next;
      await opts.store.set(key, next);
      return next;
    },
    async clear() {
      cached = { ...EMPTY_STATE };
      await opts.store.del(key);
    },
  };
}
