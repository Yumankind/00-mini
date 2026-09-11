/**
 * `dist/embed/m/setup.js` — the OWNER's setup wizard, fetched when the gear is pressed.
 *
 * WHY IT IS NOT IN `e.js`: a visitor never opens it. The wizard is five screens, a preview, the
 * carrier documents it hands the owner to save, and the Register card of §5.3 — 58 KB of source for
 * a flow that is run once, by one person, on their own site. Everything a VISITOR does (search the
 * site, open a page, have a control outlined) is in the loader and stays there.
 *
 * The panel reaches this through `panel/setup-seam.ts`, which shows a loading line while it comes
 * and a plain sentence if it does not.
 */

export { renderSetup } from "../panel/setup.js";
export type { AdminFlow, LocalAiCard, SetupHandle, SetupOptions } from "../panel/setup.js";
