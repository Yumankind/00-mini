/**
 * TWO SCREENS ON ONE ORIGIN — which of them a URL means, and how to move between them.
 *
 * The app lives on ONE product origin (§3.1: OPFS and the push subscription are per origin), so the
 * landing page and the full app are not two deployments; they are two readings of the same document.
 * `/` is the landing with the floating agent over it, `/app` is the app full screen — and so is any
 * URL the app already answers, because a deep link that opened the app yesterday must not land on a
 * marketing page today.
 *
 * WHY `pushState` AND A SYNTHETIC `popstate`. There is no router in this app and one would be a
 * dependency for two routes. `history.pushState` does not notify anybody, so the helper dispatches
 * the event the browser would have dispatched, and the shell listens for exactly one thing.
 *
 * The decision itself is a pure function of the URL, tested in node with no history and no document.
 */

/** The app's own path. Everything else on this origin is the landing. */
export const APP_PATH = "/app";

/**
 * Is this URL the app?
 *
 * The three deep links are the app's, whatever path they arrive on: `?claim=` is §5.4's one-time
 * grant, `?receive` and `#receive` are the move flow a QR code opens. They are read here rather
 * than in the shell so that the rule has one home and a test can pin it.
 */
export function isAppUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://0-0.chat");
  } catch {
    return false;
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (path === APP_PATH) return true;
  if (parsed.searchParams.has("claim") || parsed.searchParams.has("receive")) return true;
  return parsed.hash.replace(/^#/, "").split("?")[0] === "receive";
}

/** The current location, or `/` in a context that has none (a test, a worker). */
export function currentUrl(): string {
  return typeof location === "undefined" ? "/" : location.pathname + location.search + location.hash;
}

/**
 * Go somewhere on this origin without a reload — and tell the shell, which the browser does not.
 *
 * A push to the path already showing is skipped: a history entry that changes nothing is a Back
 * button that appears to do nothing.
 */
export function goTo(path: string): void {
  if (typeof history === "undefined" || typeof window === "undefined") return;
  if (currentUrl() !== path) history.pushState(history.state, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
