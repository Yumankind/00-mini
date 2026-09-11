// THE WIRING FOR WHAT IS BEING BUILT IN PARALLEL — gap audit B7, B8, B12, B14, and A5's honest prompt.
//
// `createOwnedAgent` joins five capabilities other builders own: git operations (`createGitOps` in
// @00/agent-fs), the offline workspace index (`createWorkspaceIndex`), a real shell
// (`createBrowserShell` in this app's `src/power/`), the vault as `SecretsAccess`, and the network
// allow-list. They land at different times, so what this suite holds is the contract between "not
// there yet" and "there": the boot SUCCEEDS either way, and whatever is missing is NAMED in
// `agent.stubs` rather than silently absent — the day an export appears, the stub disappears and the
// capability is wired with no further edit.
//
// It boots the real thing (MemoryFs, because node has no OPFS and the bootstrap falls back to it by
// design), so it is also the only test that proves the whole construction still runs at all.

import { describe, expect, it } from "vitest";
import { companionOrSiteProxy, createOwnedAgent, proxyUrlFor } from "../src/runtime/bootstrap.js";
import {
  configureCompanion,
  connect,
  probeCompanionNow,
  resetCompanion,
} from "../src/state/companion.js";
import { MemoryDeviceKeyStore } from "@00/agent-models";

async function boot(): Promise<Awaited<ReturnType<typeof createOwnedAgent>>> {
  return createOwnedAgent({
    onStep: () => undefined,
    askPermission: async () => ({ allowed: false }),
    identity: { displayName: "Zero", emoji: "🟢" },
  });
}

describe("the boot", () => {
  it("comes up in a browser that has neither OPFS nor any of the parallel exports", async () => {
    const agent = await boot();
    expect(agent.profile.displayName).toBe("Zero");
    expect(agent.runtime).toBeTruthy();
    // The fallback is a decision, not an accident: an agent that lives only until the tab closes is
    // still an agent, and the shell says so from this same list.
    expect(agent.stubs.join(" ")).toContain("MemoryFs");
  });

  it("says nothing about the capabilities that HAVE landed", async () => {
    // Both of these were missing when this wiring was written and were exported the same day:
    // `createGitOps` in @00/agent-fs and `createBrowserShell` in src/power. A stub for either now
    // would mean the lookup went looking under the wrong name — which is the failure this whole
    // guarded style is exposed to, and the reason it is asserted rather than assumed.
    const said = (await boot()).stubs.join("\n");
    expect(said).not.toMatch(/git tools/);
    expect(said).not.toMatch(/bash answers 127/);
  });

  it("says nothing about a capability at all: every one of them landed", async () => {
    // The list is the record of what is NOT here. As of the end of this work it holds one line, and
    // that line is about this browser's storage, not about a missing module.
    const stubs = (await boot()).stubs;
    expect(stubs.filter((line) => !line.startsWith("MemoryFs"))).toEqual([]);
  });

  it("keeps the search index on the agent, so the no-brain pane and the tool share one", async () => {
    // §4.1 promises retrieval with no model at all (B14). Two indexes over the same files would be
    // two walks of OPFS and two answers to the same question.
    const agent = await boot();
    expect(agent.workspaceIndex).not.toBeNull();
    expect(typeof agent.workspaceIndex?.search).toBe("function");
  });

  it("wires the vault as `SecretsAccess`, and a locked vault answers null rather than throwing", async () => {
    // §4.5 / B12. The adapter is the wiring: a fresh agent has no vault, so `get` must resolve — a
    // throw here is a run that ends instead of a tool that is told the key is sealed.
    const agent = await boot();
    expect(await agent.vault.list().catch(() => null)).toEqual([]);
    expect(agent.vault.unlocked).toBe(false);
  });
});

describe("the read-only proxy the network policy hands the tools", () => {
  it("points at this origin's own /~fetch and carries the whole URL, encoded", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "https://0-0.chat" },
    });
    expect(proxyUrlFor(new URL("https://example.com/a?b=c#d"))).toBe(
      "https://0-0.chat/~fetch?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%23d",
    );
  });

  it("is `null` where there is no page — a node host, or a sandboxed frame with no origin", () => {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "null" } });
    expect(proxyUrlFor(new URL("https://example.com/"))).toBeNull();
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "" } });
    expect(proxyUrlFor(new URL("https://example.com/"))).toBeNull();
    Reflect.deleteProperty(globalThis, "location");
    expect(proxyUrlFor(new URL("https://example.com/"))).toBeNull();
  });
});

describe("the two roads a blocked fetch can take (§14.3's `fetch` scope)", () => {
  function page(origin: string): void {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
  }

  it("is the site's own proxy while no computer is connected", async () => {
    resetCompanion();
    page("https://0-0.chat");
    expect(await companionOrSiteProxy(new URL("https://example.com/a"))).toBe(
      "https://0-0.chat/~fetch?url=https%3A%2F%2Fexample.com%2Fa",
    );
  });

  it("becomes the companion, with its signature, the moment one is paired", async () => {
    // The companion is strictly the better road: the site's Worker can reach public hosts, and the
    // person's own computer can reach the box on their desk.
    resetCompanion();
    page("https://0-0.chat");
    configureCompanion({
      store: new MemoryDeviceKeyStore(),
      matchMedia: () => ({ matches: false }),
      innerWidth: 1440,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/health")) return new Response(JSON.stringify({ name: "Mac", engineFp: "ff11" }), { status: 200 });
        return new Response(JSON.stringify({ fingerprint: "d", engineName: "Mac", scopes: ["git", "fetch"] }), {
          status: 200,
        });
      }) as typeof globalThis.fetch,
    });
    await probeCompanionNow();
    await connect("amber lantern quiet");

    const target = await companionOrSiteProxy(new URL("http://192.168.1.9/status"));
    expect(typeof target).toBe("object");
    expect((target as { url: string }).url).toBe(
      "http://127.0.0.1:4600/api/companion/fetch?url=http%3A%2F%2F192.168.1.9%2Fstatus",
    );
    expect((target as { headers: Record<string, string> }).headers["x-00-sig"]).toBeTruthy();
    resetCompanion();
  });
});
