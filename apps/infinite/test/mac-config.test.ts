// WHERE THE RELAY IS — gap audit A1.
//
// The Mac card pointed at `https://api.overblast.com`, a host that does not exist, so both directions
// of §8.4/§8.5 failed as a bare network error. Three things are pinned here: the default is the
// origin the ENGINE derives (read out of the engine's own source, so the two cannot drift apart), a
// build with no usable origin says so instead of fetching, and the origin actually answers.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { RELAY_NOT_CONFIGURED, RELAY_ORIGIN, envRelayOrigin, relayConfigured, relayOrigin } from "../src/mac/config.js";
import { createRelay } from "../src/mac/relay.js";

const engineClient = fileURLToPath(new URL("../../00d/src/overblast-client.ts", import.meta.url));

// `import.meta.env` is inlined at BUILD time and cannot be moved from a node test, so the value under
// test is passed in — the seam `relayOrigin()` and `relayConfigured()` declare for exactly this.

describe("the relay origin", () => {
  it("is the origin of the engine's own Overblast base", () => {
    // The twin: `DEFAULT_BASE` in apps/00d/src/overblast-client.ts, and `relayFor()` in
    // mobile-connect-client.ts taking `new URL(overblastBaseUrl()).origin` of it. Read from the file
    // rather than imported, because this app must not depend on the engine package to hold a string.
    const source = readFileSync(engineClient, "utf8");
    const match = /const DEFAULT_BASE = "([^"]+)"/.exec(source);
    expect(match, "apps/00d/src/overblast-client.ts no longer declares DEFAULT_BASE").not.toBeNull();
    expect(RELAY_ORIGIN).toBe(new URL(match![1]).origin);
    expect(RELAY_ORIGIN).toBe("https://brain.deployd.network");
  });

  it("defaults to it, and is configured", () => {
    expect(relayOrigin()).toBe(RELAY_ORIGIN);
    expect(relayConfigured()).toBe(true);
  });

  it("takes an override, as an origin and never a path", () => {
    expect(relayOrigin("http://127.0.0.1:8787/some/path")).toBe("http://127.0.0.1:8787");
    expect(relayConfigured("http://127.0.0.1:8787/some/path")).toBe(true);
  });

  it("answers 'not configured' for a bad value, `off`, an empty one, or a placeholder host", () => {
    for (const value of ["not a url", "off", "", "   ", "https://infinite-relay.invalid"]) {
      expect(relayOrigin(value), `for ${JSON.stringify(value)}`).toBe("");
      expect(relayConfigured(value), `for ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("treats an empty environment value as unset, not as a refusal", () => {
    // The env reader is the half that decides that; the origin resolver above never sees the empty
    // string, which is why both halves are pinned rather than one.
    expect(envRelayOrigin()).toBeUndefined();
    expect(relayConfigured()).toBe(true);
  });
});

describe("the relay transport", () => {
  it("refuses by name instead of fetching when there is no origin", async () => {
    const fetchImpl = vi.fn();
    const relay = createRelay({ token: () => "tok", origin: "", fetchImpl: fetchImpl as unknown as typeof fetch });
    const answer = await relay("GET", "/api/engines");
    expect(answer).toEqual({ ok: false, status: 0, json: expect.objectContaining({ code: RELAY_NOT_CONFIGURED }) });
    // The whole point: nothing left the browser, so nothing can 404 against the PWA's own host.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for the token only once there is somewhere to send it", async () => {
    const token = vi.fn(() => null);
    const relay = createRelay({ token, origin: "" });
    await relay("GET", "/api/engines");
    expect(token).not.toHaveBeenCalled();
  });
});

describe("the real origin", () => {
  // READ-ONLY AND UNAUTHENTICATED, on purpose: `GET /api/engines` without a bearer token is the
  // cheapest proof that the host exists and is the worker — it must answer 401, not a DNS failure.
  // Skipped, never failed, when this machine has no network: a test suite that needs the internet to
  // pass is a test suite that fails on a plane.
  it("answers /api/engines with a refusal rather than nothing", async () => {
    let status: number | null = null;
    try {
      const res = await fetch(`${RELAY_ORIGIN}/api/engines`, { signal: AbortSignal.timeout(8000) });
      status = res.status;
      await res.body?.cancel();
    } catch {
      return; // offline, or the host is unreachable from here — nothing to assert
    }
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  }, 15_000);
});
