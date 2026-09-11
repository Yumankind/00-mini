// THE 1.5-SECOND QUESTION — §14.1's probe, and the four ways it can go wrong.
//
// Every assertion here is about a SENTENCE a person reads, because the probe's whole output is one:
// the card offers a different thing for "nothing is installed", "it is there but too old" and
// "Safari will not let this page reach localhost", and the last of those cannot be fixed by running
// anything. Getting the three confused is the failure this suite exists to stop.

import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_HEALTH_PATH,
  DEFAULT_COMPANION_BASE,
  NO_COMPANION_ROUTES_REASON,
  SAFARI_LOCALHOST_REASON,
  isDesktopSurface,
  probeCompanion,
  probeFailureReason,
} from "../src/companion/probe.js";

const HEALTH = { name: "Bruno's MacBook", engineFp: "a1b2c3d4e5f60718", version: "0.9.7", scopes: ["git", "fetch"] };

function answering(body: unknown, init: ResponseInit = {}): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, ...init })) as typeof globalThis.fetch;
}

describe("which surfaces are asked at all", () => {
  it("skips a phone entirely — coarse pointer AND a narrow window", async () => {
    const fetchFn = vi.fn();
    const phone = {
      matchMedia: () => ({ matches: true }),
      innerWidth: 390,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    };
    expect(isDesktopSurface(phone)).toBe(false);
    expect(await probeCompanion(DEFAULT_COMPANION_BASE, phone)).toEqual({ state: "not-a-desktop" });
    // Not one request: a probe to localhost from a phone is a wasted second and a console error.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still asks a touchscreen laptop — a coarse pointer on a wide window is a desktop", () => {
    expect(isDesktopSurface({ matchMedia: () => ({ matches: true }), innerWidth: 1440 })).toBe(true);
    expect(isDesktopSurface({ matchMedia: () => ({ matches: false }), innerWidth: 420 })).toBe(true);
  });

  it("asks where there is no matchMedia at all — a node host has nothing that says otherwise", () => {
    expect(isDesktopSurface({})).toBe(true);
    expect(
      isDesktopSurface({
        matchMedia: () => {
          throw new Error("no");
        },
        innerWidth: 300,
      }),
    ).toBe(true);
  });
});

describe("what the engine says", () => {
  it("reads the health row into `found`, with the name and the engine's fingerprint", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(HEALTH), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await probeCompanion("http://127.0.0.1:4600", { fetch: fetchFn });
    expect(calls).toEqual([`http://127.0.0.1:4600${COMPANION_HEALTH_PATH}`]);
    expect(result).toEqual({
      state: "found",
      name: "Bruno's MacBook",
      engineFp: "a1b2c3d4e5f60718",
      version: "0.9.7",
      scopes: ["git", "fetch"],
    });
  });

  it("takes the engine's other spelling of the same two fields", async () => {
    const result = await probeCompanion("x", {
      fetch: answering({ engineName: "Studio", fingerprint: "ff00" }),
    });
    expect(result).toMatchObject({ state: "found", name: "Studio", engineFp: "ff00" });
  });

  it("treats a 200 with no fingerprint as an engine that has no companion routes", async () => {
    expect(await probeCompanion("x", { fetch: answering({ ok: true }) })).toEqual({
      state: "unreachable",
      reason: NO_COMPANION_ROUTES_REASON,
    });
  });

  it("says UPDATE, not INSTALL, when the engine answers 404", async () => {
    // The one case where "run the install script" is the wrong advice: something IS listening.
    const fetchFn = (async () => new Response("", { status: 404 })) as typeof globalThis.fetch;
    expect(await probeCompanion("x", { fetch: fetchFn })).toEqual({
      state: "unreachable",
      reason: NO_COMPANION_ROUTES_REASON,
    });
  });

  it("names any other status rather than guessing at it", async () => {
    const fetchFn = (async () => new Response("", { status: 503 })) as typeof globalThis.fetch;
    expect(await probeCompanion("x", { fetch: fetchFn })).toEqual({
      state: "unreachable",
      reason: "the companion answered HTTP 503",
    });
  });

  it("answers `unreachable` where the browser cannot fetch at all", async () => {
    const real = globalThis.fetch;
    try {
      (globalThis as { fetch?: typeof fetch }).fetch = undefined;
      expect(await probeCompanion("x")).toEqual({
        state: "unreachable",
        reason: "this browser cannot make requests",
      });
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("why the probe failed", () => {
  it("names Safari's mixed-content rule on an https page, and offers the other road", () => {
    expect(probeFailureReason(new TypeError("Load failed"), { protocol: "https:" })).toBe(SAFARI_LOCALHOST_REASON);
    expect(SAFARI_LOCALHOST_REASON).toContain("relay road");
  });

  it("says `run 00d companion` for the same TypeError on an http page", () => {
    // Same exception, different page: on http there is no mixed-content rule to blame, so the
    // honest reading is that nothing is listening.
    expect(probeFailureReason(new TypeError("Failed to fetch"), { protocol: "http:" })).toContain("00d companion");
  });

  it("treats the 1.5-second timeout as nothing answering", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(probeFailureReason(abort, { protocol: "https:" })).toContain("00d companion");
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })));
      })) as unknown as typeof globalThis.fetch;
    const result = await probeCompanion("x", { fetch: hanging, timeoutMs: 5 });
    expect(result).toMatchObject({ state: "unreachable" });
    expect((result as { reason: string }).reason).toContain("00d companion");
  });
});
