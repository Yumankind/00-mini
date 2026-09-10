/**
 * What the crawler is allowed to touch.
 *
 * WHY a guard list and not a heuristic: the crawl fetches with the visitor's own credentials, so a
 * GET is only harmless as long as the site treats GET as harmless — and plenty do not. A link
 * called "Delete" is a real delete on more sites than anyone would like. So the guard is a fixed,
 * readable list of shapes that MEAN a state change, checked before a URL is ever enqueued, and the
 * owner can only ever ADD to it (`doNotTouch`), never subtract.
 *
 * The list, in prose, exactly as docs/HANDOFF-infinite-agent.md §5.2.1 states it:
 *
 *   - anything that ends a session or removes something:
 *       logout, signout, sign-out, delete, remove, cancel, unsubscribe
 *   - anything that buys:  add-to-cart, checkout/complete, checkout/confirm
 *   - any query that carries a verb or a capability:  action=…, token=…, reset
 *   - anything under an administrative or destructive area:
 *       admin, wp-admin, account/settings, account/delete
 *   - plus the owner's `excludes` and `doNotTouch` paths.
 *
 * Everything here is a pure predicate over a URL string so the whole list is unit-testable with no
 * network and no DOM.
 */

/** Path-or-query shapes that mean "this URL changes something". Never fetched. */
export const STATE_CHANGE_PATTERNS: readonly RegExp[] = [
  /logout/i,
  /signout/i,
  /sign-out/i,
  /delete/i,
  /remove/i,
  /cancel/i,
  /unsubscribe/i,
  /add-to-cart/i,
  /checkout\/(complete|confirm)/i,
  /[?&]action=/i,
  /[?&]token=/i,
  /reset/i,
];

/** Areas that are administrative or account-destructive, matched on the path only. */
export const GUARDED_AREA_PATTERNS: readonly RegExp[] = [
  /(^|\/)admin(\/|$)/i,
  /(^|\/)wp-admin(\/|$)/i,
  /(^|\/)account\/settings(\/|$)/i,
  /(^|\/)account\/delete(\/|$)/i,
];

/** File extensions that are certainly not a page. Cheap pre-filter before any fetch. */
const NON_PAGE_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|pdf|zip|gz|tar|mp[34]|m4a|mov|webm|woff2?|ttf|eot|txt|csv|rss)$/i;

export interface ScopeOptions {
  origin: string;
  includes: string[];
  excludes: string[];
  doNotTouch: string[];
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin);
    // Scheme AND host, per §5.2.1. `URL.origin` compares both, and the port with them.
    return u.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** A URL is guarded when any pattern matches its path+query, or an owner path prefixes its path. */
export function isGuarded(url: string, opts: Pick<ScopeOptions, "excludes" | "doNotTouch">): string | null {
  let path = url;
  let full = url;
  try {
    const u = new URL(url, "http://x.invalid");
    path = u.pathname;
    full = u.pathname + u.search;
  } catch {
    /* a relative scrap; match it as-is */
  }
  for (const re of STATE_CHANGE_PATTERNS) if (re.test(full)) return `matches the state-change guard ${re}`;
  for (const re of GUARDED_AREA_PATTERNS) if (re.test(path)) return `is under a guarded area ${re}`;
  for (const p of opts.doNotTouch) if (prefixes(p, path)) return `is under the owner's do-not-touch path ${p}`;
  for (const p of opts.excludes) if (prefixes(p, path)) return `is under the owner's exclude path ${p}`;
  return null;
}

/** `/help` covers `/help` and `/help/faq`, and does NOT cover `/helpful`. */
export function prefixes(prefix: string, path: string): boolean {
  if (!prefix) return false;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(`${p}/`);
}

/** Everything the crawler asks before a URL joins the frontier. Returns null when it may be fetched. */
export function rejectReason(url: string, opts: ScopeOptions): string | null {
  if (!sameOrigin(url, opts.origin)) return "is off-origin";
  const u = new URL(url, opts.origin);
  if (u.username || u.password) return "carries credentials in the URL";
  if (NON_PAGE_EXT.test(u.pathname)) return "is not a page";
  if (opts.includes.length && !opts.includes.some((p) => prefixes(p, u.pathname))) {
    return "is outside the owner's include list";
  }
  return isGuarded(u.pathname + u.search, opts);
}

/** Strip the fragment and any trailing slash noise, so one page is one entry. */
export function canonicalise(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}
