/**
 * Going somewhere else in the same document.
 *
 * The PWA answers every path from one bundle: `/` is the landing page with the floating 00 Mini on
 * it, `/app` is the full app, and the root component switches between them by listening to
 * `popstate`. `history.pushState` alone does NOT fire that event — it is only dispatched for a
 * BACK or a FORWARD — so a link inside the app has to say out loud that the location changed, and
 * every caller doing it by hand is one caller forgetting.
 */

/** Change the path and tell the listeners. Same-path calls are ignored: no history entry for a no-op. */
export function goTo(path: string): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
