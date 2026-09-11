import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, cpSync, readdirSync } from "node:fs";
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
  plugins: [vue(), tailwindcss(), serviceWorkerPrecache(), mediapipeWasm()],
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
