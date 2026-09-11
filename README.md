# 00 Mini

**An AI agent you don't install.** A whole coding agent — files, editor, terminal, Git, Node with npm
and TypeScript, a live preview and its own memory — running inside a browser tab, on your own GPU or
your own keys, with no account, working offline after the first load. The agent is one encrypted
file you can download, back up, restore and carry to another browser or to the 00 Mac app; with the
00 engine running on your computer it also clones, pushes and pulls through it.

Live: https://infinite-site.powerhouse.workers.dev (dev link) · the 00 platform: https://0-0.chat

## What is in this repository

| Folder | What |
|---|---|
| `packages/agent-fs` | The agent's filesystem: OPFS and in-memory adapters, the `.00agent` bundle (gzip tar, AES-256-GCM), Git over isomorphic-git, remote git through a companion |
| `packages/agent-models` | Brains behind one interface: LiteRT/MediaPipe (Gemma, on-device), Transformers.js on WebGPU (Gemma 4, Qwen3.5, Phi-4, Llama 3.2 — with vision), WebLLM, OpenAI-compatible, Anthropic, the sponsored device-signed transport, class-aware routing |
| `packages/agent-runtime` | The agent loop, tools, permissions, sessions, the vault, prompt budgeting, loop detection |
| `packages/agent-node` | Node in the tab: core-module polyfills over the agent's filesystem, a CommonJS/ESM loader with `node_modules` resolution, an npm client, a Worker-per-process model, a TypeScript transform through esbuild-wasm |
| `packages/shared` | A pinned copy of the contracts shared with the 00 engine (`scripts/check-shared.sh`) |
| `apps/infinite` | The PWA (Vue 3): the landing page, the floating widget, the full app, and the embed loader for any website |
| `apps/infinite-site` | The static Worker that serves the app, the embed at `/e/<ref>.js`, the model weights and a read-only fetch proxy |
| `apps/infinite-preview-site` | A second origin for the live preview with element picking |
| `docs/` | The plan and contract (`HANDOFF-infinite-agent.md`); the design brief is `apps/infinite/DESIGN.md` |

## Run it

```sh
pnpm install
pnpm -C packages/shared build
pnpm -C apps/infinite dev
```

Open http://localhost:5273. The local brain downloads a model from the project's public mirror the
first time you ask for it; set `VITE_LITERT_MODEL_BASE` to serve your own copy (see
`apps/infinite/.env.example`).

## Put it on a website

```html
<script async src="https://<your deployment>/e/ia_….js"></script>
```

The tag is minted in the owner's browser; level 0 needs no account and no server of ours. The
owner's setup is a step-by-step wizard behind the gear in the widget.

## The rules it keeps

- **No account until the last moment.** Everything local works with nothing signed.
- **Secrets stay in the vault**, under a password or a passkey, in the owner's browser only. An
  embedded agent never holds one.
- **Models come with their terms.** Each row names its licence; Gemma's terms and Llama's community
  licence are served beside the weights.
- **Text on a page is data**, never an instruction the agent obeys.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
