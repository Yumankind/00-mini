/**
 * THE TWO REGISTRY FACTS THAT ARE NOT A NETWORK CALL — and are therefore the only ones the loader
 * keeps (§5.1's carrier 1, §5.5).
 *
 * `registry/client.ts` is 31 KB of source and lives in `m/registry.js` now, fetched the first time
 * somebody actually reaches the registry. But two of its answers were never calls at all:
 *
 *   · the PUBLIC BUNDLE this browser already holds — carrier 1 of §5.1, read from IndexedDB on
 *     every load so a claimed app opens with its owner's persona and makes no call doing it;
 *   · the CLAIM LINK, which is a URL built out of three strings this browser already knows.
 *
 * Both are pure over the store and the state, so they stay in `e.js` where the loader can have them
 * for nothing, and `client.ts` imports them from here rather than keeping a second copy. The
 * shapes are written down once, in this file, for the same reason.
 */

import type { Store } from "../index/store.js";
import type { RegistryState } from "./state.js";

/** `registry:bundle:<origin>:<ref>` — where this browser keeps the copy it last fetched. */
export const bundleKey = (origin: string, ref: string): string => `registry:bundle:${origin}:${ref}`;

export interface CachedBundle {
  etag: string | null;
  siteFile: unknown | null;
  files: Record<string, string>;
  at: number;
}

/**
 * The bundle already in IndexedDB, or null. NO NETWORK — this is what carrier 1 reads on load, and
 * a fetch here would be a backend call at level 0, which §9.1 does not allow.
 *
 * Re-typed field by field on the way out, exactly as `state.ts` re-types its record: what comes back
 * is whatever was in the store, including an older shape or something another script wrote.
 */
export async function readCachedBundle(store: Store, origin: string, ref: string): Promise<CachedBundle | null> {
  const held = await store.get<CachedBundle>(bundleKey(origin, ref));
  if (!held || typeof held !== "object") return null;
  const files = held.files && typeof held.files === "object" ? held.files : {};
  return {
    etag: typeof held.etag === "string" ? held.etag : null,
    siteFile: held.siteFile ?? null,
    files,
    at: typeof held.at === "number" ? held.at : 0,
  };
}

/**
 * `<product origin>/?claim=<appId>&nonce=…&origin=…`, or null when this browser cannot claim (§5.4).
 *
 * The REGISTRATION origin when the worker has named it, this page's origin only as a last resort:
 * the claim signature is over `appId‖origin‖nonce`, and an allowed-but-different host (`www.` of the
 * registered one) signing its own address would sign a string nobody holds.
 */
export function claimUrlFor(state: RegistryState, pageOrigin: string, productOrigin: string): string | null {
  if (!state.appId || !state.claimNonce) return null;
  const url = new URL("/", productOrigin);
  url.searchParams.set("claim", state.appId);
  url.searchParams.set("nonce", state.claimNonce);
  url.searchParams.set("origin", state.claimOrigin ?? pageOrigin);
  return url.toString();
}
