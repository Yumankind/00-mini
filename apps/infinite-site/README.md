# infinite-site — the static Worker for Infinite Agent

Serves two things and holds no data: the **embed loader** at `/e/<ref>.js` (one file, every ref) and
the **owned agent's PWA** at `/`. See [`docs/HANDOFF-infinite-agent.md`](../../docs/HANDOFF-infinite-agent.md)
§5 (the embed), §9.1 (why this needs no backend) and §10 (the repository layout).

## It is outside the pnpm workspace, and has no node_modules

`pnpm-workspace.yaml` excludes `apps/infinite-site`, the same call as `apps/skills-site`,
`apps/models-site`, `apps/meeting-site` and `apps/yumankind-site`: this deploys to Cloudflare on its
own schedule and has nothing to do with building the Mac app. There is **no `package.json` and no
`node_modules` here at all** — like `apps/yumankind-site`, it is deployed with the **Homebrew
wrangler**, and the only thing it needs built is produced next door in `apps/infinite`, which *is* a
workspace member.

Never run `npm install` or `pnpm install` in this folder. There is nothing to install.

## Build

```sh
apps/infinite-site/scripts/build-site.sh
```

It runs the two vite builds in `apps/infinite` (the embed config and the PWA config) and fills
`public/`:

| In `public/` | From | Served as |
|---|---|---|
| `e.js` | `apps/infinite/dist/embed/e.js` | every `/e/<ref>.js` |
| `m/` | `apps/infinite/dist/embed/m/` | `/m/m.js`, the local model — fetched only when a visitor presses "Load local AI" |
| everything else | `apps/infinite/dist/` | the PWA, `/` and its routes |

`m/` is megabytes and `e.js` is 32 KB gzipped, which is the point of them being two files: the
loader every page fetches carries the runtime and the site tools, and the WebGPU model arrives only
when somebody asks for it (§5.2.3).

`public/` is generated and cleared on every build; nothing is edited there by hand.

## Why there is a Worker at all

The ref in the snippet (`ia_…`) is minted **offline, in the owner's browser, with no server call**
(§5.1). The server therefore never knows a ref, and there can never be a file per ref. `src/index.ts`
is one rewrite rule: any `/e/<ref>.js` answers with the single built `e.js`. Everything else is a
real file (served by the asset layer before the Worker runs) or an SPA route that gets `index.html`.

`not_found_handling: "none"` is load-bearing. With `single-page-application` or `404-page`, the asset
layer would answer `/e/<ref>.js` with `index.html` before this Worker ever ran, and every embed on
the web would load an HTML page as a script.

There is **one binding**, `MODELS` → the public bucket `00-downloads`, and the Worker only reads
from it (the section below). No D1, no KV, no secrets. Phases 0–2 need no backend (§9.1);
registration, the inbox and push arrive in Phase 3, in moltworker or in a second Worker (§9.4).

## The one thing the asset layer cannot carry: MediaPipe's wasm

The PWA's preferred local brain (LiteRT, `packages/agent-models/src/litert.ts`) loads Google's LLM
Inference runtime from `/mediapipe/genai/wasm/*` on this origin, never from a CDN. Those are three
~27 MB binaries plus their loaders, and Cloudflare caps a static asset at 25 MiB, so `build-site.sh`
deliberately leaves `dist/mediapipe/` out of `public/`. They live on the public bucket already
(`00-downloads`, custom domain `dl.0-0.chat`, read-only CORS for any origin), under
`mediapipe/genai/0.10.29/wasm/<file>`, beside the model weights under `litert/` — both published
by `scripts/publish-litert-models.sh` and the plan's §12.7.

**Decided: same-origin, through this Worker.** The alternative was to build the PWA with
`VITE_LITERT_WASM_BASE=https://dl.0-0.chat/mediapipe/genai/0.10.29/wasm` and take the bytes
cross-origin. That was rejected because `public/sw.js` caches only `response.type === "basic"` — a
cross-origin wasm is never in the service worker's cache, and offline would rest on the browser's
own HTTP cache honouring an `immutable` header. §4.4 promises the local model works with the
network gone, so the runtime has to be same-origin.

So `wrangler.jsonc` carries `r2_buckets: [{ binding: "MODELS", bucket_name: "00-downloads" }]` and
`src/index.ts` answers two prefixes from it, before the SPA fallback and never through the asset
layer (nothing under them exists in `public/`):

| Path | R2 key | Cache | Allow-list |
|---|---|---|---|
| `/mediapipe/genai/wasm/<name>` | `mediapipe/genai/<MEDIAPIPE_VERSION>/wasm/<name>` | `immutable`, a year | the six known files only; anything else 404 |
| `/litert/<file>` | `litert/<file>` | `immutable`, a year | `*.task`, `*.litertlm`, `NOTICE.txt`, `GEMMA_TERMS.md` |
| `/litert/catalog.json` | `litert/catalog.json` | 5 minutes | — |

`MEDIAPIPE_VERSION` is one constant in `src/index.ts` and **must track `@mediapipe/tasks-genai` in
`packages/agent-models`**: the loader `.js` and the `.wasm` are one build, and a mismatched pair
fails at instantiation rather than at the fetch. The weights' names are deliberately *not* known
here — the catalogue grows a row from a publish on the Mac without a deploy of this site, so the
allow-list is a shape and R2's own miss is the answer for everything else.

Both prefixes serve the stored content-type, `ETag` from R2, `Range` (206, and 416 for an
unsatisfiable one — the provider streams multi-GB weights, so a resumable range matters),
`If-None-Match` (304) and `HEAD` (which never reads a body: the size comes from `head()`).
CORS is open, matching the bucket's own read-only policy, so a self-hosted PWA may point at this
host too.

### The env a hosted PWA build uses

In `apps/infinite/.env.local` (or the deploy's environment), for a build served by this Worker:

```sh
# EMPTY / unset on purpose: the app then uses LITERT_DEFAULT_WASM_PATH = "/mediapipe/genai/wasm",
# which is this Worker's R2 door on the app's own origin. Setting it would take the bytes
# cross-origin and lose the service-worker cache.
VITE_LITERT_WASM_BASE=

# OPTIONAL. Unset means dl.0-0.chat, which stays the default home for the weights. Point it here
# only when the weights should be same-origin too — the same-origin twin of the same bucket, which
# the service worker can then keep across a reload.
# VITE_LITERT_MODEL_BASE=https://<site>/litert
```

Dev and previews from `apps/infinite` (`vite dev` / `vite preview`) serve the wasm folder themselves,
from `packages/agent-models/node_modules/@mediapipe/tasks-genai/wasm` — no bucket involved.

## Preview

The R2 binding needs the real bucket, so the preview is remote:

```sh
cd apps/infinite-site && wrangler dev --port 8794 --remote
```

The loader, which needs no binding:

```sh
curl -sI http://127.0.0.1:8794/e/ia_test_abcdefgh.js | grep -i "content-type\|cache-control"
curl -s  http://127.0.0.1:8794/e/ia_test_abcdefgh.js | head -c 60    # the IIFE, not HTML
```

The mirror:

```sh
# 200, application/wasm, ~27 MB
curl -sI http://127.0.0.1:8794/mediapipe/genai/wasm/genai_wasm_internal.wasm
# 206 with content-range: bytes 0-1023/27220715
curl -sI -H 'Range: bytes=0-1023' http://127.0.0.1:8794/mediapipe/genai/wasm/genai_wasm_internal.wasm
# 404 — a name that is not one of the six
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8794/mediapipe/genai/wasm/nope.wasm
# the catalogue
curl -s http://127.0.0.1:8794/litert/catalog.json | head -c 200
```

## Deploy

```sh
apps/infinite-site/scripts/build-site.sh
cd apps/infinite-site && wrangler deploy
```

No custom domain is claimed yet — the workers.dev URL is what a snippet points at until the hostname
is decided (§12). Adding a `routes` entry to `wrangler.jsonc` later changes nothing else.

Deploys are Bruno's call, per round, like every other production deploy in this repo.
