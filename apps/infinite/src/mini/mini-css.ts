/**
 * ONE STYLESHEET FOR TWO IMPLEMENTATIONS — the floating widget and the embed (DESIGN.md, "The
 * floating widget (and the embed)").
 *
 * The widget on our own landing page is Vue; the widget on somebody else's site is 400 lines of DOM
 * inside a closed shadow root. They are the SAME product, so they must be the same pixels, and the
 * only way to guarantee that is one stylesheet and one set of class names rather than two that drift.
 *
 * WHY A STRING, AND WHY THIS MODULE IMPORTS NOTHING. The embed ships as one self-contained IIFE
 * under 60 KB gz (§10): a `.css` file would be a second request that can fail on a stranger's site,
 * and any import here would drag a module graph into that budget. So this is a string with no
 * dependencies, injected into the shadow root by the embed and into a `<style data-mini>` by the app.
 *
 * WHY IT CARRIES ITS OWN TOKENS. `src/style.css` owns the app's variables; this widget cannot depend
 * on them, because on somebody else's website there is no `style.css` and no `:root` to read. Every
 * colour below is a `--mini-*` variable declared on `.mini` itself. The values are DESIGN.md's
 * palette, light first, dark under `prefers-color-scheme` — plus `[data-theme]` overrides, which
 * match in the app's document (where the theme is a choice) and simply never match inside a shadow
 * root (where the host page's `html` is out of reach).
 *
 * EVERY SELECTOR IS UNDER `.mini`. In the shadow root that is belt and braces; in the app's own
 * document it is the rule that keeps a widget stylesheet from restyling the landing page behind it.
 */

export const MINI_CSS = `
:host { all: initial; }
.mini, .mini *, .mini *::before, .mini *::after { box-sizing: border-box; }
/* The hidden attribute is how this widget hides a row it may show again, and every display rule
   below would otherwise out-specify the browser's own [hidden] { display: none }. */
.mini [hidden] { display: none !important; }
.mini {
  --mini-void: #ffffff; --mini-card: #fafafa; --mini-panel: #f4f4f5; --mini-panel-2: #ececee;
  --mini-line: #e4e4e7; --mini-ink: #111113; --mini-dim: #6b6b74; --mini-faint: #9b9ba3;
  --mini-accent: #16a37a; --mini-red: #d64545; --mini-amber: #c98a12;
  --mini-shadow: 0 12px 40px rgba(0,0,0,.18);
  --mini-font: -apple-system, "Inter", "Segoe UI", system-ui, sans-serif;
  --mini-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  font: 400 13px/1.55 var(--mini-font); color: var(--mini-ink);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .mini {
    --mini-void: #0f0f10; --mini-card: #131315; --mini-panel: #18181b; --mini-panel-2: #212124;
    --mini-line: #2a2a2e; --mini-ink: #ededef; --mini-dim: #9a9aa3; --mini-faint: #64646c;
    --mini-accent: #4ade9b; --mini-red: #f0555f; --mini-amber: #ecc36b;
    --mini-shadow: 0 12px 40px rgba(0,0,0,.5);
  }
}
[data-theme="dark"] .mini {
  --mini-void: #0f0f10; --mini-card: #131315; --mini-panel: #18181b; --mini-panel-2: #212124;
  --mini-line: #2a2a2e; --mini-ink: #ededef; --mini-dim: #9a9aa3; --mini-faint: #64646c;
  --mini-accent: #4ade9b; --mini-red: #f0555f; --mini-amber: #ecc36b;
  --mini-shadow: 0 12px 40px rgba(0,0,0,.5);
}
[data-theme="light"] .mini {
  --mini-void: #ffffff; --mini-card: #fafafa; --mini-panel: #f4f4f5; --mini-panel-2: #ececee;
  --mini-line: #e4e4e7; --mini-ink: #111113; --mini-dim: #6b6b74; --mini-faint: #9b9ba3;
  --mini-accent: #16a37a; --mini-red: #d64545; --mini-amber: #c98a12;
  --mini-shadow: 0 12px 40px rgba(0,0,0,.18);
}
/* Only the family, and only where a browser would otherwise impose its own. A shorthand font or
   colour here would out-specify every .mini-* control below (element + class beats a bare class),
   which is how a white arrow on a black send button once came out black on black. */
.mini button, .mini input, .mini textarea, .mini select { font-family: inherit; }
.mini :focus-visible { outline: 2px solid color-mix(in srgb, var(--mini-accent) 40%, transparent); outline-offset: 1px; }
.mini svg { display: block; }

/* ── the launcher ─────────────────────────────────────────────────────────────────────────────── */
.mini-launcher {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 9px 16px 9px 10px; border-radius: 999px; border: 1px solid var(--mini-line);
  background: var(--mini-void); color: var(--mini-ink);
  font: 600 13px/1 var(--mini-font); box-shadow: var(--mini-shadow);
}
.mini-launcher:hover { background: var(--mini-panel); }
.mini-launcher .mini-face { width: 22px; height: 22px; }

/* ── the panel ────────────────────────────────────────────────────────────────────────────────── */
.mini-panel {
  display: none; flex-direction: column; width: 400px; max-width: calc(100vw - 32px);
  height: 640px; max-height: calc(100vh - 32px);
  background: var(--mini-void); border: 1px solid var(--mini-line); border-radius: 18px;
  box-shadow: var(--mini-shadow); overflow: hidden;
}
.mini-panel[data-open="1"] { display: flex; }
.mini-panel[data-open="1"] ~ .mini-launcher { display: none; }

.mini-header {
  display: flex; align-items: center; gap: 9px; padding: 11px 12px;
  border-bottom: 1px solid var(--mini-line); background: var(--mini-card);
}
.mini-face { width: 26px; height: 26px; flex: none; }
.mini-face svg { width: 100%; height: 100%; border-radius: 7px; }
.mini-heading { min-width: 0; display: flex; flex-direction: column; }
.mini-title { font: 600 13px/1.3 var(--mini-font); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-sub { font-size: 11px; color: var(--mini-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.mini-icon {
  border: 0; background: transparent; color: var(--mini-dim); cursor: pointer;
  width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px; font: 400 15px/1 var(--mini-font);
}
.mini-icon:hover { background: var(--mini-panel-2); color: var(--mini-ink); }

/* ── the transcript ───────────────────────────────────────────────────────────────────────────── */
.mini-body {
  flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.mini-row { max-width: 100%; overflow-wrap: anywhere; }
.mini-row.me {
  align-self: flex-end; max-width: 85%; background: var(--mini-panel); border-radius: 14px 14px 4px 14px;
  padding: 7px 11px; white-space: pre-wrap;
}
/* A context line the widget added to the message is SHOWN — a person may read everything their
   agent was told — but it is two lines of it, not eight: the sentence they typed is the message. */
.mini-row.me .mini-note {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; margin-bottom: 4px; font-family: var(--mini-mono); font-size: 10.5px;
}
.mini-row.them { align-self: stretch; }
.mini-row.status, .mini-row.tool {
  align-self: stretch; color: var(--mini-dim); font-size: 11.5px;
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px 7px; font-family: var(--mini-mono);
}
.mini-row.tool .mini-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--mini-faint); flex: none;
}
.mini-row.tool[data-state="running"] .mini-dot { background: var(--mini-accent); }
.mini-row.tool[data-state="failed"] .mini-dot { background: var(--mini-red); }
.mini-row.error {
  align-self: stretch; color: var(--mini-red); font-size: 12px;
  border: 1px solid color-mix(in srgb, var(--mini-red) 35%, transparent);
  border-radius: 12px; padding: 8px 10px;
}
.mini-row.error button {
  display: block; margin-top: 6px; border: 1px solid var(--mini-line); background: transparent;
  border-radius: 8px; padding: 4px 9px; cursor: pointer; font: 600 11px/1 var(--mini-font);
  color: var(--mini-ink);
}
.mini-row.footer { color: var(--mini-faint); font-size: 11px; }
.mini-row.owner {
  align-self: stretch; border-left: 3px solid var(--mini-accent); padding-left: 9px;
}
.mini-row.owner b { display: block; font-size: 10.5px; color: var(--mini-dim); font-weight: 600; }
/* The bar takes what the line leaves, and never shrinks to a dot on a long download line. */
.mini-bar { height: 3px; border-radius: 999px; background: var(--mini-panel-2); overflow: hidden; flex: 1 0 72px; }
.mini-bar i { display: block; height: 100%; background: var(--mini-accent); transition: width .16s ease-out; }

/* ── rendered markdown ────────────────────────────────────────────────────────────────────────── */
.mini-md { font-size: 13px; line-height: 1.6; }
.mini-md > :first-child { margin-top: 0; }
.mini-md > :last-child { margin-bottom: 0; }
.mini-md p { margin: 0 0 8px; }
.mini-md h1, .mini-md h2, .mini-md h3, .mini-md h4 { margin: 14px 0 6px; font-size: 13.5px; font-weight: 650; }
.mini-md ul, .mini-md ol { margin: 0 0 8px; padding-left: 20px; }
.mini-md li { margin: 2px 0; }
.mini-md a { color: var(--mini-accent); }
.mini-md code {
  font: 400 12px/1.4 var(--mini-mono); background: var(--mini-panel); border-radius: 5px; padding: 1px 4px;
}
.mini-md pre, .mini-md .md-code {
  margin: 0 0 8px; padding: 9px 10px; background: var(--mini-panel); border-radius: 10px;
  overflow-x: auto; max-height: 260px;
}
.mini-md pre code { background: transparent; padding: 0; font-size: 12px; white-space: pre; }
.mini-md blockquote {
  margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--mini-line); color: var(--mini-dim);
}
.mini-md hr { border: 0; border-top: 1px solid var(--mini-line); margin: 12px 0; }
.mini-md img { max-width: 100%; height: auto; border-radius: 8px; }
.mini-md table { border-collapse: collapse; width: 100%; margin: 0 0 8px; font-size: 12px; display: block; overflow-x: auto; }
.mini-md th, .mini-md td { border: 1px solid var(--mini-line); padding: 4px 7px; text-align: left; }
.mini-md th { background: var(--mini-panel); font-weight: 600; }

/* ── the composer ─────────────────────────────────────────────────────────────────────────────── */
.mini-composer {
  display: flex; align-items: flex-end; gap: 7px; padding: 10px 12px;
  border-top: 1px solid var(--mini-line); background: var(--mini-card);
}
.mini-input {
  flex: 1; min-width: 0; resize: none; max-height: 120px;
  padding: 9px 12px; border-radius: 14px; border: 1px solid var(--mini-line);
  background: var(--mini-void); color: var(--mini-ink); font: 400 13px/1.45 var(--mini-font);
}
.mini-input::placeholder { color: var(--mini-faint); }
.mini-send, .mini-stop, .mini-attach {
  flex: none; width: 32px; height: 32px; border-radius: 999px; border: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--mini-ink); color: var(--mini-void); font: 600 14px/1 var(--mini-font);
}
.mini-attach { background: transparent; color: var(--mini-dim); border: 1px solid var(--mini-line); }
.mini-attach:hover { color: var(--mini-ink); }
.mini-send:disabled { opacity: .35; cursor: default; }
.mini-stop { background: var(--mini-red); color: #fff; }

.mini-footer {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px;
  border-top: 1px solid var(--mini-line); color: var(--mini-faint); font-size: 10.5px;
}
.mini-footer button {
  border: 0; background: transparent; color: var(--mini-dim); text-decoration: underline;
  cursor: pointer; padding: 0; font: inherit;
}
.mini-footer .mini-sponsor { margin-left: auto; text-align: right; }

/* ── the embed's own furniture: the offer, the confirm, a search hit, the owner's setup ───────── */
.mini-offer, .mini-ask {
  border: 1px solid var(--mini-line); border-radius: 14px; padding: 10px;
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
}
.mini-offer { border-style: dashed; }
.mini-ask { border-color: var(--mini-accent); }
.mini-offer p, .mini-ask p { margin: 0; flex: 1; font-size: 12px; }
.mini-ask p { flex-basis: 100%; }
.mini-offer .mini-licence { flex-basis: 100%; font-size: 11px; color: var(--mini-dim); }
.mini-offer .mini-licence a { color: inherit; }
.mini-offer button, .mini-ask button {
  border: 1px solid var(--mini-line); background: transparent; color: var(--mini-ink);
  border-radius: 10px; padding: 6px 12px; cursor: pointer; font: 600 12px/1.2 var(--mini-font);
}
.mini-ask button.yes { background: var(--mini-ink); color: var(--mini-void); border-color: var(--mini-ink); }
.mini-hit {
  border: 1px solid var(--mini-line); border-radius: 14px; padding: 9px 11px; background: transparent;
  text-align: left; cursor: pointer; width: 100%; color: inherit; font: inherit;
}
.mini-hit:hover { border-color: var(--mini-accent); }
.mini-hit b { display: block; font-weight: 600; }
.mini-hit span { color: var(--mini-dim); font-size: 11.5px; }
.mini-setup { display: flex; flex-direction: column; gap: 14px; }
.mini-setup h2 { margin: 0; font-size: 14px; }
.mini-step { border: 1px solid var(--mini-line); border-radius: 14px; padding: 11px; }
.mini-step > b { display: block; margin-bottom: 2px; }
.mini-blurb { color: var(--mini-dim); font-size: 12px; margin: 0 0 8px; }
.mini-setup label { display: block; font-size: 11.5px; color: var(--mini-dim); margin: 8px 0 3px; }
.mini-setup input, .mini-setup select, .mini-setup textarea {
  width: 100%; padding: 7px 9px; border-radius: 10px; border: 1px solid var(--mini-line);
  background: var(--mini-void); color: var(--mini-ink); font: inherit;
}
.mini-rule { background: var(--mini-panel); border-radius: 10px; padding: 7px 9px; font-size: 12px; }
.mini-field { display: flex; gap: 8px; align-items: center; }
.mini-field input[type=checkbox] { width: auto; }
.mini-pre {
  margin: 0; padding: 9px; background: var(--mini-panel); border-radius: 10px;
  font: 400 11px/1.45 var(--mini-mono); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 190px; overflow: auto;
}
.mini-copy {
  border: 1px solid var(--mini-line); background: transparent; color: var(--mini-ink);
  border-radius: 10px; padding: 5px 9px; cursor: pointer; font: 600 11.5px/1 var(--mini-font);
  margin-top: 6px;
}
.mini-note { color: var(--mini-dim); font-size: 11px; }

/* ── the owner's setup: a centred modal wizard over the panel (§5.2.4) ────────────────────────── */
/* Fixed to the viewport rather than to the .mini column, which is a 400 px column in the bottom-right corner:
   the setup is the whole screen's business for as long as it is up. It is still inside the closed
   shadow root, so "over the page" never means a node on the page. */
.mini-modal {
  position: fixed; inset: 0; z-index: 10; display: none; align-items: center; justify-content: center;
  padding: 24px;
}
.mini-modal[data-open="1"] { display: flex; }
.mini-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
.mini-wizard {
  position: relative; display: flex; flex-direction: column; text-align: left;
  width: 100%; max-width: 560px; max-height: calc(100vh - 48px);
  background: var(--mini-void); border: 1px solid var(--mini-line); border-radius: 18px;
  box-shadow: var(--mini-shadow); overflow: hidden;
}
.mini-wizard-head {
  display: flex; align-items: center; gap: 9px; padding: 12px 14px;
  border-bottom: 1px solid var(--mini-line); background: var(--mini-card);
}
.mini-wizard-head h2 { margin: 0; font: 600 14px/1.35 var(--mini-font); min-width: 0; }
.mini-wizard-head .mini-icon { margin-left: auto; flex: none; }

/* The progress row: five numbered steps, done behind, current lit, next waiting. Scoped under
   .mini-steps so the plain .mini-step card keeps the look it has. */
.mini-steps {
  display: flex; gap: 8px; padding: 10px 14px; overflow-x: auto;
  border-bottom: 1px solid var(--mini-line); background: var(--mini-card);
}
.mini-steps .mini-step {
  flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px;
  border: 0; border-radius: 8px; padding: 2px; background: transparent; cursor: default;
  color: var(--mini-faint); font: 600 10.5px/1.2 var(--mini-font); text-align: left;
}
.mini-steps .mini-step span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini-steps .mini-step i {
  flex: none; width: 18px; height: 18px; border-radius: 999px; font-style: normal;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--mini-panel-2); color: var(--mini-dim); font-size: 10px;
}
.mini-steps .mini-step[data-state="done"] { color: var(--mini-dim); cursor: pointer; }
.mini-steps .mini-step[data-state="done"] i { background: var(--mini-accent); color: var(--mini-void); }
.mini-steps .mini-step[data-state="current"] { color: var(--mini-ink); }
.mini-steps .mini-step[data-state="current"] i { background: var(--mini-ink); color: var(--mini-void); }
.mini-steps .mini-step:disabled { opacity: .75; }

.mini-wizard-body { flex: 1; overflow-y: auto; padding: 15px 14px; display: flex; flex-direction: column; gap: 13px; }
/* A column that scrolls must not also squash: without this the review's summary is compressed to
   whatever is left rather than scrolled to. */
.mini-wizard-body > * { flex: 0 0 auto; }
.mini-wizard-body > .mini-copy { align-self: flex-start; margin-top: 0; }
.mini-wizard-body h3 { margin: 0; font: 600 14px/1.35 var(--mini-font); }
.mini-wizard-body > h3 + .mini-note { margin: -11px 0 0; }
.mini-wizard-group { display: flex; flex-direction: column; gap: 13px; }
.mini-wizard .mini-field { display: flex; flex-direction: column; align-items: stretch; gap: 5px; }
.mini-wizard .mini-field.row { flex-direction: row; align-items: center; gap: 9px; }
.mini-wizard .mini-field > .mini-note { margin: 0; }
.mini-wizard label { display: block; font: 600 11.5px/1.4 var(--mini-font); color: var(--mini-dim); }
.mini-wizard .mini-field.row label { color: var(--mini-ink); font-weight: 500; font-size: 13px; }
.mini-wizard input, .mini-wizard select, .mini-wizard textarea {
  width: 100%; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--mini-line);
  background: var(--mini-void); color: var(--mini-ink); font: 400 13px/1.4 var(--mini-font);
}
.mini-wizard input[type="checkbox"] { width: auto; flex: none; }
.mini-wizard p { margin: 0; }
.mini-wizard .mini-error:empty { display: none; }
.mini-wizard .mini-error { color: var(--mini-red); font-size: 11.5px; }
.mini-preview {
  display: flex; justify-content: center; padding: 14px; border-radius: 12px;
  background: var(--mini-panel); border: 1px dashed var(--mini-line);
}

/* A path list, as what it is: one chip a path, each removable on its own. */
.mini-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mini-chips:empty { display: none; }
.mini-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 9px;
  border: 1px solid var(--mini-line); border-radius: 999px; background: var(--mini-panel);
  font: 400 11.5px/1.5 var(--mini-mono); overflow-wrap: anywhere;
}
.mini-chip button {
  border: 0; background: transparent; color: var(--mini-dim); cursor: pointer; padding: 0;
  width: 17px; height: 17px; border-radius: 999px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; font: 400 12px/1 var(--mini-font);
}
.mini-chip button:hover { background: var(--mini-panel-2); color: var(--mini-ink); }

.mini-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 9px; align-items: start; }
.mini-card {
  display: flex; flex-direction: column; gap: 6px; padding: 11px; text-align: left;
  border: 1px solid var(--mini-line); border-radius: 14px; background: var(--mini-void);
  color: var(--mini-ink); font: inherit;
}
button.mini-card { cursor: pointer; }
button.mini-card:hover { border-color: var(--mini-dim); }
.mini-card b { font: 600 12.5px/1.35 var(--mini-font); }
.mini-card p { font-size: 11.5px; color: var(--mini-dim); }
.mini-card[data-picked="1"] { border-color: var(--mini-accent); background: color-mix(in srgb, var(--mini-accent) 9%, var(--mini-void)); }
.mini-card-foot { display: flex; flex-wrap: wrap; gap: 6px; }
.mini-card-foot .mini-copy { margin-top: 0; }
.mini-card .mini-licence { font-size: 11px; color: var(--mini-dim); }
.mini-card .mini-licence a { color: inherit; }

.mini-summary { border: 1px solid var(--mini-line); border-radius: 12px; overflow: hidden; }
.mini-summary > div { display: flex; align-items: baseline; gap: 9px; padding: 6px 10px; font-size: 11.5px; border-top: 1px solid var(--mini-line); }
.mini-summary > div:first-child { border-top: 0; }
.mini-summary b { flex: 0 0 36%; color: var(--mini-dim); font-weight: 600; }
.mini-summary span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mini-jump {
  flex: none; border: 0; background: transparent; color: var(--mini-dim); cursor: pointer;
  padding: 0; text-decoration: underline; font: 500 11px/1.4 var(--mini-font);
}
.mini-jump:hover { color: var(--mini-ink); }

.mini-wizard-foot {
  display: flex; align-items: center; gap: 8px; padding: 11px 14px;
  border-top: 1px solid var(--mini-line); background: var(--mini-card);
}
.mini-wizard-foot .mini-grow { margin-left: auto; }
.mini-wizard-foot button {
  border: 1px solid var(--mini-line); background: transparent; color: var(--mini-ink);
  border-radius: 10px; padding: 7px 15px; cursor: pointer; font: 600 12.5px/1.2 var(--mini-font);
}
/* DESIGN.md: the primary button is ink on void, never mint. */
.mini-wizard-foot button.primary { background: var(--mini-ink); color: var(--mini-void); border-color: var(--mini-ink); }
.mini-wizard-foot button:disabled { opacity: .4; cursor: default; }
.mini-wizard-foot .mini-note { margin-right: 4px; }

/* ── a phone: the panel is a sheet, the launcher stays out of the page's own buttons ──────────── */
@media (max-width: 480px) {
  .mini { right: 10px; left: 10px; bottom: 10px; align-items: stretch; }
  .mini-launcher { align-self: flex-end; }
  .mini-panel {
    width: auto; max-width: none; height: min(80vh, 640px);
    border-radius: 18px 18px 12px 12px; padding-bottom: env(safe-area-inset-bottom);
  }
  /* The wizard is a full-screen sheet: five screens of questions do not fit beside a phone's edge. */
  .mini-modal { padding: 0; }
  .mini-wizard {
    max-width: none; height: 100%; max-height: none; border: 0; border-radius: 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .mini-cards { grid-template-columns: 1fr; }
  .mini-summary b { flex-basis: 42%; }
}
@media (prefers-reduced-motion: no-preference) {
  .mini-panel[data-open="1"] { animation: mini-rise .16s ease-out; }
  .mini-modal[data-open="1"] .mini-wizard { animation: mini-rise .16s ease-out; }
  @keyframes mini-rise { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
}
`;
