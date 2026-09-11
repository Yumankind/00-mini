/**
 * A BRAIN THAT BRINGS ITS OWN TOOLS — `ModelInfo.supportsTools: false`, respected by the loop.
 *
 * The peer this exists for is the agent on the person's own Mac (`RemoteBrainProvider` in
 * `@00/agent-models`, docs/HANDOFF-infinite-agent.md §8.4): a whole agent with a shell, a filesystem
 * and a git of its own, reached over a relay that carries one string each way. Handing it this
 * browser's tool schemas invites it to call something that exists nowhere it can see, so the loop
 * withholds them — and says so under the answer, because "it did not use my tools" is a thing a
 * person should be told rather than left to work out from a shell that never opened.
 *
 * The default must not move: every "I do not know" answer still gets the tools.
 */
import { describe, expect, it } from "vitest";
import {
  OWN_TOOLS_FOOTER,
  createAgentRuntime,
  fullTools,
  providerOffersTools,
  type AgentEvent,
  type ModelProvider,
} from "../src/index.js";
import { FakeProvider } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

function harness(provider: ModelProvider) {
  const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief" });
  const runtime = createAgentRuntime({
    fs,
    providers: [provider],
    tools: fullTools({ now }),
    trust: "full",
    now,
    async askPermission() {
      return { allowed: true };
    },
  });
  const events: AgentEvent[] = [];
  runtime.on((e) => events.push(e));
  return { runtime, events };
}

describe("a provider that says it does not take tools", () => {
  it("is asked without them, and the transcript says whose tools ran", async () => {
    const mac = new FakeProvider("remote-mac", [{ text: "I read it on my Mac." }], { supportsTools: false });
    const { runtime, events } = harness(mac);

    const result = await runtime.run({ prompt: "what is in the folder?" });

    expect(result.text).toBe("I read it on my Mac.");
    // The tools EXIST — this is not a runtime built without them — they are simply not offered.
    expect(mac.requests[0].tools).toBeUndefined();
    expect(events.find((e) => e.type === "model_completed")).toMatchObject({ footer: OWN_TOOLS_FOOTER });
  });

  it("lets the provider's own footer stand when it wrote one", async () => {
    const mac = new FakeProvider("remote-mac", [{ text: "done", footer: "Answered by Claude Code on your Mac." }], {
      supportsTools: false,
    });
    const { runtime, events } = harness(mac);
    await runtime.run({ prompt: "hi" });
    expect(events.find((e) => e.type === "model_completed")).toMatchObject({
      footer: "Answered by Claude Code on your Mac.",
    });
  });

  it("asks its catalogue once per run, however many steps the run takes", async () => {
    const mac = new FakeProvider("remote-mac", [{ text: "one" }], { supportsTools: false });
    const { runtime } = harness(mac);
    await runtime.run({ prompt: "hi" });
    // One read for the class question, one for the tools question, one for the context budget —
    // each cached per run, and none of them per step.
    expect(mac.modelsCalls).toBeLessThanOrEqual(3);
  });
});

describe("everything else keeps the tools it always had", () => {
  it("offers the schemas to an ordinary provider, and says nothing about tools under the answer", async () => {
    const local = new FakeProvider("local", [{ text: "hello" }]);
    const { runtime, events } = harness(local);
    await runtime.run({ prompt: "hi" });

    expect((local.requests[0].tools ?? []).length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === "model_completed")).toMatchObject({ footer: undefined });
  });

  it("treats every kind of not-knowing as yes", async () => {
    expect(await providerOffersTools(new FakeProvider("empty", [], { emptyCatalog: true }))).toBe(true);
    expect(await providerOffersTools(new FakeProvider("broken", [], { modelsThrows: true }))).toBe(true);
    expect(await providerOffersTools(new FakeProvider("plain", []))).toBe(true);
    expect(await providerOffersTools(new FakeProvider("mac", [], { supportsTools: false }))).toBe(false);
  });
});
