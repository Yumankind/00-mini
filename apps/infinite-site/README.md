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

There are **no bindings** — no D1, no KV, no R2, no secrets. Phases 0–2 need no backend (§9.1);
registration, the inbox and push arrive in Phase 3, in moltworker or in a second Worker (§9.4).

## Preview

```sh
cd apps/infinite-site && wrangler dev --port 8794
```

Then check the two things that matter:

```sh
curl -sI http://127.0.0.1:8794/e/ia_test_abcdefgh.js | grep -i "content-type\|cache-control"
curl -s  http://127.0.0.1:8794/e/ia_test_abcdefgh.js | head -c 60    # the IIFE, not HTML
```

## Deploy

```sh
apps/infinite-site/scripts/build-site.sh
cd apps/infinite-site && wrangler deploy
```

No custom domain is claimed yet — the workers.dev URL is what a snippet points at until the hostname
is decided (§12). Adding a `routes` entry to `wrangler.jsonc` later changes nothing else.

Deploys are Bruno's call, per round, like every other production deploy in this repo.
