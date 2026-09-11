# Infinite Agent — the browser runtime (plan, 2026-09-10)

**Product name, decided 2026-09-11: "00 Mini"** — Bruno's ruling; §12.2 is closed. "Infinite Agent"
stays the working name of this document and of the code (`apps/infinite`, `ia_` refs, `@00/agent-*`);
nothing a person reads says it any more. The design brief is `apps/infinite/DESIGN.md`.
Working name: **Infinite Agent**. Tagline under test: *an AI agent you don't install*. Longer
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
4. ~~`api.ts` gaps found by the PWA: the vault is not in the frozen surface; `agent_message` does not
   say delta vs whole; `readiness().detail` is free-form (a `progress?: number` is wanted);
   `ModelProvider` has no `unload`; `RunResult` lacks `providerId`; providers are fixed at
   construction (a `setProviders` would remove the PWA's façade).~~ **DONE 2026-09-10** — all six
   shipped additively; see *Contract revision 2026-09-10* at the end of this file.
5. Runtime divergences from the engine, all documented in-module: `grep`/`find` ignore no
   `.gitignore`; git tools have no engine twin (a Mac agent uses `bash`); no `git_push` by design;
   ~~the router's class-aware routing of §6 is not implemented (`auto` = first ready provider)~~
   **DONE 2026-09-10** — `auto` now derives a class per model call and the picker honours it; the
   rule is under §6.1 and the surface under *Contract revision 2026-09-10 (g)*.
6. Argon2id at 64 MiB / t=3 makes an unlock cost a visible second or two on a laptop. Intended;
   the UI should say "unlocking…".
7. The embed relies on `createAgentRuntime` spreading `opts.context` per turn so the site map stays
   fresh; a guard test pins it.
8. Move flow edges (from building §7.2): the browser cannot know whether 00 opened after a
   `zerozero://` navigation, so "I imported it on my Mac" is the person's word — a return link from
   the app (`zerozero://agent/imported?name=` back to the origin, or a poll) would make it a fact;
   two moves on one day collide on the date-only file name and the browser suffixes ` (1)`, so the
   Mac's picker should match the hint loosely; the Mac's export secret is a free passphrase while the
   browser's is a six-word code — make the Mac generate a word code too so both fields validate the
   same shape; and Move should say up front when a passkey-wrapped vault will stay behind (§4.5).
9. MediaPipe's three wasm binaries are ~27 MB each, over Cloudflare's 25 MiB per-asset cap, so
   `apps/infinite-site` must serve `/mediapipe/genai/wasm/*` from R2 through its Worker (same bucket
   as the model assets of §12.7); the vite build copies them beside the bundle for dev and
   self-hosting, and the site's build script leaves them out of `public/`.

---

## For the owner's review — decisions taken on the evening of 2026-09-10, unasked

You said "do everything you can without asking; I'll review all decisions and the UX/UI later".
This is that list. Every item is committed and pushed on 00Local `main` (moltworker: merged to
`main`, NOT pushed, NOT deployed); nothing outward-facing beyond the R2 mirror was touched.

**Product and UX (please look at these first)**
1. **Local AI is a picker on desktop and one model on a phone.** The Local AI card lists the mirror's
   rows (name, size, vision, licence, "on this device"), a phone silently gets Gemma 3 270m. The
   default desktop row is Gemma 4 E2B (2 GB, Apache-2.0), not the smaller gated 1B.
2. **The embed's "Load local AI" is Gemma 3 270m (250 MB) over LiteRT**, Llama 3.2 1B (879 MB, web-llm)
   only when LiteRT cannot run. The licence line names whichever will load.
3. **Move has two roads** in one panel: the file road (six-word code → `.00agent` → "Open in 00") and
   "Move live" (same code, over the SFU, with a four-character confirmation); Connections gains
   "Receive an agent" and a "Mac" card (drive your Mac's agent / let your phone reach this agent).
4. **The landing gets `/infinite`** and "Browser agent" in the header and footer, with a preview
   banner. Copy claims I was unsure about are listed in that page's commit; the nav label is a
   placeholder for the working name.
5. **Gemma terms shipped as consent lines** on the Local AI card and the embed offer, plus a "Local
   models" paragraph in the site's terms and a bullet in acceptable-use.

**Architecture**
6. **Contract revision** (additive): `setProviders`, `agent_delta` + whole `agent_message`, typed
   readiness `progress`, `unload`/`unloadAll`, `RunResult.providerId/model`, `brain: auto|small|strong`,
   `Vault` in the public surface. Details in "Contract revision 2026-09-10" at the end.
7. **Class-aware brain routing**: light read-only exchanges stay small; anything after a tool
   result is strong; single-provider setups behave exactly as before (pinned).
8. **The 00mc/3 wire moved to `@00/shared`**; signing stays per host (WebCrypto in the browser,
   @noble in the engine). The browser is both a mobile-connect client and an answerer for the phone
   app, which needs no change. One spelling: the browser's refusal is `kind_unsupported`.
9. **Phase 3 backend** is one flag-dark module in moltworker (`worker/src/infinite/`, 21 routes,
   migration 0141), merged to main and not deployed; deviations listed in §9.4. A follow-up adds the
   room salt, the publisher id and the SFU forwarder the browser client expects.
10. **The model mirror** lives on `00-downloads` at `dl.0-0.chat/litert` with CORS opened read-only
    on that bucket, copied at the edge by a throwaway Worker deployed per publish and removed after.

11. **Phase 3's browser halves are built** (owner: ref, link key, claim pane, owner panel with
    origins, publish, inbox-as-escalations, purse link; visitor: device key, register-on-first-need,
    real `send_to_owner` with a 30 s reply poll, public bundle as carrier 1, the Register card in
    the setup flow). Two shapes chosen where the plan was silent: the public bundle is ONE JSON
    document `{ version, ref, publishedAt, files: [{ path, text }] }` (≤ 256 KB) rather than a
    tar.gz, so the 40 KB embed needs no tar reader; and `site.json` gains an optional `linkPub`
    because registration must come from the site's origin while only the owner's browser holds
    the key — the owner's page shows the public half to copy. Both halves refuse by name
    (`link_key_unavailable`) in a browser without WebCrypto Ed25519.
12. **Live transfer is wired end to end but the rooms base is a `.invalid` placeholder** until the
    worker deploys; the UI says "not connected yet" rather than spinning.

17. **Cross-origin isolation and a synchronous filesystem** (2026-09-11): the site Worker sends
    COOP `same-origin` + COEP `credentialless` on documents and the service worker (with
    `run_worker_first`, since the asset layer would otherwise answer `/` without them), CORP
    `same-origin` on its own assets and `cross-origin` on what third parties embed. Proven live:
    `crossOriginIsolated`, SharedArrayBuffer, wasm and weights still loading as CORS. A dedicated
    Worker owns the workspace through OPFS sync access handles and serves a shared-memory channel
    byte-compatible with `@00/agent-node`'s; scripts get real `readFileSync`/`writeFileSync`/`require`
    when isolated. Found on the way: the system prompt had grown past the 4096-token LiteRT context
    (fixed the same day: a prompt budget per model, compact tool signatures, 8192 tokens asked at
    load for the desktop rows; a fresh agent's prompt plus tool block went from 4060 to 1718 tokens;
    verified live on the dev link, which now streams a truthful answer from Gemma 4 E2B under the
    isolation headers), and the browser pane blocks service-worker registration (the app's own too).
24. **The embed is a light core and three lazy modules** (2026-09-11, Bruno: "the embedded agent
    doesn't need these extra things like git, ts, etc — make it more light"): `e.js` was 167.7 KB raw
    / 56.7 KB gz and carried @00/agent-runtime, @00/agent-fs (git-ops, OPFS, node-dir, transfer
    crypto), @00/shared, @00/agent-models' router, the owner's setup wizard, the registry client and
    the markdown highlighter — none of which a visitor at level 0 can reach. It is now **84.8 KB raw
    / 29.1 KB gz** (−49%), and a level-0 visitor downloads that ONE file and nothing else: search the
    site, open a page, have a control outlined, with no `/m/` request at all. Three modules sit behind
    a person's press, each fetched from the product host by computed URL and served with the CORP
    header `/m/*` already carries: `m/brain.js` (33.1 KB gz — the agent loop and the local model pair,
    was `m/m.js`) on "Load local AI"; `m/setup.js` (10.2 KB gz — the wizard) on the gear;
    `m/registry.js` (6.0 KB gz — the client, the ed25519 device key, the bundle reader) on the first
    call that genuinely needs the registry. What stayed in the loader is what level 0 reads without a
    network: the persisted registry record, the cached public bundle (carrier 1) and the claim link.
    The panel shows a line while a module comes and a plain sentence if it does not. Proven live on a
    static site: `e/…js` alone on load, `m/setup.js` only on the gear, `m/brain.js` only on the
    button. `test/embed/bundle-budget.test.ts` walks the import graph from `loader.ts` and fails on a
    value import of any of the four packages; the source map of the built file agrees (no `packages/`
    source). Two smaller cuts came with it: `renderMarkdown` takes its highlighter as an option so the
    embed's `renderMarkdownPlain` drops the 9 KB tokeniser (every app caller unchanged), and the embed
    build minifies `mini-css.ts`'s string with esbuild's CSS minifier (6.3 → 4.7 KB gz; the file on
    disk keeps its comments).
20. **An overflowing turn is refused by name** (2026-09-11): the engines' "too long" sentences map
    to one `context_overflow` code with the numbers; the loop drops the older turns once and asks the
    same brain again before showing the sentence; a raw engine trace can no longer reach the chat.
    The `contextTokens` rows are the KV budget asked at load, not the models' ceilings (Gemma 4 E2B
    accepts far more); 8192 on desktop rows is the memory trade, and the picker lets a person choose.
19. **The shell runs Node programs with their npm packages** (2026-09-11): the runner is a vite
    module Worker serving `@00/agent-node`'s process model; `npm install`, `npm ls`, `npm run` with
    `.bin` tools on the shell's PATH, `npx <local bin>`, live stdout, and `http.createServer` on a
    virtual port. Proven live under isolation: `npm install is-number@7` from the real registry,
    `require` through the shared-memory channel, a `.bin` shim running, a server answering `hi`
    through the page bridge. Refuses by name: other package clients, bundlers and compilers,
    `npx` of a package not installed, hosts off the allow-list, nested processes, sockets.
18. **`@00/agent-node`** (2026-09-11): the "own WebContainers" layers as a package — 45 Node builtins
    over the agent's filesystem, a CommonJS/ESM loader with node_modules resolution, an npm client
    proven live against the public registry (CORS on metadata and tarballs), a Worker-per-process
    model. §12.4 is answered by it: no WebContainers licence; the shell adopts the package next, which
    lifts `npm install` for pure-JavaScript packages. Native addons and postinstall scripts stay named
    refusals, as in WebContainers.
16. **Live preview on a second origin + element picker** (2026-09-11): `apps/infinite-preview-site`,
    deployed at `https://infinite-preview.powerhouse.workers.dev` (no bindings, no data): the app posts
    a folder's files to it, its service worker serves them under `/s/<site>/` and forwards a virtual
    port's requests back to the app under `/p/<site>/<port>/`, and an inspector injected into every
    served page posts what the person clicks (selector, role, name, text, trimmed HTML, box, styles,
    source file) to the app, which shows a chip in the composer and prepends a fenced block to the
    next prompt. The iframe's sandbox is same-origin to the PREVIEW origin only. The snapshot frame
    keeps the same picker. The browser pane used for checks blocks service-worker registration
    (the app's own too), so the live road was proven by executing the service worker's text in a
    fake worker global and the snapshot road live; a normal browser runs both.
15. **Scripts and servers in the browser shell** (2026-09-11): `node file.js`, `node -e`, `npm run`,
    `serve`, `ports`, `kill` in a sandboxed Worker with a Node-flavoured prelude; `http.createServer`
    registers a virtual port the service worker routes under `/~/<port>/`; folders serve the same way.
    Measured in a real browser: a sandboxed iframe is never served by the service worker and an
    unsandboxed one can read the app's storage, so the preview renders a served page as a snapshot
    in the opaque frame, and a live in-pane preview waits for a separate origin (§12.1). Sync `fs`
    writes and `npm install` refuse by name; the latter stays that way until the "own WebContainers"
    layers (node polyfills, an npm client over the registry, a process model) or the licence.
14. **"Remote brain via my Mac"** (later): a ModelProvider over mobile connect. The browser sends
    the latest turn to the Mac's agent, which answers with its own brain and tools, subscription
    CLIs included; the browser never holds those OAuth tokens (their terms bind them to their own
    clients). Appears in the chip as "<agent> · via my Mac"; a busy Mac is a retry, a refused relay
    hands the turn to the local brain; the runtime now respects a provider with no tools of its own.
13. **Deployed the site Worker to its workers.dev link at your request** (2026-09-10 late):
    `https://infinite-site.powerhouse.workers.dev` serves the app at `/`, the loader at `/e/<ref>.js`,
    and the wasm and weights from R2 on the same origin. No custom domain, no registry behind it
    (the API bases stay `.invalid`, so "Move live", registration and messages say "not connected
    yet"); level 0, the local brains, the vault, the file road and the Mac card all work there.
    Plain http works only on localhost (secure-context features), so this link is also the way to
    open the agent from another device; `INFINITE_LAN=1` on the dev server reuses the engine's
    self-signed LAN certificate as an alternative.

21. **The agent can read the web, through a read-only proxy on our own origin** (2026-09-11). A page
    may only read a cross-origin response when the far side sends `Access-Control-Allow-Origin`, and
    almost no website does — so `http_get` answered "could not reach" for most of the links a person
    would hand it, while the fetch itself had worked fine. The site Worker now answers `/~fetch`
    (`apps/infinite-site/src/fetch-proxy.ts`, pure and tested from `apps/infinite` like the isolation
    headers), and `NetworkPolicy.proxy` lets the tool retry through it — only after a direct fetch has
    failed, only for the same URL, and saying so in its own output ("fetched through the site's
    read-only proxy"). The allow list still decides what is `safe` and what the person is asked about.
    **The abuse limits, which are the decision you may want to look at:** GET/HEAD only; `https:`
    only; public hosts only (no IP literal in any spelling, no `localhost`, `*.local`, `*.internal`,
    `*.arpa`, no single-label name, no userinfo); **same-origin callers only** (`sec-fetch-site`, or an
    `origin`/`referer` that begins at this origin — curl, a bot and a pasted address bar all get 403);
    no credentials forwarded, ever; at most 3 redirects with every hop re-checked by the host rule;
    10 seconds; 1 MiB, cut and cancelled rather than drained; text content types only (415 otherwise);
    5 minutes of cache on an answer and 60 seconds on anything else. Answers also carry
    `content-security-policy: sandbox`, so a page fetched through the proxy lands in an opaque origin
    and can never reach this origin's storage — where the whole agent lives. There is no auth, no log
    and no state: **the bound on abuse is the same-origin check plus the caps**, and if that is not
    enough for a public deploy the next step is a token minted by the page, which is not built.
    `http_get` also returns HTML as readable text now (`htmlToText`), which is what makes a page
    legible to a 8192-token local brain at all.

22. **The QR code carries the six-word code in the URL fragment — a deliberate exception to "the code
    is never in a URL"** (2026-09-11, please confirm). The Move screen's code step now shows a QR of
    `https://<origin>/?receive#code=<six-words>` and a "Copy link" button, so a phone joins by
    scanning instead of typing. The older rule (`src/lib/move.ts`) is about the whole URL; a FRAGMENT
    is the one part that is never sent to a server — not in the request line, not in a referer, not in
    this Worker's logs, and a Worker cannot read it even if it wanted to. On the other device
    `receiveFromLocation()` reads it once and `history.replaceState` takes it out of the address bar
    and out of the history entry before the first frame, malformed codes included. The screen says so
    in the person's own words: "The code rides in the part of the link that never leaves your phone;
    the app forgets it the moment it reads it." **What is still on you:** a QR code on a screen is a
    secret anyone in the room can photograph, which typed six words are not. If that trade is wrong,
    the block comes out in one edit (`MovePanel.vue`, the `receiveLink` computed and its section).

    **One line is needed in `App.vue`, which this round did not own.** `receiveRequested` (new, in
    `src/state/move.ts`) is true when a scanned link asked for the receive screen, and the shell must
    read it at boot to open the Move pane — `receiveWanted` cannot do it alone, because its only
    reader is `MovePanel`'s `onMounted` and MovePanel is not mounted until the pane is already open.
    `loadMoveReceipt()` (which `App.vue` already awaits) sets both flags and the prefilled code; the
    Root/App owner adds `if (receiveRequested.value) pane.value = "move"` after that await. Until then
    a scanned link opens the app with the code loaded and the person still has to press
    Connections → Receive, where the code is already in the field. The live receive road itself is
    still the `.invalid` placeholder of item 12, so the phone lands on "not connected yet" and the
    file road is the one that works today.
    **Done later the same morning:** `App.vue` reads `receiveRequested` after `loadMoveReceipt()` and
    opens the Move pane.

23. **The whole app was redesigned as "00 Mini"** (2026-09-11, Bruno's ask: professional, Codex-like,
    plus a floating one-session version). Three surfaces share one look (`apps/infinite/DESIGN.md`):
    the FULL APP at `/app` (sidebar with threads grouped by day, a centred thread with rendered
    markdown and folded "activity" cards, a rounded composer with image attach + model chip, a
    workspace panel for files/editor/preview/git/terminal, ⌘K palette, light and dark); the FLOATING
    widget over the LANDING at `/` (one session, follows the scroll, expand → `/app`); and the website
    EMBED, now pixel-identical to the widget through the import-free `src/mini/mini-css.ts` +
    `brand.ts` (e.js 49.9 KB gz, budget 60). The landing lives INSIDE the PWA so the widget in its
    corner is the live agent, and the agent gets five `page_*` tools over the embed's DOM bridge on `/`
    (through the new `setExtraTools`, revision 2026-09-11 (e)) so "where do I set the vault?" scrolls
    to `#vault`. Deployed to the dev link. Rulings taken on the way: the mark is WHITE pixels (icons,
    brand SVG, the Vue face) and the halo behind it is white-on-dark / a plain shadow on light, never
    mint; the Nuxt `landing/pages/infinite.vue` is now secondary to the PWA's own landing. Images on a
    turn are written to `workspace/uploads/` and named in the message (the frozen `RunOptions.prompt`
    has no image field; `lib/attachments.ts` says what to delete when it grows one). The setup flow of
    the embed is being turned into a centred step-by-step modal wizard (Bruno's ask) in a follow-up.

24. **Registration is for embedded 00 Minis only, and optional** (Bruno, 2026-09-11, confirming §5.3
    and §6.2): the hosted agent at our origin never registers as an app; an embed runs on the local
    model with nothing signed, and the owner registers the site as a sponsoredtokens frontend app only
    when they want the router's extra power (ads / balance / their own keys, priority between local,
    sponsored and own keys read from the app). The separate `infinite_apps` registration in the
    moltworker module should collapse onto that app once the sponsoredtokens side (being built by
    another agent) exposes: the app card fields a frontend caller may read (purse mode, brain
    priority, allowance, origins, country policy, models), one register-or-link call from the site's
    origin returning the app id and a claim nonce, and the device popup as built. Until that contract
    exists nothing on the backend is touched.

25. **The phone rows ask for 4096 tokens, not 2048.** Bruno hit the named refusal on a phone ("needs
    about 2479 tokens; the window holds 2048") — the full agent's first turn never fit. 40–110 MB more
    KV cache buys a brain that answers. (`packages/agent-models/src/litert.ts`, pinned in its test.)

26. **The read-only proxy is live on the dev link** and answered the smoke this round: a same-origin
    caller got 0-0.chat as HTML (200, `x-mini-final-url`, CSP sandbox), an outside caller got 403.
    The plumbing builder's "no outbound network" was example.com failing DNS on this Mac, nothing else.

27. **The embed's owner setup is a centred modal wizard** (Bruno's ask, 2026-09-11): five steps —
    name and line (live launcher preview), what it may read (depth, TTL, path chips, the sign-out
    rule), knowledge and persona (skippable), brain (device model by default; the router card only
    when a registry is configured, and it says registration is never required), review and install
    (the `infinite-agent.json` to download or copy, and the `data-site` tag). Backdrop, Esc with an
    inline "Discard changes?", focus trapped, a full-screen sheet on a phone. `e.js` is 56.6 KB gz
    (budget 60). Tapping through the wizard on a real phone is still unverified (the harness's mobile
    emulation refuses clicks).

28. **A progress bar while the embed reads a site** (Bruno's ask): the crawler reports phase, pages
    done and the round's bound after every fetch; the panel draws "Reading this site · 12 of 44
    pages" under its header with a bar, the launcher's face pulses while a closed panel is reading,
    and the finished bar says "Read N pages" for a moment before going. The denominator is the
    round's page bound — the only total a crawl knows before it has run — and the words say pages,
    never a percentage of "the site". Verified live on a 44-page test site.

29. **No browser outlines anywhere, and the widget is isolated in both directions** (Bruno's asks):
    focus is a soft ink ring on buttons and links only, fields mark focus with their border; iOS gets
    a 16px floor on fields so Safari stops zooming them. The FLOATING widget now renders in a shadow
    root of its own (open, host appended to `<body>`, `<Teleport>`), so the landing's stylesheet and
    Tailwind's preflight no longer touch it — the same string, the same look as the embed on a
    customer's site, which pins every inheritable text property on `.mini` and sizes in px. Verified
    on a test page with serif, uppercase, letter-spaced, hot-pink CSS: nothing reached the panel. The
    theme rides on the `.mini` element (`data-theme`) because a shadow root cannot see an ancestor's.

30. **The landing's script tag is real.** It shows THIS browser's ref (minted when the section
    scrolls into view, after the agent has booted) and carries the public link key in `data-site`,
    so the site can be registered for extra power later without a second visit. Level 0 needs none
    of it; nothing private is in the tag.

31. **On a phone the Workspace tab lands on the workspace** (it used to toggle, and a tap while the
    panel was already open showed the chat — Bruno hit it).

32. **Stop stops everything, downloads resume, and the compile has a name** (Bruno's asks, 2026-09-11):
    `ModelProvider.abortLoad` (additive) pulls a model download or abandons a compile; the composer
    shows Stop while a model loads, not only during a run. LiteRT downloads land in 64 MiB parts in
    Cache Storage and the next load asks for the rest with a Range header (a closed tab or a phone that
    froze the page no longer restarts 2 GB); readiness phases `load` ("Loading … into the GPU") and
    `paused` ("44% downloaded · resumes with your next message") replace a bar stuck at 100 %.

33. **Settings is one door.** Connections, the vault, move & backup and the website are tabs of a
    Settings pane whose first control is "Back to chat" on every width; the header carries the same
    arrow. The sidebar's three destinations became one.

34. **The companion shipped both halves** (§14): the engine's routes and CLI, and the browser's card,
    key, signed client, remote git and proxy preference. Not yet done live end to end: the running
    engine on this Mac predates the routes (a `scripts/deploy-dev.sh --restart` is the owner's call),
    and the credential path of the git proxy (`git credential fill` with real credentials, a real
    push) was exercised only on its empty path.

35. **`node file.ts` runs in the tab** through esbuild-wasm (12 MB, served same-origin at
    `/esbuild/<version>/esbuild.wasm`, fetched only when a `.ts` file runs); the Node layer measures
    itself against 767 cases ported from macaly/almostnode (MIT) — the scoreboard is
    `packages/agent-node/test/compat/SCOREBOARD.md`, and `docs/dev-servers.md` there says what a real
    Vite would still need. almostnode reimplements Vite and Next rather than running them.

36. **The public repository is prepared, not published** (Bruno: "00-mini", Apache-2.0, all
    suggestions, no secret). A filter-repo cut of the slice (four packages, the three apps, the
    publish scripts, this plan, four files of `@00/shared` pinned by sha256) with LICENSE, NOTICE,
    README, a GitHub Actions gate and its own workspace files sits at the session's scratchpad as
    `00-mini/` — it installs, builds and tests on its own. The sweep over the slice found no keys,
    tokens or private keys (only test fakes and a vault key NAME); private references left are doc
    mentions and the workers.dev account name. Creating the GitHub repository is the click the owner
    makes.

37. **A model going in circles is stopped by name** (Bruno's transcript, 2026-09-11: a stuck Gemma
    wrote `remember("Waiting for the correct image path")` forty times). Three things: the
    prompt-fallback parser runs ONE call for twelve identical spellings in one message; the loop ends
    a run after three identical rounds of tool calls (`RunResult.stopped = "loop"`, additive, with an
    error that names the call — "going in circles, not working"); and `remember` refuses a note it
    already holds for the day. On the picture itself: the vision road (read → image parts → LiteRT
    prompt segments) is implemented and pinned; a brain without vision gets "[A picture was attached
    (path), but this model cannot see pictures.]" — the transcript's "path is incorrect" was a
    text-only row talking about a picture it never saw. Gemma 3n is the vision row, and its 3 GB
    load only became possible with the streamed model load of the same day.

**Things I did NOT do, on purpose**
- No deploy of the landing, the site Worker, or moltworker (your call each time).
- No enabling of `INFINITE_ENABLED`, no D1 migration applied, no secrets created.
- Turning anything on: the Web Push sender is built (see §9.4) but sends nothing until you mint the
  VAPID pair; Turnstile on embed device registration was left out by the worker builder's argument.

---

## Gap audit — 2026-09-10, late (three read-only auditors over the code, not the docs)

What a person can do today: open the deployed app, get an agent scaffolded into their browser,
download a Gemma model and talk to it (proven live on the workers.dev link), keep files, seal a
vault, export and restore a `.00agent`, move it to the Mac by file, put the level-0 guide on a
website. Everything below is what the plan or the original spec promises beyond that and the code
does not yet deliver. Ordered by user-visible impact; each item names the evidence.

**Status of this list, later on 2026-09-10:** A1–A6 and B7–B17, B20 are DONE (commits `1134d68c`
… `e81f5ddf`): real relay origin with a sentinel, the vault stays home unless ticked, iOS builds,
six-word code on the Mac, no phantom bash, download progress in the chat; the power shell (built-in
terminal, editor, preview, git panel, IDE layout), git wired with a real diff, delete/move/copy/stat,
vision input through to LiteRT/OpenAI/Anthropic, streaming, secrets reachable from tools with
`${secret:NAME}`, onboarding runs, BM25 without a model, push received in the service worker,
credential fallthrough, high-risk tier in use, http_get under a policy, brain and answered-by shown.
Still open from B: B18 (cloud burst, R2 backup, schedules UI) and B19 (Sponsored sign-in, Overblast
mint, embed paid path) — cloud-side. The audit itself follows as written that evening.

**A. Broken or misleading today (fix first)**
1. **The Mac card points at an invented host.** `apps/infinite/src/mac/config.ts` has
   `RELAY_ORIGIN = "https://api.overblast.com"`; the real relay is the worker origin
   (`https://brain.deployd.network`). Both directions fail as a bare network error with no "not
   connected yet" line, unlike the two `.invalid` bases.
2. **The vault travels in every export, silently**, including a passkey-wrapped one that is dead
   weight on the far side: `vault.json` classifies `record`, `exportBundle` includes it, and the
   "carry my secrets" tick of §4.5 exists only as `canCarrySecrets` in a test.
3. **The iOS target does not compile** (six macOS-only symbols in `EngineSocket.swift`), so the
   iOS document type and share-sheet door of §7.3 are declared and unreachable.
4. **The two file-road halves disagree on the secret**: the browser mints and validates a six-word
   code; the Mac's "move to a browser" accepts any passphrase of eight characters or more.
5. **The agent claims it can run bash** (seen live: "executing bash commands") while `bash` is
   `NoShell` and always answers exit 127. The prompt should say what the browser cannot do.
6. **The chat shows nothing during the first model download** (a run started before the weights
   arrive sits silent for a minute); the Local AI card does not name the model it loaded.

**B. Promised in the plan, missing in the app**
7. **No power shell at all**: no terminal pane, no editor (the file viewer is read-only), no
   browser or preview pane, no git interface, no image or video editor (§1, §4.2).
8. **Git tools are wired to nothing**: `fullTools()` is called without `git`, so the shipped agent
   has zero git tools although `agent-fs` implements init, add, commit, log and status; diff is
   names-only; clone, push, pull refuse by name; no branch or checkout; no OAuth (§4.2).
9. **Filesystem tools are half the spec**: no delete, move, copy or stat tool, although `AgentFs`
   has remove, rename and stat; `file_changed` can therefore never say `delete` or `rename`.
10. **No image reaches any brain**: `ChatMessage.content` is a string; the 3n rows' `vision: true`
    is decoration; there is no `VisionProvider` (§6, §13 of the spec).
11. **Nothing streams**: the loop calls `chat()`, never `stream()`; `agent_delta` is declared and
    never emitted, so a 10 tok/s local answer is a blank pane until the end.
12. **The vault is unreachable from tools**: the prompt says values resolve at use, but
    `ToolContext` has no vault and there is no `list_secrets`; BYOK keys can be sealed and never
    spent by a tool (§4.5).
13. **The onboarding interview never runs**: `BOOTSTRAP.md` is written and ignored; no
    `finish_onboarding` tool, no prompt rule, `profile.onboarded` stays false (§4.1).
14. **No retrieval without a model in the owned agent** (§4.1 says it works with no model); only
    the embed has BM25.
15. **The service worker cannot receive a push**: no `push` or `notificationclick` handler, so a
    subscription is taken and would be revoked for never showing a notification (§4.6).
16. **The router that recovers from a dead credential is dead code**: `agent-models`'s `ModelRouter`
    with 402/401 fallthrough has no production consumer; the loop's own picker picks once and a
    provider failure ends the run.
17. **Local tool calling is a JSON-scraping fallback** on every local model (no runtime exposes
    function calling); `high-risk` is a tier no shipped tool uses; no HTTP tool, no network policy.
18. **No cloud burst, no R2 backup, no schedules or watchers UI** (§4.6, §8.1, §8.3).
19. **The paid brains do not work from the app**: Sponsored is a disabled button; Overblast only
    accepts a pasted `sk-obd` token and never mints one via the cloud-brain devices route (§6.1);
    the embed has no paid path at all (§6.2), and the host's `APPS_ENABLED` is off anyway.
20. **`RunOptions.brain` and `RunResult.providerId` are never surfaced**; the person cannot see
    which brain answered.

**C. Built but dark (needs the owner's switches, not code)**
21. Every server-backed feature on the deployed site points at `.invalid`: registration, claim,
    inbox, push, Move live, Receive. The worker module (21 routes, 173 tests, push sender) is
    merged and not enabled: `INFINITE_ENABLED`, the `infinite-public` bucket, the pepper, the
    Realtime and VAPID secrets, migrations 0141 and 0142.
22. The landing's `/infinite` page is not deployed and advertises `https://0-0.chat` as the product
    origin while the app lives on `infinite-site.powerhouse.workers.dev` (§12.1 open).
23. Decisions §12.1 (origin), §12.2 (name), §12.3 (trial before account), §12.4 (WASM shell) are
    still open, and the first two key every snippet, OPFS store and push subscription.

**D. Absent capability families from the original spec** (deferred by §11 Phase 6, listed so
nobody reads §4.2's table as present tense): Python/Pyodide, Whisper voice, image and video tools,
browser automation and website editing for the owned agent, SSH with the Worker TCP forward,
remote container execution, multi-agent subagents, semantic memory, session checkpoints. On the
sponsoredtokens side: per-app BYOK with rotation and per-app country allow/block (§9.3); the purse
link stores two columns and changes nothing.

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

**The class per call (2026-09-10).** `auto` derives a class from the SHAPE of each model call, never
from the words in the message: `small` for a tool-less short single-turn question and for the whole
of a light-trust exchange whose tools only read, search or navigate; `strong` for the first call when
tools are registered or the prompt runs past 280 characters, and for every call that follows a tool
result (planning over observations). `classifyCall` in `packages/agent-runtime/src/brain-class.ts` is
that rule and nothing else.

**What the picker does with it.** It walks the providers in the caller's order — which is what
`setProviders` means — skips the ones that are not ready, and takes the first ready one whose
catalogue offers that class; when none does, it takes the first ready one anyway and reports the
class actually used in `model_started.brainClass`. A class is a preference, never a cap: no strong
brain means the small one answers, and `small` asked of a cloud-only setup uses the cloud. With one
ready provider nothing changes at all. `RunOptions.brain: "small" | "strong"` forces the class.

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

**Built 2026-09-10 evening, merged to moltworker main, NOT deployed:** `worker/src/infinite/` (21
routes, migration `0141_infinite.sql`, 106 tests, the wire in moltworker's `docs/infinite/API.md`).
Deviations, each argued in-file: a fifth canonical line `X-Infinite-Nonce` (ed25519 is
deterministic, so a signature cannot be the replay latch the way §24's P-256 one is); the room
`token` is OUR room-scoped capability, not a Cloudflare credential (Realtime has none per session,
and the app secret must never reach a browser), so `POST /rooms/:code/join` mints the second
peer's SFU session server-side; no Turnstile on device registration (the queue is capped and the
paid brain uses sponsoredtokens' own flow); push subscriptions are stored, not sent (VAPID comes
later); `inbox.ts::sweepInbox` was unwired in this round and is wired to the cron since the push
round. To enable: apply the migration, create the
`infinite-public` bucket and the `INFINITE_IP_PEPPER` / `REALTIME_APP_SECRET` secrets, set
`INFINITE_ENABLED` and `REALTIME_APP_ID` in vars, redeploy, wire the sweep into `scheduled()`.
Two follow-up rounds the same evening, both merged: the rooms carry `roomId`, `salt`, `channel`
(`ia-<roomId>`, never the code, which is key material), `publisherSessionId` on join, and an SFU
forwarder under the room token (`/infinite/rooms/:roomId/sfu/sessions/:sid/…`) because Realtime
has no per-session credential and the app secret stays in the worker; then the five seams the
browser builders found (`If-None-Match` in CORS, `POST /apps/:id/claim-nonce` for a second browser,
`since` against `replied_at`, the VAPID public key on the app card, the signed-request header
corrected). Optional var `INFINITE_VAPID_PUBLIC_KEY` joins the enable list.
A third round adds the **Web Push sender**: RFC 8292 VAPID and RFC 8291 `aes128gcm` in WebCrypto
alone, proven against the RFC's own vector; one notification per app per 15-minute cron run, at
most every ten minutes, `infinite_apps.last_push_at` (migration 0142) as both cursor and latch;
the inbox retention sweep is wired beside it. Keys are the `web-push` CLI's format (public: the
65-byte uncompressed point, private: the 32-byte scalar, both base64url); the mint one-liner is in
moltworker's `docs/infinite/API.md` §5. Sending is on only when BOTH `INFINITE_VAPID_PUBLIC_KEY`
(var) and `INFINITE_VAPID_PRIVATE_KEY` (secret) are set; rotating the pair invalidates every
subscription.

---

## 10. Repository layout

```
00Local/
  packages/shared/           + bundle-policy, manifest types, tool names, session shape
  packages/agent-runtime/    the runtime (§2), no DOM, no framework; runs in a Worker; vitest
  packages/agent-fs/         OPFS adapter + in-memory adapter for tests; isomorphic-git backend
  packages/agent-models/     ModelProvider + WebLLM / OpenAI-compatible providers
  apps/infinite/             the PWA (Vue 3, shares @00/shared and chosen web-vue components)
  apps/infinite/embed/       the loader + panel, no framework: e.js < 60 KB gz (29.1 today) plus
                             m/{brain,setup,registry}.js, fetched only when a person asks (item 24)
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
7. **Hosting the LiteRT assets — DECIDED 2026-09-10: mirrored on the public bucket.**
   `00-downloads` behind `https://dl.0-0.chat`, flat keys under `litert/` (so
   `modelBaseUrl = https://dl.0-0.chat/litert`), MediaPipe's runtime under
   `mediapipe/genai/<version>/wasm/`, a read-only CORS policy on the bucket (GET/HEAD, any origin,
   Range exposed), and `litert/catalog.json` naming every asset's bytes, sha256, source commit and
   licence. `scripts/publish-litert-models.sh` streams each file from the Hub straight into R2
   (nothing touches the disk) and verifies the sha256 on the way through.
   Why a mirror and not the Hub on demand: the ungated repos DO answer a browser (CORS `*` on the
   CDN hop, Range → 206), but the URL is a signed redirect marked `no-store`, anonymous traffic is
   rate-limited at their discretion, and the Gemma 3 / 3n / 270m repos are GATED (401 without a
   token, and a token in a page is a token for everyone). R2 egress is free and the custom domain
   sits behind Cloudflare's cache, so the set costs storage only: ~15 GB at $0.015/GB-month is about
   $0.25 a month, reads at $0.36 per million. What is on the list, and why:

   | Asset | Size | Licence | Gated at source | Role |
   |---|---|---|---|---|
   | `gemma-4-E2B-it-web.task` | 2.0 GB | Apache-2.0 | no | default desktop brain, text only |
   | `gemma-4-E4B-it-web.task` | 3.0 GB | Apache-2.0 | no | strong desktop brain, text only |
   | `gemma-4-12B-it-web.litertlm` | 6.0 GB | Apache-2.0 | no | power users with the VRAM |
   | `gemma-3n-E2B-it-int4-Web.litertlm` | 3.0 GB | Gemma terms | yes | **vision and audio** (the Gemma 4 web builds are text-only per their card) |
   | `gemma-3n-E4B-it-int4-Web.litertlm` | 4.3 GB | Gemma terms | yes | vision, larger |
   | `gemma3-270m-it-q4_0-web.task` | 0.25 GB | Gemma terms | yes | phones and the embed's "load local AI" |
   | `gemma3-1b-it-int4-web.task` | 0.7 GB | Gemma terms | yes | small desktop / good phones |

   Left out: `FastVLM-0.5B` (vision, but `apple-amlr`, a research licence); the Qwen LiteRT
   builds (Apache, ungated, but no `-web` variant, so unproven on the browser runtime). The gated
   rows need an `HF_TOKEN` at publish time only; visitors never see the Hub.

   **Gemma terms, §3.1, met like this (2026-09-10):** `litert/NOTICE.txt` with Google's sentence and
   `litert/GEMMA_TERMS.md` (a verbatim copy) beside the files, re-put on every publish from
   `scripts/litert-notices/`; the catalog carries licence, terms and use-restriction URLs per asset;
   the app's local-brain card and the embed's "Load local AI" offer name the licence and the
   Prohibited Use Policy before the download; the landing's terms and acceptable-use pages
   incorporate the policy as an enforceable term. Nothing is modified (sha256 proves it), so §3.1.3
   has nothing to say. The Gemma 4 rows are Apache-2.0 per the Hub, and carry none of this.

   **Live on 2026-09-10, all seven rows:** Gemma 4 E2B, E4B and 12B; Gemma 3n E2B and E4B
   (vision); Gemma 3 270m and 1B — each sha256-proven, plus MediaPipe's wasm, the NOTICE and the
   terms copy, with `litert/catalog.json` listing them; range requests and CORS verified on the
   custom domain. The gated rows were published with the owner's Hub token resolved on his Mac
   into the pre-signed CDN URL; the Worker never held it. Re-running the script is idempotent:
   what exists is skipped by size. Measured: a 2 GB copy takes ~2 min and 22 s of
   Worker CPU, the 6 GB one ~5.5 min and 63 s, well inside the 300 s budget.

---

## 14. The companion — the engine on this computer as the browser agent's local proxy (2026-09-11)

Bruno's ask: a copy-paste script installs a small local proxy on a desktop; the browser pings
localhost and gets the features a tab cannot have (git clone/push/pull, any-host fetch, later a host
folder and host commands); secure, "only this tab/agent", a first-time ceremony. The proxy IS the
00 engine (`00d`, already installed by `curl -fsSL https://0-0.chat/install.sh | bash`), in a
**companion mode** that adds one small route family and one pairing road. Nothing new to install.

### 14.1 The ceremony

```
$ 00d companion                       # starts/finds the engine, prints:
  00 Mini companion is ready on this computer.
  In the browser: Connections → This computer → enter   amber-lantern-quiet-fox-river-stone
  (the code works once, for two minutes)
```

The browser probes `GET http://127.0.0.1:4600/api/companion/health` (1.5 s timeout, desktop
widths only; Safari refuses http://localhost from an https page — the card then says so and offers
the relay road). It takes no auth and answers CORS, saying
`{ ok: true, name: <hostname>, engineFp, version, companion: true }` — `engineFp` being a stable
16-hex id for this engine INSTALL, derived from its data root, which is the key the browser files
its device key under. Found and not paired → the card asks for the code. Pairing:

```
POST /api/companion/pair    (CORS: the product origins; PNA preflight answered)
  { code, publicKeyJwk (ECDSA P-256, non-extractable in the browser), name, agentId }
  → 200 { fingerprint, engineName, scopes: ["git","fetch"] }
  → 403 { code: "code_refused" }    // wrong, expired, or already used; 5 tries then a new code
```

`00d companion` mints the code through a **localhost-only** route (`POST /api/companion/code`),
six words from the app's own MOVE_WORDS list, in-memory, 120 s, single use. Being able to read
the terminal is the proof of local presence. The device lands in `<dataRoot>/pairing.json` like a
LAN device, with two additive fields: `alg: "p256"` and `companion: { origin, agentId, scopes }`.
Perms are written out EXPLICITLY DENIED — all six of them, which is NOT the LAN default (engine
side, 2026-09-11: a browser agent reaches this computer through the companion doors and holds no
engine capability at all, so the three a LAN device gets by default — conversations, approve,
directMessage — would be authority nobody asked for). `devicePerms()`'s own defaults are untouched.
`00d companion list|revoke <fp>` and `DELETE /api/companion/pair` (signed, self) take it away;
Connections shows Disconnect. The two the CLI reads are **localhost-only** and deliberately NOT on
the CORS surface — `GET /api/companion/connections` (also what `00d companion origins` prints) and
`DELETE /api/companion/connections/<fp>` — because a page that could enumerate the connections could
also name the one to take away.

### 14.2 Every call is signed — the engine's own scheme, one new algorithm

Headers `x-00-dev` (fingerprint), `x-00-ts` (ms), `x-00-sig`; canonical string
`METHOD\npathWithQuery\nts\nsha256hex(body)` exactly as `apps/00d/src/device-auth.ts` verifies
today; ±120 s, replay cache. The one additive change: a device record with `alg: "p256"` is
verified with WebCrypto ECDSA P-256 / SHA-256 over a raw 64-byte r‖s signature (base64url), because
a browser's non-extractable key cannot be Ed25519 everywhere yet. Ed25519 devices are untouched.
The browser key lives in `IndexedDbDeviceKeyStore` under `companion:<engineFp>`; the grant is
bound to that key, this origin and this agent id — a second tab of the same agent on the same
origin shares it, which is the same agent.

### 14.3 Scopes, in the order they ship

| Scope | Route | What it does | Bounds |
|---|---|---|---|
| `git` | `ANY /api/companion/git/<host>/<path…>` | git smart-HTTP proxy for isomorphic-git (`corsProxy` shape): forwards `info/refs?service=…`, `git-upload-pack`, `git-receive-pack` | https only; host allow-list (github.com, gitlab.com, bitbucket.org, codeberg.org, `ZEROZERO_COMPANION_GIT_HOSTS`); 200 MB body cap; 120 s; credentials from the Mac's own `git credential fill` added when the remote answers 401 or for receive-pack, never returned to the browser |
| `fetch` | `GET /api/companion/fetch?url=` | a GET from this computer's network | the Worker proxy's rules (text, 1 MiB, 10 s, no cookies) but ANY host incl. private ones — it is the person's own machine |
| `folder` (later) | — | a host directory mounted into the workspace | Chromium first through the File System Access API with no companion at all; the companion road for Firefox/Safari |
| `exec` (later) | `POST /api/companion/exec` | a host shell command | `confirm` per command, off by default, on only through `00d companion perms` |

### 14.4 The browser side

`apps/infinite/src/companion/`: probe, pairing, the signed fetch, and the wiring: `createGitOps`
gains a remote `{ http, corsProxy }` (isomorphic-git's web http client behind a signing wrapper)
so `git clone/push/pull/fetch` in the shell and the Git pane work; `NetworkPolicy.proxy` may return
`{ url, headers }` (additive) so `http_get` dials the companion first and the Worker proxy second;
`GIT_REMOTE_LINE` says "connect this computer (Connections → This computer)" instead of "a CORS
proxy". Readiness is polled like a brain's: the card shows found / paired / unreachable with the
reason, and every companion feature greys out when it is gone.

### 14.5 The browser half, as built (2026-09-11)

`apps/infinite/src/companion/` + `src/state/companion.ts`, built to §14.1–14.4 while the engine half
was built beside it. What the engine must answer, in the exact shapes this code sends and reads:

| Call | Sent | Read |
|---|---|---|
| `GET /api/companion/health` | nothing, unsigned, 1.5 s timeout | `{ name, engineFp, version?, scopes? }` — `engineName`/`fingerprint` are accepted as aliases. **A 200 with no fingerprint is treated as "too old"**, so the route must carry one. 404 → "update 00d". |
| `POST /api/companion/pair` | `{ code, publicKeyJwk, alg: "p256", name, agentId }`, unsigned | `{ fingerprint, engineName, scopes }`; `403 { code: "code_refused" }` gets §14.1's sentence |
| `GET /api/companion/me` | signed, no body | `{ fingerprint, engineName, scopes }`. **This is the readiness poll** (every 20 s while the tab is visible): a grant revoked on the Mac must make it answer non-2xx, which is what flips the card back to "found". |
| `DELETE /api/companion/pair` | signed, no body | any 2xx. The browser forgets its key either way. |
| `GET /api/companion/fetch?url=` | signed | the body, as `http_get`'s second road |
| `ANY /api/companion/git/<host>/<path…>` | signed per request, body buffered to hash it, capped at 200 MB in the browser | git smart-HTTP verbatim |

Signing is §14.2 exactly: `x-00-dev` = first 16 hex of sha256 over the **raw 65-byte uncompressed
P-256 point** (`0x04‖x‖y`, what `exportKey("raw")` gives and what the browser rebuilds from the JWK),
`x-00-ts` in **milliseconds**, `x-00-sig` = base64url of the raw 64-byte `r‖s`, over
`METHOD\npathWithQuery\nts\nsha256hex(body)` — `canonicalHttp` in `apps/00d/src/device-auth.ts`,
with the empty body hashing to `e3b0c442…`. Vectors: `apps/infinite/test/companion-key.test.ts`.

Two notes for the engine half: **the `git` and `fetch` scopes are read separately** (the card shows
them as chips and the Git pane greys out on `git` alone, so a grant may carry one without the other),
and **pairing is per engine fingerprint** — the browser keys its device record on `companion:<engineFp>`,
so two computers from one browser are two keys and revoking one leaves the other alone.

## 13. What is deliberately not in this plan

A second public-agent implementation (Overblast's exists); any owner key or secret in a visitor's
browser, and any vault on an embedded agent; SSH into the Mac; a copy
semantics for transfer; a separate owner console (the owner panel is inside the owned agent, and the
Overblast app once linked); the embed modifying, submitting, clicking or reading anything on the
host page beyond navigating, scrolling, highlighting and describing (it shows the button, the
person presses it); the crawl leaving the site's own origin, sending anything other than `GET`, or
uploading a visitor's index anywhere; any path that wakes a container without a lease.

---

## Contract revision 2026-09-10

Finding 4 of the Status list, shipped. **Every change is additive**: a consumer written against the
previous surface still compiles, with the one exception named under (b). Three packages moved
together (`@00/agent-models`, `@00/agent-runtime`, `apps/infinite`); the embed was not edited.

### (a) `AgentRuntime.setProviders(providers: ModelProvider[]): void`

The brain changes mid-session (§4.1's proof) and `createAgentRuntime` fixed its providers at
construction, so the PWA held a façade whose listeners survived while the inner runtime was rebuilt.
The façade is **gone** (`apps/infinite/src/runtime/bootstrap.ts`); the runtime swaps its own list.

**When it takes effect: at the next `run()`.** A run in flight keeps the list it started with,
because a turn planned by one model and answered by another is a corrupted turn, not a fallback —
the same rule `ModelRouter.stream` applies once it has emitted. A caller who wants the change to bite
now calls `abort()` first, which is a decision made out loud rather than a side effect. (The old
façade aborted silently; that behaviour is not preserved, and the PWA no longer wants it.)
An empty list throws `a runtime needs at least one ModelProvider`, at the call, as the constructor does.

### (b) `agent_message` splits into `agent_delta` + `agent_message`

```ts
| { type: "agent_delta"; text: string }              // one streamed increment, never repeated
| { type: "agent_message"; text: string; final: true } // ONE whole message, once, repeating its deltas
```

`final` was a boolean that said nothing about whether the text repeated the stream or added to it, so
every consumer guessed — the PWA's reducer carried a heuristic ("a repeat is dropped") with a bug in
it for any answer that ends by repeating itself. Now: **a delta ADDS, a message REPLACES and closes.**
`final` stays, always `true`, so the two tell apart at a glance and a reducer written against the old
union still compiles.

The loop calls `provider.chat()`, which buffers, so today it emits `agent_message` only — one per
assistant turn, including a turn that also called tools. `agent_delta` is emitted the day the loop
takes `provider.stream()`; consumers should handle it now.

**The one non-additive edge:** code that read `final` as *false ⇒ more is coming* now sees `true` on
an intermediate turn. Nothing in this repo did.

### (c) `Readiness.progress`

```ts
interface ReadinessProgress { loadedBytes: number; totalBytes?: number; percent?: number }
```

Beside the free-form `detail`, not instead of it. `Readiness` moved to `agent-models/src/types.ts`
(`openai-compatible.ts` re-exports it, so every import path still works). `LiteRtProvider` fills it
from the download it is already streaming, and `WebLLMProvider` from `initProgressCallback` — which
counts WORK, not bytes, so it reports `loadedBytes: 0`, no `totalBytes`, and a `percent`. `percent` is
present only when it can be computed honestly: a host that sent no `Content-Length` knows what has
arrived and cannot know what is left, and a made-up bar is worse than no bar.
`downloadPercent()` in the PWA reads the typed field first and keeps the sentence parser behind it.

### (d) `ModelProvider.unload?()` and `ModelRouter.unloadAll()`

`unload` is optional on the interface, so **always call it as `provider.unload?.()`**; it means "give
the machine back what you are holding", not "close" — the provider stays usable and the next request
loads again. `ModelRouter.unloadAll()` walks every provider it holds, not only the ones in a
preference list (the one no longer preferred is exactly the one still sitting on the GPU), and a
provider that throws on the way out does not stop the others being released.

### (e) `RunResult.providerId` / `RunResult.model`

Both optional; the LAST provider that answered, since a run that switched ended on that one. Absent
when no provider was reached (an abort before the first step). The agent still never learns any of
it — this is the caller's receipt, not the model's context.

### (f) `Vault` in the frozen surface

`api.ts` re-exports `Vault`, `VaultErrorCode`, `VaultFile`, `VaultOptions`, `VaultStore` (types only;
`createVault` stays in `index.ts`). The PWA holds a vault for the life of a session and could not name
its type without reaching past the contract.

### (g) Class-aware routing — `RunOptions.brain`, `model_started.brainClass`, `ModelRouterOptions.preference`

Finding 5's router item, shipped, additively. The rule itself is under §6.1; the surface is three
optional fields:

```ts
RunOptions.brain?: "auto" | "small" | "strong"        // default "auto": a class PER MODEL CALL
AgentEvent  { type: "model_started"; providerId; model?; brainClass?: ModelClass }  // the class USED
ModelRouterOptions.preference?                        // now optional: absent = the provider order
```

`brainClass` is the class that ANSWERED, not the one that was asked for — a run that wanted `strong`
where only the local brain is ready says `small`. `@00/agent-models` gained `providerClasses()` and
`classActuallyUsed()`, one place where a catalogue is read for its class, including the rule that an
EMPTY catalogue means `strong` (a BYOK provider built without rows, or Overblast before the mint call
answers, is a cloud brain). `ModelRouter` without a `preference` ranks the caller's order by class
rather than filtering it, so nothing is ever dropped for being the wrong class; a preference list
that IS given stays trusted as written and no catalogue is read. The PWA needed no edit.

### The local brain picker (§12.7, §12.6), same day

The Local AI card is now a picker fed by `https://dl.0-0.chat/litert/catalog.json`.

- **The join.** `parseMirrorCatalog` + `mergeMirrorCatalog` in `@00/agent-models` join the mirror's
  rows to `LITERT_CATALOG` on `file`/`assetFile`: the mirror decides WHAT IS THERE (exact bytes,
  sha256, licence, `vision`, gated-at-source), the package decides WHAT IT COSTS to run (`vramMb`,
  `family`, `contextTokens`, the label). A mirror row the package has never heard of is still offered
  with its numbers derived and marked `estimated`; a package row the mirror does not serve is left
  out, because that download would 404. `gemma-4-12B-it-web` joined `LITERT_CATALOG` so the offline
  fallback holds the same seven rows the mirror serves.
- **The cache.** `apps/infinite/src/lib/litert-catalog.ts`, five minutes in the settings IndexedDB
  (`LITERT_CATALOG_KEY`). A fresh cache short-circuits before the network is touched; a stale one is
  used only after the network failed; with neither, the package's own rows answer. The caller is told
  which of the three it got (`live` / `cached` / `offline`). It is fetched when the card is OPENED,
  never at boot.
- **Choosing a row** builds a new `LiteRtProvider` (`modelId` + `assetFile`, `modelBaseUrl` from the
  catalogue's own `base`), unloads the old one, calls `setProviders([litert, webllm])` and saves the
  choice in the settings KV as `ConnectionSettings.localModel` — with the host, so a person who
  downloaded two gigabytes from a mirror does not lose them to an environment variable change.
- **Already downloaded?** `readiness()` of a provider built for that row, asked lazily, one row at a
  time, after the list paints. Nothing is downloaded and no request is made.
- **A phone gets no picker** (§12.6): `isPhone()` is `navigator.userAgentData.mobile` where it exists
  and `width < 768` otherwise (which is the honest test — the rule is about a screen with no room for
  a picker). It takes the smallest row under `PHONE_VRAM_CAP_MB` (2000, i.e. the 270m or the 1B),
  decided from the PACKAGE's rows so the boot needs no network, and gets one line of explanation.
  Rows whose numbers were derived are never eligible. The router's fallthrough to WebLLM is untouched.
- **The licence line is per row**, not generic: each row links its own licence and, when it has one,
  its use restrictions and the host's verbatim copy (`ModelLicense.termsCopyUrl`, filled only from the
  mirror — the copy belongs to whoever redistributes the weights). `Unload` frees the GPU via (d).

### Coverage

`packages/agent-models` 98.9/90.3/98.2/98.9 and `packages/agent-runtime` 99.1/94.1/98.8/99.1, both
above their floors. `apps/infinite` measured 54.4/84.7/74.5/54.4 against floors of 47/80/65/47 —
statements and functions rose well past the ratchet's usual slack, but the floors are **left alone
deliberately**: the embed owner is editing `embed/src`, which this config counts, and raising a floor
under a peer's in-flight work is how a gate breaks for someone who did not touch it. Raise them
together once the embed round lands.

---

## Contract revision 2026-09-11

One additive field, one new export, and one behaviour change inside a tool. A consumer written
against the 2026-09-10 surface still compiles and still behaves the same way: everything below is
inert until a host fills the new field in.

### (a) `NetworkPolicy.proxy?: (url: URL) => string | null`

```ts
export interface NetworkPolicy {
  allow: string[];
  /** A read-only proxy to retry a blocked fetch through. `null` = not through me, for this URL. */
  proxy?: (url: URL) => string | null;
}
```

**The problem is the browser's, not the policy's.** A page may read a cross-origin response only when
the far side sent `Access-Control-Allow-Origin`, and almost no website does — so `http_get` in a tab
could reach its own origin and a handful of APIs, and every ordinary link came back as a `TypeError`
the model could only report as "could not reach". The host that SERVES the page can fetch it
server-side, where there is no CORS at all.

It is a function and not a base URL because the host decides per target whether its proxy will take
that URL; `null` means "not through me", and the tool then reports the original failure rather than
inventing a second one. **It does not widen the policy**: `allow` still decides what is `safe` and
what the person is asked about, the call is still a GET with no credentials, and the proxy is dialled
only AFTER a direct fetch has failed — a second road to the same URL, never a road to a URL the
person did not approve. `apps/infinite/src/runtime/bootstrap.ts` fills it with `proxyUrlFor`, which
points at `${location.origin}/~fetch` and answers `null` where there is no page.

`http_get`'s two new behaviours, both visible to a reader of a transcript:

- A fetch that throws a `TypeError` (the browser's one word for "blocked or unreachable") or answers
  opaque (`status === 0`) is retried through the proxy when there is one, and the output line then
  ends `(fetched through the site's read-only proxy)`. With no proxy, an opaque answer is now named —
  `<host> refused to be read from this page (CORS).` — instead of arriving as an empty success.
- **HTML comes back as text.** `htmlToText` (below) runs on any `text/html` answer, and the 1 MB cap
  applies AFTER the conversion, because the cap is on what the model reads. The tool's description
  says so: *"Fetch a web page or URL over GET and return it as readable text (HTML becomes
  markdown-ish text). Same rules: no cookies, 1024KB, text only."*

### (b) `htmlToText(html, baseUrl?)`, `decodeEntities`, `resolveHref` — `@00/agent-runtime`

`packages/agent-runtime/src/tools-html.ts`, exported from the package index. One linear pass over the
tags, no DOM (it runs in a Worker and in node, and the package has no dependencies). Keeps the title,
headings as `#` lines, paragraphs, list items as `- `, table cells separated by ` | `, `pre` blocks
fenced with their own whitespace, inline `code` in backticks, links as `[text](ABSOLUTE href)`
resolved against `baseUrl`, and images as `![alt](src)` only when the alt text is not empty. Drops
`script`, `style`, `noscript`, `svg`, `iframe`, `nav`, `footer`, a `<header role="banner">`, comments
and the doctype. A plain `<header>` survives — inside an article it is the article's own.

Exported on its own because a host that already has HTML in hand should not have to fetch it again.
Everything it returns is still untrusted data; conversion makes the words readable, not trustworthy.

### (c) The site Worker's `/~fetch` (not a package surface, but the other half of (a))

`apps/infinite-site/src/fetch-proxy.ts` is the pure decision — `decideProxy`, `isPublicHost`,
`publicHttpsTarget`, `calledBySite`, `isTextual` and the five caps as named constants — and
`src/index.ts` carries it out before the SPA fallback. It is imported and tested from
`apps/infinite/test/fetch-proxy.test.ts`, both as the pure verdict and as the Worker putting it on a
response, for the same reason `isolation-headers.test.ts` exists: that folder has no `node_modules`.
The rules and the reasoning are in `apps/infinite-site/README.md`, "The read-only fetch proxy".

### (e) `AgentRuntime.setExtraTools(tools: Tool[]): void`

The tools become swappable the way the brains did in (a) of 2026-09-10. The host's base table is
still what `createAgentRuntime` was given; `setExtraTools` adds a second list beside it, and each
call REPLACES the previous extras (so `[]` takes them away). Same timing rule as `setProviders`:
the next `run()` sees the new table, a run in flight keeps the one it started with — a call the
model still makes after the tool is gone is refused by name, not run. A name that collides with a
base tool throws in the caller's stack. Why it exists: the surface in front of the person changes
without the agent changing — the landing page's `page_*` tools (scroll to `#vault`, outline a
button) belong to `/` and not to `/app`, and rebuilding the runtime to swap a tool would drop the
listeners the panes subscribed at mount. Pinned in `test/runtime.test.ts` ("setExtraTools").

### (f) `NetworkPolicy.proxy` may answer with headers, and may answer late

```ts
export type ProxyTarget = string | { url: string; headers?: Record<string, string> };
proxy?: (url: URL) => ProxyTarget | null | Promise<ProxyTarget | null>;
```

§14's companion is a proxy on the person's own computer, and every call to it is authenticated with a
per-device signature — minted per request (it binds the method, the path and the body) and minted
with WebCrypto, which is a promise. So the policy's proxy hook gained two things, both additive: it
may return an object carrying the headers that call needs, and it may return a promise. A host that
returns a bare string (`apps/infinite-site`'s `/~fetch`, via `proxyUrlFor`) behaves exactly as before
and needed no edit.

`http_get` awaits the hook and sends the headers **on the proxy request only, never on the direct
one** — they are a credential for the proxy, not for the site, and the direct fetch stays the
credential-free GET it has always been. Everything else is unchanged: `allow` still decides what is
safe, the proxy is still dialled only after the browser has refused, and `null` still means "not
through me". Pinned in `test/tools-net.test.ts` ("takes an ASYNC proxy that answers `{ url, headers }`").

### (d) The QR encoder — `apps/infinite/src/lib/qr.ts`

App-local, not a package: `qrMatrix(text)` and `qrSvg(text, { size, fg, bg, quiet })`, byte mode,
error correction M, versions 1–10 (213 bytes), all eight masks scored by the spec's four penalties.
No dependency — a QR library is 15–60 KB of canvas rendering to get one grid of booleans, and this
app ships a 60 KB embed and promises to work offline. `QrCode.vue` renders it with
`fill="currentColor"` so it is theme-aware. `test/qr.test.ts` decodes what it encodes with an
independently written inverse; what no test here can prove is that a phone agrees.

### Coverage

`packages/agent-runtime` measured 99.4 / 94.3 / 99.2 / 99.4 with 405 tests, above its 98/92/98/98
floors. `apps/infinite` measured 76.0 / 82.6 / 79.6 / 76.0 with 1057 tests against floors of
72/79/75/72 — up from 2026-09-10's 75.3 / 82.0 / 79.1 / 75.3, and the floors are again left alone
while the embed and shell owners are mid-round.

---

## `@00/agent-node` grows a TypeScript transform, and a borrowed corpus (2026-09-11)

Three things landed in `packages/agent-node`, all of them sparked by
[macaly/almostnode](https://github.com/macaly/almostnode) (MIT, `6ab61f31`), which Bruno pointed at.
We kept our layer and borrowed what was worth borrowing.

**A `Transformer` seam, and esbuild-wasm behind it.** `src/loader/transform.ts` is the seam;
`src/transform/esbuild.ts` is the implementation, and it is the ONLY file in `src/` that names
`esbuild-wasm` — with an `await import()` inside a function, so a host that never runs a `.ts` file
never downloads the **12.2 MB** of wasm. A browser host copies
`node_modules/esbuild-wasm/esbuild.wasm` to its own origin under a versioned path
(`/esbuild/0.25.9/esbuild.wasm`) and passes it as `wasmURL`; same-origin because COOP+COEP, which we
already need for the synchronous filesystem, will not load it from anywhere else. `.ts` `.mts` `.cts`
`.tsx` `.jsx` are transformed to **CommonJS** before our own ESM rewriter sees them, which means a
file that goes through esbuild escapes all eight of `src/loader/esm.ts`'s limits. The resolver's
extension ladder gained them after the JavaScript ones, so `a.js` still beats `a.ts`. Without a
transformer a `.ts` refuses by name (`ERR_TRANSFORM_UNAVAILABLE`). Because esbuild's browser build has
no synchronous transform and `require` does, the loader gained `warmup(entry)` — an async walk of the
require graph that fills a cache keyed by (path, sha256) — and `runMainAsync`.

**A 767-case compatibility corpus**, ported from almostnode's `tests/node-compat` onto our modules:
`test/compat/`, with their LICENSE beside it and `SCOREBOARD.md` as the table. 663 pass, 104 are
`it.skip` with a `// SKIP:` line naming the gap. Read the scoreboard before reading the numbers: 43 of
those skips are `stream` cases that construct a bare `Readable`/`Writable` and would fail on Node
itself, because we ship readable-stream (Node's own code) and almostnode ships something laxer. The
port found and fixed ten real gaps on the way — sha256, HMAC and PBKDF2 in JS so Node's synchronous
shapes work, `events.on()`'s async iterator, the `stream` module being the `Stream` function, `%i`/
`%f` in `util.format`, `url.parse(x, true)` and `url.format`'s dropped port, `fs.rmdir`'s ENOTEMPTY,
and `file:` URLs as fs paths.

**`packages/agent-node/docs/dev-servers.md`** — the Vite/Next checklist, and its headline finding:
almostnode does not run Vite or Next. It reimplements both (a 700-line Vite-shaped dev server, a
1,688-line Next one) and loads esbuild/rollup/react from a CDN. The doc lists what the real `vite`
would need from us — `fs.watch` and a `chokidar` shim first, then a WebSocket road in `HttpBridge`,
`net.createServer` as a port probe, an `esbuild` package shim, and `module.createRequire` honouring
its argument — as a numbered to-do. Nothing of it was attempted this round.

Suite: 182 tests → **973** (869 running, 104 skipped). Coverage 96.6 / 89.9 / 94.6 / 96.6 against the
unchanged 90 / 80 / 90 / 90 floors.

---

## A THIRD local brain, and the first one that sees: Gemma 4 E2B on Transformers.js (2026-09-11)

Bruno asked for Gemma 4 E2B **with pictures** in the tab. Neither runtime we had can give him that,
and the reason is a fact about the builds rather than about our code:

- **LiteRT's Gemma 4 web builds are TEXT ONLY.** The `litert-community` cards say so, which is why
  §12.7's table marks the three Gemma 4 rows "text only" and why `LITERT_CATALOG`'s Gemma 4 rows carry
  no `vision` flag. LiteRT's vision rows are **Gemma 3n** — a generation behind, and gated at source.
- **web-llm's only vision builds are Phi-3.5-vision** at ~4 GB of VRAM. Not Gemma, and not in that
  catalogue (rule 3 of `webllm.ts`).

`onnx-community/gemma-4-E2B-it-ONNX` is the same Gemma 4 E2B weights exported to ONNX — **ungated,
Apache-2.0**, and Transformers.js runs it on WebGPU with the vision encoder attached. So the picture
road exists; it runs on a third runtime. `TransformersProvider` (`local-onnx`,
`packages/agent-models/src/transformers.ts`) is that runtime behind the one `ModelProvider` door.

### The row, as the picker shows it

| | |
|---|---|
| id | `gemma-4-E2B-it-onnx-q4f16` |
| label | **Gemma 4 E2B · vision (ONNX)** |
| size | **3.40 GB** (3 401 448 652 bytes, exact) |
| flags | `vision` · `class: small` · `supportsTools` (prompt fallback) · `contextTokens: 8192` |
| licence | Apache-2.0 — no use restrictions, so no Gemma-terms consent line |
| note | *Sees pictures · ONNX runtime, slower than LiteRT · needs 3.4 GB of browser storage, and the download does not resume* |

`contextTokens: 8192` is a **budget, not the weights' limit**. `config.json` says
`text_config.max_position_embeddings: 131072`, and the ONNX decoder's KV cache grows as it generates
rather than being asked for at load — so nothing caps anything. 8192 is what a laptop GPU holds of
that cache beside 3.4 GB of weights, and it is also the number `FALLBACK_SCHEMAS_MIN_CONTEXT` (16384)
is compared against, so the prompt fallback sends signatures rather than raw schemas. Claiming 131072
would be true about the weights and a lie about both of those.

### Six facts about the installed library that shaped the provider

Every one is read out of `@huggingface/transformers@4.2.0` in `node_modules`, and each has a twin
guard in `test/transformers.test.ts` that re-reads it.

1. **The library fetches its own files, and its `env` is a global singleton.** There is no per-call
   host: `buildResourcePaths` composes every URL as
   `remoteHost + remotePathTemplate.replace("{model}"…) + file`. Pointing it at our mirror means
   writing to a module-level object, so `applyEnv()` runs at the top of **every** `load()`.
2. **The wasm comes from our origin.** Transformers.js defaults `wasmPaths` to **jsdelivr**
   (`src/backends/onnx.js`), which is a local brain that stops working on a plane and would not load
   under COOP+COEP anyway. `ONNX_DEFAULT_WASM_PATH` is `/ort/`, and `ortWasm()` in
   `apps/infinite/vite.config.ts` copies four files there out of the installed `onnxruntime-web`.
3. **The download does not resume, and nothing here can make it.** In a browser
   `loadResourceFile` reads each file with `readResponse` into ONE `Uint8Array` and then puts it in
   Cache Storage — no `Range`, no part file anywhere in the package. `LiteRtProvider`'s part-wise
   resumable download cannot be lent to it, because the fetching happens inside the library. Two
   consequences, both said out loud rather than hidden: the row's `note`, and the fact that the
   biggest single buffer this path allocates is the 1.52 GB `embed_tokens` data file — under Chrome's
   ArrayBuffer ceiling, but the same class of allocation that failed at 3 GB on 2026-09-11, and the
   reason this row is **desktop only** (`vramMb: 4600`, far past §12.6's phone cap).
4. **Progress is aggregated for us — per `from_pretrained` CALL, which is not the same thing.**
   `DefaultProgressCallback` wraps the callback separately for each call, so the processor's seven
   files (19.5 MB) and the model's eight are summed in two maps that never see each other. Reading its
   `progress_total` was the first live bug of the day: the chip sat at **"99 % · 3.4 of 3.4 GB"** for
   the whole compile, because the last 0.6 % belonged to a call whose aggregate the provider was not
   reading. The provider now sums the per-file `progress` events itself, across both calls, and passes
   the same callback to both. Its own `total` still climbs as files start, so `totalBytes` is the
   larger of that and the row's `sizeBytes`, and the bar only ever fills.
5. **The sessions are not negotiable, so the audio encoder is mirrored.**
   `MODEL_SESSION_CONFIG[ImageAudioTextToText]` builds `embed_tokens`, `decoder_model_merged`,
   `vision_encoder` **and** `audio_encoder` unless the caller loads through a `…ForCausalLM` class,
   which drops vision with it. **There is no vision-without-audio load**, so 171 MB of the 3.40 GB is
   capability that is paid for and unused — `audio: true` on the row records that, and `ChatMessage`
   has no audio part to send it. Leaving it out means the model does not load at all.
6. **Tool calls take the prompt fallback, deliberately.** Unlike LiteRT this is a choice, not an
   absence: the repo's `chat_template.jinja` **does** have a native function-calling path
   (`format_function_declaration`), but its output is a bespoke `<|"|>`-quoted syntax needing its own
   parser, while `parseFallbackToolCalls` is what both other local brains already use.
   `TRANSFORMERS_NATIVE_TOOLS` is the constant that says the road exists and is not taken.

### The wire

`AutoProcessor.from_pretrained` first and on its own (the tokenizer, the chat template and two small
JSON files — a wrong host 404s in a second rather than three gigabytes later), then
`AutoModelForImageTextToText.from_pretrained(repo, { dtype: "q4f16", device: "webgpu", progress_callback })`.
The auto class rather than `Gemma4ForConditionalGeneration` by name: the registry maps
`gemma4 → Gemma4ForConditionalGeneration` in `MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING_NAMES`, and a test
pins that mapping.

**Pictures travel separately from their placeholders, and must stay in step.**
`apply_chat_template(messages, { enable_thinking: false, add_generation_prompt: true })` is handed
`{ type: "image" }` placeholders and writes the model's image token for each; the pixels go to
`processor(prompt, images, null, { add_special_tokens: false })` in the order the placeholders
appeared. Images go **before** the text of their turn — the model card's "Modality order" note, and
the only order in which the words can refer to the picture. Capped at 4 per turn
(`TRANSFORMERS_MAX_IMAGES`): each image is 280 tokens of 8192 before the words start.

Streaming is `TextStreamer`'s `callback_function` bridged to `ChatChunk`s through the same queue
LiteRT uses, with the same hold-back so a model that types `<end_of_turn>` as text never streams the
marker to a reader. `signal` → `InterruptableStoppingCriteria.interrupt()`. Generation runs in the
calling thread, as LiteRT's does.

**`abortLoad()` is best effort, and honestly so.** The fetches DO stop — `applyEnv` hands the library
an `env.fetch` bound to the load's controller — but ORT gives no way to interrupt a session build, so
a model that arrives after the stop is disposed rather than kept. The bytes already written stay in
Cache Storage, and re-reading them is the only "resume" this runtime has.

### Serving it

- **Mirror keys**: `onnx/<org>/<repo>/<relative path>` — the repo's OWN layout, because
  Transformers.js composes `<remoteHost>/<remotePathTemplate>/<file>` and this app sets that template
  to `{model}/`. `pathTemplateFor()` switches to the Hub's `{model}/resolve/{revision}/` when the base
  IS the Hub, which is what makes a live check one environment variable instead of two.
- **`scripts/publish-litert-models.sh`** grew two columns (`runtime`, `key prefix`) and the fifteen
  ONNX rows, each with the Hub's exact size and LFS sha256 (verified on the way into the bucket as
  every other row is). `--dry-run` now prints the whole `catalog.json` it would write.
- **`litert/catalog.json` holds ONE row for the repo**, not fifteen: `parseMirrorCatalog`
  deliberately drops any `file` with a slash in it, so the fifteen collapse into an asset whose `file`
  is the repo's directory name, whose `bytes` is their sum, carrying `runtime: "transformers"`. It has
  **no `sha256`** — fifteen files have fifteen hashes and no single one; the per-file list with its
  hashes is `GEMMA_4_E2B_ONNX_FILES` in the package, and a made-up aggregate would be worse than none.
- **`apps/infinite-site/src/index.ts`** answers `/onnx/*` from R2 beside `/litert/*`, with the same
  read-only CORS, ranges, ETags and `cross-origin` CORP. Its allow-list is a SHAPE (`org/repo/[sub/]file`)
  rather than a list of names, so a new repo needs a publish and not a deploy.
- **`/ort/` is NOT that door.** ONNX Runtime Web's own wasm is 22.5 MiB at the largest — under
  Cloudflare's 25 MiB asset cap — so it ships from `public/` as an ordinary static asset and the
  Worker has no route for it. `test/ort-wasm.test.ts` holds the size line, because MediaPipe's runtime
  is in R2 for exactly the reason that cap exists.
- **`scripts/r2-mirror`** gained a key-prefix allow-list (`litert/`, `onnx/`, `mediapipe/`). Its regex
  already permitted slashes; what it did not check was the destination.

**The command for the owner** (the publish copies 3.4 GB and is nobody's to run but his):

```sh
scripts/publish-litert-models.sh --only ONNX     # just the new repo; --dry-run first
```

It is idempotent — a key already there with the right size is skipped — so a plain
`scripts/publish-litert-models.sh` re-verifies the seven LiteRT rows and adds the fifteen ONNX ones.
No `HF_TOKEN` is needed for this repo: it is ungated.

### The app

`bootstrap.ts` builds **exactly one** of `LiteRtProvider` and `TransformersProvider` — a provider is
fixed to one row at construction and the person has chosen one row — and `localProviders()` puts it in
the right slot of `[litert, transformers, webllm]`. The row's `runtime` field is the only thing that
distinguishes it in the picker, which now joins the mirror to `LOCAL_MODEL_CATALOG` (all three
runtimes' rows) rather than to `LITERT_CATALOG`. `VITE_ONNX_MODEL_BASE` names the host and `off`
builds no ONNX provider at all, exactly as `VITE_LITERT_MODEL_BASE` does.

A saved `localModel` choice from before today has no `runtime` and therefore means `litert`, which is
what it meant — nobody's chosen model silently becomes the 3.4 GB one on a reload.

### Three things the live check found, that no unit test would have

**The progress denominator** — fact 4 above. Fixed in `report()`, with a test named after the symptom.

**ORT's workers need the embedder policy on their own script.** `ort-wasm-simd-threaded.asyncify.mjs`
is not just a script the page loads: the THREADED build spawns dedicated workers from it, and a worker
created by a cross-origin-isolated document is refused unless **its own script response** carries a
compatible `Cross-Origin-Embedder-Policy`. The main-thread fetch of that file answered 200 while three
worker spawns failed with `ERR_BLOCKED_BY_RESPONSE` — silently, so the symptom was a session build that
never finished and nothing in the console to say why. Two fixes, because two things serve that path:
the dev middleware now sets the isolation headers itself (a `configureServer` middleware runs BEFORE
vite's own, so `server.headers` has not been applied when it ends the response), and `headers.ts` grew
a **`runtime-worker`** kind — COEP plus `same-origin` CORP, and deliberately no
`Cross-Origin-Opener-Policy`, which means nothing on a subresource. Neither `asset` nor `mirror` was
right: one drops the policy the workers need, the other would put `cross-origin` on the app's own bytes.

**The browser can refuse to cache it.** On the machine this was checked on,
`navigator.storage.estimate()` reported a **3.0 GB quota** against a 3.40 GB model, and the library's
own `cache.put` for the two 1.5 GB data files failed with
`UnknownError: Failed to execute 'put' on 'Cache': Unexpected internal error.` It warns and carries on
with the buffers in hand — so **the model still loads and answers** — and then downloads all 3.4 GB
again on the next open. Chrome's quota tracks free disk (this Mac had 17 GB free), so a roomier machine
will cache it; there is nothing in our code to fix, so the row's `note` says it. Watched live, the JS
heap sat at **3.48 GB** while both buffers were held — fact 3's ceiling, seen rather than reasoned
about.

### Live, 2026-09-11 (Hub direct, before any publish)

`VITE_ONNX_MODEL_BASE=https://huggingface.co` on a dev server, so the row could be exercised before the
mirror has it. What was seen, in order:

1. The picker listed **Gemma 4 E2B · vision (ONNX) · 3.4 GB · `vision`**, with the note and the Apache
   licence line, alongside the seven LiteRT rows — from a `catalog.json` generated by the publish
   script's own `--dry-run`, so the row the app drew is the row a publish will write.
2. Choosing it set the chip to **"Gemma 4 E2B · vision (ONNX) · local"** and the card to
   "Would use Gemma 4 E2B · vision (ONNX), once it has downloaded."
3. The download ran from
   `huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/9f4bef82…/<file>` — the Hub layout
   `pathTemplateFor` picked on its own — into Cache Storage under `00-onnx-models`. **All fifteen files
   were requested and no others**, the audio encoder among them (fact 5, confirmed live).
4. The chip read **"Downloading … · 56 % · 1.9 of 3.4 GB"**, then (after the fix above)
   **"Loading Gemma 4 E2B · vision (ONNX) into the GPU…"** — the typed `ReadinessProgress` reaching
   both the chip and the card, denominated against the row's own `sizeBytes`.
5. The model **loaded and answered**. It took the prompt fallback, emitted
   `{"tool_call": {"name": "read", "arguments": {"path": "files/dot.png"}}}`, which parsed and ran
   (`Read 1 file · 10ms`), and each turn was labelled **`local-onnx`** in the transcript — so the
   runtime that answered is named, which is why the provider has an id of its own.

6. **It saw the picture.** Asked to `read files/dot.png` and say what was in it, the answer was:

   > The image contains a solid red circle.

   — which is exactly what was drawn into that file. Gemma 4 E2B, with pictures, in a tab, on WebGPU.

**THE ONE NUMBER TO KNOW: that answer took about twenty-five minutes of prefill.** The main thread
stayed responsive throughout, so it was waiting on the GPU rather than wedged, and text turns on the
same loaded model answered in the ordinary way. Two things explain it — the agent's system prompt is
~5k tokens before the image's 280 are added, and prefill on a q4f16 2B decoder over WebGPU is the
expensive half — but "slower than LiteRT" in the row's note is an understatement for a vision turn on
this machine, and nobody should ship this to a person as an interactive feature until it is measured on
better hardware. The first lever to pull is the **visual token budget**: the model card lists 70 / 140 /
280 / 560 / 1120, the processor defaults to 280, and this provider does not set it yet.

Also worth knowing: an earlier attempt showed the model **mangling a 40-character timestamped filename**
(`2026-09-11T13-14-42-…` → `2026-09-11T-14-42-…`) in its tool call, so the `read` missed. That is a 2B
model transcribing, not a wiring fault, and it is what the composer's upload path currently hands it.

### Undone

- **The visual token budget is not wired.** `processor_config.json` defaults to 280 image tokens and
  nothing here offers the 70 or 140 the model card supports — which is the first thing to try against
  the twenty-five-minute prefill measured above.
- The mirror publish itself (the owner's to run; the rows and the `--dry-run` are here).
- Nothing sends audio: the row pays for the encoder and `ChatMessage` has no audio part. If audio ever
  arrives, this row already loads the encoder for it.
- The 1.52 GB single-buffer allocation of fact 3 is a real ceiling, not a theoretical one. If it bites
  on a machine, the fix is upstream (a streaming `readResponse`), not here.

---

## `hosts` — a row says which harness may offer it, and five more ONNX rows (2026-09-11, later)

Bruno, on the local-model catalogue: **"gate the models to the compatible harness"**, and five models
he picked by name. Two changes, one vocabulary.

### The `Host` type, and where it lives on both sides

```ts
type Host = "browser-desktop" | "browser-phone" | "mac" | "headless";
```

It is declared **once**, in `packages/shared/src/models.ts` (with `HOSTS` and `isHost` beside it), and
both sides import that one definition: `@00/agent-models`'s `types.ts` re-exports it and adds
`hosts?: Host[]` to `ModelInfo`, and the engine's `apps/00d/src/llm-catalog.ts` adds `hosts?: Host[]`
to `LlmFacts`. Two definitions of the same four words is how two pickers start disagreeing about what
a phone is.

**What it is not.** Not readiness — a row offered on `browser-desktop` may still need two gigabytes
downloading, and `readiness()` stays the only truth about that. Not a capability list — `vision`,
`contextTokens` and `supportsTools` still say what a model can DO; `hosts` says only where it may be
SHOWN.

**The absent case, said in one place and obeyed everywhere:** `DEFAULT_HOSTS = ["browser-desktop"]`
(`types.ts`), with `hostsOf(row)` and `offeredOn(row, host)` beside it. A row nobody has classified is
desktop-only — the conservative reading, and the one that cannot put three gigabytes on a phone by
omission. A mirror row this package has never heard of falls under exactly that rule.

**Where it is filled in:** every row of `LITERT_CATALOG`, `TRANSFORMERS_CATALOG` and `WEBLLM_CATALOG`;
every asset of `litert/catalog.json` (the publish script's new `hosts` column); and every entry of
`catalogs/llm-models.json`, which carries `["mac","headless"]` — additive and **inert on the engine
this round**: nothing there filters on it, the models table shows what it showed yesterday, and what
the field buys today is the shared vocabulary for the day a row is genuinely harness-specific.

The WebLLM rows were decided by size, since `vram_required_MB` is all that catalogue publishes: the
879 MB Llama 3.2 1B (which is also `WEBLLM_DEFAULT_MODEL_ID`, the fallback brain) is offered on a
phone, and the 1.4 GB Qwen3 0.6B and everything above it are not.

### The picker: one gate, where there were two

`apps/infinite/src/lib/litert-catalog.ts` derives the harness ONCE:

- `thisHost(view?)` — `browser-phone` when `(pointer: coarse)` matches **and** the window is under
  `PHONE_MAX_WIDTH_PX` (768, the width the old rule already used), `browser-desktop` otherwise. Either
  signal alone is a device this would get wrong: a touchscreen laptop is a desktop, and a desktop
  window dragged thin can still hold a 3 GB model. Where there is no `matchMedia` at all,
  Chromium's `navigator.userAgentData.mobile` answers; failing both it is a desktop, which is the
  reading that offers MORE rather than fewer.
- `rowsForHost(rows, host)` — the filter, applied in `state/local-models.ts` **before any size rule**.
- `localHost` (a ref, re-read when the rows are) replaced `localPicker`, and `localBrain().picker` is
  gone from `runtime/bootstrap.ts`. §12.6's "a phone gets no picker" is now "a phone gets a picker of
  the rows offered on a phone" — three today (Gemma 3 270m, Gemma 3 1B, Qwen3.5 0.8B), with one line
  saying why the list is short. The 0.8B is the first phone row that **sees**, which is precisely why
  one row chosen by a number was no longer the right answer.
- The old VRAM rule survives only as a **tie-breaker**: `phoneRow()` picks the smallest row *offered
  on a phone* as the DEFAULT a phone that has never chosen starts on, and still refuses a row whose
  numbers were `estimated`.

### The six ONNX rows, as the picker draws them

| label | size | vision | licence | note |
|---|---|---|---|---|
| Gemma 4 E2B · vision (ONNX) | 3.4 GB | yes | Apache-2.0 | Sees pictures · ONNX runtime, slower than LiteRT · needs 3.4 GB of browser storage, and the download does not resume |
| **Qwen3.5 0.8B · vision (ONNX)** | 666 MB | yes | Apache-2.0 | Sees pictures · small enough for a phone · ONNX runtime, and the download does not resume |
| **Qwen3.5 2B · vision (ONNX)** | 1.6 GB | yes | Apache-2.0 | Sees pictures · 1.6 GB, desktop only · ONNX runtime, and the download does not resume |
| **Qwen3.5 4B · vision (ONNX)** | 3.0 GB | yes | Apache-2.0 | Sees pictures · 3.0 GB, the largest local row that fits a laptop GPU · the download does not resume |
| **Phi-4 mini (ONNX)** | 2.6 GB | no | MIT | Text only · 2.6 GB · ONNX runtime, and the download does not resume |
| **Llama 3.2 3B (ONNX)** | 2.4 GB | no | Llama 3.2 Community License · use restrictions · copy · **Built with Llama** | Text only · 2.4 GB · built with Llama, under Meta's community licence · the download does not resume |

Exact byte totals, which are the download bars' denominators and the publish script's rows:
666 085 872 · 1 600 200 215 · 3 019 398 759 · 2 564 860 424 · 2 419 252 013 (and Gemma's
3 401 448 652). Every file list, size and sha256 was read from
`https://huggingface.co/api/models/<repo>?blobs=true` at the commit each row pins; the half-dozen
small text files the Hub records no LFS hash for were fetched at that commit and hashed here.

**Licences, and where each was verified.** The Qwen3.5 0.8B export declares `apache-2.0` itself. The
two `-OPT` exports and the Phi-4-mini export declare **nothing** — their READMEs are front matter
naming `base_model:` and no `license:` — so the licence was read at the base model through the pointer
the export itself gives (`Qwen/Qwen3.5-2B`, `Qwen/Qwen3.5-4B` → Apache-2.0;
`microsoft/Phi-4-mini-instruct` → MIT), and the catalogue row says so in a comment rather than
assuming it from the name. Llama 3.2 is declared on the export, and it is the one row with an
obligation beyond a link: §1.b.i asks that **"Built with Llama"** be displayed and §5 incorporates an
Acceptable Use Policy, so `LLAMA_3_2` carries `useRestrictionsUrl`, `termsCopyUrl` and a new
`ModelLicense.attribution` — a line to SHOW, which the picker prints beside the licence and the Local
AI card repeats in its consent sentence. `scripts/litert-notices/` gained the two verbatim copies
(`LLAMA_3_2_LICENSE.txt`, `LLAMA_3_2_USE_POLICY.md`, both byte-for-byte from the ONNX repo) and
`NOTICE.txt` names every ONNX repo, its licence and the attribution line.

### What the provider had to grow: a second door

The Qwen3.5 rows are `Qwen3_5ForConditionalGeneration` — `ImageTextToText`, so embed_tokens + decoder
+ vision_encoder and, unlike Gemma 4's `ImageAudioTextToText`, **no audio encoder to pay for**. Phi-4
and Llama 3.2 are `Phi3ForCausalLM` and `LlamaForCausalLM` — `DecoderOnly`, ONE `model` graph, and
neither repo even ships a `processor_config.json`. So `TransformersProvider` now loads through
`AutoTokenizer` + `AutoModelForCausalLM` for a text row and `AutoProcessor` +
`AutoModelForImageTextToText` for a sighted one, behind one internal `PromptSide`
(`tokenizer` / `template` / `encode`) so `chat()` and `stream()` stayed single-path. Which door is
DERIVED from `vision`; the row's `files` and `probeFile` are per row, because no two rows fetch the
same set (`use_external_data_format` decides how many `_data` chunks a graph has: one for the small
Qwen rows, two for the 4B decoder and both text rows).

**The templates are the models' own.** `apply_chat_template` renders the repo's
`chat_template.jinja`, so three new model families cost no renderer here. What `family` is still read
for is the **cut** — which strings mean "the turn is over" if a model types one as text — so
`templates.ts` grew `chatml` (`<|im_start|>` / `<|im_end|>`), `phi` (`<|user|>` … `<|end|>`) and
`llama3` (`<|start_header_id|>` … `<|eot_id|>`), each read out of that repo's own template, plus
`turnStops(family)` and `turnMarkerMaxLength(family)`. Phi's stop list names its headers in full
because its header opens with `<|`, and scanning a stream for two characters would cut an answer that
merely mentioned them.

`contextTokens: 8192` on all six is a **budget, not the weights' limit** (the repos claim 131072 and
262144) — and worth knowing before picking a vision row: Gemma 4 spends a fixed 280 tokens per image,
while the Qwen rows' `Qwen2VLImageProcessorFast` scales with the picture's resolution, so a large
screenshot is thousands of tokens of that 8192. `TRANSFORMERS_MAX_IMAGES` (4) caps the count either way.

### The publish, for the owner to run

```sh
scripts/publish-litert-models.sh --dry-run                 # prints every row and the whole catalog.json
scripts/publish-litert-models.sh --only Qwen3.5-0.8B-ONNX  # the phone vision row first, 0.67 GB
scripts/publish-litert-models.sh                           # everything: the five new repos ≈ 10.3 GB
```

No `HF_TOKEN` is needed — all five repos are ungated — and the script is idempotent, so the seven
LiteRT rows and the Gemma ONNX directory are skipped by size. The run also re-puts `NOTICE.txt`,
`GEMMA_TERMS.md` and the two new Llama copies, and rewrites `litert/catalog.json` with `hosts` on
every asset. Until it runs, the five rows exist in the app's offline fallback list but their downloads
would 404 — which is why `mergeMirrorCatalog` leaves out a package row the mirror does not serve.

### Checked

`--dry-run` writes a catalogue of thirteen assets whose byte totals match the package's own sums
exactly, and a live picker at desktop width lists all thirteen rows with their notes and licence
lines; at 375 px with a coarse pointer it lists Gemma 3 270m, Gemma 3 1B and Qwen3.5 0.8B and nothing
larger. No model was downloaded: the five rows are ten gigabytes and the mirror does not serve them
yet.

`packages/agent-models` 418 tests, 98.27 / 91.14 / 96.47 / 98.27 against floors of 96 / 89 / 95 / 96 —
branches rose (90.32 → 91.14) and the floors are left where they are, one ratchet step behind.
`apps/infinite` 1299 tests, 75.82 / 83.63 / 80.21 / 75.82 against 73 / 81 / 78 / 73. Two new twin
guards read `scripts/publish-litert-models.sh` itself and hold its rows — files, bytes, hashes,
commit, licence word and `hosts` — equal to the package's, because the script runs with no TypeScript
in reach and the package with no shell.

### Undone

- **The publish itself** (the owner's; the rows and the `--dry-run` are here).
- **Nothing has run these five models.** The wiring is exercised against a fake library, the file
  lists come from the Hub's own record, and the twenty-five-minute vision prefill measured on the
  Gemma 4 ONNX row is the warning that applies to the Qwen rows until someone measures them.
- **A saved choice is not re-checked against the harness.** Choosing a desktop row and then opening
  the same browser profile at phone width leaves the chip on a row the picker no longer lists. Storage
  is per device, so this is a narrow case; the fix is one comparison in `bootstrap.ts` if it bites.
- **The visual token budget is still not wired** (the older round's item, and the Qwen rows make it
  sharper: their image cost scales with resolution).

---

## The visual token budget, and where the twenty-five minutes actually went (2026-09-11, later still)

Bruno: **"make picture turns on the Transformers.js rows fast enough to use."** The round before left
one number on the table — an image turn on Gemma 4 E2B that took about twenty-five minutes — and one
untaken lever, the visual token budget. Both were measured this round, on this Mac, and only one of
them is what the story said it was.

### The knobs, by their exact names, and the one thing that is NOT true about them

Read out of `@huggingface/transformers@4.2.0` in `node_modules`, not from a memory of the Python API:

| family | class | field | ships as | this round |
|---|---|---|---|---|
| Gemma 4 | `Gemma4ImageProcessor` | `max_soft_tokens` | **280** (`processor_config.json`) | **140** |
| Qwen3.5 | `Qwen2VLImageProcessor` (`…Fast` in the config, the suffix is stripped) | `max_pixels`, falling back to `size.longest_edge` | **16 777 216** (`preprocessor_config.json`) | **262 144** |

**There is no call-time kwarg, on either family, and that is the finding the whole design rests on.**
`Gemma4Processor._call(text, images, audio, options)` does pass the options down —
`this.image_processor(images, options)` — but `Gemma4ImageProcessor._call(images)` declares ONE
parameter and drops them. `Qwen2VLProcessor._call` does not even pass them: `this.image_processor(images)`.
Both read their budget off `this`, set in the constructor, and `AutoProcessor.from_pretrained` takes
only a revision and a progress callback — no config override. So `processor(images, text, { … })` is a
road that does not exist in 4.2.0, and the budget is **assigned onto the loaded instance** or it is not
applied at all. `applyVisionBudget(processor, budget)` is that assignment, it answers **whether it
found the field**, and `TransformersProvider.sessionDevices()` reports the answer, because a budget
that silently did not land is the export's 280 back and twice the prefill with it.

One arithmetic covers both: a visual token is a `patch_size * pool` square of pixels — `pool` being
Gemma's `pooling_kernel_size` (3) and Qwen's `merge_size` (2) — so `tokens * (patchSize * pool)²` is
the pixel budget either way, and the families differ only in which end of that identity their field
takes. `visionBudgetPixels`, `visionTokensForPixels` and `visionBudgetValue` in
`packages/agent-models/src/transformers.ts` are those three lines, and two twin guards read
`image_processing_gemma4.js` and `image_processing_qwen2_vl.js` so the formulas cannot drift from the
processors they were copied out of.

**Why 140 and not 70.** The card lists 70 / 140 / 280 / 560 / 1120. 70 is the FAST one, not the good
one — it is what the repo's own `video_processor` uses, where a frame is one of thirty-two — and a
person attaching a screenshot has usually attached it to be read. 140 resizes a square picture to
about 568 px a side rather than 803 px, which is still legible. **Why 256 for Qwen**, expressed as
262 144 pixels: a 512 × 512 picture. Their export's own default is sixteen megapixels, which is 16 384
visual tokens against a row whose context budget here is 8192 — the first screenshot anybody attached
would overflow the context before a word of it was read.

`visionBudget` is a **constant per row**, on all four vision rows, and deliberately not a `RunOptions`
field: the processor's budget is an instance field, so raising it mid-conversation would change what
an already-templated transcript meant. A caller can still pass `visionBudget: null` to get the repo's
own default back, which is how the before-number below was measured.

### Measured: the budget is worth 1.9×

Gemma 4 E2B ONNX q4f16, WebGPU, this Mac, a 400 × 300 PNG, time from `generate()` to the first token,
three runs each on a short prompt:

| `max_soft_tokens` | prompt tokens | time to first token |
|---|---|---|
| **280** (the export's default) | 318 | 1662 / 1667 ms |
| **140** (this row now) | 182 | 885 / 888 ms |
| 70 | 115 | 571 / 567 ms |

The processor's own encode falls with it, 84 → 48 ms. Through the real `TransformersProvider`, over
the real library, a whole turn (40 tokens out, the red-dot picture, "This image is a simple graphic
featuring a solid red circle on a white background.") is **2.27 s at 280 and 1.64 s at 140**.
At a ~1.5k-token prompt the same three budgets are 6172 / 5408 / 4668 ms.

### Where the twenty-five minutes actually went: the prompt, not the picture

This is the part the round before got wrong, and it was worth measuring rather than assuming.
Text-only turns, same loaded model, no picture anywhere, time to first token:

| prompt tokens | 43 | 537 | 1317 | 2617 | ~3600 |
|---|---|---|---|---|---|
| prefill | 0.37 s | 1.7 s | 4.6 s | **15.8 s** | **fails** |

Prefill on this row grows **superlinearly** — 2× the tokens is 3.4× the time — and at about 3600
tokens it does not complete at all on this machine: first
`WebGPU device error(3): Failed to allocate memory for buffer mapping`, then
`RuntimeError: operation does not support unaligned accesses`, and after either one the GPU device is
poisoned and every later turn on that page fails the same way. A reload is the only recovery.

So the twenty-five minutes was **the agent's own ~5k-token system prompt**, with the picture's 280
tokens riding on the worst part of that curve. Halving the picture's share is worth doing — it is
1.9× on a short prompt and it is what this round shipped — but **the row is still not usable as an
agent brain until the system prompt is short**, and on this machine a 5k-token prompt does not merely
crawl, it fails.

### The three things item 4 asked about

**WebGPU or a silent fallback to wasm?** WebGPU, and provably: `session.config = { dtype, device }` is
stamped on every session by `createInferenceSession`, and all four of Gemma 4's read
`{ device: "webgpu", dtype: "q4f16" }` live. There is no silent EP fallback to fear —
`deviceToExecutionProviders` THROWS for a device the browser lacks rather than choosing wasm.
`TransformersProvider.sessionDevices()` now reports this so nobody has to argue about it again. What
it **cannot** see, and what nothing in the library exposes, is ORT's per-NODE fallback: the console
does carry `VerifyEachNodeIsAssignedToAnEp — Some nodes were not assigned to the preferred execution
providers`, so some operators in these graphs do run on the CPU, and only a verbose-build rerun would
name them.

**Is the q4f16 vision encoder the problem?** No. Timed on its own, as a bare ORT WebGPU session on
`vision_encoder_q4f16.onnx` (+ its 99 MB external data): the session builds in **500 ms** and one run
over the full 2520-patch tensor takes **862 ms** cold. A `dtype: { vision_encoder: "fp16" }` map IS
supported — `selectDtype` accepts a per-file object keyed by session file name, as does `device` — but
it would need `onnx/vision_encoder_fp16.onnx` (+ 337 MB of data) on the mirror, which this round did
not add, and the measurement says there is nothing there to win.

**Can the audio encoder be skipped?** No, and the reason is now exact.
`MODEL_SESSION_CONFIG[ImageAudioTextToText].sessions(config, options, textOnly)` adds `audio_encoder`
and `vision_encoder` together, and the only thing that sets `textOnly` is `resolveTypeConfig` noticing
that a `…ForCausalLM` class is loading a `…ForConditionalGeneration` config — which drops vision with
it. There is no `session_options` or `dtype` value that skips one graph: a dtype map still loads the
file, and there is no "sessions to build" option. 171 MB of the row's 3.40 GB is an encoder nothing
sends anything to, exactly as fact 5 said, and it is paid at load time and not per turn.

### The downscale that was not worth doing

Item 2 asked for a second shrink in the provider, to the row's pixel target. It was built, measured,
and **removed**, and `toImages` now carries the measurement so nobody rebuilds it:

- It cannot change the **token** count. Gemma's processor resizes to its budget in either direction —
  it will ENLARGE a thumbnail — and then zero-pads the patch tensor to `max_soft_tokens * 9` rows
  whatever it was given; Qwen's `smart_resize` already caps at `max_pixels`. Once the budget is
  applied, both cost the same for any picture.
- The only thing left to save is the processor's own decode and resize, and that was timed: **50 ms**
  for the 1568 px attachment `attachments.ts` actually writes, 124 ms for 4000 × 3000, 232 ms for
  6000 × 4500 — against 50 ms for a picture already at the budget. The ceiling on the saving is under
  200 ms, and only for a picture no attachment path can produce (`IMAGE_MAX_BYTES` refuses 4 MB, which
  a 27-megapixel PNG is five times over).
- The shrink itself costs a decode and a re-encode, which is not free.

So **`apps/infinite/src/lib/attachments.ts` is unchanged**: its 1568 px cap is the right cap in the
right place — it is what the two cloud wires want, and it already lands every attachment within about
50 ms of optimal on this road.

### Checked

`packages/agent-models` 437 tests, 98.23 / 91.21 / 96.53 / 98.23 against floors of 96 / 89 / 95 / 96;
the floors are left where they are. `apps/infinite` 1299 tests unchanged, `tsc --noEmit` and
`vue-tsc --noEmit` clean. The live check ran the REAL `TransformersProvider` against the REAL library
with the loaded Gemma 4 sessions handed to it through `createLibrary`: the budget went 280 → 140 on
the processor, `sessionDevices()` reported all four graphs on WebGPU with `visionBudgetApplied: true`,
and the model described the picture correctly.

### Undone

- **The prompt, which is the actual problem.** A 5k-token system prompt is 15 s of prefill at 2.6k
  tokens and a hard failure somewhere under 4k on this machine. Nothing in this round addresses it; a
  local-brain system prompt that fits in a few hundred tokens would be worth more than every knob here.
- **The failure mode is a poisoned page.** Once a turn hits the buffer-mapping OOM or the unaligned
  access, every later turn on that page fails identically and only a reload recovers. The provider
  reports it as a provider error like any other; it should probably unload and say "reload the tab".
- **Nothing has run the five newer rows.** The Qwen budget is arithmetic and tests, not a stopwatch.
- **`dtype`/`device` per component is available and unused.** Both accept a map keyed by session file
  name. Using it needs the other dtype's files on the mirror.
- **Chrome still refuses to cache this row** (3.0 GB quota against 3.40 GB), so every measurement above
  began with a fresh 3.4 GB download — 75 to 90 s from the mirror at about 35 MB/s.
