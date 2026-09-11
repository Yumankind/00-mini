import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, cpSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * WHY A HAND-WRITTEN SERVICE WORKER, AND WHY A PLUGIN AROUND IT.
 *
 * The PWA must serve its own shell offline (docs/HANDOFF-infinite-agent.md §4.1: "0 ms shell paints,
 * offline-capable after this"), and `vite-plugin-pwa` is not installed and is not worth a dependency
 * for one precache list. `public/sw.js` is therefore the tracked source, written by hand — but it
 * cannot know the hashed asset names, and a stale precache list is a shell that boots into a blank
 * page after a deploy. So the build substitutes them: this plugin reads the emitted bundle, writes the
 * real file list and a build id into the copy that lands in `dist/`, and leaves the source alone. The
 * build id is what makes an update actually replace the old cache instead of joining it.
 *
 * IT ALSO INLINES ONE MODULE. A service worker has no module graph a node test can import, so the two
 * decisions a push actually makes live in `src/lib/push-notification.ts` and are tested there; this
 * plugin transpiles that file (esbuild, types stripped, `export` keywords removed) and drops it in at
 * the `//__PUSH_LIB__` marker. Inlining rather than `importScripts` because the worker must keep
 * working offline from cache with no second request, and rather than a duplicated copy in sw.js
 * because two copies of a rule are one copy of a rule and one bug. Missing marker or missing function
 * = the build FAILS: a shipped worker whose push handler references an undefined name shows nothing,
 * and a browser revokes a subscription that shows nothing (§4.6, gap audit B15).
 */
/** The names sw.js calls; each must survive the transpile or the worker is silently broken.
 *  Exported with `inlinePushLib` so test/push-notification.test.ts can run the REAL substitution and
 *  then run the REAL handlers — the alternative was a second copy of this logic in a test, which is
 *  the one thing that could pass while the build shipped something else. */
const PUSH_LIB_EXPORTS = ["notificationFor", "clickTarget", "clientToFocus"] as const;
const PUSH_LIB_MARKER = "//__PUSH_LIB__";
/** The second inlined module: what a `/~/…` path means (src/lib/virtual-route.ts), for the virtual
 *  ports of docs/HANDOFF-infinite-agent.md §1's terminal row. Same rule as the push one — a marker
 *  that vanished or a function that was renamed FAILS the build, because a fetch handler calling an
 *  undefined name would serve nothing and swallow every `/~/` request on the origin. */
const ROUTE_LIB_EXPORTS = ["routeFor", "requestUrlFor"] as const;
const ROUTE_LIB_MARKER = "//__VIRTUAL_ROUTE_LIB__";

/**
 * Transpile one pure module and drop it in at its marker.
 *
 * Inlining rather than `importScripts` because the worker must keep working offline from cache with
 * no second request, and rather than a duplicated copy in sw.js because two copies of a rule are one
 * copy of a rule and one bug.
 */
async function inlineLib(
  source: string,
  marker: string,
  moduleFile: string,
  names: readonly string[],
): Promise<string> {
  if (!source.includes(marker)) {
    throw new Error(`public/sw.js has no ${marker} marker — the handlers it feeds would ship undefined`);
  }
  const ts = readFileSync(moduleFile, "utf8");
  const { code } = await transformWithEsbuild(ts, moduleFile, { loader: "ts", format: "esm", target: "es2022" });
  // A worker is a classic script here (`register("/sw.js")` with no `type: "module"`), so the module's
  // `export` keywords have to go; the declarations they were attached to stay exactly as they are.
  const inlined = code.replace(/^export\s*\{[^}]*\};?$/gm, "").replace(/^export\s+/gm, "");
  for (const name of names) {
    if (!new RegExp(`function ${name}\\b`).test(inlined)) {
      throw new Error(`${moduleFile} no longer defines ${name}(), which public/sw.js calls`);
    }
  }
  return source.replace(marker, inlined);
}

export async function inlinePushLib(source: string, moduleFile: string): Promise<string> {
  return await inlineLib(source, PUSH_LIB_MARKER, moduleFile, PUSH_LIB_EXPORTS);
}

export async function inlineVirtualRouteLib(source: string, moduleFile: string): Promise<string> {
  return await inlineLib(source, ROUTE_LIB_MARKER, moduleFile, ROUTE_LIB_EXPORTS);
}

function serviceWorkerPrecache(): Plugin {
  const assets: string[] = [];
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "infinite-sw-precache",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    generateBundle(_options, bundle) {
      // ONLY THE SHELL. A lazy chunk is not part of the shell, and the local brain's is six
      // megabytes of WebGPU runtime that a person who never asks for a local model should never
      // download. Those are hashed, so the fetch handler caches them the first time they are
      // actually used — which is the correct moment.
      for (const [file, chunk] of Object.entries(bundle)) {
        const isEntryChunk = chunk.type === "chunk" && chunk.isEntry;
        const isStylesheet = chunk.type === "asset" && file.endsWith(".css");
        if (isEntryChunk || isStylesheet) assets.push(`/${file}`);
      }
    },
    async closeBundle() {
      const src = resolve(root, "public/sw.js");
      const dest = resolve(root, outDir, "sw.js");
      if (!existsSync(src)) return;
      const precache = ["/", "/manifest.webmanifest", "/icon.svg", ...assets].filter(
        (p, i, all) => all.indexOf(p) === i,
      );
      // A HASH, not a prefix of the list: the first sixteen characters of these paths are identical
      // in every build, so slicing the encoded string would have produced one id forever — and a
      // service worker whose cache name never changes never replaces its cache. The asset names are
      // content-hashed, so hashing the list is hashing the shell.
      const buildId = `ia-${createHash("sha256").update(precache.join("|")).digest("hex").slice(0, 12)}`;
      const out = readFileSync(src, "utf8")
        .replace('"__PRECACHE__"', JSON.stringify(precache, null, 2))
        .replace('"__BUILD_ID__"', JSON.stringify(buildId));
      const withPush = await inlinePushLib(out, resolve(root, "src/lib/push-notification.ts"));
      const withRoutes = await inlineVirtualRouteLib(withPush, resolve(root, "src/lib/virtual-route.ts"));
      writeFileSync(dest, withRoutes);
    },
  };
}

/**
 * MEDIAPIPE'S WASM, SERVED BY US. `LiteRtProvider` loads Google's LLM Inference runtime from
 * `/mediapipe/genai/wasm` on the app's own origin (packages/agent-models/src/litert.ts,
 * LITERT_DEFAULT_WASM_PATH) — never from a CDN, because a local brain that needs jsdelivr is not a
 * local brain the day the network is gone. The files live in `@mediapipe/tasks-genai/wasm/`, which is
 * agent-models' dependency, not this app's, so they are resolved through that package rather than
 * copied into the repo (three ~27 MB binaries do not belong in git). In dev the folder is served by a
 * middleware; in a build it is copied beside the bundle, where the service worker caches each file
 * the first time it is fetched, and the app is offline-capable from then on.
 *
 * Deploy note: each binary is over Cloudflare's 25 MiB per-asset cap, so apps/infinite-site cannot ship
 * them as static assets — its Worker serves this path from R2 (see that README). The copy here is for
 * dev, previews and self-hosting.
 */
function mediapipeWasm(): Plugin {
  const URL_PREFIX = "/mediapipe/genai/wasm/";
  // Not `require.resolve`: the package's `exports` map exposes neither package.json nor wasm/, so the
  // folder is reached the way pnpm lays it out — linked under the depending package's node_modules.
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmDir = resolve(here, "../../packages/agent-models/node_modules/@mediapipe/tasks-genai/wasm");
  const types: Record<string, string> = { ".wasm": "application/wasm", ".js": "text/javascript" };
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "infinite-mediapipe-wasm",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        if (!url.startsWith(URL_PREFIX)) return next();
        const name = url.slice(URL_PREFIX.length);
        // The folder is flat and the names are known: anything with a slash or a dot-segment is not one of them.
        if (!/^[A-Za-z0-9_]+\.(wasm|js)$/.test(name)) return next();
        const file = join(wasmDir, name);
        if (!existsSync(file)) return next();
        response.setHeader("content-type", types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
        response.setHeader("cache-control", "public, max-age=31536000, immutable");
        response.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (!existsSync(wasmDir)) return;
      const dest = resolve(root, outDir, "mediapipe", "genai", "wasm");
      cpSync(wasmDir, dest, { recursive: true });
      const copied = readdirSync(dest).length;
      console.log(`mediapipe wasm: ${copied} files copied to dist/mediapipe/genai/wasm`);
    },
  };
}

/**
 * ESBUILD'S WASM, SAME-ORIGIN, VERSIONED. `@00/agent-node`'s TypeScript transform initialises
 * esbuild-wasm from `/esbuild/<version>/esbuild.wasm` on THIS origin: under COOP+COEP a CDN copy
 * would not load, and esbuild's JS half refuses a binary whose version differs from its own, so the
 * version is in the path and read from the package rather than typed. 12 MB, under Cloudflare's 25 MiB
 * asset cap, so unlike MediaPipe's runtime it can ship as a static asset (build-site.sh copies dist/
 * minus embed/ and mediapipe/ — this folder rides along). Fetched only when a `.ts` file is run.
 */
function esbuildWasm(): Plugin {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgDir = resolve(here, "../../packages/agent-node/node_modules/esbuild-wasm");
  const version = ((): string => {
    try {
      return (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;
    } catch {
      return "unknown";
    }
  })();
  const file = join(pkgDir, "esbuild.wasm");
  const urlPath = `/esbuild/${version}/esbuild.wasm`;
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "infinite-esbuild-wasm",
    // The runner reads the path from this define, so the two can never disagree about the version.
    config() {
      return { define: { __ESBUILD_WASM_URL__: JSON.stringify(urlPath) } };
    },
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url?.split("?")[0] ?? "") !== urlPath || !existsSync(file)) return next();
        response.setHeader("content-type", "application/wasm");
        response.setHeader("cache-control", "public, max-age=31536000, immutable");
        response.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (!existsSync(file)) return;
      const dest = resolve(root, outDir, "esbuild", version);
      cpSync(file, join(dest, "esbuild.wasm"), { recursive: true });
      console.log(`esbuild wasm: ${version} copied to dist/esbuild/${version}/esbuild.wasm`);
    },
  };
}

/**
 * ONNX RUNTIME WEB'S WASM, SAME-ORIGIN. The third local brain (`TransformersProvider`,
 * packages/agent-models/src/transformers.ts) runs Gemma 4 E2B with its vision encoder on ONNX Runtime
 * Web, and that runtime loads a wasm module and its loader `.mjs` from
 * `env.backends.onnx.wasm.wasmPaths` — which Transformers.js DEFAULTS TO JSDELIVR
 * (`src/backends/onnx.js`, line 350). Same rule as MediaPipe's: a local brain that needs a CDN is not
 * a local brain the day the network is gone, and under COOP+COEP a CDN copy would not load anyway. So
 * the files are copied out of the installed package to `/ort/` on this origin and the provider's
 * `ONNX_DEFAULT_WASM_PATH` points there.
 *
 * WHY FOUR FILES AND NOT THE WHOLE `dist/`. `@huggingface/transformers` imports
 * `onnxruntime-web/webgpu`, whose default condition resolves to `ort.webgpu.bundle.min.mjs`, and the
 * only wasm names that appear anywhere in that bundle are `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`
 * (every browser but Safari) and `ort-wasm-simd-threaded.{mjs,wasm}` (Safari). The jsep and jspi
 * builds belong to other entry points and copying them would be 40 MB nobody fetches. The list is
 * closed and checked: a name that is no longer in the package FAILS the build, because a missing wasm
 * is a local brain that dies at session creation with a message about a fetch.
 *
 * WHY THE PATH IS NOT VERSIONED, unlike esbuild's. The `.mjs` and the `.wasm` are a matched pair, and
 * they can only ever come from one install — both are copied in the same `closeBundle`, so there is no
 * way to serve a mismatched pair. They are also under Cloudflare's 25 MiB asset cap (22.5 MiB is the
 * largest), so unlike MediaPipe's runtime they ship as ordinary static assets and the site Worker
 * needs no route for them; the asset layer's five-minute cache-control is what makes an unversioned
 * path safe across a deploy.
 */
function ortWasm(): Plugin {
  const URL_PREFIX = "/ort/";
  /**
   * Reached the way pnpm lays it out, like MediaPipe's — and through a REALPATH, which MediaPipe's
   * did not need. `onnxruntime-web` is a dependency of `@huggingface/transformers`, not of this app or
   * of agent-models, so pnpm puts it beside that package inside the store and links only the package
   * itself into `packages/agent-models/node_modules`. Lexical `..` on the link path would land back in
   * agent-models; `realpathSync` first is what makes `../../onnxruntime-web/dist` the store sibling it
   * actually is. Neither `onnxruntime-web` nor `@huggingface/transformers` exposes `dist/` or
   * `package.json` in its `exports` map, so there is no `require.resolve` road to it.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgLink = resolve(here, "../../packages/agent-models/node_modules/@huggingface/transformers");
  const distDir = existsSync(pkgLink) ? resolve(realpathSync(pkgLink), "../../onnxruntime-web/dist") : pkgLink;
  /** Closed list; see the note above. Order is (loader, binary) per browser family. */
  const FILES = [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
  ];
  /** Cloudflare refuses a static asset over this, which is why MediaPipe's runtime is in R2. */
  const ASSET_CAP = 25 * 1024 * 1024;
  const types: Record<string, string> = { ".wasm": "application/wasm", ".mjs": "text/javascript" };
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "infinite-ort-wasm",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        if (!url.startsWith(URL_PREFIX)) return next();
        const name = url.slice(URL_PREFIX.length);
        if (!FILES.includes(name)) return next();
        const file = join(distDir, name);
        if (!existsSync(file)) return next();
        response.setHeader("content-type", types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
        // `no-store` IN DEV, and not the year-long `immutable` the other two wasm middlewares use.
        // The path carries no version, so an `immutable` answer pins whatever headers it had at the
        // moment it was first fetched — which cost an hour on 2026-09-11: the fix below was added, the
        // server restarted, and the browser kept replaying the header-less copy from its HTTP cache
        // while the worker spawns went on failing. In production the file is served by the asset layer
        // with a five-minute cache-control, so the same trap is not there.
        response.setHeader("cache-control", "no-store");
        // THE ISOLATION HEADERS, ON THIS RESPONSE. `ort-wasm-simd-threaded.asyncify.mjs` is not just a
        // script the page loads — ORT's THREADED build spawns dedicated workers from it, and a worker
        // created by a cross-origin-isolated document is refused unless ITS OWN script response
        // carries a compatible `Cross-Origin-Embedder-Policy`. Without this the main-thread fetch
        // succeeds (200) and the three worker spawns fail with `ERR_BLOCKED_BY_RESPONSE`, which is
        // silent: the session build simply never finishes. Seen live on 2026-09-11.
        //
        // A middleware added in `configureServer` runs BEFORE vite's own, so `server.headers` has not
        // been applied by the time this handler ends the response — it has to set them itself.
        for (const [name_, value] of Object.entries(ISOLATION_HEADERS)) response.setHeader(name_, value);
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (!existsSync(distDir)) return;
      const dest = resolve(root, outDir, "ort");
      for (const name of FILES) {
        const from = join(distDir, name);
        if (!existsSync(from)) {
          throw new Error(`onnxruntime-web no longer ships ${name}, which the ONNX local brain loads from /ort/`);
        }
        const bytes = readFileSync(from);
        if (bytes.byteLength > ASSET_CAP) {
          throw new Error(
            `${name} is ${Math.round(bytes.byteLength / 1048576)} MiB, over Cloudflare's 25 MiB asset cap — route /ort/ through R2 like /mediapipe/ before shipping this`,
          );
        }
        cpSync(from, join(dest, name));
      }
      console.log(`onnx runtime wasm: ${FILES.length} files copied to dist/ort`);
    },
  };
}

/**
 * THE LAN, OVER HTTPS. Everything the agent is built on — OPFS, WebGPU, WebCrypto keys, the service
 * worker — exists only in a secure context, which plain http gets on localhost and nowhere else. To
 * open the app from a phone or another machine on the LAN, the dev server must speak https, and the
 * engine already minted a self-signed certificate with this Mac's names and IPs for its own LAN proxy
 * (apps/00d/src/tls.ts, <dataRoot>/tls). `INFINITE_LAN=1` reuses it: host 0.0.0.0, https on, one
 * trust prompt on the far device. Absent the flag or the files, the server stays localhost-only http.
 */
function lanHttps(): { host: string; https?: { key: Buffer; cert: Buffer } } | undefined {
  if (process.env.INFINITE_LAN !== "1") return undefined;
  const dir =
    process.env.ZEROZERO_DATA_DIR ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "00")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "00"));
  const key = join(dir, "tls", "key.pem");
  const cert = join(dir, "tls", "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    console.warn(`INFINITE_LAN=1 but no certificate at ${dir}/tls — start the 00 app once, it mints one; serving plain http on localhost only`);
    return undefined;
  }
  return { host: "0.0.0.0", https: { key: readFileSync(key), cert: readFileSync(cert) } };
}

/**
 * CROSS-ORIGIN ISOLATION, IN DEV AND IN PREVIEW, SO DEV AND PROD AGREE.
 *
 * `SharedArrayBuffer` — and with it `Atomics.wait`, and with it the synchronous filesystem a script
 * in the power shell gets (`src/power/fs-service.ts`) — exists only in a page the browser calls
 * `crossOriginIsolated`, which is these two headers on the document and nothing else. In production
 * they come from the site Worker (`apps/infinite-site/src/headers.ts`); here they come from vite, so
 * that `pnpm dev` is not a different app from the deploy — the difference would show up as
 * `SyncUnsupportedError` on a laptop and nowhere else, which is the worst kind of bug to chase.
 *
 * `credentialless` rather than `require-corp` for the same reason as in production: every
 * cross-origin load this app makes is CORS-enabled (the model mirror at dl.0-0.chat answers
 * `Access-Control-Allow-Origin: *`, the relay and SFU APIs are CORS), and `credentialless` asks
 * nothing of the far side for those. See apps/infinite-site/README.md.
 *
 * They are set on EVERY response rather than on documents only, because vite's dev server has no
 * per-route hook and a policy header on a JS asset is inert — the browser reads COOP and COEP off
 * documents and workers.
 */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [vue(), tailwindcss(), serviceWorkerPrecache(), mediapipeWasm(), esbuildWasm(), ortWasm()],
  /**
   * THE NODE RUNTIME IS A MODULE WORKER. `src/power/js-runner.ts` starts one process per `node`
   * command with `new Worker(new URL("./node-runtime-worker.ts", import.meta.url), { type: "module" })`,
   * which vite turns into its own chunk. `format: "es"` because that Worker is declared `type:
   * "module"` and because the default (`iife`) cannot code-split — `@00/agent-node` and the packages
   * it stands on would otherwise be inlined into one file per worker entry.
   */
  worker: { format: "es" },
  // The owned agent lives on ONE product origin (§3.1: OPFS and the push subscription are per origin),
  // so the app is always served from the root and every path here is absolute.
  base: "/",
  server: { port: 5273, headers: ISOLATION_HEADERS, ...lanHttps() },
  preview: { port: 5273, headers: ISOLATION_HEADERS },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
