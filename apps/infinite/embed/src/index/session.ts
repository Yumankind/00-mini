/**
 * The session signal, and what a logout does (docs/HANDOFF-infinite-agent.md §5.2.1).
 *
 * WHY the loader cares at all whether a visitor is signed in: because a crawl made with the
 * visitor's own cookies can index that person's own data — their orders, their address, their
 * ticket history — and a shared computer must not keep it. Knowing the session is how the embed
 * knows when to FORGET.
 *
 * THE PURGE RULES, in prose, because they are the whole point of this module:
 *
 *   1. Every entry records the `authState` it was crawled in: anon, authed or unknown.
 *   2. On a logout — the configured signal disappears, a navigation hits a `logoutPaths` entry, or
 *      a page indexed as `authed` now answers with a login form — the loader DELETES:
 *        · every entry crawled while `authed`, and
 *        · every entry crawled while `unknown` DEEPER THAN LEVEL 1,
 *      because an unknown-state page below the shallow map may hold that person's private data.
 *      What remains is the public, shallow map, and the next open re-crawls from there.
 *   3. `session.kind: "temporary"` is stricter: `authed` entries never reach IndexedDB at all. They
 *      live in memory and die with the tab, so a shared computer keeps nothing.
 *   4. The same purge runs when the visitor presses "clear memory" in the panel footer, and when
 *      the owner's `site.json` version changes.
 *   5. `crawlAuthed: false` means nothing is indexed while `authed` in the first place (enforced in
 *      the crawler, not here — there is nothing to purge if nothing was written).
 *
 * Everything in this file is pure: an `AuthState` in, a decision out. The DOM half — reading
 * document.cookie, the Cookie Store API, the storage event, the poll — is in ../page/session-host.ts.
 */

import type { SessionConfig } from "../site-config.js";
import type { AuthState, PageEntry } from "../types.js";

/** What the loader can see of the page, expressed so a test can hand it a literal. */
export interface SessionHost {
  /** `document.cookie`. HttpOnly cookies are invisible here — the setup flow says so out loud. */
  cookie(): string;
  /** `localStorage.getItem`, or null when storage is unavailable. */
  storageItem(key: string): string | null;
  /** The heuristic's two questions: is a sign-in control on the page, is an account/sign-out one. */
  hasSignInControl(): boolean;
  hasAccountControl(): boolean;
}

export function cookiePresent(cookieHeader: string, name: string): boolean {
  // Names only. A value is never read into the index (§5.2.4) — only its presence is a signal.
  return cookieHeader
    .split(";")
    .map((c) => c.trim().split("=")[0])
    .some((c) => c === name);
}

/**
 * The visitor's session as the owner configured it. `none` falls back to the heuristic: a sign-in
 * control present ⇒ anon, an account/sign-out control present ⇒ authed, neither ⇒ unknown.
 */
export function detectAuthState(session: SessionConfig, host: SessionHost): AuthState {
  switch (session.kind) {
    case "cookie": {
      if (!session.cookies.length) break;
      const jar = host.cookie();
      return session.cookies.some((n) => cookiePresent(jar, n)) ? "authed" : "anon";
    }
    case "localStorage": {
      if (!session.storageKeys.length) break;
      return session.storageKeys.some((k) => host.storageItem(k) != null) ? "authed" : "anon";
    }
    case "temporary":
      // A memory/sessionStorage session is invisible from here by definition, so the heuristic is
      // the only reading available — and nothing authed will be persisted anyway.
      break;
    case "none":
      break;
  }
  if (host.hasAccountControl()) return "authed";
  if (host.hasSignInControl()) return "anon";
  return "unknown";
}

/** A navigation to one of the owner's sign-out paths means a logout, whatever the signal says. */
export function isLogoutNavigation(path: string, logoutPaths: string[]): boolean {
  const clean = path.split("?")[0]!.replace(/\/+$/, "") || "/";
  return logoutPaths.some((p) => {
    const q = p.replace(/\/+$/, "") || "/";
    return clean === q || clean.startsWith(`${q}/`);
  });
}

/** Why a purge is happening. Every one of these runs the SAME rule (§5.2.1). */
export type PurgeReason =
  | "logout"
  | "login-form-on-authed-page"
  | "clear-memory"
  | "site-config-version-changed";

export interface PurgeOutcome {
  kept: PageEntry[];
  removed: PageEntry[];
  reason: PurgeReason;
}

/**
 * Rule 2, and nothing else: authed entries go, unknown entries deeper than level 1 go, anon and
 * shallow-unknown entries stay. `depth` 0 is the page the visitor was on and 1 its links; those are
 * the public map, and a signed-out visitor would have seen the same.
 */
export function purgeEntries(pages: PageEntry[], reason: PurgeReason): PurgeOutcome {
  const kept: PageEntry[] = [];
  const removed: PageEntry[] = [];
  for (const p of pages) {
    const doomed = p.authState === "authed" || (p.authState === "unknown" && p.depth > 1);
    (doomed ? removed : kept).push(p);
  }
  return { kept, removed, reason };
}

/**
 * Rule 3: what may be written to disk under this session kind. `temporary` keeps authed entries in
 * memory only; every other kind persists what it crawled and relies on the purge above.
 */
export function persistable(pages: PageEntry[], kind: SessionConfig["kind"]): PageEntry[] {
  if (kind !== "temporary") return pages;
  return pages.filter((p) => p.authState !== "authed");
}

/**
 * A transition worth acting on. Returns a purge reason when the session just ENDED; a sign-in
 * (anon → authed) is not a purge, it is a re-crawl.
 */
export function transition(previous: AuthState, next: AuthState): PurgeReason | null {
  return previous === "authed" && next !== "authed" ? "logout" : null;
}
