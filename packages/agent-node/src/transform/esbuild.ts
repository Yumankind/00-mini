/**
 * `createEsbuildTransformer` — the one `Transformer` this package ships, over esbuild-wasm.
 *
 * WHY THIS IS THE ONLY FILE IN src/ THAT MENTIONS esbuild-wasm, AND WHY IT IMPORTS IT LAZILY.
 * `esbuild.wasm` is **12,216,279 bytes** (12.2 MB) at 0.25.9. A host that runs JavaScript and never
 * a `.ts` file must not download it, so there is no top-level `import "esbuild-wasm"` anywhere in
 * this package — only the `await import("esbuild-wasm")` inside `start()` below, which a bundler
 * splits into its own chunk and a browser fetches the first time somebody requires a `.ts`.
 *
 * HOW A BROWSER HOST SERVES THE WASM. Same-origin, from a path it controls, exactly like the
 * MediaPipe wasm in this product:
 *
 *     cp node_modules/esbuild-wasm/esbuild.wasm  public/esbuild/0.25.9/esbuild.wasm
 *     createEsbuildTransformer({ wasmURL: "/esbuild/0.25.9/esbuild.wasm" })
 *
 * The version is in the path on purpose: the JS half of esbuild-wasm refuses a wasm binary whose
 * version does not match it, so the two must be updated together and a cache that outlives a
 * deploy must not be able to pair them wrongly. Cross-origin isolation (COOP+COEP, which this
 * product already needs for the synchronous filesystem) makes a CDN copy unloadable anyway, which
 * is the second reason it is same-origin. `wasmModule` is the alternative for a host that already
 * has the bytes (a `WebAssembly.Module` it compiled itself, or one it pulled out of OPFS).
 *
 * THE TWO ENTRY POINTS, AND WHY THIS FILE NEGOTIATES. esbuild-wasm ships `lib/browser.js` (the
 * `browser` field) and `lib/main.js` (the `main` field), and their `initialize` contracts are
 * opposites: the browser one REQUIRES `wasmURL` or `wasmModule` and accepts `worker`; the node one
 * REFUSES all three by name and runs the wasm in a child process that starts itself. So `start()`
 * offers the options it was given, and when the answer is "that only works in the browser" it
 * initializes bare and carries on. That is what makes the same transformer usable from the vitest
 * suite (node entry, no wasmURL needed) and from a tab (browser entry, wasmURL required).
 *
 * DOES: `transform` (async, everywhere) and `transformSync` (node only — esbuild's browser build
 * throws "only works in node" and it is right to, the wasm is in another Worker). `target: es2022`,
 * `format: cjs`, dynamic `import()` lowered to `require` so the loader resolves it, `import.meta.url`
 * / `.filename` / `.dirname` supplied by `define` from the file's own path, the two JSX runtimes,
 * and an in-memory cache keyed by (path, sha256 of source).
 *
 * DOES NOT: bundle. `esbuild.build` needs a filesystem plugin and would defeat the whole point of a
 * loader — the files are already on the disk and change while you watch. Nor does it typecheck:
 * esbuild strips types, it does not verify them, which is the same deal `ts-node --swc` and Vite
 * give and should be said out loud.
 */

import { NodeCompatError } from "../errors.js";
import { TransformCache, type TransformOutput, type TransformRequest, type Transformer } from "../loader/transform.js";
import { pathToFileURL } from "../modules/small.js";
import { dirnameAbs } from "../paths.js";

export interface EsbuildTransformerOptions {
  /** Browser only: where `esbuild.wasm` is served from, same-origin. Ignored by the node entry. */
  wasmURL?: string;
  /** Browser only: an already-compiled module, for a host that has the bytes itself. */
  wasmModule?: WebAssembly.Module;
  /** Browser only: run the wasm in esbuild's own Worker (the default) rather than on this thread. */
  worker?: boolean;
  /** `true` appends an inline source map to every file. Off by default: it doubles the output. */
  sourcemap?: boolean;
  /** Overridden only by the tests, to prove the lazy import is the only road in. */
  load?: () => Promise<EsbuildApi>;
}

/** The sliver of esbuild-wasm's surface this file uses. Written out so nothing here imports it. */
export interface EsbuildApi {
  initialize(options: { wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }): Promise<void>;
  transform(source: string, options: Record<string, unknown>): Promise<{ code: string; map: string }>;
  transformSync?(source: string, options: Record<string, unknown>): { code: string; map: string };
  stop?(): void | Promise<void>;
  version?: string;
}

export interface EsbuildTransformer extends Transformer {
  /** Resolves when the wasm is up. Called for you by the first `transform`; here for a host that
   *  wants to pay the 12.2 MB before somebody is waiting on it. */
  ready(): Promise<void>;
  /** Shuts esbuild's worker (or, in node, its child process) down. */
  stop(): Promise<void>;
  readonly cache: TransformCache;
}

/**
 * One initialize per module instance, ever — esbuild's own rule ("Cannot call initialize more than
 * once"), so two transformers in one page share the wasm rather than fighting over it. The FIRST
 * caller's options win, which is why they are recorded and a later mismatch says so.
 */
let started: Promise<EsbuildApi> | null = null;
let startedWith: string | null = null;

/** Only for tests: forget the singleton so another set of options can be proven. */
export function resetEsbuildForTests(): void {
  started = null;
  startedWith = null;
}

async function loadEsbuild(): Promise<EsbuildApi> {
  // THE lazy import. Nothing else in src/ may name this package: see the header.
  const mod = (await import("esbuild-wasm")) as unknown as EsbuildApi & { default?: EsbuildApi };
  return typeof mod.transform === "function" ? mod : (mod.default as EsbuildApi);
}

async function start(opts: EsbuildTransformerOptions): Promise<EsbuildApi> {
  const fingerprint = JSON.stringify({ wasmURL: opts.wasmURL ?? null, module: Boolean(opts.wasmModule), worker: opts.worker ?? null });
  if (started) {
    if (startedWith !== null && startedWith !== fingerprint) {
      // Not fatal — the wasm that is up is the wasm you get — but silence here would be a mystery.
      console.warn(
        `@00/agent-node: esbuild-wasm was already initialized with ${startedWith}; this transformer's ${fingerprint} is ignored (esbuild allows one initialize per module instance).`,
      );
    }
    return started;
  }
  startedWith = fingerprint;
  started = (async (): Promise<EsbuildApi> => {
    const api = await (opts.load ?? loadEsbuild)();
    const wanted: { wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean } = {};
    if (opts.wasmURL) wanted.wasmURL = opts.wasmURL;
    if (opts.wasmModule) wanted.wasmModule = opts.wasmModule;
    if (opts.worker !== undefined) wanted.worker = opts.worker;
    const first = await attempt(api, wanted);
    if (first === null) return api;
    if (/only works in the browser/.test(first)) {
      // The node entry: it refuses wasmURL/wasmModule/worker and needs none of them.
      const second = await attempt(api, {});
      if (second === null || /more than once/.test(second)) return api;
      throw esbuildStartFailed(second);
    }
    if (/more than once/.test(first)) return api; // the host initialized it before we did; fine.
    throw esbuildStartFailed(first);
  })();
  try {
    return await started;
  } catch (err) {
    started = null;
    startedWith = null;
    throw err;
  }
}

async function attempt(api: EsbuildApi, options: Record<string, unknown>): Promise<string | null> {
  try {
    await api.initialize(options);
    return null;
  } catch (err) {
    return String((err as Error)?.message ?? err);
  }
}

function esbuildStartFailed(message: string): NodeCompatError {
  if (/Must provide either/.test(message)) {
    return new NodeCompatError(
      "ERR_ESBUILD_WASM_MISSING",
      "esbuild-wasm's browser build needs the wasm binary before it can transform anything: pass " +
        "`wasmURL` (serve node_modules/esbuild-wasm/esbuild.wasm — 12.2 MB — from your own origin, e.g. " +
        "/esbuild/0.25.9/esbuild.wasm; a cross-origin copy cannot load under COOP+COEP) or `wasmModule`",
    );
  }
  return new NodeCompatError("ERR_ESBUILD_START", `esbuild-wasm could not start: ${message}`);
}

function esbuildOptions(request: TransformRequest, sourcemap: boolean): Record<string, unknown> {
  const url = pathToFileURL(request.path).href;
  const options: Record<string, unknown> = {
    loader: request.loader,
    format: request.format,
    target: "es2022",
    platform: "browser",
    sourcefile: request.path,
    // `import()` must become a `require` the loader can resolve: a real dynamic import in a
    // `new Function` body would be resolved by the BROWSER, against the page's URL, and fetch a
    // 404 from the host's origin instead of reading the file next to the module.
    supported: { "dynamic-import": false },
    // `import.meta` has no meaning in a CommonJS body, and esbuild would warn and emit `{}`. We
    // know the path, so we answer the three questions a file actually asks.
    define: {
      "import.meta.url": JSON.stringify(url),
      "import.meta.filename": JSON.stringify(request.path),
      "import.meta.dirname": JSON.stringify(dirnameAbs(request.path)),
    },
  };
  if (sourcemap) {
    options.sourcemap = "inline";
    options.sourcesContent = true;
  }
  if (request.loader === "ts") return options;
  if (request.jsx === "automatic") {
    options.jsx = "automatic";
    options.jsxImportSource = request.jsxImportSource ?? "react";
  } else {
    // The classic runtime: `<div/>` becomes `React.createElement("div")` and the file is expected to
    // have a `React` in scope, which is what a package without a react dependency means by JSX.
    options.jsx = "transform";
  }
  return options;
}

/** esbuild's own refusals, re-thrown with this package's codes so a caller can branch on them. */
function esbuildFailure(err: unknown, request: TransformRequest): NodeCompatError {
  const message = String((err as Error)?.message ?? err);
  if (/[Tt]op-level await/.test(message)) {
    return new NodeCompatError(
      "ERR_TOP_LEVEL_AWAIT",
      `${request.path}: top-level await is not supported here — a CommonJS module body is a synchronous function and there is nowhere to await. Wrap the work in an async function and call it, or move it into the entry file's main().`,
    );
  }
  return new NodeCompatError("ERR_TRANSFORM_FAILED", `${request.path}: ${message}`);
}

export function createEsbuildTransformer(opts: EsbuildTransformerOptions = {}): EsbuildTransformer {
  const cache = new TransformCache();
  const sourcemap = opts.sourcemap ?? false;
  let api: EsbuildApi | null = null;

  const finish = (result: { code: string }, source: string, request: TransformRequest): TransformOutput =>
    cache.set(request.path, source, { code: result.code });

  return {
    cache,
    async ready(): Promise<void> {
      api = await start(opts);
    },
    async transform(source: string, request: TransformRequest): Promise<TransformOutput> {
      const hit = cache.get(request.path, source);
      if (hit) return hit;
      const esbuild = api ?? (api = await start(opts));
      try {
        return finish(await esbuild.transform(source, esbuildOptions(request, sourcemap)), source, request);
      } catch (err) {
        throw esbuildFailure(err, request);
      }
    },
    transformSync(source: string, request: TransformRequest): TransformOutput {
      const hit = cache.get(request.path, source);
      if (hit) return hit;
      if (!api) {
        throw new NodeCompatError(
          "ERR_TRANSFORM_PENDING",
          `${request.path}: this transformer has not started yet — the esbuild import is lazy (12.2 MB of wasm), and nothing synchronous can await it. Call \`await transformer.ready()\` once at startup, or warm the loader (\`await loader.warmup(entry)\`).`,
        );
      }
      if (!api.transformSync) {
        throw new NodeCompatError(
          "ERR_TRANSFORM_PENDING",
          `${request.path}: esbuild has no synchronous transform here — its browser build runs the wasm in another Worker, so transformSync throws "only works in node". Warm the loader first (await loader.warmup(entry)).`,
        );
      }
      try {
        return finish(api.transformSync(source, esbuildOptions(request, sourcemap)), source, request);
      } catch (err) {
        throw esbuildFailure(err, request);
      }
    },
    async stop(): Promise<void> {
      const esbuild = api;
      api = null;
      started = null;
      startedWith = null;
      await esbuild?.stop?.();
    },
  };
}
