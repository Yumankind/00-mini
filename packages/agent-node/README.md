# `@00/agent-node`

Node, in a browser tab, over the agent's own filesystem. The "own WebContainers" layers of
[`docs/HANDOFF-infinite-agent.md`](../../docs/HANDOFF-infinite-agent.md) (the review list, item 15):
core modules, a `require` with Node's resolution algorithm, an npm client that talks to
`registry.npmjs.org` directly, and a process model where a process is a Worker.

Framework-free TypeScript. It runs in a Web Worker, in a page, and in Node (the test suite is Node
against an in-memory filesystem). It depends on six npm packages — `buffer`, `events`,
`path-browserify`, `readable-stream`, `string_decoder`, `util` — because those ARE the browser
versions of those modules and re-writing them would be worse, plus `semver` for range resolution and
`@00/agent-fs` for the filesystem contract, the tar reader and gzip.

---

## What runs

- **Pure-JS packages from npm.** `npm install express` fetches, verifies and unpacks; `require("express")`
  resolves through the same `node_modules` walk Node uses, `exports` maps, `browser` field maps,
  scoped names, nested copies and all.
- **CommonJS, and ESM that a scanner can honestly rewrite.** `import`/`export` in all their usual
  shapes, `import.meta.url`, dynamic `import()`. The limits are listed below and in
  `src/loader/esm.ts`'s own header.
- **Express-style servers.** `http.createServer(...).listen(3000)` becomes a handler the HOST routes
  — in this product, a service worker turning `/~/3000/…` into a call
  (`apps/infinite/src/power/virtual-ports.ts`).
- **Child processes and worker threads.** `child_process.spawn`, `fork`, `worker_threads.Worker`:
  each one a real Worker with real pipes, killable, with `exit`/`close` in Node's order.
- **`fs` in all three Node shapes.** Callbacks, promises, and — behind cross-origin isolation — the
  synchronous ones, over a `SharedArrayBuffer` channel with a real service on the other end.
- **`crypto`, `zlib`, `stream`, `url`, `os`, `assert`, `querystring`, `timers`, `buffer`,
  `string_decoder`, `util`, `path`, `events`, `process`, `console`** — see each module's header for
  what it does and does not do.

## What does not

| Thing | Why | What it does instead |
|---|---|---|
| **Native addons** (`.node`, `binding.gyp`) | machine code for a real OS; nothing in a browser can load one | `require` of a `.node` throws `ERR_NATIVE_ADDON`; `install()` lists the packages by name in `nativePackages` and writes their JS anyway |
| **Lifecycle scripts** (`preinstall`/`install`/`postinstall`) | arbitrary code from a stranger, run against the person's own workspace, at the moment they typed a package name | never run; listed by name in `skippedScripts`, the same decision WebContainers took |
| **Synchronous `fs` without isolation** | a synchronous filesystem needs `SharedArrayBuffer` + `Atomics.wait`, which need COOP+COEP | every `*Sync` throws `ERR_SYNC_FS_UNAVAILABLE` carrying the isolation sentence; supply a `SyncFsClient` and they all start working |
| **Sockets** (`net`, `tls`, `dgram`) | a tab has no TCP and no polyfill can invent one | each function throws `ERR_NO_SOCKETS`; outbound goes through `fetch` (the other origin's CORS decides), inbound through the host's `HttpBridge` |
| **DNS** | a browser resolves names inside `fetch` and exposes no resolver | `dns.*` throws `ERR_NO_DNS` |
| **Top-level await in ESM** | the CommonJS wrapper is a synchronous function | `ERR_TOP_LEVEL_AWAIT`, naming the file |
| **Synchronous children** (`execSync`, `spawnSync`) | blocking this thread while another runs a whole program is an unbounded wait | `ERR_SYNC_CHILD_UNAVAILABLE`, naming the async twin |
| **Synchronous zlib** (`gzipSync`, …) | `CompressionStream` is a stream | `ERR_SYNC_ZLIB_UNAVAILABLE`, naming the async twin; a host with real isolation can pass a `SyncCompressor` |
| **`hash.digest()` for sha256/384/512** | `subtle.digest` returns a promise | `digestAsync()`; md5 and sha1 ARE synchronous (implemented here in JS) because npm packages call them that way |
| **Brotli, ciphers, key generation** | no browser exposes a Brotli compressor to script; a half-right AES is worse than none | refuse by name and point at `crypto.webcrypto.subtle` |
| **git, file:, link:, URL and alias dependency specifiers** | each needs a transport or a symlink a browser does not have | `ERR_UNSUPPORTED_SPECIFIER` |
| **Peer dependency installation** | npm 7+ installs peers; doing it silently here would pull a React into a tab | reported as unmet-peer warnings |

### The loader's ESM limits, in full

1. **Imported bindings are a snapshot, not live.** `import { count } from "./m.js"` becomes a `const`.
2. **Imports are not hoisted.** They run where they are written.
3. **No top-level await** (refused by name).
4. **No import attributes** (`with { type: "json" }`); JSON is loaded by extension.
5. **`export * from` copies own enumerable keys at the moment it runs.** Named re-exports are live.
6. **`export { x as "a string" }`** is not parsed.
7. **The regex/division heuristic** is the classic one; `if (a) /re/.test(b)` is the case it gets wrong.
8. **Nothing is renamed**, so a module declaring its own `require`/`exports`/`__esm*` will collide.

`require` also needs `new Function` — which is `unsafe-eval`. A Content-Security-Policy without it
stops this package dead, and the host has to say so rather than let it fail three frames in.

---

## The integration recipe

Four objects, wired once. Nothing below is a framework: each piece is usable on its own.

### 1. A filesystem

```ts
import { NodeFsBackend, createSyncChannel, serveSyncChannel, SyncFsClient } from "@00/agent-node";

// On the side that owns the real AgentFs (the page):
const backend = new NodeFsBackend({ fs: agentFs, root: "workspace", cwd: () => currentCwd });

// Optional, and only under cross-origin isolation: the synchronous half.
const sab = createSyncChannel();
serveSyncChannel(backend, sab);          // page side, async, never blocks
// …post `sab` to the Worker, and there:
backend.sync = new SyncFsClient(sab);    // module side, blocking — this is what makes *Sync real
```

Without a channel, `fs.promises.*` works and every `*Sync` refuses by name. That is a usable
runtime; the channel is the upgrade.

### 2. A loader

```ts
import { createLoader, backendLoaderFs, snapshotLoaderFs } from "@00/agent-node";

const loader = createLoader({
  // The SYNCHRONOUS view `require` needs. Two implementations ship:
  fs: backend.hasSync ? backendLoaderFs(backend) : snapshotLoaderFs(preloadedFiles),
  cwd: "/projects/site",
  root: "/",                       // the node_modules walk stops here
  env: { NODE_ENV: "development" },
  backend,                         // gives `fs` and `fs/promises` something to talk to
  conditions: ["browser", "require", "default"],
  httpBridge,                      // see 4
  network: { fetch: (u, i) => fetch(u, i) },   // or null to deny outbound traffic
  processes,                       // see 3
  builtins: { "my-host-api": hostApi },        // host roads, checked before the builtin table
  globals: { __hostThing: value },             // extra names in every module's scope
  stdout: (t) => term.write(t),
  stderr: (t) => term.write(t),
});

loader.runMain("/projects/site/app.js", ["--watch"]);
```

### 3. A process model

```ts
import { ProcessManager, createInlineWorkerFactory, serveProcess } from "@00/agent-node";

// In the browser, the factory makes a real Worker whose entry calls `serveProcess`:
const manager = new ProcessManager({
  createWorker: (spec) => makeBrowserWorker(spec),   // `new Worker(url)` + the three-method adapter
  cwd: "/projects/site",
  env: {},
});

// Inside that Worker:
serveProcess(self as unknown as WorkerChannel, {
  configure(spec, io) {
    return { fs, cwd: spec.cwd, root: "/", backend, httpBridge: bridgeOver(io), /* … */ };
  },
});
```

`io.hold()` is how anything that should keep a process alive says so — an open server takes one and
releases it on close. Timers and in-flight filesystem calls are counted automatically.

The node test suite uses `createInlineWorkerFactory`, which runs the SAME `serveProcess` in-process
on an asynchronous channel. A browser host swaps the factory and changes nothing else.

### 4. An HTTP bridge

```ts
const httpBridge: HttpBridge = {
  listen(port, handler) { registerPort(port, async (req) => handler(req)); },
  close(port) { unregister(port); },
};
```

That is the whole interface. `http.createServer(...).listen(3000)` calls `listen`; the host's router
(a service worker, in this product) calls the handler with `{ method, url, headers, body }` and gets
back `{ status, headers, body }`.

### 5. npm

```ts
import { install, resolveTree, npmLs, npmRunPlan, rewriteBinArgv } from "@00/agent-node";

const result = await install(agentFs, "workspace/projects/site", {
  registry: "https://registry.npmjs.org",
  onProgress: ({ done, total, name }) => term.write(`${done}/${total} ${name}\n`),
});
// result.warnings names the skipped install scripts, the native packages and the unmet peers.
```

`npmRunPlan` returns the command lines `npm run <name>` would execute (with its `pre`/`post` hooks
and npm's `npm_package_*` environment) for the host's own shell to run; `rewriteBinArgv` is the PATH
substitute, turning `["vitest", "run"]` into `["node", "<cwd>/node_modules/.bin/vitest", "run"]`.

---

## Proof

`pnpm --filter @00/agent-node test` — 182 tests, node environment, in-memory filesystem.

- The **sync channel** is tested end to end with a real `SharedArrayBuffer` and a real
  `worker_threads` Worker, including a 2 MB file crossing the 1 MB frame limit in both directions and
  a channel barely bigger than its header, so every message is many frames.
- The **loader** runs against a fixture tree with a scoped package, an `exports` map with conditions,
  patterns, arrays and `null` blocks, a `browser` map with a `false`, a `"type": "module"` package, a
  nested `node_modules`, and a cycle.
- The **npm client** is tested against a registry of real gzipped tarballs built with agent-fs's own
  tar writer and verified with real sha512 — and against `registry.npmjs.org` itself, once,
  read-only, in `test/registry-live.test.ts`: it asserts `Access-Control-Allow-Origin: *` on BOTH the
  abbreviated metadata and the tarball, installs a package end to end, and `require`s it through the
  loader. That test skips cleanly when the machine is offline or `NO_NETWORK_TESTS=1`.

Coverage floors (`vitest.config.ts`): 90 / 80 / 90 / 90.
