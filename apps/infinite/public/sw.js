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
 *
 * SO IS `__PUSH_LIB__`: the two pure decisions a push makes (a payload becomes a notification; a click
 * becomes a url) live in `src/lib/push-notification.ts`, where a node test can reach them, and the
 * same plugin transpiles that module and inlines it at the marker below. THIS FILE IS NEVER RUN AS
 * IT STANDS — `main.ts` registers `/sw.js` only in a production build, and the copy served there is
 * the substituted one in `dist/`. The build fails loudly if the marker or either function goes
 * missing, because a service worker that takes a push and shows nothing gets its subscription REVOKED
 * by the browser (§4.6, gap audit B15).
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

// ── Notifications (§4.6, §5.7) ──────────────────────────────────────────────────────────────────
//
// The payload the sender writes is `{ kind, appId, count, title, body, url }`, sealed under this
// browser's own subscription keys (moltworker `worker/src/infinite/push-send.ts`). Both handlers here
// are plumbing only; every judgement they make comes from the inlined module.

//__PUSH_LIB__

self.addEventListener("push", (event) => {
  // `event.data` is null for an empty push, and `text()` can throw on a payload that failed to
  // decrypt. Either way something MUST be shown: `userVisibleOnly: true` was a promise, and a browser
  // that catches us breaking it drops the subscription.
  let raw = "";
  try {
    raw = event.data ? event.data.text() : "";
  } catch (err) {
    console.warn("[sw] push payload unreadable", err);
  }
  const plan = notificationFor(raw);
  event.waitUntil(self.registration.showNotification(plan.title, plan.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = clickTarget(event.notification.data, self.location.origin);
  event.waitUntil(
    (async () => {
      // `includeUncontrolled` matters on the first load after an update: a page controlled by the
      // PREVIOUS worker is still the person's open tab, and opening a second one on top of it is the
      // behaviour everyone complains about.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const index = clientToFocus(windows.map((c) => c.url), target);
      if (index < 0) {
        await self.clients.openWindow(target);
        return;
      }
      const client = windows[index];
      await client.focus();
      // Same origin, different page: the shell routes client-side, so navigating an already-open tab
      // is what "focus an open client" means for a single-page app.
      if (client.url !== target && typeof client.navigate === "function") {
        await client.navigate(target).catch(() => undefined);
      }
    })(),
  );
});

// The page asks for this after an update banner; nothing else may skip the wait.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});
