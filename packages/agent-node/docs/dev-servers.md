# Running a dev server in the tab: Vite, Next, and what is actually missing

Written after reading [macaly/almostnode](https://github.com/macaly/almostnode) (MIT, `6ab61f31`),
which advertises "develop with Vite or Next.js" and is the closest prior art. **Nothing here is
implemented yet** — this is the checklist for the round that does it, and the first thing it has to
say is what "Vite works" turns out to mean.

## The headline: almostnode does not run Vite

`src/frameworks/vite-dev-server.ts` in that repo is **700 lines of its own dev server**, Vite-shaped:
it serves files out of the virtual filesystem, transforms them with esbuild-wasm, rewrites bare
specifiers, and injects React Refresh. `src/frameworks/next-dev-server.ts` is 1,688 lines of the same
idea for Next, with a route resolver (604), an API-route handler (361) and an HTML generator (569)
beside it. The `vite` and `next` packages from npm are never loaded. What IS loaded, from esm.sh, is
`esbuild-wasm`, `@rollup/browser`, `react`, `react-dom` and `react-refresh`, pinned in
`src/config/cdn.ts`.

`almostnode/vite` and `almostnode/next`, the two things its README calls plugins, are plugins for the
HOST's build: they serve `__sw__.js` — the service worker that turns a page request into a call into
the in-page server — from the right path. They have nothing to do with running Vite in the tab.

That is not a criticism; it is the honest shape of the problem, and it sets our own options:

- **A.** Run the real `vite` package under this loader. Nobody has done it. The list below is what it
  would take.
- **B.** Ship a Vite-shaped dev server of our own, as almostnode did — an `apps/infinite` concern,
  not this package's, since it needs a service worker and a page.
- **C.** Do neither, and be a runtime that runs scripts and servers well. A workspace agent runs
  `node build.ts`, `tsx watch`, `vitest`, an express server — far more often than it runs `vite dev`.

This document exists so the choice is made with the list in hand.

## What Vite needs from this package

Vite 5/6's dev server is `connect` middleware over `node:http`, a `chokidar` watcher, `esbuild` for
dependency pre-bundling and single-file transforms, and `rollup` for the production build.

| It needs | We have | Gap |
|---|---|---|
| `http.createServer().listen(port)` | **yes** — `src/modules/http.ts` hands the handler to the host's `HttpBridge`, and `apps/infinite/src/power/virtual-ports.ts` routes `/~/3000/…` to it | none for the dev server; Vite also opens a **WebSocket** for HMR, which the bridge has no shape for yet |
| `fs.promises` + `fs.*Sync` over a real tree | **yes**, and `*Sync` behind cross-origin isolation (`src/fs/sync-channel.ts`) | Vite is heavily synchronous at startup: without COOP+COEP every `readFileSync` refuses by name and Vite stops at the first one. **Isolation is not optional for this path.** |
| `fs.watch` / `chokidar` | **no** — `fs.watch` refuses by name (`ERR_FS_NO_WATCH`) | chokidar is a hard dependency of Vite's dev server. Needs a `chokidar` **package shim** over the host's `file_changed` events (almostnode has `src/shims/chokidar.ts` and a no-op `fsevents.ts` for exactly this), plus a real `fs.watch` behind it |
| `esbuild` (the npm package, with its native binary) | **no** — we have `esbuild-wasm` behind the `Transformer` seam, which is a different module | Needs an `esbuild` **package shim** mapping `transform`/`build` onto our transformer. Vite calls `esbuild.build()` for dependency pre-bundling, which BUNDLES — our seam only transforms one file |
| `rollup` | **no** | Only for `vite build`. `@rollup/browser` exists and is what almostnode loads; it is a package shim, not a runtime change |
| `module.createRequire` | **partly** — returns the loader's own `require` | Vite's config loader calls it on a path and expects resolution relative to THAT path; ours ignores the argument |
| ESM in the config file (`vite.config.ts`) | **yes** — `.ts` through the transformer (this round), `.mts` too | `vite.config.ts` is loaded by Vite with its own esbuild + `import()` of a data URL. Data-URL `import()` is the browser's, not ours: it would not see our module graph |
| `worker_threads` | **yes** — `src/modules/child.ts` over `ProcessManager` | none known |
| `net.createServer` | **no**, refuses by name (`ERR_NO_SOCKETS`) | Vite's `strictPort` check probes with `net`; it must be shimmed to "the port is free" or the probe must be patched |
| top-level await in dependency ESM | **no** — `ERR_TOP_LEVEL_AWAIT` | Vite's own source has none at the top level today; its plugins might |

## What Next needs on top of that

Everything above, plus:

- **The compiler is Rust.** `next/dist/build/swc` loads `@next/swc-*`, a `.node` native addon.
  `require` of a `.node` refuses by name here and no polyfill can change that. Next's own
  wasm fallback (`@next/swc-wasm-nodejs`) exists and is the only road; it is a package shim.
- **A child process per compile.** Next spawns workers with `child_process.fork` — we have that, as
  real Workers — but it also uses `jest-worker`, which reaches for `process.send`, IPC channels and
  `execArgv`. `process.send` is absent here.
- **The file-system router** reads the tree at startup and watches it: the chokidar gap again.
- **Server components and the RSC payload** need `react-server-dom-webpack`, which expects a webpack
  chunk loader in the page. almostnode does not run this at all — its `next-html-generator.ts` builds
  an HTML page and a client bundle itself.

Next under this loader is not a checklist item; it is a project. The honest first target is Vite.

## The to-do, in order

1. **`fs.watch`, really** — the host already emits `file_changed`; expose it as Node's `fs.watch`
   (`{ recursive: true }` included) and as `fs.promises.watch`'s async iterator. Everything else
   waits on this.
2. **A `chokidar` package shim** over (1), plus an `fsevents` stub that answers "not supported" the
   way the real one does on non-macOS. Both are `builtins:` entries on `createLoader`, not new
   modules in this package.
3. **`net.createServer` as a port probe** — `listen()` succeeds, `close()` succeeds, no data ever
   flows. It is the one socket lie worth telling, because the alternative is patching Vite.
4. **A WebSocket road in `HttpBridge`** — HMR is a `ws` server on the dev port. Either a `ws` package
   shim over the host's own WebSocket, or an `upgrade` hook on the bridge. Decide before (5).
5. **An `esbuild` package shim** over `createEsbuildTransformer`: `transform` maps directly;
   `build` does not, and the pre-bundling call is the one to study first.
6. **`module.createRequire(path)` honouring its argument** — a loader-scoped require rooted at the
   directory it names. Small, and needed by every config loader in the ecosystem.
7. **`process.send` / an IPC channel** between a forked child and its parent. `ProcessManager` has
   the pipes; this is a message type, not a redesign.
8. **Then, and only then, try `vite dev`** on a two-file project with cross-origin isolation on, and
   write down where it stops. Everything above is a guess until that run happens.

Items 1, 2, 3 and 6 are each an afternoon and useful on their own — a watcher and a working
`createRequire` are worth having whether or not Vite ever starts. Items 4, 5 and 7 are the ones that
decide between option A and option B above.
