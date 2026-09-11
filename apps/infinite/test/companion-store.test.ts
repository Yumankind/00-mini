// THE CARD'S FIVE STATES, AND THE TRANSITIONS BETWEEN THEM (§14.4).
//
// The store is what the card, the Git pane, the terminal and the network policy all read, so the
// thing worth pinning is not any one call but the WALK: nothing → probing → found → paired →
// (revoked elsewhere) → found again. Two of those steps only exist because a companion is a process
// a person starts and stops by hand, and a page that believed its own memory would offer Disconnect
// for a grant that is gone and Push for a road that is not there.
//
// `kv` writes into IndexedDB, which node has none of — `lib/kv.ts` answers `null` and swallows the
// write by design, so the persistence half is exercised here only as "it does not throw". What IS
// pinned is everything downstream of it.

import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "@00/agent-models";
import {
  companionBusy,
  companionDeviceFp,
  companionGitBlocked,
  companionGitRemote,
  companionHasScope,
  companionHidden,
  companionName,
  companionPaired,
  companionProblem,
  companionProxyTarget,
  companionScopes,
  companionStatus,
  configureCompanion,
  connect,
  disconnect,
  probeCompanionNow,
  resetCompanion,
  startCompanionWatch,
} from "../src/state/companion.js";

const HEALTH = { name: "Bruno's MacBook", engineFp: "a1b2c3d4e5f60718", version: "0.9.7" };

interface Fake {
  /** What `/health` answers. `null` throws, as a dead port does. */
  health: unknown | null;
  me: { status: number; body: unknown };
  pair: { status: number; body: unknown };
  calls: string[];
}

function wire(fake: Fake): void {
  configureCompanion({
    store: new MemoryDeviceKeyStore(),
    visible: () => true,
    matchMedia: () => ({ matches: false }),
    innerWidth: 1440,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fake.calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/health")) {
        if (fake.health === null) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(fake.health), { status: 200 });
      }
      if (url.includes("/me")) return new Response(JSON.stringify(fake.me.body), { status: fake.me.status });
      if (url.includes("/pair")) return new Response(JSON.stringify(fake.pair.body), { status: fake.pair.status });
      return new Response("", { status: 404 });
    }) as typeof globalThis.fetch,
  });
}

function fresh(overrides: Partial<Fake> = {}): Fake {
  return {
    health: HEALTH,
    me: { status: 401, body: { code: "unknown_device" } },
    pair: { status: 200, body: { fingerprint: "dev-fp", engineName: "Bruno's MacBook", scopes: ["git", "fetch"] } },
    calls: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetCompanion();
});

describe("the walk", () => {
  it("starts idle, finds an engine, and stays `found` until a code is entered", async () => {
    const fake = fresh();
    wire(fake);
    expect(companionStatus.value).toBe("idle");
    expect(await probeCompanionNow()).toBe("found");
    expect(companionName.value).toBe("Bruno's MacBook");
    expect(companionPaired.value).toBe(false);
    expect(companionScopes.value).toEqual([]);
    // With no record of a grant, `me` is never even asked: there is nothing to ask with.
    expect(fake.calls.filter((c) => c.includes("/me"))).toEqual([]);
  });

  it("pairs on a code and reports what the grant is worth", async () => {
    const fake = fresh();
    wire(fake);
    await probeCompanionNow();
    expect(await connect("amber lantern quiet fox river stone")).toBe(true);
    expect(companionStatus.value).toBe("paired");
    expect(companionPaired.value).toBe(true);
    expect(companionScopes.value).toEqual(["git", "fetch"]);
    expect(companionDeviceFp.value).toBe("dev-fp");
    expect(companionBusy.value).toBe(false);
  });

  it("keeps a refused code on the card as words, and stays unpaired", async () => {
    const fake = fresh({ pair: { status: 403, body: { code: "code_refused" } } });
    wire(fake);
    await probeCompanionNow();
    expect(await connect("wrong words here")).toBe(false);
    expect(companionStatus.value).toBe("found");
    expect(companionProblem.value).toMatch(/two minutes/);
  });

  it("refuses to pair before anything has been found", async () => {
    wire(fresh());
    expect(await connect("amber lantern quiet")).toBe(false);
    expect(companionProblem.value).toMatch(/no companion to pair with/);
  });

  it("hands the grant back on disconnect and drops the scopes", async () => {
    const fake = fresh();
    wire(fake);
    await probeCompanionNow();
    await connect("amber lantern quiet");
    await disconnect();
    expect(companionStatus.value).toBe("found");
    expect(companionScopes.value).toEqual([]);
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(true);
  });

  it("notices a grant revoked on the other side, and goes back to asking for a code", async () => {
    // The key is still in this browser and the engine is still there: only the signed `me` call can
    // say that the grant behind it is gone, and a card still offering Disconnect would be a lie.
    const fake = fresh({ me: { status: 200, body: { fingerprint: "dev-fp", engineName: "M", scopes: ["git"] } } });
    wire(fake);
    await probeCompanionNow();
    await connect("amber lantern quiet");
    expect(companionStatus.value).toBe("paired");

    // It stays paired while `me` keeps answering.
    expect(await probeCompanionNow()).toBe("paired");
    expect(companionScopes.value).toEqual(["git"]);

    fake.me = { status: 401, body: { code: "unknown_device" } };
    expect(await probeCompanionNow()).toBe("found");
    expect(companionScopes.value).toEqual([]);
    expect(companionGitRemote()).toBeNull();
  });

  it("a dead port is `unreachable` with the reason on the card", async () => {
    wire(fresh({ health: null }));
    expect(await probeCompanionNow()).toBe("unreachable");
    expect(companionProblem.value).toContain("00d companion");
    expect(companionHidden.value).toBe(false);
  });

  it("a phone is `not-a-desktop`, and the card is not drawn at all", async () => {
    configureCompanion({
      store: new MemoryDeviceKeyStore(),
      matchMedia: () => ({ matches: true }),
      innerWidth: 390,
      fetch: (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch,
    });
    expect(await probeCompanionNow()).toBe("not-a-desktop");
    expect(companionHidden.value).toBe(true);
    expect(companionGitBlocked()).toBe("Clone, push and pull need a computer running 00.");
  });
});

describe("what the rest of the app reads", () => {
  it("hands out no git road and no proxy until the grant carries the scope", async () => {
    const fake = fresh({ pair: { status: 200, body: { fingerprint: "d", engineName: "M", scopes: ["fetch"] } } });
    wire(fake);
    await probeCompanionNow();
    expect(companionGitRemote()).toBeNull();
    expect(await companionProxyTarget(new URL("https://example.com"))).toBeNull();

    await connect("amber lantern quiet");
    // `fetch` was granted and `git` was not — the two are separate answers, not one "paired".
    expect(companionHasScope("fetch")).toBe(true);
    expect(companionHasScope("git")).toBe(false);
    expect(companionGitRemote()).toBeNull();
    expect(companionGitBlocked()).toBe("this computer did not grant git.");
    const target = await companionProxyTarget(new URL("https://example.com/a"));
    expect(target?.url).toContain("/api/companion/fetch?url=https%3A%2F%2Fexample.com%2Fa");
    expect(target?.headers["x-00-dev"]).toHaveLength(16);
  });

  it("hands out the corsProxy and a signing client once `git` is granted", async () => {
    wire(fresh());
    await probeCompanionNow();
    await connect("amber lantern quiet");
    const road = companionGitRemote();
    expect(road?.corsProxy).toBe("http://127.0.0.1:4600/api/companion/git");
    expect(typeof road?.http.request).toBe("function");
    expect(companionGitBlocked()).toBeNull();
  });

  it("says which of the three reasons the remote buttons are off for", async () => {
    resetCompanion();
    expect(companionGitBlocked()).toMatch(/Connect this computer \(Connections/);
    wire(fresh());
    await probeCompanionNow();
    expect(companionGitBlocked()).toBe("Connect this computer in Connections → This computer.");
  });
});

describe("the watch", () => {
  it("probes once immediately and returns its own stopper", async () => {
    const fake = fresh();
    wire(fake);
    const stop = startCompanionWatch(50);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls.length).toBeGreaterThan(0);
    stop();
    const after = fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.calls.length).toBe(after);
  });

  it("polls nothing while the tab is hidden", async () => {
    const fake = fresh();
    wire(fake);
    configureCompanion({
      store: new MemoryDeviceKeyStore(),
      visible: () => false,
      matchMedia: () => ({ matches: false }),
      innerWidth: 1440,
      fetch: (async () => {
        fake.calls.push("GET /health");
        return new Response(JSON.stringify(HEALTH), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const stop = startCompanionWatch(20);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 90));
    // The immediate probe happened; the interval's did not.
    expect(fake.calls.length).toBe(first);
    stop();
  });
});
