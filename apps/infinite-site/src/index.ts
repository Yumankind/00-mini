/**
 * infinite-site — the static Worker that serves the embed loader and the owned agent's PWA.
 *
 * WHY there is a Worker at all, when everything it serves is a file: the snippet is
 * `<script async src="https://<host>/e/<ref>.js">`, and the ref is minted OFFLINE in the owner's
 * browser (§5.1). The server does not know it, must not have to know it, and there can never be a
 * file per ref. So one route rewrites every `/e/<anything>.js` to the single built `e.js`. That is
 * the whole of the server side of level 0 — no database, no registry, no request that knows who is
 * asking (§9.1).
 *
 * Everything else is either a real file (served by the asset layer before this code runs) or an
 * SPA route of the PWA, which gets index.html.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** The ref shape of §5.1: `ia_<base32 seconds>_<12 base32 chars>`. Anything else is not a loader URL. */
const EMBED_PATH = /^\/e\/[A-Za-z0-9_-]{4,80}\.js$/;

const immutable = "public, max-age=31536000, immutable";
const shortLived = "public, max-age=300";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (method !== "GET") return new Response("method not allowed", { status: 405 });

    const strip = (res: Response): Response =>
      request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;

    // The loader: one file, every ref.
    if (EMBED_PATH.test(url.pathname)) {
      const file = await env.ASSETS.fetch(new Request(new URL("/e.js", url).toString(), { method: "GET", headers: request.headers }));
      if (!file.ok) return new Response("// the embed is not built", { status: 503, headers: { "content-type": "application/javascript" } });
      const headers = new Headers(file.headers);
      headers.set("content-type", "application/javascript; charset=utf-8");
      // The build is content-addressed by the deploy, not by the ref, so a ref URL cannot be cached
      // for ever: five minutes at the edge keeps a fixed embed reaching every site the same day.
      headers.set("cache-control", shortLived);
      // Public, static and identical for everyone — CORS costs nothing and lets a page fetch it.
      headers.set("access-control-allow-origin", "*");
      headers.set("x-content-type-options", "nosniff");
      return strip(new Response(file.body, { status: 200, headers }));
    }

    if (url.pathname === "/robots.txt") {
      return strip(new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } }));
    }

    // Real files (the PWA's assets, its manifest, its service worker) were already served by the
    // asset layer. What reaches here is either an SPA route or a genuine miss.
    const asset = await env.ASSETS.fetch(request);
    if (asset.ok) {
      const headers = new Headers(asset.headers);
      headers.set("cache-control", url.pathname.startsWith("/assets/") ? immutable : shortLived);
      return strip(new Response(asset.body, { status: asset.status, headers }));
    }

    // The SPA fallback asks for "/" and NOT for "/index.html": the asset layer's html_handling
    // answers the explicit filename with a 307 back to "/", which is a redirect, not a page.
    const index = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), { method: "GET", headers: request.headers }));
    if (index.ok) {
      const headers = new Headers(index.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", shortLived);
      return strip(new Response(index.body, { status: 200, headers }));
    }
    return new Response("not found", { status: 404 });
  },
};
