/*
 * The owned agent's service worker — docs/HANDOFF-infinite-agent.md §4.1 and §4.4.
 *
 * WHY BY HAND. The whole promise of this app is that after the first load nothing of ours is needed:
 * the agent, its files and its local brain are already in the browser. That promise is this file. It
 * is deliberately small enough to read in one sitting, because a service worker that goes wrong
 * bricks the origin, and it precaches ONLY the shell — never model weights (Cache Storage holds those
 * under the models package's own key, and they are hundreds of megabytes), never a cross-origin
 * request, never a non-GET.
 *
 * PRECACHE and BUILD_ID are substituted at build time by the plugin in vite.config.ts, which knows
 * the hashed asset names. In the source they are the placeholders below, so this file stays readable.
 */

const BUILD_ID = "__BUILD_ID__";
const PRECACHE = "__PRECACHE__";
const CACHE = `infinite-shell-${BUILD_ID}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One failing entry must not fail the whole install, or a single 404 leaves the origin with no
      // worker at all and the offline promise silently gone. Add what answers; log what does not.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch (err) {
            console.warn("[sw] precache miss", url, err);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("infinite-shell-") && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/** A page load, however the browser spells it. Everything else is an asset or somebody else's. */
function isShellNavigation(request) {
  return request.mode === "navigate" || (request.method === "GET" && request.headers.get("accept")?.includes("text/html"));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // weights, fonts, a connected brain: never ours to cache

  if (isShellNavigation(request)) {
    // The app is a single shell; every route inside it is client-side. Network first so a deploy is
    // picked up while online, the cached shell the moment it is not.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          void cache.put("/", fresh.clone());
          return fresh;
        } catch {
          const cached = (await caches.match("/")) ?? (await caches.match(request));
          return cached ?? new Response("Offline, and this browser has no cached shell yet.", { status: 503 });
        }
      })(),
    );
    return;
  }

  // Hashed assets: the name IS the version, so a hit is always correct and never stale.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const fresh = await fetch(request);
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(CACHE);
        void cache.put(request, fresh.clone());
      }
      return fresh;
    })(),
  );
});

// The page asks for this after an update banner; nothing else may skip the wait.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});
