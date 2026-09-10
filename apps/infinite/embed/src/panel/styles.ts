/**
 * The panel's styles, as one string injected into the CLOSED shadow root.
 *
 * WHY a string and not a stylesheet file: the embed ships as ONE self-contained script (§10, "one
 * bundle, no framework, < 60 KB gz"). A second request for CSS would be a second thing to cache, a
 * second thing to go missing, and a moment where the panel renders unstyled on somebody's site.
 *
 * WHY a closed shadow root: isolation in both directions. The host page's CSS cannot reach in and
 * make the panel unreadable, and the panel's CSS cannot leak out and change the host page — which
 * would be a modification, and §13 forbids modifying the page.
 *
 * Colours are declared for light and follow `prefers-color-scheme` into dark; sizes are relative,
 * and under 480 px the panel takes the whole width, because most visitors are on a phone.
 */

export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb; --accent: #ffbb22;
  --bubble: #f3f4f6; --shadow: 0 12px 40px rgba(0,0,0,.18);
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  font: 400 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .wrap {
    --bg: #14161a; --fg: #eceef2; --muted: #9aa1ad; --line: #2a2e36; --bubble: #1e2128;
    --shadow: 0 12px 40px rgba(0,0,0,.5);
  }
}
.launcher {
  display: flex; align-items: center; gap: 8px; border: 0; cursor: pointer;
  padding: 10px 16px; border-radius: 999px; background: var(--fg); color: var(--bg);
  font: 600 14px/1 system-ui, sans-serif; box-shadow: var(--shadow);
}
.launcher:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.panel {
  display: none; flex-direction: column; width: 380px; max-width: calc(100vw - 32px);
  height: 560px; max-height: calc(100vh - 32px);
  background: var(--bg); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: var(--shadow); overflow: hidden;
}
.panel[data-open="1"] { display: flex; }
.panel[data-open="1"] + .launcher { display: none; }
header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
header .name { font-weight: 650; }
header .line { color: var(--muted); font-size: 12px; }
header .grow { flex: 1; }
.iconbtn {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font: 400 16px/1 system-ui, sans-serif; padding: 6px; border-radius: 8px;
}
.iconbtn:hover { background: var(--bubble); color: var(--fg); }
.body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 90%; padding: 8px 11px; border-radius: 12px; background: var(--bubble); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.me { align-self: flex-end; background: var(--fg); color: var(--bg); }
.msg.status { align-self: flex-start; background: transparent; color: var(--muted); font-size: 12px; padding: 0 2px; }
.hit { border: 1px solid var(--line); border-radius: 12px; padding: 9px 11px; background: transparent; text-align: left; cursor: pointer; width: 100%; color: inherit; font: inherit; }
.hit:hover { border-color: var(--accent); }
.hit b { display: block; font-weight: 600; }
.hit span { color: var(--muted); font-size: 12px; }
form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
input[type=text], input[type=search] {
  flex: 1; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); font: inherit; min-width: 0;
}
input:focus-visible, button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button.send { border: 0; border-radius: 10px; padding: 9px 14px; background: var(--fg); color: var(--bg); font: 600 14px/1 system-ui; cursor: pointer; }
footer { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
footer button { border: 0; background: transparent; color: var(--muted); text-decoration: underline; cursor: pointer; font: inherit; padding: 0; }
footer .sponsor { margin-left: auto; text-align: right; }
.offer { border: 1px dashed var(--line); border-radius: 12px; padding: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.offer p { margin: 0; flex: 1; font-size: 12px; color: var(--muted); }
.offer .licence { flex-basis: 100%; font-size: 11px; color: var(--muted); }
.offer .licence a { color: inherit; text-decoration: underline; }
.offer button { border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
.setup { display: flex; flex-direction: column; gap: 14px; }
.setup h2 { margin: 0; font-size: 15px; }
.setup .step { border: 1px solid var(--line); border-radius: 12px; padding: 11px; }
.setup .step > b { display: block; margin-bottom: 2px; }
.setup .blurb { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
.setup label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 3px; }
.setup input, .setup select, .setup textarea {
  width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); font: inherit;
}
.setup .rule { background: var(--bubble); border-radius: 8px; padding: 7px 9px; font-size: 12px; }
.setup .row { display: flex; gap: 8px; align-items: center; }
.setup .row input[type=checkbox] { width: auto; }
pre { margin: 0; padding: 9px; background: var(--bubble); border-radius: 8px; font: 400 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 190px; overflow: auto; }
.copy { border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 8px; padding: 5px 9px; cursor: pointer; font: 600 12px/1 system-ui; margin-top: 6px; }
.note { color: var(--muted); font-size: 11px; }
@media (max-width: 480px) {
  .wrap { right: 8px; left: 8px; bottom: 8px; }
  .panel { width: auto; height: min(78vh, 560px); }
}
@media (prefers-reduced-motion: no-preference) {
  .panel { animation: rise .16s ease-out; }
  @keyframes rise { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
}
`;
