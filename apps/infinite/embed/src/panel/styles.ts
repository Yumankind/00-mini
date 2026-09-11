/**
 * The panel's styles — which are the WIDGET's styles, not a second set that looks like them.
 *
 * This file used to hold its own copy. It does not any more: `src/mini/mini-css.ts` is the one
 * stylesheet both implementations render, so that the widget floating over our own landing page and
 * the widget on somebody else's website are the same pixels rather than two drifting cousins
 * (DESIGN.md: "The floating widget and the embed are pixel-for-pixel the same UI").
 *
 * The reasons the string is a string are unchanged, and they are why that module imports nothing:
 * the embed ships as ONE self-contained script under 60 KB gz (§10), a second request for CSS could
 * fail on a stranger's site, and the CLOSED shadow root it is injected into is what keeps the host
 * page's CSS out and this CSS in — the panel may not modify the page it sits on (§13).
 *
 * `PANEL_CSS` keeps its name here because that is what the panel calls it.
 */
export { MINI_CSS as PANEL_CSS } from "../../../src/mini/mini-css.js";
