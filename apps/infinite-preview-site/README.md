# infinite-preview-site — the preview origin

A Cloudflare Worker whose only job is **to be a different origin**. It serves three static files and
holds no data: no KV, no D1, no R2, no queue, no secret, no log of what anyone previewed.

It is the live half of the Infinite Agent's preview pane
(`apps/infinite/src/power/preview-host.ts`, `docs/HANDOFF-infinite-agent.md` review item 15).

## Outside the workspace, like its siblings

This folder is **not** in the pnpm workspace and has **no `node_modules`** — same arrangement as
`apps/infinite-site`, `apps/skills-site`, `apps/models-site` and `apps/meeting-site` (the comments in
`pnpm-workspace.yaml` say why). The Homebrew `wrangler` bundles `src/index.ts` and that is the entire
build. There is no `package.json` here and nothing to install.

## Why a second origin at all

Measured, not assumed. On ONE origin a browser offers exactly two frames, and neither is a preview:

- `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an **opaque** origin, and a
  service worker never serves an opaque client — the navigation is not intercepted at all, so the
  frame gets whatever the network has, which on the app's origin is the app's own `index.html`.
- Drop the sandbox and the frame **is** served — and it is then the app's own origin, with the app's
  OPFS, IndexedDB vault and `localStorage` readable from inside it.

So the app frames THIS host with `sandbox="allow-scripts allow-same-origin allow-forms
allow-popups"`. "Same origin" there means *this* origin: the frame keeps an identity of its own (so
it may register a service worker and be served by one), and that identity is not the app's (so there
is nothing of the person's for a previewed page to reach). The only storage in reach is this origin's,
and this origin holds exactly what the app just posted, for as long as the tab lives.

## What it serves

| Path | What | Headers that matter |
|---|---|---|
| `/` | the bootstrap page (`src/bootstrap.ts`) | `Cross-Origin-Embedder-Policy: credentialless`, `no-store` |
| `/preview-sw.js` | the preview service worker (`src/preview-sw.ts`) | `Service-Worker-Allowed: /`, `COEP: credentialless`, `no-store` |
| `/__inspector.js` | the element picker (`src/inspector.ts`) | `Cross-Origin-Resource-Policy: cross-origin`, `COEP: credentialless`, `no-store` |
| `/s/<siteId>/…` | **the service worker answers this**, from Cache Storage | reaching the server = 503 saying the worker is not installed |
| `/p/<siteId>/<port>/…` | **the service worker answers this**, by asking the app | same 503 |

`src/inspector.ts` is a **pinned copy** of `INSPECTOR_SOURCE` in `apps/infinite/src/lib/pick.ts`, and
the route decision inside `src/preview-sw.ts` is a pinned copy of `previewRouteFor` in the same file.
`apps/infinite/test/preview-live.test.ts` reads both files and fails the day either drifts. The
duplication is deliberate: the same picker has to run inside the app's own opaque snapshot frame,
which this origin can never reach, and this Worker can never import from a workspace package.

### The COEP header, and why a host with no `SharedArrayBuffer` needs one

The app is cross-origin isolated (`apps/infinite-site/src/headers.ts`: `COOP: same-origin` +
`COEP: credentialless`, so a script in a Worker can have a synchronous filesystem). An isolated page
may only frame a cross-origin document that carries a **compatible COEP of its own** — otherwise the
browser blocks the frame outright, with no request and no error anywhere the pane can see. So this
host sends `Cross-Origin-Embedder-Policy: credentialless` on all three responses: not for its own
capabilities, but as consent to be embedded.

`credentialless` rather than `require-corp` because `require-corp` would demand a
`Cross-Origin-Resource-Policy` header from every cross-origin subresource **inside the previewed
page** — a Google font, a CDN script, a hotlinked image — and a preview that silently drops the
page's own font is a preview that lies about what the page looks like.

The two values must agree; `apps/infinite/test/preview-live.test.ts` reads both files and fails if
they stop agreeing.

## How the three parties talk

```
app (origin A)  ──iframe──▶  bootstrap page (origin B)  ──▶  preview service worker (origin B)
      ▲                             │                                 │
      └────── MessagePort ──────────┘                                 ▼
                                                      served page + /__inspector.js (origin B)
```

1. The app frames `/#o=<its own origin>` — the fragment never reaches this server.
2. The page registers the worker and posts `00-preview-ready` to that exact origin, handing over one
   `MessagePort`. Everything after that travels on the port, which no third party can obtain.
3. The app posts the folder (`{ site, mime, bytes, source }` per file); the page writes them into
   Cache Storage under `/s/<siteId>/…` and points its inner frame at the entry page.
4. The worker serves them back, injecting `<script src="/__inspector.js">` and
   `<meta name="00-source">` into every HTML response.
5. A click in the page posts `00-pick` to the page above it; the page relays it to the app.
6. `/p/<siteId>/<port>/…` is forwarded worker → page → app → the app's `handleVirtualRequest`.
   Ten seconds without an answer is a 504 that says the app's tab is what serves it.

## Preview

No bindings, so local is enough:

```sh
cd apps/infinite-preview-site && wrangler dev --port 8795
```

```sh
curl -sI http://127.0.0.1:8795/preview-sw.js | grep -i 'service-worker-allowed\|cache-control'
curl -sI http://127.0.0.1:8795/__inspector.js | grep -i 'cross-origin'
curl -sI http://127.0.0.1:8795/ | grep -i 'cross-origin-embedder-policy'
curl -s  http://127.0.0.1:8795/ | head -3                       # the bootstrap page
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/s/abc/index.html   # 503, by design
```

And the app against it:

```sh
cd apps/infinite && VITE_PREVIEW_ORIGIN=http://localhost:8795 pnpm build:app && pnpm preview --port 5298
```

## Deploy

```sh
cd apps/infinite-preview-site && wrangler deploy
```

Then set `VITE_PREVIEW_ORIGIN` in the app's build environment to the resulting origin (the code's
default is `https://infinite-preview.powerhouse.workers.dev`), and rebuild the app — Vite inlines the
variable at build time.

Deploys are Bruno's call, per round, like every other production deploy in this repo.
