/**
 * The preview host's SERVICE WORKER, as text.
 *
 * WHY IT IS A STRING AND NOT A FILE. This Worker has no build step and no node_modules (see
 * README.md): `wrangler deploy` bundles `src/index.ts` and that is the whole pipeline. A service
 * worker has to reach the browser as a script at a path with the right headers on it —
 * `Service-Worker-Allowed`, `no-store` — and serving it from the Worker itself is the shortest road
 * to exactly those headers. So the source lives here, inside a `String.raw`, which is why nothing
 * below may use a backtick or a `${`.
 *
 * WHAT IT DOES, IN ONE PARAGRAPH. The app on the OTHER origin posts a folder of files into this
 * origin's Cache Storage (the bootstrap page does the writing; see bootstrap.ts). This worker serves
 * them back under `/s/<siteId>/…` and injects the inspector into every HTML page on the way out. A
 * request under `/p/<siteId>/<port>/…` is a virtual port — something a script in the app's tab is
 * listening on — so it is forwarded to the bootstrap page over a MessageChannel, which relays it to
 * the app, which answers with its own `handleVirtualRequest`. Ten seconds without an answer is a 504
 * that says why, because the alternative is a frame that spins forever after the app's tab closed.
 *
 * WHAT IT NEVER DOES. It caches nothing of its own, reaches no origin but this one, and holds
 * nothing but what the app posted, for the life of the tab that posted it.
 */

/**
 * THE ROUTING DECISION — the twin of `previewRouteFor` in `apps/infinite/src/lib/pick.ts`.
 *
 * The two cannot be one module: this Worker is a separate deploy unit outside the pnpm workspace,
 * with no node_modules and no dependency on anything in `packages/`. So it is two copies, and
 * `apps/infinite/test/preview-live.test.ts` reads BOTH files, takes the TypeScript off the app's
 * copy, and fails the day the decisions stop being the same one. If you change this, change that.
 */
const ROUTE_JS = String.raw`const PREVIEW_SITE_PREFIX = "/s/";
const PREVIEW_PORT_PREFIX = "/p/";

function previewRouteFor(pathname) {
  if (typeof pathname !== "string") return null;
  const site = pathname.startsWith(PREVIEW_SITE_PREFIX);
  const port = pathname.startsWith(PREVIEW_PORT_PREFIX);
  if (!site && !port) return null;
  const rest = pathname.slice(PREVIEW_SITE_PREFIX.length).split("/");
  const siteId = rest.shift() ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) return null;
  const decoded = [];
  for (const raw of rest) {
    if (raw === "") {
      decoded.push("");
      continue;
    }
    let part;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === ".." || part === "." || part.includes("/") || part.includes("\\") || part.includes("\0")) return null;
    decoded.push(part);
  }
  if (site) return { kind: "site", siteId, path: decoded.join("/") };
  const head = decoded.shift() ?? "";
  if (!/^[1-9][0-9]{0,4}$/.test(head) || Number(head) > 65535) return null;
  return { kind: "port", siteId, port: Number(head), subpath: "/" + decoded.join("/") };
}`;

export const PREVIEW_SW_SOURCE =
  String.raw`/*
 * 00 preview host — the service worker. Authored in src/preview-sw.ts; that file says why.
 *
 * It serves ONLY what the page above it put into Cache Storage, and forwards ONLY the virtual-port
 * paths. It caches nothing of its own and reaches no other origin.
 */
"use strict";

const TIMEOUT_MS = 10000;
const CACHE_PREFIX = "00-preview-";
const INSPECTOR_TAG = '<script src="/__inspector.js"></' + 'script>';

` +
  ROUTE_JS +
  String.raw`

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function plain(status, text) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

/** A directory is its index.html — the rule every static server has had forever. */
function candidates(path) {
  if (path === "" || path.endsWith("/")) return [path + "index.html"];
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".") ? [path] : [path, path + "/index.html"];
}

async function stored(siteId, path) {
  const cache = await caches.open(CACHE_PREFIX + siteId);
  for (const candidate of candidates(path)) {
    const key = "/s/" + siteId + "/" + candidate.split("/").map(encodeURIComponent).join("/");
    const hit = await cache.match(new Request(new URL(key, self.location.origin).toString()));
    if (hit) return { hit: hit, path: candidate };
  }
  return null;
}

/**
 * THE INJECTION. Every HTML page this worker serves gets the inspector, and gets told which workspace
 * file it came from — the app stamped that on the stored response, and the page reads it back out of
 * the meta so the chip in the composer can name a file rather than a URL.
 */
function inject(html, source) {
  const meta = source ? '<meta name="00-source" content="' + source.replace(/"/g, "&quot;") + '">' : "";
  let out = html;
  if (meta) out = out.includes("</head>") ? out.replace("</head>", meta + "</head>") : meta + out;
  if (out.includes("</body>")) return out.replace("</body>", INSPECTOR_TAG + "</body>");
  if (out.includes("</html>")) return out.replace("</html>", INSPECTOR_TAG + "</html>");
  return out + INSPECTOR_TAG;
}

async function serveSite(route) {
  const found = await stored(route.siteId, route.path);
  if (!found) {
    return plain(
      404,
      (route.path || "index.html") +
        " is not in this preview. The app posts a folder of files and this serves them back, so a " +
        "file it did not post has nowhere to come from."
    );
  }
  const type = found.hit.headers.get("content-type") || "";
  const source = found.hit.headers.get("x-00-source");
  const headers = new Headers(found.hit.headers);
  headers.set("cache-control", "no-store");
  headers.delete("x-00-source");
  if (type.indexOf("html") < 0) return new Response(found.hit.body, { status: 200, headers: headers });
  const html = await found.hit.text();
  headers.delete("content-length");
  return new Response(inject(html, source), { status: 200, headers: headers });
}

/** The bootstrap page, never a served frame: the relay lives at the root of this origin. */
async function hostClient() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    try {
      if (new URL(client.url).pathname === "/") return client;
    } catch (err) {
      /* a client with an unparseable url is not the one we want */
    }
  }
  return null;
}

const NO_HOST =
  "the preview host page is gone, so there is nothing to forward this to. This URL is served by a " +
  "script running in the app's tab, and it answers only while that tab is open.";

async function servePort(route, request) {
  const client = await hostClient();
  if (!client) return plain(504, NO_HOST);
  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength) body = new Uint8Array(buffer);
    } catch (err) {
      /* an unreadable body is sent as none */
    }
  }
  const headers = {};
  request.headers.forEach(function (value, name) {
    headers[name] = value;
  });
  const search = new URL(request.url).search;

  const answer = await new Promise(function (resolve) {
    const channel = new MessageChannel();
    const timer = setTimeout(function () {
      resolve(null);
    }, TIMEOUT_MS);
    channel.port1.onmessage = function (event) {
      clearTimeout(timer);
      resolve(event.data);
    };
    client.postMessage(
      {
        kind: "00-preview-port-request",
        v: 1,
        siteId: route.siteId,
        port: route.port,
        request: {
          method: request.method,
          url: route.subpath + (search && search !== "?" ? search : ""),
          headers: headers,
          body: body
        }
      },
      [channel.port2]
    );
  });

  if (!answer) return plain(504, NO_HOST);
  if (!answer.ok) return plain(500, String(answer.error || "the app could not answer"));
  const out = new Headers(answer.response.headers || {});
  out.set("cache-control", "no-store");
  const type = out.get("content-type") || "";
  const status = answer.response.status || 200;
  if (type.indexOf("html") < 0) return new Response(answer.response.body || null, { status: status, headers: out });
  // A served page gets the inspector too: to the person looking at it, it is the same kind of page.
  const html = new TextDecoder().decode(answer.response.body || new Uint8Array(0));
  out.delete("content-length");
  return new Response(inject(html, null), { status: status, headers: out });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const route = previewRouteFor(url.pathname);
  if (!route) return;
  event.respondWith(route.kind === "site" ? serveSite(route) : servePort(route, event.request));
});
`;
