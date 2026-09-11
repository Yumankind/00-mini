/**
 * `createLoader` — `require`, the CommonJS module wrapper, and the ESM road into it.
 *
 * WHY A LOADER AND NOT A BUNDLER. Because the files are already on the filesystem, they change while
 * the person watches, and a bundle step between "save" and "run" is exactly the delay this runtime
 * exists to remove. `require()` reads a file and runs it, which is what Node does, and it is small.
 *
 * WHAT IT NEEDS AND WHY THAT IS THE INTERESTING PART. `require` is SYNCHRONOUS, so the loader needs
 * a synchronous view of the filesystem. There are two, and the caller picks:
 *
 *   - `snapshotLoaderFs(files)` — a map of virtual path → bytes, read once. Bounded, honest, and
 *     stale the moment a module writes a file another module requires. This is what
 *     `apps/infinite/src/power/js-runner.ts` has today, and adopting this package can start here.
 *   - `backendLoaderFs(backend)` — the real filesystem, through the shared-memory channel of
 *     `src/fs/sync-channel.ts`. Needs a Worker on a cross-origin-isolated origin, and is the one
 *     that makes `npm install` followed by `require("express")` work in one run.
 *
 * DOES: the resolution algorithm of `src/loader/resolve.ts` (relative, absolute, the `node_modules`
 * walk, `exports`, the `browser` map, `index`, the extension ladder); the module cache with cycles
 * (a module is cached BEFORE it runs, so a cycle sees a half-built `exports` rather than looping);
 * `require.resolve` (with `paths`), `require.cache`, `require.main`, `module.paths`,
 * `module.children`; JSON modules; `.mjs` and `"type": "module"` as ESM; ESM syntax anywhere,
 * detected and transformed (`src/loader/esm.ts`, whose limits are listed in its own header).
 *
 * DOES NOT: `require.extensions` (deprecated in Node, and a hook into a `new Function` call is a
 * footgun), `.node` addons (refused by name in the resolver), `NODE_PATH`, conditional exports the
 * host did not name in `conditions`, or source maps. It also needs `new Function`, which is
 * `unsafe-eval` — a Content-Security-Policy without it stops this dead, and the host must say so.
 */

import { NodeCompatError, failModuleNotFound } from "../errors.js";
import { dirnameAbs, normalizeAbs, resolveAbs } from "../paths.js";
import type { NodeFsBackend } from "../fs/backend.js";
import { builtinModule, BUILTIN_NAMES, makeConsole, type BuiltinContext } from "../modules/index.js";
import { createProcess, ExitSignal, type NodeProcess } from "../modules/process.js";
import { Buffer } from "../modules/core.js";
import type { HttpBridge, NetworkBridge } from "../modules/http.js";
import type { ProcessManager } from "../process/manager.js";
import type { SyncCompressor } from "../modules/zlib.js";
import { applyBrowserMap, EMPTY_MODULE, resolveRequest, nodeModulesPaths, type ResolveHost } from "./resolve.js";
import { hasEsmSyntax, transformEsm } from "./esm.js";

/** The synchronous view of the filesystem `require` needs. Two implementations ship below. */
export interface LoaderFs {
  readFileSync(path: string): Uint8Array;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean } | null;
}

export interface NodeModule {
  id: string;
  filename: string;
  path: string;
  exports: unknown;
  loaded: boolean;
  parent: NodeModule | null;
  children: NodeModule[];
  paths: string[];
}

export interface RequireFunction {
  (request: string): unknown;
  resolve: ((request: string, options?: { paths?: string[] }) => string) & { paths(request: string): string[] };
  cache: Record<string, NodeModule>;
  main: NodeModule | undefined;
  extensions: Record<string, unknown>;
}

export interface CreateLoaderOptions {
  fs: LoaderFs;
  cwd: string;
  env?: Record<string, string>;
  /** Overrides and additions, checked BEFORE the built-in table. A host adds its own roads here. */
  builtins?: Record<string, unknown>;
  /** Gives `fs`/`fs/promises` something to talk to. Without one they refuse by name. */
  backend?: NodeFsBackend | null;
  /** The `node_modules` walk stops here. */
  root?: string;
  /** `exports` conditions, in order. `browser` first is what makes a browser build load. */
  conditions?: string[];
  process?: NodeProcess;
  argv?: string[];
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  httpBridge?: HttpBridge | null;
  network?: NetworkBridge | null;
  processes?: ProcessManager | null;
  syncCompressor?: SyncCompressor | null;
  homedir?: string;
  /** Extra names injected into every module's scope, on top of the Node set. */
  globals?: Record<string, unknown>;
}

export interface Loader {
  require: RequireFunction;
  resolve(request: string, fromDir?: string): string;
  /** Load `entry` as the main module: sets `require.main`, `process.argv[1]` and `module.parent`. */
  runMain(entry: string, argv?: string[]): unknown;
  cache: Map<string, NodeModule>;
  process: NodeProcess;
  conditions: string[];
  /** The builtin table this loader answers with, memoised. */
  builtin(name: string): unknown;
}

/** A read-once map of the folder, the way the current runner works. Stale by design; bounded by design. */
export function snapshotLoaderFs(files: Record<string, Uint8Array>): LoaderFs {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    let dir = dirnameAbs(path);
    while (dir !== "/" && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dirnameAbs(dir);
    }
    dirs.add("/");
  }
  return {
    readFileSync(path: string): Uint8Array {
      const found = files[normalizeAbs(path)];
      if (!found) {
        throw new NodeCompatError("ENOENT", `ENOENT: no such file or directory, open '${path}' (it was not in the folder snapshot taken when this run started)`);
      }
      return found;
    },
    statSync(path: string) {
      const norm = normalizeAbs(path);
      if (files[norm]) return { isFile: () => true, isDirectory: () => false };
      if (dirs.has(norm)) return { isFile: () => false, isDirectory: () => true };
      return null;
    },
  };
}

/** The real filesystem, through the shared-memory channel. Throws with the isolation sentence without one. */
export function backendLoaderFs(backend: NodeFsBackend): LoaderFs {
  return {
    readFileSync: (path: string) => backend.opSync("readFile", { path }).data,
    statSync: (path: string) => {
      if (!backend.opSync("exists", { path }).value) return null;
      const stat = backend.opSync("stat", { path }).value as { kind: "file" | "dir" };
      return { isFile: () => stat.kind === "file", isDirectory: () => stat.kind === "dir" };
    },
  };
}

const decoder = new TextDecoder();

export function createLoader(opts: CreateLoaderOptions): Loader {
  const root = normalizeAbs(opts.root ?? "/");
  const conditions = opts.conditions ?? ["browser", "require", "default"];
  const cache = new Map<string, NodeModule>();
  const builtinCache = new Map<string, unknown>();
  const jsonCache = new Map<string, Record<string, unknown> | null>();
  const process =
    opts.process ??
    createProcess({
      argv: opts.argv ?? ["node"],
      env: opts.env,
      cwd: opts.cwd,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });

  const host: ResolveHost = {
    isFile: (path) => opts.fs.statSync(path)?.isFile() ?? false,
    isDirectory: (path) => opts.fs.statSync(path)?.isDirectory() ?? false,
    readJson: (path) => {
      if (jsonCache.has(path)) return jsonCache.get(path) ?? null;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(decoder.decode(opts.fs.readFileSync(path))) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      jsonCache.set(path, parsed);
      return parsed;
    },
    root,
    conditions,
  };

  const context: BuiltinContext = {
    process,
    fs: opts.backend ?? null,
    httpBridge: opts.httpBridge ?? null,
    network: opts.network ?? null,
    processes: opts.processes ?? null,
    syncCompressor: opts.syncCompressor ?? null,
    homedir: opts.homedir ?? root,
  };

  const builtin = (name: string): unknown => {
    const bare = name.startsWith("node:") ? name.slice(5) : name;
    if (opts.builtins && Object.prototype.hasOwnProperty.call(opts.builtins, bare)) return opts.builtins[bare];
    if (builtinCache.has(bare)) return builtinCache.get(bare);
    const built = builtinModule(bare, context);
    if (built === undefined) return undefined;
    builtinCache.set(bare, built);
    return built;
  };

  const consoleShim = makeConsole(process);
  const emptyModule: NodeModule = {
    id: EMPTY_MODULE,
    filename: EMPTY_MODULE,
    path: "/",
    exports: {},
    loaded: true,
    parent: null,
    children: [],
    paths: [],
  };
  cache.set(EMPTY_MODULE, emptyModule);

  /** `.mjs`, or a `.js` under a `"type": "module"` package, is ESM whether or not it looks it. */
  const isModuleType = (filename: string): boolean => {
    if (filename.endsWith(".mjs")) return true;
    if (filename.endsWith(".cjs")) return false;
    let dir = dirnameAbs(filename);
    for (;;) {
      const pkg = host.isFile(`${dir}/package.json`) ? host.readJson(`${dir}/package.json`) : null;
      if (pkg) return pkg.type === "module";
      if (dir === root || dir === "/") return false;
      const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
      if (parent === dir) return false;
      dir = parent;
    }
  };

  function resolve(request: string, fromDir: string): string {
    const bare = request.startsWith("node:") ? request.slice(5) : request;
    if (builtin(bare) !== undefined || BUILTIN_NAMES.includes(bare as (typeof BUILTIN_NAMES)[number])) return bare;
    const found = resolveRequest(request, fromDir, host);
    if (found) return found;
    const hint = request.startsWith(".") || request.startsWith("/")
      ? ""
      : ` — there is no '${request}' in any node_modules from '${fromDir}' up to '${root}'. Run \`npm install ${request}\` first; this runtime has its own npm client (@00/agent-node's src/npm).`;
    failModuleNotFound(request, `${fromDir}${hint}`);
  }

  function load(filename: string, parent: NodeModule | null): unknown {
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    if (filename === EMPTY_MODULE) return emptyModule.exports;

    const dir = dirnameAbs(filename);
    const module: NodeModule = {
      id: filename,
      filename,
      path: dir,
      exports: {},
      loaded: false,
      parent,
      children: [],
      paths: nodeModulesPaths(dir, root),
    };
    // In the cache BEFORE it runs: that is the whole of Node's cycle behaviour, and the reason a
    // circular require sees a half-built exports object instead of recursing forever.
    cache.set(filename, module);
    parent?.children.push(module);

    try {
      const bytes = opts.fs.readFileSync(filename);
      if (filename.endsWith(".json")) {
        module.exports = JSON.parse(decoder.decode(bytes)) as unknown;
        module.loaded = true;
        return module.exports;
      }
      let source = decoder.decode(bytes);
      if (isModuleType(filename) || hasEsmSyntax(source)) source = transformEsm(source, filename).code;
      const requireForModule = makeRequire(module);
      // The CommonJS wrapper. `new Function` is what Node uses too; the extra names past Node's five
      // are the globals a Worker does not have (`process`, `Buffer`, `global`) plus whatever the host
      // added, so a module never reaches for a global that is not there.
      const extraNames = Object.keys(opts.globals ?? {});
      const wrapper = new Function(
        "exports",
        "require",
        "module",
        "__filename",
        "__dirname",
        "process",
        "console",
        "Buffer",
        "global",
        "setImmediate",
        "clearImmediate",
        ...extraNames,
        source,
      ) as (...args: unknown[]) => void;
      wrapper(
        module.exports,
        requireForModule,
        module,
        filename,
        dir,
        process,
        consoleShim,
        Buffer,
        globalThis,
        (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 0, ...args),
        clearTimeout,
        ...extraNames.map((name) => (opts.globals as Record<string, unknown>)[name]),
      );
      module.loaded = true;
      return module.exports;
    } catch (err) {
      // A module that threw is NOT half-cached: Node deletes it so a retry re-runs it, and a stale
      // half-initialised exports object is the worst thing to leave behind.
      cache.delete(filename);
      throw err;
    }
  }

  function makeRequire(module: NodeModule | null): RequireFunction {
    const fromDir = module ? module.path : normalizeAbs(opts.cwd);
    const fn = ((request: string): unknown => {
      // The `browser` map is consulted BEFORE the builtin table, because `"browser": { "fs": false }`
      // is a package saying "in a browser this module is empty" and it has to beat our own `fs`.
      const mapped = applyBrowserMap(request, fromDir, host);
      if (mapped === EMPTY_MODULE) return emptyModule.exports;
      const effective = mapped ?? request;
      const bare = effective.startsWith("node:") ? effective.slice(5) : effective;
      const built = builtin(bare);
      if (built !== undefined) return built;
      const filename = resolve(effective, fromDir);
      if (filename === EMPTY_MODULE) return emptyModule.exports;
      if (!filename.startsWith("/")) {
        // `resolve` answered with a builtin name it knows but has no implementation for.
        throw new NodeCompatError(
          "ERR_MODULE_UNSUPPORTED",
          `require('${request}'): this runtime knows the name but has no implementation for it here`,
        );
      }
      return load(filename, module);
    }) as RequireFunction;
    const resolver = ((request: string, options?: { paths?: string[] }): string => {
      if (options?.paths?.length) {
        for (const base of options.paths) {
          const found = resolveRequest(request, normalizeAbs(base), host);
          if (found) return found;
        }
        failModuleNotFound(request, options.paths.join(", "));
      }
      return resolve(request, fromDir);
    }) as RequireFunction["resolve"];
    resolver.paths = (request: string): string[] =>
      request.startsWith(".") || request.startsWith("/") ? [] : nodeModulesPaths(fromDir, root);
    fn.resolve = resolver;
    fn.cache = cacheProxy;
    fn.main = mainModule;
    fn.extensions = {};
    return fn;
  }

  /** `require.cache` is an OBJECT in Node, and packages iterate and delete keys on it. */
  const cacheProxy = new Proxy(
    {},
    {
      get: (_t, key) => (typeof key === "string" ? cache.get(key) : undefined),
      has: (_t, key) => typeof key === "string" && cache.has(key),
      set: (_t, key, value) => {
        if (typeof key === "string") cache.set(key, value as NodeModule);
        return true;
      },
      deleteProperty: (_t, key) => (typeof key === "string" ? cache.delete(key) : false),
      ownKeys: () => [...cache.keys()],
      getOwnPropertyDescriptor: (_t, key) =>
        typeof key === "string" && cache.has(key) ? { value: cache.get(key), enumerable: true, configurable: true } : undefined,
    },
  ) as Record<string, NodeModule>;

  let mainModule: NodeModule | undefined;
  const rootRequire = makeRequire(null);
  context.loaderRequire = rootRequire;

  return {
    require: rootRequire,
    resolve: (request, fromDir) => resolve(request, normalizeAbs(fromDir ?? opts.cwd)),
    runMain(entry: string, argv?: string[]): unknown {
      const filename = entry.startsWith("/") ? normalizeAbs(entry) : resolve(entry, normalizeAbs(opts.cwd));
      process.argv = [process.argv[0] ?? "node", filename, ...(argv ?? [])];
      const exports = load(filename, null);
      mainModule = cache.get(filename);
      rootRequire.main = mainModule;
      return exports;
    },
    cache,
    process,
    conditions,
    builtin,
  };
}

export { ExitSignal, resolveAbs, EMPTY_MODULE };
