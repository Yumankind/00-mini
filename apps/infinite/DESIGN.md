# 00 Mini — design brief (2026-09-11)

The product formerly labelled "Infinite Agent" in the UI is branded **00 Mini**: an AI agent you do
not install. Code names (`infinite`, `ia_` refs, `@00/agent-*`) do not change; only what a person
reads does. Three surfaces share one look:

| Surface | Where | Owner |
|---|---|---|
| **Full app** — Codex-like IDE/chat, every pane | `/app` (and any deep link the app already answers) | `src/App.vue` and the panes |
| **Floating 00 Mini** — one session, minimalist, over the landing page, follows the scroll | `/` (landing + widget), expand → `/app` | `src/mini/`, `src/landing/` |
| **Embedded 00 Mini** — the same widget on any website | `/e/<ref>.js` | `embed/src/panel/` |

The floating widget and the embed are **pixel-for-pixel the same UI**: both render the class names
and the CSS string in `src/mini/mini-css.ts` (import-free, so the 60 KB embed can carry it) and the
brand SVG in `src/mini/brand.ts`. The full app is the "expanded" reading of the same brand.

## Brand

- Name: **00 Mini**. Never "Infinite Agent" in copy (the plan keeps the working name in prose).
- Logo: the 8×8 pixel face of the main website (`landing/components/PixelFace.vue`), lit in mint on
  near-black. Vue port at `src/components/PixelFace.vue`; string SVG at `src/mini/brand.ts`
  (`pixelFaceSvg({ size, color, bg })`). The face blinks on idle, "thinks" while a run is in flight.
- Voice: short, plain, no exclamation marks. Feature claims match what ships.

## Tokens (the existing variable names stay; the values move to a Codex-neutral palette)

Light (default when the system asks for light):

```
--color-void: #ffffff      page
--color-card: #fafafa      grouped background
--color-panel: #f4f4f5     surfaces (sidebar, cards)
--color-panel-2: #ececee   raised / hover
--color-line: #e4e4e7      hairlines
--color-ink: #111113       text
--color-ink-dim: #6b6b74   secondary text
--color-ink-faint: #9b9ba3 tertiary (new)
--color-phosphor: #16a37a  the one accent (mint, darker for contrast on white)
--color-cyan: #2f8fd6  --color-amber: #c98a12  --color-red: #d64545
```

Dark:

```
--color-void: #0f0f10   --color-card: #131315   --color-panel: #18181b   --color-panel-2: #212124
--color-line: #2a2a2e   --color-ink: #ededef    --color-ink-dim: #9a9aa3  --color-ink-faint: #64646c
--color-phosphor: #4ade9b  --color-cyan: #5cc8e8  --color-amber: #ecc36b  --color-red: #f0555f
```

- Type: `-apple-system, "Inter", "Segoe UI", system-ui, sans-serif`; body 14px/1.55; small 12px;
  micro 11px. Mono: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`, 12.5px.
- Radii: controls 10px, cards 14px, composer/widget 18px, launcher 999px.
- Shadows: `0 1px 2px rgba(0,0,0,.06)` on light cards; `0 12px 40px rgba(0,0,0,.18)` for floating.
- Primary button: ink on void (black on white / white on black), never mint. Mint is for status
  dots, the face, progress and links.
- Focus: 2px ring in `--color-phosphor` at 40% alpha, offset 1px. Every control keyboard-reachable.
- Motion: 160 ms ease-out; respect `prefers-reduced-motion`.

## The full app (Codex-like)

```
┌ sidebar 260 ┬──────────── thread ────────────┬ workspace (toggle) ┐
│ face 00 Mini│  messages, max-w 44rem centred │ Editor·Preview·Git │
│ + New thread│                                │ Terminal below     │
│ search      │                                │                    │
│ Today       │                                │                    │
│  · thread   │  ┌────────── composer ───────┐ │                    │
│ Yesterday   │  │ textarea                  │ │                    │
│ ─────────── │  │ [+] [model ▾] [sel]  [↑]  │ │                    │
│ Files Git … │  └───────────────────────────┘ │                    │
│ Connections │                                │                    │
│ Vault Move  │                                │                    │
└─────────────┴────────────────────────────────┴────────────────────┘
```

- Sidebar collapses to icons (≥ sm) and becomes a drawer on a phone. Threads grouped by day.
- Messages: user = right-aligned soft bubble (`--color-panel`), agent = full-width rendered
  markdown, no bubble. Tool calls = one compact "activity" card per run of consecutive calls
  ("Read 3 files", "Ran `npm test`") that expands to the detail. Status/download rows inline.
- Composer: one rounded card; attach image (paste, drop, button) → vision parts with thumbnails;
  model chip with download bar; selection chip; round send button; Stop while running.
- Markdown (`src/lib/markdown-lite.ts`, no dependency): headings, nested lists, task lists, tables,
  quotes, rules, links (new tab), images (workspace paths → blob URLs via AgentFs, http(s) as is),
  fenced code with language label + copy button + a small keyword highlighter. Escape first, always.
- Empty state: the face, "What are we building?", four suggestion chips.
- Keyboard: ⌘K command palette (new thread, open file, choose model, toggle workspace, theme,
  lock, move). Esc closes overlays.
- Light and dark, both first-class.

## The floating widget (and the embed)

- Launcher: a pill bottom-right, `position: fixed` (so it follows the scroll), face + "00 Mini".
- Panel: 400 × 640 max, `calc(100vh - 32px)` cap; under 480 px it is a bottom sheet the full width.
- Header: face (thinking while busy), "00 Mini", one line under it (agent name or site name, model
  or "on this device"), actions: new thread · expand (full app; the embed hides it) · close.
- Body: the same row kinds as the app (user, agent markdown, activity line, status, footer, error),
  smaller type (13px).
- Composer: single rounded field, send on Enter, Shift+Enter newline, an attach button when the
  brain sees images, a Stop while running.
- Footer: "on your device only" / sponsor line; the embed keeps "Clear memory".
- Class names (both implementations): `.mini`, `.mini-launcher`, `.mini-panel[data-open]`,
  `.mini-header`, `.mini-face`, `.mini-title`, `.mini-sub`, `.mini-actions`, `.mini-body`,
  `.mini-row.me|.them|.status|.tool|.error|.owner`, `.mini-md` (rendered markdown), `.mini-composer`,
  `.mini-input`, `.mini-send`, `.mini-footer`, `.mini-offer`, `.mini-ask`, `.mini-hit`, `.mini-setup`.

## The landing (`/`, inside the PWA so the widget is the live agent)

Dark-first, fresh, generous whitespace, one accent. Sections with ids the agent can scroll to:
`#hero`, `#code`, `#mobile`, `#file`, `#qr`, `#vault`, `#offline`, `#brains`, `#embed`, `#faq`.
Claims to make, in this order: an AI agent you do not install · everything a coding agent has
(files, terminal, Git, preview, npm) · on your phone too · the whole agent is one file you can
download, back up and restore · bring it with you by scanning a QR code · encrypted at rest, the
vault opens with a passkey or a password · no account · works offline · runs on your own GPU or on
your own keys · one script puts it on your website. Honest footnotes where a road is not live yet.
