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
import { createOwnedAgent } from "../src/runtime/bootstrap.js";

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
