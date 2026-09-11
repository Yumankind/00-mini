/**
 * THE LAZY MODULES, AND THE ONE WAY THEY ARE FETCHED (§5.2, §10).
 *
 * `e.js` is the whole product at level 0: a visitor searches the site, opens a page and has a
 * control outlined for them without a second request and without a backend of ours (§9.1). Three
 * things are NOT level 0, and each of them is a person doing something first:
 *
 *   · `m/brain.js`    — somebody pressed "Load local AI" (or the site has a brain configured).
 *                       Carries @00/agent-runtime, @00/agent-fs and @00/agent-models' local pair.
 *   · `m/setup.js`    — the OWNER pressed the gear on their own site. Carries the wizard.
 *   · `m/registry.js` — a registered site needs the registry: the first `send_to_owner`, the reply
 *                       poll, the public bundle, the admin Register card. A site whose owner never
 *                       registered never fetches it.
 *
 * WHY A URL AND NOT AN IMPORT. `vite.embed.config.ts` inlines dynamic imports — it has to, because
 * the Worker serves the same built file for EVERY `/e/<ref>.js` and a sibling chunk beside a
 * ref-shaped URL would never resolve. So a static import of any of the three would land it in
 * `e.js`, which is exactly what this file exists to prevent. The specifier is COMPUTED, `@vite-ignore`
 * keeps the bundler's hands off it, and the URL is resolved against the PRODUCT HOST — the origin of
 * the loader's own `<script src>` — never against the site the embed is sitting on.
 *
 * WHY THE SAME MECHANISM AS THE MODEL MODULE HAD. `m/m.js` was already loaded this way and the site
 * Worker already serves `/m/*` with `Cross-Origin-Resource-Policy: cross-origin`
 * (apps/infinite-site/src/headers.ts, `kindFor`), which is the header that says "yes, a third-party
 * page may load me". Nothing here changes that contract; it only puts three files behind it instead
 * of one.
 *
 * WHAT HAPPENS WHEN ONE DOES NOT LOAD. A site owner opening the gear on a plane, a network that
 * blocks our host, a deploy mid-flight: every caller gets `null` and a sentence, never an exception
 * on somebody else's page. The panel says the sentence and stays a working site search.
 */

/** The brain: the agent loop and the local model pair. Was `m/m.js` until it grew the loop too. */
export const BRAIN_MODULE = "/m/brain.js";
/** The owner's setup wizard. */
export const SETUP_MODULE = "/m/setup.js";
/** The registry client, the device key, the bundle reader. */
export const REGISTRY_MODULE = "/m/registry.js";

export type ModuleImporter = (url: string) => Promise<unknown>;

const nativeImport: ModuleImporter = (url) =>
  // A computed specifier ON PURPOSE: the bundler must NOT resolve this, or `e.js` inherits the very
  // thing the split exists to keep out of it.
  import(/* @vite-ignore */ url) as Promise<unknown>;

let importer: ModuleImporter = nativeImport;

/**
 * Hand in a loader (a test, or a host that has the module already). `null` restores the real one.
 * This is the single seam every lazy module goes through, so one fake covers all three.
 */
export function useModuleImporter(fn: ModuleImporter | null): void {
  importer = fn ?? nativeImport;
}

/** One in-flight promise per URL: pressing the gear twice fetches the wizard once. */
const cache = new Map<string, Promise<unknown>>();

/** Forget what has been loaded — for tests, which swap the importer between cases. */
export function resetModuleCache(): void {
  cache.clear();
}

/**
 * Fetch one module from the product host, once. Returns `null` rather than throwing: every caller
 * here is running inside somebody else's page.
 */
export async function loadModule<T>(
  productHost: string,
  path: string,
  onError?: (message: string) => void,
): Promise<T | null> {
  const url = new URL(path, productHost).toString();
  let pending = cache.get(url);
  if (!pending) {
    pending = importer(url);
    cache.set(url, pending);
  }
  try {
    return (await pending) as T;
  } catch (err) {
    // A failed load is not remembered: the owner who opens the gear again after the network came
    // back gets a second attempt rather than the first failure for ever.
    cache.delete(url);
    onError?.(`That part did not load (${String(err)}). Check the connection and try again.`);
    return null;
  }
}
