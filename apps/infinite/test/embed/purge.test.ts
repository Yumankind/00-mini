import { describe, expect, it } from "vitest";
import {
  cookiePresent,
  detectAuthState,
  isLogoutNavigation,
  persistable,
  purgeEntries,
  transition,
  type SessionHost,
} from "../../embed/src/index/session.js";
import { SiteIndex } from "../../embed/src/index/site-index.js";
import { MemoryStore } from "../../embed/src/index/store.js";
import { DEFAULT_SITE_CONFIG, type SessionConfig, type SessionKind } from "../../embed/src/site-config.js";
import { entry } from "./helpers.js";

const ORIGIN = "https://shop.example";

const host = (over: Partial<SessionHost> = {}): SessionHost => ({
  cookie: () => "",
  storageItem: () => null,
  hasSignInControl: () => false,
  hasAccountControl: () => false,
  ...over,
});

const session = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  kind: "none",
  cookies: [],
  storageKeys: [],
  logoutPaths: [],
  ...over,
});

describe("the session signal, per kind (§5.2.1)", () => {
  it("cookie: presence of a named cookie, never its value", () => {
    const cfg = session({ kind: "cookie", cookies: ["session_id"] });
    expect(detectAuthState(cfg, host({ cookie: () => "theme=dark; session_id=abc123" }))).toBe("authed");
    expect(detectAuthState(cfg, host({ cookie: () => "theme=dark" }))).toBe("anon");
    expect(cookiePresent("a=1; session_id=x", "session_id")).toBe(true);
    expect(cookiePresent("a=1; not_session_id=x", "session_id")).toBe(false);
  });

  it("localStorage: presence of a named key", () => {
    const cfg = session({ kind: "localStorage", storageKeys: ["auth.token"] });
    expect(detectAuthState(cfg, host({ storageItem: (k) => (k === "auth.token" ? "t" : null) }))).toBe("authed");
    expect(detectAuthState(cfg, host())).toBe("anon");
  });

  it("temporary: invisible from here, so the heuristic answers", () => {
    const cfg = session({ kind: "temporary" });
    expect(detectAuthState(cfg, host({ hasAccountControl: () => true }))).toBe("authed");
    expect(detectAuthState(cfg, host())).toBe("unknown");
  });

  it("none: the heuristic, and unknown when neither control is there", () => {
    const cfg = session({ kind: "none" });
    expect(detectAuthState(cfg, host({ hasSignInControl: () => true }))).toBe("anon");
    expect(detectAuthState(cfg, host({ hasAccountControl: () => true }))).toBe("authed");
    expect(detectAuthState(cfg, host())).toBe("unknown");
  });

  it("catches a logout by path even when the signal is invisible", () => {
    expect(isLogoutNavigation("/logout", ["/logout"])).toBe(true);
    expect(isLogoutNavigation("/account/signout?next=/", ["/account/signout"])).toBe(true);
    expect(isLogoutNavigation("/logouts-of-history", ["/logout"])).toBe(false);
    expect(isLogoutNavigation("/help", ["/logout"])).toBe(false);
  });

  it("treats only authed → not-authed as a logout", () => {
    expect(transition("authed", "anon")).toBe("logout");
    expect(transition("authed", "unknown")).toBe("logout");
    expect(transition("anon", "authed")).toBeNull();
    expect(transition("unknown", "unknown")).toBeNull();
  });
});

describe("the purge (§5.2.1)", () => {
  const mixed = [
    entry({ url: `${ORIGIN}/`, authState: "anon", depth: 0 }),
    entry({ url: `${ORIGIN}/help`, authState: "anon", depth: 1 }),
    entry({ url: `${ORIGIN}/account`, authState: "authed", depth: 1 }),
    entry({ url: `${ORIGIN}/account/orders/9`, authState: "authed", depth: 2 }),
    entry({ url: `${ORIGIN}/maybe`, authState: "unknown", depth: 1 }),
    entry({ url: `${ORIGIN}/maybe/deep`, authState: "unknown", depth: 2 }),
  ];

  it("deletes every authed entry and every unknown entry deeper than level 1", () => {
    const out = purgeEntries(mixed, "logout");
    expect(out.kept.map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/help`, `${ORIGIN}/maybe`]);
    expect(out.removed.map((p) => p.url)).toEqual([
      `${ORIGIN}/account`,
      `${ORIGIN}/account/orders/9`,
      `${ORIGIN}/maybe/deep`,
    ]);
  });

  it("runs the same rule for every reason it can run for", () => {
    const reasons = ["logout", "login-form-on-authed-page", "clear-memory", "site-config-version-changed"] as const;
    const shapes = reasons.map((r) => purgeEntries(mixed, r).kept.map((p) => p.url).join(","));
    expect(new Set(shapes).size).toBe(1);
  });

  it("temporary never lets an authed entry reach disk; the other three kinds do", () => {
    const kinds: SessionKind[] = ["cookie", "localStorage", "temporary", "none"];
    for (const kind of kinds) {
      const written = persistable(mixed, kind);
      const authed = written.filter((p) => p.authState === "authed");
      if (kind === "temporary") expect(authed).toHaveLength(0);
      else expect(authed).toHaveLength(2);
    }
  });

  it("purges the stored index, for each of the four session kinds", async () => {
    for (const kind of ["cookie", "localStorage", "temporary", "none"] as SessionKind[]) {
      const store = new MemoryStore();
      const index = new SiteIndex({
        origin: ORIGIN,
        ref: "ia_test",
        store,
        config: { ...DEFAULT_SITE_CONFIG, session: session({ kind }) },
      });
      index.merge(mixed);
      await index.save();
      const removed = await index.purge("logout");
      // temporary had already refused the two authed entries at save time, so a logout finds only
      // the deep unknown one still on disk — the point being that nothing authed survives either way.
      expect(removed).toBe(3);
      expect(index.pages().some((p) => p.authState === "authed")).toBe(false);
      const stored = await store.get<{ pages: { authState: string }[] }>(`index:${ORIGIN}|ia_test`);
      expect(stored!.pages.some((p) => p.authState === "authed")).toBe(false);
    }
  });

  it("purges when the owner's site.json version changes", async () => {
    const store = new MemoryStore();
    const v1 = new SiteIndex({ origin: ORIGIN, ref: "ia_test", store, config: { ...DEFAULT_SITE_CONFIG, version: 1 } });
    v1.merge(mixed);
    await v1.save();

    const v2 = new SiteIndex({ origin: ORIGIN, ref: "ia_test", store, config: { ...DEFAULT_SITE_CONFIG, version: 2 } });
    const outcome = await v2.load();
    expect(outcome.purged).toBe(3);
    expect(v2.pages().map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/help`, `${ORIGIN}/maybe`]);
  });

  it("clear memory leaves nothing of this site behind", async () => {
    const store = new MemoryStore();
    const index = new SiteIndex({ origin: ORIGIN, ref: "ia_test", store, config: { ...DEFAULT_SITE_CONFIG } });
    index.merge(mixed);
    await index.save();
    await index.clearAll();
    expect(index.size()).toBe(0);
    expect(await store.keys(`index:${ORIGIN}`)).toEqual([]);
  });
});
