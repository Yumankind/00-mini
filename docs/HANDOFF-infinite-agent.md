# Infinite Agent — the browser runtime (plan, 2026-09-10)

Working name: **Infinite Agent**. Tagline under test: *an AI agent that runs in your browser*. Longer
form: *a computer for your AI — filesystem, terminal, Git, browser and local AI, with no install, no
account, and offline.* It connects to 0-0 Cloud (an Overblast workspace), to a sponsoredtokens account
or app, to the 00 Mac app and to the 00 mobile app **only when a step needs them**, and never before.

This document is the plan and the contract. Two repos build to it: `00Local` (runtime, PWA, embed
loader, engine import door) and `moltworker` (registry, purses, relay, push). Where a shape is
final it is written as wire; where it is a decision still open it is listed in §12.

---

## Status (2026-09-10)

**Phases 0, 1 and 2 are BUILT and committed** (`d5d928de` … `5a8d6580`), nothing deployed, no backend
touched. Every package carries coverage floors from its first commit and `scripts/ci-local.sh` runs
them all. What exists:

| Piece | Where | Proof |
|---|---|---|
| Travel policy + manifest types in `@00/shared`; engine door `POST /api/agents/import-bundle` (settings grant, `replace`, 409/400 by name) | `packages/shared/src/bundle*.ts`, `apps/00d/src/bundle-routes.ts` | a bundle built with `node:crypto` + the `tar` CLI alone imports; the full engine suite green under COVERAGE=1 |
| `@00/agent-fs`: OPFS / memory / Node adapters, scaffold (engine text verbatim), the `.00agent` container, git over isomorphic-git | `packages/agent-fs` | bsdtar reads what it writes; an engine-made bundle round-trips byte-exact; `..` refused |
| `@00/agent-models`: OpenAI-compatible, Anthropic, WebLLM 0.2.85, the device-signed sponsored transport (§24 canonical string), Overblast/BYOK factories, router | `packages/agent-models` | 156 tests; catalog ids pinned to the installed prebuilt list |
| `@00/agent-runtime`: the loop, pi 0.84.2 tool schemas verbatim, permissions, pi-shaped sessions, the vault | `packages/agent-runtime` | 165 tests |
| The PWA (simple shell) | `apps/infinite/src` | live: OPFS scaffold, brain cards with real readiness, vault create/unlock gate, 375 px layout |
| The embed at level 0 + `apps/infinite-site` | `apps/infinite/embed` | live on a fake shop: depth-2 crawl via sitemap, `/logout` guarded, links-out recorded, "where is the basket" outlined the button, closed shadow root; `e.js` 32 KB gz |

**Phase 0's proof is closed (later the same day):** `apps/00d/test/bundle-roundtrip.test.ts`
scaffolds with `@00/agent-fs`, exports as the browser does, imports through the engine's JSON door
(`{ path, secret }` inside `<dataRoot>/imports/`), exports through
`POST /api/agents/:id/export-bundle`, imports that with the browser's reader, and compares every
travelled byte both ways. The Mac app opens `.00agent` as a document type and answers the two
`zerozero://agent/…` links (§7.2); the web UI carries the import prompt and the "move to a browser"
card. Live on a real Mac (double-click → prompt → agent) is still a manual check to run.

**Local brains (later the same day):** the installed MediaPipe package names the **Gemma 4 E2B and
E4B web assets**, so LiteRT covers Gemma 4 and no third runtime is needed; `LiteRtProvider` is
preferred, WebLLM is the fallback. MediaPipe 0.10.29 exposes **no function calling** either, so
every local brain uses the shared prompt fallback for tools. The PWA must serve MediaPipe's `wasm/`
folder from its own origin and pass a `modelBaseUrl` (decision §12.7).

**Findings the builders reported, to act on (not yet in the contracts):**
1. No local runtime has native function calling today (web-llm: only 7B–8B Hermes builds;
   MediaPipe 0.10.29: none at all): every level-0 tool call goes through the shared prompt
   fallback. Treat local tool use as best-effort; twin-guard tests flag the day either changes.
2. The sponsor footer's wire shape is inferred from `attribution.ts` (text after `— sponsored by `),
   not observed; the CORS-exposed `Sponsored-By` headers may be the better source. Capture live
   traffic once `APPS_ENABLED` is on and decide.
3. The sponsored catalog source for a device caller is unnamed (`GET /api/v1/models?tier=` looks
   intended); Overblast's `models` come from the mint call. Both providers take the catalog as a
   parameter for now.
4. `api.ts` gaps found by the PWA: the vault is not in the frozen surface; `agent_message` does not
   say delta vs whole; `readiness().detail` is free-form (a `progress?: number` is wanted);
   `ModelProvider` has no `unload`; `RunResult` lacks `providerId`; providers are fixed at
   construction (a `setProviders` would remove the PWA's façade). Promote these in one contract
   revision, with both app owners in the loop.
5. Runtime divergences from the engine, all documented in-module: `grep`/`find` ignore no
   `.gitignore`; git tools have no engine twin (a Mac agent uses `bash`); no `git_push` by design;
   the router's class-aware routing of §6 is not implemented (`auto` = first ready provider).
6. Argon2id at 64 MiB / t=3 makes an unlock cost a visible second or two on a laptop. Intended;
   the UI should say "unlocking…".
7. The embed relies on `createAgentRuntime` spreading `opts.context` per turn so the site map stays
   fresh; a guard test pins it.

---

## 0. The three rulings this plan rests on

1. **The browser is the fourth engine host, not a new product line.** The Mac engine, the container
   engine and the headless Linux engine already move an agent as ONE encrypted file (the burst
   bundle: `apps/00d/src/burst-bundle.ts`, classes in `bundle-policy.ts`, layout in
   `docs/agent-layout.md`). The browser holds the same `agents/<id>/` tree in OPFS and speaks the same
   bundle. "Transfer" is export, move bytes, import. Nothing in the OPFS layout is invented here.
2. **Two agents, the two we already have.** The agent you own in your browser is the FULL agent
   (`tools.ts` trust tier). The agent you embed on a website is the LIGHT agent (`light-tools.ts`
   trust tier: read-only public knowledge, its own thread sandbox, no shell, no secrets, replies to
   this conversation only). The embed is never a second full agent running on a stranger's machine.
3. **The account is postponed to the last moment, and the last moment is named.** Every step lists
   what it works without. A step that needs a purse or an identity asks for exactly that, when it is
   first needed, and works in a reduced form until then.

House rules that apply unchanged: worker-first, containers gated (a container appears in exactly one
place, §8.3); no hardcoded business models (plans, caps and tiers come from the worker); pnpm only;
`docs/` is copied into every agent's workspace, so this file is what every agent reads about it.

---

## 1. Product surfaces

| Surface | What it is | Needs |
|---|---|---|
| **Owned agent** | The full agent, generated on first visit of the product origin, living in that browser's OPFS. One per browser profile. Simple shell by default, power shell on demand. | Nothing. Works offline after first load. |
| **Embedded agent** | The light agent, dropped into any website with one `<script>` tag. Answers visitors from the site's own pages. | Nothing for level 0. Registration for a stronger brain or to reach the owner. |
| **Transfer** | Move the owned agent between browsers (desktop ↔ mobile browser), to the Mac app, or to a phone that only carries it. | A file, or a 6-word code and a moment where both devices are online. |
| **Connections** | Sponsored brain, Overblast credits and cloud computers, the Mac engine, the 00 mobile app. | Each one asks for its own thing, when reached. |

The two shells share one runtime and one event bus:

- **Simple**: conversation, files, approvals, connections. What the phone shows today.
- **Power**: the IDE layout from the spec — files / editor-browser-preview / agent, terminal below.
  Same runtime, more panes. A power-shell agent moved to the Mac is the same agent.

---

## 2. The runtime (framework-free, runs in a Web Worker)

```
AgentRuntime
 ├── ContextManager      what the model sees this turn (never the whole filesystem)
 ├── Planner             the loop: understand → inspect → plan → tool → observe → continue
 ├── ModelRouter         picks a ModelProvider per request (§6); the agent never knows which
 ├── ToolRegistry        JSON-schema tools, the ENGINE'S names (read/write/edit/ls/grep/find/bash…)
 ├── ToolExecutor        runs tools; local or remote is the executor's business, not the model's
 ├── PermissionManager   safe / confirm / high-risk, scoped to tool × origin × workspace × session
 ├── MemoryManager       MEMORY.md index + memory/ notes, retrieved, never bulk-injected
 ├── EventBus            every step is an AgentEvent; the UI, the recorder and the tests read it
 └── SessionManager      sessions/*.jsonl in the engine's shape, so a moved agent keeps its history
```

**Why the engine's tool names and prompt text.** `platform-doc.ts` writes the operating rules every
00 agent reads; `AGENTS.md`/`SOUL.md`/`IDENTITY.md`/`USER.md`/`MEMORY.md` are the identity. The
browser runtime uses the same files, the same prompt scaffold and the same tool vocabulary, or an
agent changes personality on the way to the Mac. Pi (`@earendil-works/pi-coding-agent`) is Node and
does not run in a browser, so the loop is a small re-implementation. It is kept small on purpose:
the tools do the work, the model chooses.

**What moves into `@00/shared`** so browser and engine classify identically:
`bundle-policy` (the four classes + `.00ignore` matcher), the `BurstManifest` types, the
tool schemas' names and descriptions, the session JSONL shape. This is a prerequisite of Phase 0.

**Custom tools** (`tools/<name>/tool.json`, a shell command each): imported and listed. Ones the WASM
shell cannot run are shown as *wakes on your Mac / in the cloud*, never hidden and never deleted.

**Skills, viewers and AI Apps** run unmodified: the browser renders the same opaque-origin
`postMessage` bridge the Mac and the phone use (`docs/HANDOFF-skill-viewers-phone.md`,
`docs/HANDOFF-skill-apps.md`). Consent for an app's capabilities is given in the owned agent's own
shell, since here the owner *is* at the machine.

---

## 3. Storage — the agent as a file

### 3.1 OPFS layout

Exactly `agents/<id>/` from `docs/agent-layout.md`. Two host-specific additions, both `ephemeral`
class so they never travel:

```
agents/<id>/
  .browser/                 ← host state: model cache pointers, crawl indexes, service-worker marks
  workspace/tmp/            ← already ephemeral
```

IndexedDB holds what the engine keeps in `~/Library/Application Support/00`: settings, the
vault (§4.5: BYOK keys, link keys, device tokens, sealed under the person's password or passkey),
permissions, push subscription.
Cache Storage holds model weights and the app shell.

### 3.2 The `.00agent` file

A burst bundle, `mode: "full"`, manifest **version 1** (the version number names the PAYLOAD LAYOUT the
reader must expect, not a document revision: 2 is session mode with a baseline and a `home/` payload;
full and paths stay at 1 so every engine keeps importing them), plus one additive field:

```ts
interface BurstManifest {
  version: 1 | 2;
  agentId: string;
  mode: "full" | "paths" | "session" | "wake";
  // …existing fields…
  host?: "mac" | "linux" | "container" | "browser";   // NEW, informational, who exported it
}
```

Encryption: AES-256-GCM as today. The key is derived from the transfer secret (§7): the pairing code
for a live transfer, a passphrase the person types for a file they download. R2, the relay and any
third party see ciphertext only. A bundle without its secret is noise.

### 3.3 Storage durability (the honest part)

- Call `navigator.storage.persist()` on first agent creation and show the answer.
- Safari evicts script-writable storage of sites the person has not interacted with for seven days
  unless the site is installed to the home screen. The owned agent therefore nags, once, to install
  the PWA, and offers **Backup** from day one: a `.00agent` file (download / share sheet / AirDrop)
  or the encrypted copy in R2 (§8.1, needs a link key only, no account).
- OPFS is per origin. The owned agent lives on ONE product origin (decision §12.1), not on the
  marketing landing.

---

## 4. The owned agent (full agent in the browser)

### 4.1 First visit

```
0 ms       shell paints (service worker, offline-capable after this)
< 500 ms   OPFS mounted; if no agent: scaffold one (profile.json, identity files, pixel avatar,
           BOOTSTRAP.md for the onboarding interview) — same scaffold rules as scaffold.ts
1–3 s      runtime worker up; retrieval (BM25 over the workspace) works with no model at all
2–10 s     small local model streams in (Cache Storage; "Local AI · ready" when compiled)
later      optional bigger local models; connections when the person reaches for one
```

Nothing above talks to our servers except fetching the static app shell and the model weights.

### 4.2 Tools, by where they run

| Local, in the browser | Remote, when connected |
|---|---|
| filesystem (OPFS), search, edit | — |
| git (`isomorphic-git`) with short-lived OAuth, never a stored PAT | — |
| terminal: WASM shell (decision §12.4) | container shell via session burst (§8.3) |
| Python: Pyodide (V2) | native Python in the container |
| browser: the app's own preview pane and DOM inspection of pages it renders | remote Chromium in the container |
| HTTP: GET only, CORS-bound | broader network in the container |
| vision: local small VLM or the brain provider | — |
| voice: Whisper wasm (V2) | — |
| media: Canvas/WebCodecs, ffmpeg.wasm (V2) | ffmpeg in the container |
| SSH client in the browser, key never leaves it | Worker TCP forward to explicitly authorised hosts only |

### 4.3 Permissions

Three tiers, the platform's existing vocabulary: **safe** (auto), **confirm** (write/delete/commit/
send/submit), **high-risk** (payments, account changes, SSH, publishing, external mutations —
always explicit). Scoped to tool × origin × workspace × session, stored in IndexedDB, exported in
the bundle under `identity` class so a moved agent keeps the person's standing answers.

### 4.4 Offline

Local model, OPFS, Git, retrieval, local tools, local viewers. Every remote thing greys out with one
line of why. The header shows `Offline · local agent available`.

### 4.5 Secrets — the owner's vault (owned agent only, never an embedded agent)

The owned agent may keep secrets (BYOK keys, Git OAuth refresh tokens, SSH private keys, the link
keys of §5.1, `sk-obd` device tokens) **only encrypted under a key the person holds**, never under
one the browser holds for them:

- **Password.** Argon2id (wasm) over a password asked **every time the person enters**; the derived
  key unwraps the vault key. Nothing about the password is stored.
- **Passkey.** WebAuthn with the PRF extension: the authenticator returns a per-credential secret at
  each sign-in, HKDF'd into the wrapping key. Face or fingerprint every time the person enters;
  device-bound by construction.
- Vault format is the engine's: AES-256-GCM, names visible, values sealed; the agent sees **names
  only** and tools resolve values at use, the same rule as `secret-store.ts` on the Mac.
- Unlocked material lives in the runtime worker's memory only, is wiped on tab close, on lock, and
  after 30 minutes idle; `Lock now` is always one click away.
- **Transfer.** A password-wrapped vault may travel inside the `.00agent` if the person ticks
  *carry my secrets* (the bundle is then encrypted twice: vault key, then transfer key). A
  passkey-wrapped vault cannot travel, because the PRF secret never leaves that authenticator; the
  flow offers to re-wrap it under a password for the move, or to re-enter secrets on the far side.
- **Embedded agents have no vault, no secrets and no `list_secrets`**, in any level, on any host.
  Their brains are paid by the app server-side (§6.2, §6.3), and nothing they could leak is worth
  more than one visitor's session.

### 4.6 Background

Nothing depends on a tab staying open. Long work goes to a session burst (§8.3) and comes back as a
Web Push (`Your agent finished`). Schedules and watchers (`workspace/schedules/*.md`,
`watchers/*.md`) travel with the agent as definitions; in a browser they run only while the tab is
open, and the UI says so and offers the Mac or the cloud for real schedules.

---

## 5. The embedded agent (light agent on any website)

### 5.1 The snippet

```html
<script async src="https://<product-host>/e/<agentRef>.js"></script>
```

`agentRef = ia_<base32 unix-seconds>_<12 chars base32 random>`, minted in the owned agent's browser,
**offline, with no server call**. The ref, and the whole `<script>` tag, are **public by design**:
anyone can read them in the page source, and that is fine, because a ref grants nothing. It
registers **once, on its first use on a website** (§5.3), and from then on it identifies the app.

Alongside the ref the owned agent mints an ed25519 **link keypair**. The private half never leaves
the owner's browser key store and is never in the snippet; it is only used later, to sign the claim
(§5.4), the public-bundle upload (§5.5) and the inbox drain (§5.6). Public ref in the page, private
key at home: that is the whole of the identity model.

The loader at `/e/<ref>.js` is one static, edge-cached script; the server does not need to know the
ref to serve it. The ref is what the loader carries, and what every later call is keyed on.

Owner settings that must reach visitors **before** anything is registered have two carriers that
need nothing of ours, and the loader reads them in this order of precedence:

1. **The claimed app's public bundle** (§5.5), signed by the link key — once it exists.
2. **A file on the website**: `GET /.well-known/infinite-agent.json`, same origin, fetched once per
   open and cached by ETag. The snippet never changes again; settings are edited in place; and the
   file is **domain-ownership proof** for the claim, the way site-verification files are (whoever
   can write the site root is the admin). It may also list same-origin knowledge files, so the
   owner's persona and FAQ reach visitors with no server of ours at all.
3. **The snippet itself**: `data-site='<base64url site.json>'` on the `<script>` tag, for hosts
   where the owner can paste a script but cannot add a file (many site builders). Changing a
   setting means re-pasting.
4. Built-in defaults.

The setup flow (§5.2.4) writes whichever carrier the owner picks and the owner panel shows which one
is in effect. The document is the same `site.json` in all three.

### 5.2 Level 0 — no registration, no account, nothing of ours beyond the static script

On the host page the loader mounts a launcher in a closed shadow root and does nothing until
clicked. From the first click it is a site guide: it knows the site's pages, finds things in them,
opens pages, scrolls to elements and points at buttons, and tells the visitor where something is or
where it can be done **in the site as it is right now**, logged out or logged in.

#### 5.2.1 Site knowledge — the crawl

- **Scope is the site's own origin, always.** Same scheme and host as the page the script is on.
  External links are recorded as *links out* (URL and anchor text) so the agent can mention them,
  and never fetched. This is a rule, not an option.
- **On load, a shallow crawl**: the current page, then its links (level 1), then theirs (level 2),
  bounded (defaults: depth 2, ≤ 60 pages on load, ≤ 400 KB of extracted text per page, ≤ 8 MB
  total, 2 fetches in flight, 250 ms apart). `sitemap.xml` and `robots.txt` are read first when
  present: the sitemap seeds the page list with `lastmod`, robots and `<meta name=robots>` /
  `rel=nofollow` are honoured.
- **GET only, with guardrails.** Fetches are same-origin `GET`s with the visitor's own credentials,
  so a logged-in visitor's crawl sees their logged-in site and a logged-out visitor's sees the public
  one. Never `POST`, never a form submission, never a URL that looks like it changes state: paths or
  queries matching `logout|signout|sign-out|delete|remove|cancel|unsubscribe|add-to-cart|checkout/
  (complete|confirm)|action=|token=|reset`, anything under `admin|wp-admin|account/(settings|
  delete)`, plus the owner's exclude list. Non-HTML responses, responses over the size cap, and
  redirects off-origin are dropped. Pages that answered with a login form are recorded as
  `requiresAuth` and not retried in that session.
- **Each page becomes an entry**: `url, title, description (meta or the first 200 chars), headings,
  extracted text (readability-style, scripts/nav/footer stripped), links in/out, forms and actions
  seen (labels only, never values), interactive landmarks (buttons, menus, search boxes with
  their accessible names), authState, lastmod/ETag, crawledAt, depth, source (sitemap|link|hint)`.
  Text is chunked and BM25-indexed.
- **Persisted per website.** IndexedDB, in the visitor's browser, keyed by `origin + ref`. Opening
  the embed again on that site reuses the index; a page is refetched only when its `lastmod`/ETag
  changed, when it is older than the owner's TTL (default 7 days), or when the visitor's `authState`
  differs from the one it was crawled in. Storage is partitioned per top-level site by the
  browsers, so nothing about one site is visible from another, and nothing is ever uploaded: a
  logged-in visitor's view of the site stays on their device.
- **Staleness.** Every entry carries `crawledAt`. On open, entries past the TTL are re-fetched in
  the background under the on-load bounds, home page and sitemap `lastmod` first; an entry that no
  longer answers 200 is dropped, and a whole index older than 30 days with no successful refresh is
  rebuilt from scratch rather than patched.
- **The session signal, and what logout does.** Every entry records the `authState` it was
  crawled in (`anon | authed | unknown`). The loader learns the state from the signal the owner
  configured in setup (§5.2.4 step 2, `site.json.session`):
  `cookie` (named cookies, read via `document.cookie` / the Cookie Store API, so HttpOnly session
  cookies cannot be used and the flow says so), `localStorage` (named keys, watched through the
  `storage` event and a poll), `temporary` (a session that lives in memory or `sessionStorage`
  only), or `none`, in which case the loader falls back to the heuristic (a sign-in control present
  ⇒ `anon`, an account/sign-out control present ⇒ `authed`, neither ⇒ `unknown`) plus the owner's
  `logoutPaths`.
  **On a logout** — the signal disappears, a navigation hits a `logoutPaths` entry, or a page that
  was indexed as `authed` now answers with a login form — the loader **deletes every entry crawled
  while `authed`**, and every entry crawled while `unknown` deeper than level 1, because it may hold
  that person's private data. What remains is the public, shallow map, and the next open re-crawls
  from there. `temporary` is stricter: `authed` entries never reach IndexedDB at all; they live in
  memory and die with the tab, so a shared computer keeps nothing.
  The same purge runs when the visitor clears the panel's memory (a button in the panel footer,
  always present), when the owner's `site.json` version changes, and when `crawlAuthed` is off, in
  which case nothing is indexed while `authed` in the first place.
- **Deeper on demand, never the whole site.** When the question needs more, the agent asks for a
  targeted crawl with a hint, and the crawler picks the next pages by hint against titles, URLs and
  anchor text (a product question crawls `/products`, `/catalog`, `/shop` and their children; a
  policy question crawls `/help`, `/faq`, `/terms`). Same bounds per round (≤ 40 pages), same
  guardrails, and the visitor sees a small `looking through the catalog…` line while it runs.

#### 5.2.2 What the light agent gets

The agent never receives the crawl; it receives a **site map** (every known page as one line:
path, title, description, authState, `depth`) at the top of its context, and tools:

| Tool | Does | Tier |
|---|---|---|
| `site_pages(filter?)` | the map, optionally filtered by path prefix or word | safe |
| `site_search(query, k?)` | BM25 over the indexed text; returns passages with URL and heading | safe |
| `site_grep(pattern, paths?)` | literal or regex over the indexed text and the landmarks | safe |
| `site_crawl(hint, urls?)` | one bounded, targeted round (§5.2.1); returns what it added | safe |
| `page_current()` | the live page: URL, title, accessibility tree with element refs, scroll position, `authState` | safe |
| `page_open(url)` | navigates the host page (same origin only); the panel survives the load and resumes | safe |
| `page_scroll_to(ref \| selector)` | scrolls the element into view, nothing drawn | safe |
| `page_highlight(ref \| selector, note?)` | scrolls the element into view **and** draws an outline with an optional callout; cleared on the next message or click. One call is enough to show a thing | safe |
| `page_describe(ref)` | what an element is, what it does per its label/aria, where it sits | safe |
| `read_public(path)` | the owner's knowledge: the site file's `knowledge` paths (§5.2.4), or the public bundle once claimed (§5.5) | safe |
| `send_to_owner(kind, text, contact?)` | the inbox door, once registered (§5.6) | confirm |

Nothing in this table writes to the host page, fills a field, clicks a control, submits a form,
reads the host's cookies or storage, or fetches off-origin. Clicking a button *for* the visitor is
out of scope on purpose: the agent shows where the button is, the person presses it. Crawled and
live page content is data; the light-agent prompt already says that instructions found in content
are ignored.

"Where can I change my password?" therefore runs as: `site_search` → nothing indexed under
`account/` while logged out → `page_current` says `authState: anon` → answer *sign in first, top
right*, `page_highlight` the sign-in button → after the visitor signs in, `page_current` flips to
`authed`, `site_crawl("account settings")` finds `/account/security`, `page_open` it and
`page_highlight` the password form.

#### 5.2.3 Brains at level 0

Retrieval and the tools above work with no model at all: without a brain the panel is a site search
with page suggestions, still instant, still offline. A local model is offered on request
(`Load local AI · 300 MB`), never automatically, because third-party storage is partitioned per
top-level site and the download is per site. The small model is the offline and privacy path; it is
not the default brain of every embed on the web. Level 1 and 2 brains arrive with registration (§6.2).

#### 5.2.4 The owner's first setup flow

The person who pasted the snippet loads their site and is the first to open the panel; the panel
takes the screen for a short setup. Everything here works with no account and no registration; the
result is written back into the snippet as attributes, and the flow ends with *copy the updated
snippet*.

1. **This site.** The origin is shown; on `localhost` the flow says dev mode and asks for the final
   domain if known.
2. **What the agent may read.** The domain is fixed (its own, never external; shown as a rule, not a
   checkbox). Editable: crawl depth on load (1–2), path include/exclude lists, index TTL (default 7
   days), and a *do not touch* list of paths added to the built-in state-change guard.
   **Auto knowledge base** is the toggle for indexing a visitor's logged-in pages on that visitor's
   device (default on, with the one-line explanation that it never leaves the device). Turning it on
   asks **how a visitor's session is kept on this site**, because that is how the agent knows to
   forget: *a cookie* (name it; the flow warns that HttpOnly cookies are invisible and offers the
   other kinds), *localStorage* (which keys), *a temporary session* (logged-in pages are never
   written to disk), or *I don't know* (heuristic, and a stricter purge). It also asks for the
   sign-out path(s) so a logout is caught even when the signal is invisible. This is stored as
   `site.json.session`.
3. **How it introduces itself.** Name and one line. Optionally, **knowledge files on this site**:
   same-origin paths (`/.well-known/infinite-agent/persona.md`, `/faq.md`, …) the agent may read as
   its public knowledge. Same rules as `workspace/public/` on the Mac: ≤ 256 KB total, text only.
4. **Where to keep these settings.** Two choices, the flow explains both in a line each:
   - *A file on my site* — the flow shows the `site.json` to save at `/.well-known/infinite-agent.json`
     and re-checks the URL until it answers. The snippet is then the bare one:
     `<script async src="https://<host>/e/<ref>.js"></script>`
   - *In the snippet* — `<script async src="https://<host>/e/<ref>.js" data-site='<base64url site.json>'></script>`
     with the note that changes mean pasting again.
5. **Optional, later.** Register and claim (§5.3–5.4), publish your agent's knowledge (§5.5), get
   messages (§5.6), give it a stronger brain (§6.2). Each is a card with what it needs; none is
   required to finish.

`site.json` is the same document in all three carriers (site file or snippet attribute before the
claim, public bundle after):

```jsonc
{
  "version": 1,
  "ref": "ia_…",                        // site file only: binds the file to the ref, which is the ownership proof
  "depth": 2, "includes": [], "excludes": [], "ttlDays": 7, "doNotTouch": [],
  "crawlAuthed": true,
  "session": {
    "kind": "cookie" | "localStorage" | "temporary" | "none",
    "cookies": ["session_id"],          // kind: cookie — names only, values are never read into the index
    "storageKeys": ["auth.token"],      // kind: localStorage — names only
    "logoutPaths": ["/logout", "/account/signout"]
  },
  "intro": { "name": "…", "line": "…" },
  "knowledge": ["/.well-known/infinite-agent/persona.md", "/faq.md"]   // same-origin, ≤ 256 KB total
}
```

validated by the loader with every field clamped (≤ 16 entries per list, names ≤ 64 chars, paths
must be same-origin relative) and unknown fields dropped. A site file whose `ref` does not match
the loaded snippet is ignored and reported in the owner panel.

With a site file and `knowledge` in place, registration (§5.3) is needed for exactly two things:
a stronger brain and messages to the owner. Persona and knowledge no longer need it.

That is a useful product on its own, and it is the whole of what a site gets before anyone signs
anything.

### 5.3 Registration — the app

Registration exists for exactly two things: a stronger brain and messages to the owner. (Persona
and public knowledge can be served by the site itself, §5.2.4; the public bundle of §5.5 is the
alternative for owners who cannot host files.) The loader requests it the first time one of those
is reached for, or when the first person on the site opens the admin flow.

```
POST /infinite/apps/register
  { ref, origin, linkPub, mode: "auto" }
  → 201 { appId, status: "dev" | "unclaimed", claimNonce }
  → 409 { code: "ref_registered", appId }          // a second site loading the same ref
  → 429 { code: "ip_limited", retryAfter }          // one registration per IP per 24 h (KV)
```

- The worker reads the **domain from the request's `Origin`** and stores it as the app's first
  allowed origin. `localhost`, `127.0.0.1`, `*.localhost` ⇒ `status: "dev"` (dev mode: level 0 plus
  a dev-sized allowance, banner in the panel, asks for the final domain if known; otherwise it is
  set later in the owner panel).
- **The first user is the admin.** On a first load that is not dev, the panel takes the screen:
  *This agent is not registered for yoursite.com yet. Is it yours?* → **Claim** (§5.4) / **Later**.
  Later leaves the app `unclaimed` with level 0 only; the prompt returns on the next admin-looking
  action, never to ordinary visitors after the first day.
- Someone pasting **your** ref on **their** site gets `ref_registered` and their origin queued as
  `requested`, visible to you in the owner panel, allowed only by you. Origins are an allow-list
  the owner edits; the proxy and the inbox check `Origin` on every call.
- Signup velocity, Turnstile on the claim flow and the two brakes (`pool.paused`,
  `signups.closed`) apply as they do to sponsoredtokens sign-ups.

### 5.4 Claim — proving it is your agent

The claim is a signature with the link key, so it is completed **in the owned agent's browser**:
the admin flow opens the product origin with `?claim=<appId>&nonce=…`, the owned agent signs
`appId‖origin‖nonce`, and posts it:

```
POST /infinite/apps/:id/claim   { ref, sig }  → 200 { status: "claimed" }
```

Claimed means: the owner may publish the public bundle, drain the inbox, edit origins, link a purse.
**No account yet.** A claimed app with no purse still has level 0 and messages to the owner; a
stronger brain is what finally asks for the sponsoredtokens account (§6.2).

Two proofs, two questions. The link-key signature proves **the agent is yours**. The site file
`/.well-known/infinite-agent.json` carrying the same `ref` proves **the domain is yours**: the worker
fetches it once at registration and again at claim (same SSRF rules as the sponsor scrape, 64 KB
cap, no redirects off-origin), and an origin with a matching file is marked `verified`. A verified
origin is allowed without the owner's manual approval, and a stranger's site pasting your ref stays
`requested`, because they cannot put your file at their root. The snippet-only carrier keeps the
manual allow-list; it is the price of not having a file.

### 5.5 Persona and public knowledge on the embed

The owned agent publishes `PERSONA.md` + `workspace/public/` (≤ 256 KB, the `read_public` surface,
nothing else — never memory, never projects) as a signed public bundle:

```
PUT  /infinite/apps/:id/public-bundle   (link-key signed)  → 204
GET  /infinite/apps/:id/public-bundle   (public, cached, ETag)
```

The embed merges it with the site crawl. Same boundary as on the Mac: `public/` is the ONLY bridge
from the private workspace to the light agent.

### 5.6 Messages back to the owner

Visitor → owner is a queue at the worker, keyed by app, drained by the owner; the visitor never
addresses the owner's device.

```
# the visitor's device key is the sponsoredtokens one (§6.2); before the app is linked to one, a
# per-site P-256 key registered here with the same Origin check and the same per-IP cap
POST /infinite/apps/:id/devices          { devicePub }  → { deviceId, caps }
POST /infinite/apps/:id/inbox            { kind: "message"|"lead"|"task", text, contact? }   // device-signed
GET  /infinite/apps/:id/inbox?since       (link-key signed)  → owner drains
POST /infinite/apps/:id/inbox/:mid/reply  (link-key signed)
GET  /infinite/apps/:id/devices/me/messages  (device-signed)  → visitor polls, webchat pattern
```

Caps without a purse: 200 open items per app, 7-day retention, then the owner is asked to link a
purse or connect Overblast. The owned agent shows them as `escalations/` (the existing folder) and
answers through the same approve-before-send door; a light reply queues until the owner is present
unless the owner turns on direct send for that app.

**When the owner has an Overblast workspace**, this whole section is replaced by what exists: the
embed becomes the Overblast webchat channel (ECDSA visitor keys, `social/webchat.ts`), the
worker-native auto-reply agent answers 24/7 from `system-prompt.md`/`business-info.md`, escalations
arrive as `agent_asks` with FCM to the 00 mobile app, and "publish" is the hosting flip that already
ships (`overblast-hosting.ts`). The plan does not build a second one of any of these.

### 5.7 Notifications

`POST /infinite/apps/:id/push-subscriptions` (link-key signed) stores a Web Push subscription for
the browser that holds the owned agent; no account needed. Events: new inbox item, task created,
daily digest. iOS delivers Web Push only to an installed PWA; the owner panel says so.

---

## 6. Brains — three peers behind one door

`ModelProvider` is one interface; the router picks by request class (small local for search,
edits and navigation; the strongest available for planning and code) and by what the person has
connected. The agent never knows which answered. The browser **never holds a platform key** — the
same invariant as containers.

### 6.1 Owned agent

| Level | Provider | Needs | Notes |
|---|---|---|---|
| 0 | Local WebGPU: **LiteRT first** (MediaPipe LLM Inference API, Gemma family), WebLLM as the fallback when LiteRT reports unsupported | nothing | offline; phones stay ≤ 1.5B. Ruling 2026-09-10: LiteRT is faster and more stable than WebLLM's Gemma builds and WebLLM errors on some Windows machines, so it is the preferred runtime; both sit behind the one ModelProvider interface and the router falls through. The PWA must serve MediaPipe's `wasm/` folder itself (offline-first, no CDN), and model assets come from a `modelBaseUrl` the owner hosts (Gemma's terms travel with the redistribution) |
| 1 | sponsoredtokens personal (`sk-st-`) | a passkey account — no email required | referral ladder tiers 0/1/2; tier 3 paid only; sponsor footer shown |
| 2 | Overblast workspace credits | Overblast sign-in; mints an `sk-obd` device token for *browser on <name>* | base `<worker>/ai/v1`; revocable per browser like a laptop; credits stream feeds the chip |
| 3 | BYOK (OpenAI / Anthropic / OpenRouter / custom) | the key, sealed in the vault (§4.5) under password or passkey | travels only password-wrapped and only when the person ticks *carry my secrets*; otherwise re-entered on the far side |

Price presentation rules from the credits work apply: final price only, never the markup.

### 6.2 Embedded agent

Level 0 needs nothing. Everything above it runs through **the owner's own sponsoredtokens app**:
registering the embed for a stronger brain (§5.3) creates, or links, a **frontend-enabled developer
app** on sponsoredtokens (`apps.frontend_enabled`, the device-key flow of the developer-apps handoff
§24, built 2026-09-08) under the owner's passkey account. That is the last moment for an account, and it is one account for
everything that follows. The app pays for answers out of one of three purses, chosen and switchable
in the app dashboard:

| Purse | Who pays | What the visitor sees |
|---|---|---|
| `ads` | the sponsored pool: the sponsor draw of `pipeline.ts`, the referral tier ladder (tier 3 never) | the sponsor footer under the answer |
| `balance` | the app's own allowance (`app-allowance.ts`: lifetime or monthly, daily and per-customer caps) | whatever the allowance rules already say about footers |
| `byok` | the developer's own provider keys, held in the app's settings (§6.3) | nothing |

**Every request is bound to the host and to a device — with the door that exists.** On its first
paid use on a site the visitor's browser mints a non-extractable ECDSA P-256 keypair on the site's
origin and registers it as a **device of the app** through the sponsoredtokens popup
(`/apps/connect/device`: Turnstile on our domain, the per-IP cap, `Origin` checked against the
app's registered origin). Every inference is then a direct call to `sponsoredtokens.com/api/v1/*`
carrying the four `X-Sponsoredtokens-*` headers and the device signature; the inbox calls of §5.6
reuse the same device key. A device is a customer, never a person: no cookie, no fingerprint, no
cross-site identity. The app dashboard shows devices, first and last seen, and spend per device and
per day. **Country and an allow/block list per app** are a later developer-apps round (§9.3): the
device row records `request.cf.country` at registration and the app carries an audience in the
`audience.ts` vocabulary; until then there is no geo control and the plan says so.

The sponsored pipeline does the rest (pre-flight, purse, sponsor draw where the purse is `ads`,
deduction, footer) with the device as end user. The registered origin and the device signature
bound abuse; the per-device and per-app caps bound the damage; the two brakes exist. A key of the
owner's never reaches a visitor's browser under any purse.

### 6.3 BYOK — in the developer's app settings, never in a page

The sponsoredtokens app dashboard gains a **Keys** section: several keys, several providers
(OpenAI, Anthropic, OpenRouter, Google, custom OpenAI-compatible), and **subscription sign-ins**
(Claude Code, Codex and their peers, the same "subscription CLIs" brain the Mac already offers),
stored encrypted worker-side per app, shown by name and last four only. Rules:

- **Rotation.** Keys of one provider form a pool: round-robin by default, a key steps out on `429`
  or a quota error and returns after a cool-down; a subscription token refreshes itself and steps
  out when its window is exhausted. The dashboard shows each key's state and spend.
- **Routing.** The app names a preferred model per class (small / strong); the pipeline picks a key
  from that provider's pool, falls through to the next provider in the owner's order, and to `ads`
  or `balance` only if the owner ticked that fallback.
- **Metering.** BYOK requests still write `usage_events` (cost from the provider's usage, footer
  none) so the dashboard is one ledger.
- **Timing.** This is a developer-apps round of its own (§9.3), useful to every app, scheduled by the
owner after the apps launch. The plan does not wait on it.

**A caveat to decide, not to hide.** Serving a website's visitors through a personal Claude Code
  or Codex subscription may sit outside those subscriptions' terms; the dashboard should say so on
  that row and let the owner choose. It is their key and their terms, and we do not pretend
  otherwise.

The owned agent's BYOK (§6.1 level 3) is a different thing: keys in the owner's own browser vault
(§4.5), used by the owner's own agent, never by an embed.

---

## 7. Transfer — bring it with you

One rule: **one live residence.** A transfer is a move. The source keeps a locked receipt (name,
avatar, when and where it went), the way a full lease locks the local copy today; two live copies
would recreate the merge problem the session baseline exists to solve. *Take a session with me* is
the copy-and-merge variant, session mode with baseline, offered separately.

### 7.1 Live transfer (both devices online for a minute)

Transport is **Cloudflare Realtime**: the Serverless SFU with DataChannels, so neither device needs
a direct path to the other (a phone on cellular and a desktop behind NAT both dial the nearest
edge), and the worker never carries the bytes itself. The SFU app id and secret live in the worker;
each room gets per-peer credentials minted for that room only.

```
A: Move → shows a 6-word code                 B: Receive → types the code
POST /infinite/rooms            → { code, sfu: { sessionId, token } }   (no account; KV, 10-min TTL)
both sides open an SFU session and publish/subscribe ONE DataChannel named by the room
the .00agent goes over it in 16 KB chunks with backpressure and a final sha256
the bundle key is HKDF(code, room salt) — the SFU sees ciphertext; DTLS ends at the edge, so the
  app-layer encryption is the protection, not the transport
both screens show a 4-character confirmation derived from the HKDF key; the person confirms
B imports; B acks over the channel; A locks its copy
```

The SFU's TURN service is the fallback for a direct P2P path if we ever want one; it is not needed
for this flow. Egress is billed per GB, which bounds the cost at the size of a bundle. Rooms carry
no identity; the code is what admits a peer, and it dies with the room.

Desktop ↔ mobile browser, browser ↔ browser, and browser → Mac all use this. The Mac side is the
web UI in the WKWebView (Node has no WebRTC); it posts the received file to a **new engine door**
`POST /api/agents/import-bundle` (multipart, full mode, refuses an id that already exists unless
`replace=true`). The engine's `bundle-routes.ts` has only the preview route today; the import is
`importBundle` in `burst.ts` behind the lease flow, and this door is the second caller.

### 7.2 File transfer — the road that exists first (2026-09-10)

Built before the SFU room, and kept after it as the offline road. Export → a **6-word code** (the
bundle secret; readable because a person types it on the other machine) → `.00agent` download /
share sheet / AirDrop → import on the other side with the code.

**Into the Mac app, without CORS and without a JS blob:** `.00agent` is the app's document type
(exported UTI `com.yumankind.zerozero.agent-bundle`, Mac and iOS), so the downloaded file opens in
00 on double-click or from the browser's post-download "open". The app copies it into
`<dataRoot>/imports/<uuid>.00agent` and tells its web UI `window.__00importAgentBundle({ path, name,
size })` (or reopens the window at `/?import-bundle=<path>`); the UI asks for the code and calls the
engine's JSON import variant `POST /api/agents/import-bundle { path, secret, replace? }`, which reads
ONLY from that folder and deletes the file after. The engine never reads an arbitrary path and
megabytes never cross a JS string. Two deep links help the browser hand over:
`zerozero://agent/import?name=<file>` (open the picker in Downloads with the name hinted) and
`zerozero://agent/receive?code=<six-words>` (Phase 4's live transfer; parsed today, answered with
"coming"). The code is never in a URL.

**Out of the Mac:** `POST /api/agents/:id/export-bundle { secret }` (settings grant, 409 under a
lease) answers the file with `host: "mac"`; the PWA's Restore imports it. The browser side locks
itself into a receipt after "I imported it on my Mac" (one live residence, §7), with *Bring it
back* and an explicit *Unlock anyway*.

An offline LAN path with no file (the Mac app as a local room, or QR-encoded SDP) is a V2 item,
not a promise; the SFU path of §7.1 needs both devices online, which is the common case.

### 7.3 The phone as a holder

The 00 mobile app can **carry** an encrypted `.00agent` without running it: receive it (7.1), keep
it, hand it to the next browser. The 00mc relay is not involved; the file is opaque to the app.

---

## 8. Connections to the ecosystem, each only when reached for

### 8.1 sponsoredtokens

Passkey account for the owned agent's level 1; the owner's own `user`-shape app for embeds with its
three purses, customers, geo controls and keys (§6.2–6.3); the
account page lists the person's Infinite apps and purses; encrypted R2 backup of a `.00agent`
keyed by link key (an account is not required; a link key is).

### 8.2 Overblast / 0-0 Cloud

- Credits as a brain (6.1 level 2, 6.2 level 2).
- Hosting the embed 24/7 = the existing worker-native public agent (5.6).
- Cloud computers: §8.3.
- The 00 mobile app's inbox and FCM for escalations once linked.
- Creating a workspace is offered only when the person asks for hosting or credits, never in the
  claim flow.

### 8.3 Cloud computers — the one place a container appears

The owned agent exports a `session` bundle with baseline to the workspace's box, the container
engine works, the result merges back with `burst-merge.ts`. Uses: remote Chromium, heavy Python,
ffmpeg, npm builds, long jobs, SSH proxying. Gated behind `cloud.burst` and the hours wallet exactly
as on the Mac; never woken implicitly; billed to the workspace's hours. The browser is just another
exporter.

### 8.4 The 00 Mac app

Two doors, never SSH to the Mac:

- **Drive the Mac's agent from the browser** = the browser is a mobile-connect client: ed25519
  keypair in IndexedDB, `00mc` frames through the relay, 24-hour sessions, per-agent opt-in made at
  the Mac. Shared devices talk to an agent and never configure it; the browser is a shared device.
- **Move the agent to the Mac** = §7.1. From then on it is a Mac agent with the Mac's tools, and it
  can move back.

SSH stays a **tool of the browser agent** for the person's own servers: Worker TCP forward
(`connect()`), hosts allow-listed per agent, key in the browser.

### 8.5 The 00 mobile app

The Flutter app already speaks `00mc/3` to an engine. If the browser runtime answers `session.open`,
`prompt`, `sessions.list`, `skill-ui.list`, `skill-ui.open`, and publishes a hub, the phone drives a
browser-hosted agent with **no Flutter change**; the pending-frame drain covers a closed tab.
Running the runtime inside the mobile app is a later phase (WebView first).

---

## 9. Backend touchpoints — and the isolation rule

**Infinite Agent is a customer of sponsoredtokens and of Overblast, not a change to either.** Until
the last moment it touches no backend at all, and when it does, it goes through doors that already
exist, as any third-party developer would. Nothing in this plan sits in the sponsoredtokens launch
path, and no sponsored file is edited for it.

### 9.1 What needs no backend (Phases 0–2, the whole free tier)

The runtime, the owned agent, the vault, the `.00agent` file, the embed at level 0 with its crawl,
site map, tools, session signal and purge, the site file and the snippet attribute, knowledge files
on the owner's site. The loader and the PWA are static: they ship from their own Worker site
(`apps/infinite-site` in 00Local, the pattern of `apps/skills-site` and `apps/models-site`, plain
`npm`, outside the pnpm workspace) with no D1, no KV, no routes. Nothing in moltworker changes.

### 9.2 What already exists on the sponsoredtokens host, gated off, and is used as is

Developer apps are **built and gated off for launch** (`APPS_ENABLED` / `VITE_APPS_ENABLED`,
`docs/sponsoredtokens/HANDOFF-developer-apps.md`). The embed's paid brain (§6.2) is exactly the
**frontend caller** of that handoff's §24, as built on 2026-09-08:

| Plan | Existing door |
|---|---|
| the owner's app | `POST /api/account/apps` with `frontendEnabled`, the owner's registered origin = their site |
| a device as a customer | `app_devices`: P-256 keypair non-extractable in IndexedDB on the site's origin, registered through the `/apps/connect/device` popup on sponsoredtokens.com (Turnstile there, `DEVICES_PER_IP_PER_DAY`, `Origin` checked against the registered origin) |
| every request bound to host and device | the four `X-Sponsoredtokens-*` headers and the ECDSA signature over the canonical string; CORS answers the registered origin only |
| purses `ads` and `balance` | the sponsor draw, the allowance, the pool match, the per-end-user caps of §8 and §23 |
| the ledger and the dashboard | `usage_events`, the account's Apps card |

So the embed does not call a route of ours to spend; it calls `sponsoredtokens.com/api/v1/*` with a
device signature, the way the handoff tells every developer to. There is no `infinite/…/ai/v1`
rewrite to build. The apps flag stays the owner's launch decision: while it is off, the embed has
level 0 and the *stronger brain* card says *coming soon*, which is the truth.

### 9.3 What is new, and belongs to sponsoredtokens as generic app features — later rounds

Two things the plan wants are not Infinite-specific and should land as ordinary developer-apps
rounds when the owner schedules them, after the apps launch, never before:

- **Per-app BYOK with rotation (§6.3)** — a third purse for any frontend or server app.
- **Country on devices and an allow/block list per app (§6.2)** — `app_devices.country` from
  `request.cf.country` at registration, `apps.audience` reusing `audience.ts`, a refusal by name.

Until they exist the plan works without them: purses `ads` and `balance` only, no geo control.
The doc for those rounds is the developer-apps handoff, not this one.

### 9.4 What is new and Infinite's own — one small module, its own flag, its own tables

Only Phase 3's registry needs state that no host has today. It is one module in the Overblast
worker, `worker/src/infinite/`, behind `INFINITE_ENABLED` (off by default, its own reader file in
the style of `apps-flag.ts`), with its own D1 tables and KV prefix, importing nothing from
`sponsored/` and touching no shared route file beyond one mount line:

| Store | What |
|---|---|
| D1 `infinite_apps` | `id, ref, link_pub, status (dev/unclaimed/claimed/killed), created_ip_hash, created_at, claimed_at, st_app_id?, overblast_cid?` |
| D1 `infinite_app_origins` | `app_id, origin, status (allowed/requested/verified/blocked)` |
| D1 `infinite_inbox` | `app_id, mid, kind, text, contact, created_at, drained_at, replied_at` |
| KV | `ia:ip:<hash>` registration limiter; `ia:room:<code>` room + SFU session ids (10 min); replay nonces |
| R2 | `infinite/<appId>/public-bundle`, `infinite/backups/<linkPubHash>/<ts>.00agent` |
| Realtime SFU | one app (`REALTIME_APP_ID` / `REALTIME_APP_SECRET`, fail loud by name); the worker mints per-room sessions and never joins one |

Routes: `/infinite/apps/*` (§5.3–5.7) and `/infinite/rooms/*` (§7.1). The link to a sponsoredtokens
app is a column (`st_app_id`) the owner fills from the dashboard, not a join across hosts. Nothing
here reaches a container, wakes one, or holds a plaintext bundle.

If even that mount line is unwelcome while the sponsoredtokens launch is in flight, the module can
ship as a **second Worker** on its own subdomain with its own bindings; the plan does not depend on
sharing a process with anything.

---

## 10. Repository layout

```
00Local/
  packages/shared/           + bundle-policy, manifest types, tool names, session shape
  packages/agent-runtime/    the runtime (§2), no DOM, no framework; runs in a Worker; vitest
  packages/agent-fs/         OPFS adapter + in-memory adapter for tests; isomorphic-git backend
  packages/agent-models/     ModelProvider + WebLLM / OpenAI-compatible providers
  apps/infinite/             the PWA (Vue 3, shares @00/shared and chosen web-vue components)
  apps/infinite/embed/       the loader + panel, one bundle, no framework, < 60 KB gz
  apps/infinite-site/        the static Worker site that serves both (skills-site pattern, plain npm,
                             outside the pnpm workspace); no bindings until Phase 3
  apps/00d/src/bundle-routes.ts   + POST /api/agents/import-bundle
moltworker/  (Phase 3 only, behind INFINITE_ENABLED; or a second Worker, §9.4)
  worker/src/infinite/       registry, origins, inbox, rooms, push; migrations
  worker/src/routes/infinite-*.ts
```

Coverage floors apply to the new packages from their first commit; tests derive platform paths and
use `mkdtemp` per `docs/testing.md`.

---

## 11. Phases, each with the thing that proves it

**Phase 0 — Runtime core** (00Local only)
`@00/shared` gains the bundle policy and manifest; `agent-runtime` with the loop, tool registry,
permissions, events, sessions; `agent-fs` on OPFS; WebLLM provider; the `.00agent` export/import;
the engine import door.
*Proof:* an agent scaffolded in a browser, exported, imported on the Mac engine, exported again and
imported back, is byte-identical under the `identity` class and runs its skills on both sides.

**Phase 1 — The owned agent** (PWA, simple shell)
First-visit flow, offline, persist + install nag + backup file, retrieval-first, the four brains of
§6.1 with the passkey and the `sk-obd` device mint.
*Proof:* airplane mode end to end; brain switching mid-session; a Safari eviction drill recovers
from backup.

**Phase 2 — Embed level 0**
Loader, shadow-root panel, the owner's setup flow writing `site.json` into the snippet, the shallow
crawl on load with the state-change guard, the persisted per-site index, the site map + the tool
table of §5.2.2 (search, grep, targeted crawl, open, scroll, highlight, describe), optional local
model, no server calls beyond the static script.
*Proof:* dropped on the marketing landing and on a Shopify test store, answers from their pages
with the network tab showing only the loader, same-origin GETs and weights; a second open reuses
the index with zero refetches; a product question triggers one targeted round under `/products`
and nothing else; the "where do I change my password" walk of §5.2.2 works logged out and logged
in; no request in the crawl log matches the guard list; a logout with each of the four session
kinds leaves only `anon` level-1 entries in IndexedDB, and `temporary` leaves no `authed` entry on
disk at any point; entries past the TTL refresh on the next open.

**Phase 3 — Registration, claim, inbox, push, owner panel** (both repos)
§5.3–5.7; §6.2 with the owner's sponsoredtokens app, the three purses, device customers and the
country allow/block list; §6.3 keys with rotation; the owned agent's vault (§4.5) with both
unlock kinds; dev mode; one-per-IP; origin
allow-list; Web Push; the owner panel inside the owned agent.
*Proof:* a stranger pasting the ref on another domain is refused; the owner sees the request; a
visitor's lead reaches the owned agent as an escalation and the reply goes back; the sponsor footer
shows on `ads` answers and not on `byok` ones; a blocked country gets level 0 only and a blocked
device is refused by name; a `429` from one key rotates to the next without a failed answer; the
vault locks on idle and a passkey-wrapped vault refuses to travel until re-wrapped; caps hold
under a load test.

**Phase 4 — Transfer**
Rooms + WebRTC + SAS; desktop → mobile browser → Mac and back; locked receipts; the phone as holder.
*Proof:* the same agent, three hosts, one residence at a time, history intact.

**Phase 5 — Ecosystem**
Browser as mobile-connect client to the Mac; browser answering `00mc/3` for the Flutter app; session
burst to the container; Overblast hosting flip for the embed; power shell.
*Proof:* the phone drives a browser agent with the shipped Flutter build; a burst round-trips with
a clean merge.

**Phase 6 — The spec's V2**
Pyodide, Whisper, image/video tools, SSH tool with allow-listed hosts, QR-SDP offline transfer,
runtime inside the mobile app, scheduled work handed to Mac/cloud.

---

## 12. Decisions to take before Phase 1

1. **The product origin.** A dedicated origin for the owned agent and the loader (OPFS and the
   push subscription are per origin; the marketing landing stays static). Domain to pick.
2. **The name.** *Infinite Agent* is the working name in this file; the code says `infinite` until
   the name is final.
3. **A trial before the account?** Embeds pay through the owner's own sponsoredtokens app (§6.2),
   so the account arrives with the first stronger answer. Decide whether a small first-party trial
   allowance (a few answers per device per day, sponsor footer shown) precedes that, or whether
   level 0 is the whole of the free tier. Starting caps live in the worker, not in clients.
4. **The WASM shell.** WebContainers need a commercial licence for production; a lighter WASM
   coreutils shell covers `grep/find/cat/git/node -e` and no `npm install`. Recommend starting
   light and buying WebContainers only if the power shell earns it.
5. **Unclaimed apps.** How long an `unclaimed` registration lives (recommend 30 days) and whether
   level 0 keeps working after that (recommend yes: level 0 never needed the server).
6. **Local model on phones.** Cap at 1.5B and ship one model, not a picker, on the mobile browser.
7. **Hosting the LiteRT assets.** Gemma `.task`/`.litertlm` files are hundreds of MB and carry
   Gemma's terms; the provider takes a `modelBaseUrl`, so the decision is where we mirror them (R2
   like the media model store) and which entries the first catalog carries.

---

## 13. What is deliberately not in this plan

A second public-agent implementation (Overblast's exists); any owner key or secret in a visitor's
browser, and any vault on an embedded agent; SSH into the Mac; a copy
semantics for transfer; a separate owner console (the owner panel is inside the owned agent, and the
Overblast app once linked); the embed modifying, submitting, clicking or reading anything on the
host page beyond navigating, scrolling, highlighting and describing (it shows the button, the
person presses it); the crawl leaving the site's own origin, sending anything other than `GET`, or
uploading a visitor's index anywhere; any path that wakes a container without a lease.
