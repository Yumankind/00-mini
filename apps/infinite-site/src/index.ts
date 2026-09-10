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
 *
 * THE ONE EXCEPTION, AND WHY IT IS AN R2 BINDING: `/mediapipe/genai/wasm/*` and `/litert/*`.
 * The PWA's preferred local brain loads Google's LLM Inference runtime from
 * `/mediapipe/genai/wasm` ON ITS OWN ORIGIN (packages/agent-models/src/litert.ts,
 * `LITERT_DEFAULT_WASM_PATH`), because a local brain that needs a CDN is not a local brain the day
 * the network is gone. Those are three ~27 MB binaries and Cloudflare caps a static asset at
 * 25 MiB, so `scripts/build-site.sh` deliberately leaves `dist/mediapipe/` out of `public/` and
 * this Worker answers the path from the public bucket instead (`00-downloads`, the mirror of
 * §12.7, also reachable cross-origin as `dl.0-0.chat`). Same-origin was the choice of the two the
 * README offered: the service worker only caches `response.type === "basic"`, so cross-origin bytes
 * are never in the offline promise of §4.4 — these are, the first time the model loads.
 *
 * `/litert/*` is the same door for the weights, so a deploy may point `modelBaseUrl` at its own
 * origin (`https://<site>/litert`) and have the service worker keep those too. `dl.0-0.chat` stays
 * the default; this is its same-origin twin, not its replacement.
 *
 * Both prefixes are answered BEFORE the SPA fallback and never by the asset layer — no such file
 * exists in `public/`, and without this an embedded `<script>` for a 27 MB wasm would get
 * index.html. R2 is read-only here: a GET, a HEAD, a Range, an If-None-Match, and nothing else.
 *
 * AND IT NOW DECIDES THE CROSS-ORIGIN POLICY. The PWA is cross-origin isolated so that a script in
 * the power shell can have a synchronous filesystem (`SharedArrayBuffer` + `Atomics.wait`, which the
 * browser hands out only to an isolated page). Isolation is two headers on the DOCUMENT, and the
 * asset layer sends neither — which is why `assets.run_worker_first` is now on in wrangler.jsonc and
 * this Worker answers every request, `/` and `/sw.js` included. Which header goes on which route is
 * `src/headers.ts`, alone, so it can be tested without a deploy.
 */

import { applyCrossOrigin, kindFor } from "./headers.js";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /**
   * The public bucket `00-downloads` (scripts/publish-litert-models.sh fills it). Typed
   * structurally rather than as `R2Bucket`: this folder has no node_modules and therefore no
   * `@cloudflare/workers-types`, the same reason `ASSETS` is spelled out above.
   */
  MODELS: R2Like;
}

interface R2Range {
  offset: number;
  length: number;
}

interface R2Head {
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  writeHttpMetadata(headers: Headers): void;
}

interface R2Body extends R2Head {
  body: ReadableStream;
}

interface R2Like {
  head(key: string): Promise<R2Head | null>;
  get(key: string, options?: { range?: R2Range }): Promise<R2Body | null>;
}

/** The ref shape of §5.1: `ia_<base32 seconds>_<12 base32 chars>`. Anything else is not a loader URL. */
const EMBED_PATH = /^\/e\/[A-Za-z0-9_-]{4,80}\.js$/;

const immutable = "public, max-age=31536000, immutable";
const shortLived = "public, max-age=300";

/**
 * MUST TRACK `@mediapipe/tasks-genai` IN packages/agent-models (its `LITERT_VERSION`, and the
 * version pinned in that package's package.json). The runtime's loader `.js` and its `.wasm` are one
 * build: serving a mismatched pair fails at instantiation, not at the fetch, which is a much worse
 * error to read. Bumping the dependency there means bumping this line and re-running
 * `scripts/publish-litert-models.sh`, which puts the new folder in the bucket beside the old one.
 */
const MEDIAPIPE_VERSION = "0.10.29";

const MEDIAPIPE_WASM_PREFIX = "/mediapipe/genai/wasm/";
/** The whole of that folder at 0.10.29. A closed list, because a name is not a place to be creative. */
const MEDIAPIPE_WASM_FILES = new Set([
  "genai_wasm_internal.js",
  "genai_wasm_internal.wasm",
  "genai_wasm_module_internal.js",
  "genai_wasm_module_internal.wasm",
  "genai_wasm_nosimd_internal.js",
  "genai_wasm_nosimd_internal.wasm",
]);

const LITERT_PREFIX = "/litert/";
/**
 * The weights, whose names this Worker deliberately does NOT know: the catalogue is published from
 * the Mac and grows a row without a deploy here (§12.7), so the shape is the allow-list and R2's own
 * miss is the answer for everything else. Flat keys only — no slash, no dot-segment, no traversal.
 */
const LITERT_ASSET = /^[A-Za-z0-9._-]+\.(?:task|litertlm)$/;
/** The three files that travel with them: the index, Google's notice, and the Gemma terms (§12.7). */
const LITERT_SIDECARS = new Set(["catalog.json", "NOTICE.txt", "GEMMA_TERMS.md"]);

/** What the mirror stores, when it stored no content-type of its own. */
const TYPE_BY_EXT: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".task": "application/octet-stream",
  ".litertlm": "application/octet-stream",
};

/** The R2 key behind a mirrored path, and how long it may be held. `null` = not one of ours. */
function mirrorTarget(pathname: string): { key: string; cacheControl: string } | null {
  if (pathname.startsWith(MEDIAPIPE_WASM_PREFIX)) {
    const name = pathname.slice(MEDIAPIPE_WASM_PREFIX.length);
    if (!MEDIAPIPE_WASM_FILES.has(name)) return null;
    return { key: `mediapipe/genai/${MEDIAPIPE_VERSION}/wasm/${name}`, cacheControl: immutable };
  }
  if (pathname.startsWith(LITERT_PREFIX)) {
    const name = pathname.slice(LITERT_PREFIX.length);
    if (!LITERT_ASSET.test(name) && !LITERT_SIDECARS.has(name)) return null;
    // The catalogue gains a row when a publish adds one, so it is the single short-lived key here;
    // a weight is content-named and never changes under its own name.
    return { key: `litert/${name}`, cacheControl: name === "catalog.json" ? shortLived : immutable };
  }
  return null;
}

/**
 * One byte range, or `"unsatisfiable"` (→ 416), or `null` for "serve the whole thing". A multi-range
 * request lands on `null` on purpose: answering the whole object is a legal reply to a Range this
 * server does not speak, and the alternative is a multipart body nobody here needs.
 */
function parseRange(header: string | null, size: number): R2Range | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

/** `If-None-Match`, list and `*` and weak tags included. R2 hands back a strong tag; a resumed
 *  download may hand it back weakened by a proxy, so both are compared unquoted and unweakened. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const mine = bare(etag);
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === mine);
}

/**
 * Read one mirrored object out of R2 and answer it as a file server would. The Worker streams the
 * body straight through, so the 25 MiB static-asset cap that put these here does not apply again.
 */
async function serveMirrored(request: Request, bucket: R2Like, key: string, cacheControl: string): Promise<Response> {
  // HEAD first, always: it is what makes a correct 416 and a correct `content-range` possible (both
  // need the full size before the read), and for a HEAD request it is the whole answer — a 27 MB
  // body is never fetched to be thrown away.
  const head = await bucket.head(key);
  if (!head) return new Response("not found", { status: 404 });

  const base = (): Headers => {
    const headers = new Headers();
    head.writeHttpMetadata(headers); // content-type/encoding/language as the mirror stored them
    const ext = key.slice(key.lastIndexOf("."));
    if (!headers.get("content-type")) headers.set("content-type", TYPE_BY_EXT[ext] ?? "application/octet-stream");
    headers.set("cache-control", cacheControl); // ours, not the object's
    headers.set("etag", head.httpEtag);
    headers.set("accept-ranges", "bytes");
    // The bucket itself answers any origin (§12.7's read-only CORS policy), and so does its twin:
    // a self-hosted PWA may point VITE_LITERT_WASM_BASE or its modelBaseUrl at this host.
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", "content-length, content-range, accept-ranges, etag");
    headers.set("x-content-type-options", "nosniff");
    // These are published to be fetched from anywhere, and under this origin's own COEP they are
    // also fetched by an isolated page — `cross-origin` is the header that permits both.
    applyCrossOrigin(headers, key, "mirror");
    return headers;
  };

  if (etagMatches(request.headers.get("if-none-match"), head.httpEtag)) {
    return new Response(null, { status: 304, headers: base() });
  }

  const range = parseRange(request.headers.get("range"), head.size);
  if (range === "unsatisfiable") {
    const headers = base();
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  // A HEAD answers with exactly the headers the GET would carry — a ranged one included, so a
  // resuming downloader that probes with HEAD reads the same 206 and `content-range` it will get.
  if (request.method === "HEAD") {
    const headers = base();
    if (range) {
      headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
      headers.set("content-length", String(range.length));
      return new Response(null, { status: 206, headers });
    }
    headers.set("content-length", String(head.size));
    return new Response(null, { status: 200, headers });
  }

  const object = await bucket.get(key, range ? { range } : undefined);
  if (!object) return new Response("not found", { status: 404 }); // deleted between the two calls
  const headers = base();
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("content-length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(head.size));
  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const mirrored = mirrorTarget(url.pathname);
    const method = request.method === "HEAD" ? "GET" : request.method;

    // A cross-origin `Range` is only safelisted in its simplest form, so the one door that expects
    // ranged reads answers a preflight rather than leaving a self-hoster with an opaque failure.
    if (method === "OPTIONS" && mirrored) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "range, if-none-match",
          "access-control-max-age": "86400",
        },
      });
    }
    if (method !== "GET") return new Response("method not allowed", { status: 405 });

    // The mirror, BEFORE the asset layer and before the SPA fallback: nothing under these two
    // prefixes is a file in public/, and index.html is not a wasm module.
    if (mirrored) return serveMirrored(request, env.MODELS, mirrored.key, mirrored.cacheControl);
    if (url.pathname.startsWith(MEDIAPIPE_WASM_PREFIX) || url.pathname.startsWith(LITERT_PREFIX)) {
      // Under a mirrored prefix but not a name we serve. The SPA must never answer here.
      return new Response("not found", { status: 404 });
    }

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
      // NEVER `same-origin` here: the loader exists to be a `<script>` on somebody else's page.
      applyCrossOrigin(headers, url.pathname, "embed");
      return strip(new Response(file.body, { status: 200, headers }));
    }

    if (url.pathname === "/robots.txt") {
      const headers = new Headers({ "content-type": "text/plain" });
      applyCrossOrigin(headers, url.pathname, "asset");
      return strip(new Response("User-agent: *\nAllow: /\n", { headers }));
    }

    // Real files (the PWA's assets, its manifest, its service worker) were already served by the
    // asset layer. What reaches here is either an SPA route or a genuine miss.
    const asset = await env.ASSETS.fetch(request);
    if (asset.ok) {
      const headers = new Headers(asset.headers);
      headers.set("cache-control", url.pathname.startsWith("/assets/") ? immutable : shortLived);
      // `/sw.js` and `/index.html` are files, and both are documents in the sense that matters:
      // the shell's isolation and the service worker's come from the response the browser stored.
      applyCrossOrigin(headers, url.pathname, kindFor(url.pathname));
      return strip(new Response(asset.body, { status: asset.status, headers }));
    }

    // The SPA fallback asks for "/" and NOT for "/index.html": the asset layer's html_handling
    // answers the explicit filename with a 307 back to "/", which is a redirect, not a page.
    const index = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), { method: "GET", headers: request.headers }));
    if (index.ok) {
      const headers = new Headers(index.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", shortLived);
      // A miss that this Worker chose to answer with the shell IS a document, whatever the path was
      // — with the one exception of `/~/…`, which belongs to a script in somebody's tab and is not
      // this Worker's to label (see src/headers.ts).
      applyCrossOrigin(headers, url.pathname, kindFor(url.pathname) === "served" ? "served" : "document");
      return strip(new Response(index.body, { status: 200, headers }));
    }
    return new Response("not found", { status: 404 });
  },
};
