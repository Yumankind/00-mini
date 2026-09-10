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
real file (fetched from the asset binding) or an SPA route that gets `index.html`. Since
`run_worker_first` was turned on for the isolation headers, the Worker sees every request first and
the asset layer answers through `env.ASSETS` — see "Cross-origin isolation" below.

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

## Cross-origin isolation, and what it costs

This origin sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` on every document, which makes
`self.crossOriginIsolated === true` in the app and `SharedArrayBuffer` exist. That is the whole
reason it is here: a script run from the power shell (`node file.js`) gets a Worker, and a Worker can
only have a SYNCHRONOUS filesystem — `readFileSync`, `writeFileSync`, `require` of any workspace file
— if it can park on `Atomics.wait` against shared memory while another Worker does the OPFS work.
Without the headers there is no shared memory, and those calls go back to reading a snapshot of the
working folder and refusing every sync write by name (`SyncUnsupportedError`, see
`apps/infinite/src/power/js-runner.ts`, `sync-channel.ts` and `fs-service.ts`).

The decision is `src/headers.ts`, alone, and `test/isolation-headers.test.ts` in `apps/infinite`
runs it and this Worker against a stub bucket:

| Route | `Cross-Origin-Opener-Policy` | `Cross-Origin-Embedder-Policy` | `Cross-Origin-Resource-Policy` |
|---|---|---|---|
| `/`, `/index.html`, any SPA route (the shell) | `same-origin` | `credentialless` | `same-origin` |
| `/sw.js` | `same-origin` | `credentialless` | `same-origin` |
| `/assets/*`, icons, `/manifest.webmanifest`, `/robots.txt` | — | — | `same-origin` |
| `/e/<ref>.js` (the embed loader) | — | — | `cross-origin` |
| `/m/*` (the loader's local-model chunk) | — | — | `cross-origin` |
| `/mediapipe/genai/wasm/*`, `/litert/*` (the R2 mirror) | — | — | `cross-origin` |
| `/~/*` (a virtual port or served folder) | — | — | — |

Three of those rows are deliberate exceptions and none of them may become `same-origin`:

- **`/e/<ref>.js` and `/m/*` are somebody else's page's business.** The loader is a `<script>` on a
  third-party site; `same-origin` there would break every embed on the web at once. They keep
  `access-control-allow-origin: *` as well.
- **The mirror is published to be fetched from anywhere** (`dl.0-0.chat` is the same bucket).
- **`/~/*` is a page a script in the app's tab is serving**, not a document this Worker is deciding a
  policy for. It reaches the network only when the service worker is not controlling the load.

`assets.run_worker_first: true` in `wrangler.jsonc` is new and load-bearing. By default the asset
layer answers a request that matches a real file WITHOUT invoking the Worker, so `/` and `/sw.js`
would go out with none of these headers and the page would silently not be isolated. Two headers can
only come from code, so the code has to run; the cost is one Worker invocation per asset.

`apps/infinite/vite.config.ts` sends the same two headers from `server.headers` and
`preview.headers`, so `pnpm dev` and `vite preview` are the same app as the deploy. A difference
there would show up as `SyncUnsupportedError` on a laptop and nowhere else.

### What still loads under `credentialless`, and what would not

`credentialless` was chosen over `require-corp` because it asks nothing of hosts we do not own: a
no-cors cross-origin load is sent WITHOUT credentials instead of being refused for want of a
`Cross-Origin-Resource-Policy` header on the far side, and a CORS-enabled load is unaffected.

Still works, and was checked live:

- **The LiteRT wasm** — same-origin (`/mediapipe/genai/wasm/*`, this Worker's R2 door). Same-origin
  subresources are never subject to COEP.
- **The model weights from `dl.0-0.chat`** — a plain `fetch()` of a cross-origin URL is CORS mode,
  and that bucket answers `Access-Control-Allow-Origin: *` (§12.7). Ranged reads and the streaming
  download with its progress bar both work unchanged.
- **The relay, the rooms/SFU and the sponsoredtokens device API** — all `fetch`/WebSocket, all CORS.
- **web-llm's weights** (Hugging Face, GitHub raw) — `Cache.add()` and `fetch` are CORS mode too.

Would NOT work, and none of it exists in this app: a no-cors `<img>`, `<video>`, `<audio>` or
stylesheet from a host that sends no `Cross-Origin-Resource-Policy` — the request would be sent
credentialless and, for an opaque response, silently fail. There are no external images, no web
fonts and no third-party stylesheets in the PWA (its icons are same-origin, its type is the system
stack). A cross-origin IFRAME is the other case: under `credentialless` a framed document must send
COEP itself, which matters for the separate preview origin of §12.1 when that lands — that origin
has to send `Cross-Origin-Embedder-Policy` too, or be framed from a page that is not isolated.

### The live check

Recorded 2026-09-11, `pnpm --filter @00/infinite build:app` served with `vite preview --port 5299`
(the same two headers as this Worker), in a Chromium browser:

```js
self.crossOriginIsolated                // true
typeof SharedArrayBuffer                // "function"
new Int32Array(new SharedArrayBuffer(64)).length   // 16
await fetch("/mediapipe/genai/wasm/genai_wasm_internal.wasm", { headers: { Range: "bytes=0-1023" } })
                                        // 206, type "basic", 1024 bytes
await fetch("https://dl.0-0.chat/litert/catalog.json")             // 200, type "cors"
await fetch("https://dl.0-0.chat/litert/gemma3-270m-it-q4_0-web.task",
            { headers: { Range: "bytes=0-524287" } })
                                        // 206, type "cors", content-range bytes 0-524287/249233408
```

And the capability it buys, in the power shell's terminal on that build:

```
/ $ node -e "const fs=require('fs'); fs.writeFileSync('/sync-proof.txt','written synchronously');
             console.log('read back:', fs.readFileSync('/sync-proof.txt','utf8'),
                         '| size', fs.statSync('/sync-proof.txt').size,
                         '| exists', fs.existsSync('/sync-proof.txt'))"
read back: written synchronously | size 21 | exists true
/ $ cat /sync-proof.txt                      # the shell reads through AgentFs — the same OPFS
written synchronously
/ $ node -e "const fs=require('fs'); fs.writeFileSync('/kit/fresh.js','module.exports=41+1');
             console.log('require gives', require('/kit/fresh.js'))"
require gives 42                             # a module that did not exist when the run started
/ $ node -e "const fs=require('fs'); const big='x'.repeat(2500000); fs.writeFileSync('/big.txt', big);
             const back=fs.readFileSync('/big.txt','utf8');
             console.log('bytes', fs.statSync('/big.txt').size, '| round trip', back===big)"
bytes 2500000 | round trip true              # 2.5 MB across a 1 MB frame: three frames each way
/ $ node -e "try { require('fs').readFileSync('/../vault.json','utf8') } catch (e) { console.log(e.message) }"
ENOENT: no such file or directory, open '/vault.json'   # `..` floors at the workspace
```

Every one of those was a `SyncUnsupportedError` before the headers.

The channel underneath is `apps/infinite/src/power/sync-channel.ts`, and its wire is
`@00/agent-node`'s (`packages/agent-node/src/fs/sync-channel.ts`) byte for byte — same 64-byte
header, same six states, same 1 MB frames, same `u32 jsonLength` + JSON + raw bytes. The two
implementations exist because one of them has to survive `Function.prototype.toString()` into a
classic Blob Worker; `apps/infinite/test/sync-channel.test.ts` drives that Worker's client against
`@00/agent-node`'s own server to prove they still agree.

Two things that did NOT change and are worth writing down so nobody re-debugs them:

- The app boots, scaffolds its agent and sends a chat message on this build. The local brain
  downloads its 2.0 GB of weights from the mirror to 100% and initialises the WebGPU graph — and
  then refuses the turn, because the agent's system prompt is ~5197 tokens and every LiteRT row
  declares a 4096-token window (`packages/agent-models/src/litert.ts`, `contextTokens`). That is a
  prompt-length gap, not a header one; it fails identically without isolation.
- Service worker registration fails in the browser-pane profile used for this check
  (`An unknown error occurred when fetching the script`). It fails the same way on a plain static
  server with NO isolation headers, so it is that profile, not this change.

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

The isolation headers, which are the ones a deploy must be re-checked for (the app is not
`crossOriginIsolated` without the first two, and no site can load the loader if the third ever says
`same-origin`):

```sh
curl -sI http://127.0.0.1:8794/            | grep -i "cross-origin"   # opener+embedder+resource
curl -sI http://127.0.0.1:8794/sw.js       | grep -i "cross-origin"   # the same three
curl -sI http://127.0.0.1:8794/e/ia_test_abcdefgh.js | grep -i "cross-origin"  # resource: cross-origin
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
