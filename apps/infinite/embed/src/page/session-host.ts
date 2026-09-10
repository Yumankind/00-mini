/**
 * Reading the session signal from a real page, and noticing when it goes away.
 *
 * WHY a poll as well as events: `document.cookie` fires nothing when a cookie is deleted, and the
 * `storage` event only reaches OTHER tabs — the tab that signed out never hears its own write. So
 * the watcher listens to everything that does exist (the Cookie Store API's `change`, the `storage`
 * event, history navigations) AND re-reads on a slow timer, because missing a logout is the one
 * failure that leaves somebody's account pages on a shared computer.
 *
 * The decision itself lives in ../index/session.ts; this file only supplies it with facts.
 */

import type { SessionConfig } from "../site-config.js";
import type { AuthState } from "../types.js";
import { detectAuthState, isLogoutNavigation, transition, type SessionHost } from "../index/session.js";

/** Controls whose accessible name says "sign in" / "account", for the `none` heuristic. */
const SIGN_IN = /\b(sign[\s-]?in|log[\s-]?in|register|create account)\b/i;
const ACCOUNT = /\b(sign[\s-]?out|log[\s-]?out|my account|your account|profile|dashboard)\b/i;

export function createSessionHost(): SessionHost {
  const controls = (): string[] => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("a[href],button,[role=button]")) {
      if (el.closest("[data-infinite-agent]")) continue;
      const label = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""} ${el.getAttribute("href") ?? ""}`;
      out.push(label.replace(/\s+/g, " ").trim());
      if (out.length >= 250) break;
    }
    return out;
  };
  return {
    cookie: () => {
      try {
        return document.cookie;
      } catch {
        return "";
      }
    },
    storageItem: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    hasSignInControl: () => controls().some((c) => SIGN_IN.test(c)),
    hasAccountControl: () => controls().some((c) => ACCOUNT.test(c)),
  };
}

export interface SessionWatcherEvents {
  /** The state changed; a re-crawl may be wanted. */
  onChange(next: AuthState, previous: AuthState): void;
  /** The session ENDED: run the purge (index/session.ts explains what it deletes). */
  onLogout(): void;
}

/** Poll interval. Slow on purpose: this is a safety net, not the primary signal. */
const POLL_MS = 4000;

export function watchSession(
  config: SessionConfig,
  host: SessionHost,
  events: SessionWatcherEvents,
): () => void {
  let state = detectAuthState(config, host);
  const disposers: (() => void)[] = [];

  const reread = (): void => {
    const next = detectAuthState(config, host);
    if (next === state) return;
    const previous = state;
    state = next;
    events.onChange(next, previous);
    if (transition(previous, next)) events.onLogout();
  };

  const onNavigate = (): void => {
    // A navigation to a sign-out path IS a logout, even when the signal itself is invisible
    // (HttpOnly cookies, a server-side session) — that is why the setup flow asks for the paths.
    if (isLogoutNavigation(location.pathname, config.logoutPaths)) {
      state = "anon";
      events.onLogout();
      return;
    }
    reread();
  };

  const timer = setInterval(reread, POLL_MS);
  disposers.push(() => clearInterval(timer));

  const add = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
    window.addEventListener(type, fn);
    disposers.push(() => window.removeEventListener(type, fn));
  };
  add("storage", reread);
  add("pageshow", onNavigate);
  add("popstate", onNavigate);
  add("focus", reread);

  // The Cookie Store API, where it exists, is the only event a cookie deletion actually fires.
  const cookieStore = (globalThis as { cookieStore?: EventTarget }).cookieStore;
  if (cookieStore) {
    const fn = (): void => reread();
    cookieStore.addEventListener("change", fn);
    disposers.push(() => cookieStore.removeEventListener("change", fn));
  }

  return () => {
    for (const d of disposers) d();
  };
}

export function currentAuthState(config: SessionConfig, host: SessionHost): AuthState {
  return detectAuthState(config, host);
}
