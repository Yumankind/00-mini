import { describe, expect, it } from "vitest";
import { ProviderError, contextOverflowOf, isContextOverflow, providerErrorFromThrow } from "@00/agent-models";
import { createAgentRuntime, dropOlderTurns, fullTools, type AgentEvent } from "../src/index.js";
import { FakeProvider } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

/**
 * The window is the problem, not the brain (2026-09-11, reproduced live: MediaPipe answered
 * "input_size(5197) was not less than maxTokens(4096)" and the person saw the C++ trace). Two
 * promises: the trace never reaches anybody, and a conversation that has grown past the window gets
 * one more chance with its older turns dropped before the sentence is shown.
 */
const TRACE =
  'INVALID_ARGUMENT: CalculatorGraph::Run() failed: Calculator::Process() for node "LlmGpuCalculator" failed: Input is too long for the model to process: current_step(0) + input_size(5197) was not less than maxTokens(4096).';

function harness(provider: FakeProvider) {
  const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief" });
  const events: AgentEvent[] = [];
  const runtime = createAgentRuntime({
    fs,
    providers: [provider],
    tools: fullTools(),
    trust: "full",
    askPermission: async () => ({ allowed: true }),
  });
  runtime.on((e) => events.push(e));
  return { runtime, events };
}

describe("the error mapper reads an overflow", () => {
  it("turns MediaPipe's trace into context_overflow with the two numbers and a sentence a person can read", () => {
    const err = providerErrorFromThrow("local-litert", new Error(TRACE));
    expect(err.code).toBe("context_overflow");
    expect(err.message).toContain("5197");
    expect(err.message).toContain("4096");
    expect(err.message).not.toContain("CalculatorGraph");
    expect(contextOverflowOf(TRACE)).toEqual({ needed: 5197, window: 4096 });
  });
  it("recognises the cloud spellings without numbers, and a raw error a provider forgot to map", () => {
    expect(contextOverflowOf("This model's maximum context length is 8192 tokens.")).toEqual({});
    expect(isContextOverflow(new Error("prompt is too long"))).toBe(true);
    expect(isContextOverflow(new ProviderError({ status: 0, code: "network", message: "x" }))).toBe(false);
  });
});

describe("dropOlderTurns", () => {
  it("keeps the system turn and everything from the latest user turn on", () => {
    const m = [
      { role: "system", content: "s" },
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "user", content: "two" },
      { role: "tool", content: "r", toolCallId: "c" },
    ] as Parameters<typeof dropOlderTurns>[0];
    expect(dropOlderTurns(m)).toBe(2);
    expect(m.map((x) => x.content)).toEqual(["s", "two", "r"]);
    expect(dropOlderTurns(m)).toBe(0);
  });
});

describe("the loop and an overflow", () => {
  it("drops the older turns once, says so, and asks the same brain again", async () => {
    const provider = new FakeProvider("local", [{ text: "first answer" }, { throws: TRACE }, { text: "second answer" }]);
    const { runtime, events } = harness(provider);
    const first = await runtime.run({ prompt: "one" });
    expect(first.text).toBe("first answer");
    const second = await runtime.run({ prompt: "two", sessionId: first.sessionId });
    expect(second.stopped).toBe("final");
    expect(second.text).toBe("second answer");
    const trimmed = events.find((e) => e.type === "context_trimmed" && e.dropped.some((d) => d.startsWith("history")));
    expect(trimmed).toBeDefined();
    const retried = provider.requests.at(-1)!;
    expect(retried.messages.some((m) => m.content === "one")).toBe(false);
    expect(retried.messages.some((m) => m.content === "two")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
  it("shows the sentence, not the trace, when there is nothing left to drop", async () => {
    const provider = new FakeProvider("local", [{ throws: TRACE }]);
    const { runtime, events } = harness(provider);
    const result = await runtime.run({ prompt: "hello" });
    expect(result.stopped).toBe("error");
    const error = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(error.message).toContain("context window");
    expect(error.message).not.toContain("CalculatorGraph");
    expect(error.message).not.toMatch(/^model failed/);
  });
});
