import { describe, expect, it } from "vitest";
import { ProviderError, type ModelProvider } from "@00/agent-models";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_STEPS,
  EventRecorder,
  MAX_OUTPUT_CHARS,
  ModelRouter,
  PermissionManager,
  SYSTEM_PROMPT_SHARE,
  SeenFiles,
  ToolRegistry,
  contextTokensOf,
  createAgentRuntime,
  estimateTokens,
  fullTools,
  lightTools,
  parseSessionEntries,
  type AgentEvent,
  type AgentRuntimeOptionsExt,
  type PermissionDecision,
  type Tool,
} from "../src/index.js";
import { ChunkedProvider, FakeProvider, call, type ScriptedTurn } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

function harness(over: Partial<AgentRuntimeOptionsExt> & { script?: ScriptedTurn[] } = {}) {
  const fs = (over.fs as MemoryFs) ?? new MemoryFs({ "workspace/AGENTS.md": "be brief" });
  const provider = new FakeProvider("local", over.script ?? [{ text: "done" }]);
  const answers: PermissionDecision[] = [];
  const asked: { name: string; tier: string }[] = [];
  const seenFiles = new SeenFiles();
  const runtime = createAgentRuntime({
    fs,
    providers: [provider],
    tools: fullTools({ seen: seenFiles, now }),
    trust: "full",
    now,
    seenFiles,
    origin: "https://agent.example",
    async askPermission(req) {
      asked.push({ name: req.name, tier: req.tier });
      return answers.shift() ?? { allowed: true };
    },
    ...over,
  } as AgentRuntimeOptionsExt);
  const events: AgentEvent[] = [];
  runtime.on((e) => events.push(e));
  return { runtime, fs, provider, events, asked, answers, seenFiles };
}

describe("the loop", () => {
  it("answers in one step when the model uses no tools", async () => {
    const { runtime, events } = harness({ script: [{ text: "hello there", usage: { inputTokens: 5, outputTokens: 2 } }] });
    const result = await runtime.run({ prompt: "hi" });

    expect(result).toMatchObject({ text: "hello there", steps: 1, stopped: "final" });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    // The loop STREAMS (gap B11): the delta goes out while the answer is being written, and the
    // whole message closes it.
    expect(events.map((e) => e.type)).toEqual(["model_started", "agent_delta", "model_completed", "agent_message"]);
    expect(events.at(-1)).toMatchObject({ type: "agent_message", final: true });
  });

  it("runs a tool, feeds the result back and finishes on the next turn", async () => {
    const fs = new MemoryFs({ "workspace/README.md": "the contents" });
    const { runtime, events, provider } = harness({
      fs,
      script: [{ text: "looking", toolCalls: [call("read", { path: "README.md" })] }, { text: "it says: the contents" }],
    });
    const result = await runtime.run({ prompt: "what does the readme say?" });

    expect(result).toMatchObject({ steps: 2, stopped: "final", text: "it says: the contents" });
    expect(events.map((e) => e.type)).toEqual([
      "model_started",
      "agent_delta",
      "model_completed",
      "agent_message",
      "tool_started",
      "tool_completed",
      "model_started",
      "agent_delta",
      "model_completed",
      "agent_message",
    ]);
    // The tool result actually reached the second request.
    const second = provider.requests[1].messages;
    expect(second.at(-1)).toMatchObject({ role: "tool", content: "the contents", name: "read" });
  });

  it("runs several tool calls from ONE turn sequentially, in the emitted order", async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number): Tool => ({
      tier: "safe",
      schema: { name, description: name, parameters: { type: "object", properties: {} } },
      async run() {
        await new Promise((r) => setTimeout(r, ms));
        order.push(name);
        return { output: name };
      },
    });
    const { runtime } = harness({
      tools: [slow("slow", 20), slow("quick", 1)],
      script: [{ toolCalls: [call("slow"), call("quick")] }, { text: "done" }],
    });
    await runtime.run({ prompt: "both" });
    // Parallel execution would have put `quick` first.
    expect(order).toEqual(["slow", "quick"]);
  });

  it("stops at maxSteps and says so", async () => {
    const looping: ScriptedTurn[] = Array.from({ length: 10 }, () => ({ toolCalls: [call("ls")] }));
    const { runtime } = harness({ script: looping });
    const result = await runtime.run({ prompt: "loop", maxSteps: 3 });
    expect(result).toMatchObject({ steps: 3, stopped: "max_steps" });
  });

  it("defaults maxSteps to 40", () => {
    expect(DEFAULT_MAX_STEPS).toBe(40);
  });

  it("a tool failure is an observation: the loop keeps going and the model sees the error", async () => {
    const { runtime, events, provider } = harness({
      script: [{ toolCalls: [call("read", { path: "nope.md" })] }, { text: "that file is not there" }],
    });
    const result = await runtime.run({ prompt: "read nope" });
    expect(result).toMatchObject({ stopped: "final", text: "that file is not there" });
    expect(provider.requests[1].messages.at(-1)!.content).toContain("File not found");
    expect(events.some((e) => e.type === "tool_completed")).toBe(true);
  });

  it("a THROWN tool becomes tool_failed and still feeds the model", async () => {
    const { runtime, events, provider } = harness({
      script: [{ toolCalls: [call("read", { path: "../vault.json" })] }, { text: "cannot reach that" }],
    });
    await runtime.run({ prompt: "escape" });
    expect(events.filter((e) => e.type === "tool_failed")).toHaveLength(1);
    expect(provider.requests[1].messages.at(-1)!.content).toContain("outside this agent's sandbox");
  });

  it("an unknown tool name is answered with the list of real ones", async () => {
    const { runtime, provider } = harness({
      script: [{ toolCalls: [call("teleport")] }, { text: "no such thing" }],
    });
    await runtime.run({ prompt: "x" });
    expect(provider.requests[1].messages.at(-1)!.content).toContain('No tool named "teleport"');
  });

  it("a MODEL failure ends the run with `error`", async () => {
    const { runtime, events } = harness({ script: [{ throws: "network down" }] });
    const result = await runtime.run({ prompt: "hi" });
    expect(result.stopped).toBe("error");
    expect(events.at(-1)).toMatchObject({ type: "error", message: "model failed: network down" });
  });

  it("truncates a huge tool result and says how to narrow it", async () => {
    const big: Tool = {
      tier: "safe",
      schema: { name: "flood", description: "flood", parameters: { type: "object", properties: {} } },
      async run() {
        return { output: "x".repeat(MAX_OUTPUT_CHARS + 5000) };
      },
    };
    const { runtime, provider } = harness({
      tools: [big],
      script: [{ toolCalls: [call("flood")] }, { text: "ok" }],
    });
    await runtime.run({ prompt: "flood me" });
    const observed = provider.requests[1].messages.at(-1)!.content;
    expect(observed).toContain("[Output truncated:");
    expect(observed.length).toBeLessThan(MAX_OUTPUT_CHARS + 500);
  });

  it("honours a per-run tool subset", async () => {
    const { runtime, provider } = harness({ script: [{ text: "ok" }] });
    await runtime.run({ prompt: "x", tools: ["read", "ls", "not-a-tool"] });
    expect(provider.requests[0].tools?.map((t) => t.name)).toEqual(["read", "ls"]);
  });
});

describe("permissions in the loop", () => {
  it("never asks about a safe tool and always asks about a confirm one", async () => {
    const { runtime, asked, events } = harness({
      script: [{ toolCalls: [call("ls")] }, { toolCalls: [call("write", { path: "a.md", content: "x" })] }, { text: "done" }],
    });
    await runtime.run({ prompt: "make a file" });
    expect(asked).toEqual([{ name: "write", tier: "confirm" }]);
    expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(1);
    expect(events.filter((e) => e.type === "permission_answered")).toHaveLength(1);
  });

  it("a refusal blocks the tool and tells the model not to retry", async () => {
    const fs = new MemoryFs();
    const h = harness({
      fs,
      script: [{ toolCalls: [call("write", { path: "a.md", content: "x" })] }, { text: "they said no" }],
    });
    h.answers.push({ allowed: false });
    const result = await h.runtime.run({ prompt: "write a file" });

    expect(fs.readSync("workspace/a.md")).toBeUndefined();
    expect(h.events.some((e) => e.type === "tool_started")).toBe(false);
    expect(h.provider.requests[1].messages.at(-1)!.content).toContain("Do not retry");
    expect(result.text).toBe("they said no");
  });

  it('an "always" answer is not asked again — in this run or the next one', async () => {
    const fs = new MemoryFs();
    const permissions = new PermissionManager(fs, { now: () => 1 });
    const h = harness({
      fs,
      permissions,
      script: [{ toolCalls: [call("write", { path: "a.md", content: "1" })] }, { text: "one" }],
    });
    h.answers.push({ allowed: true, remember: "always" });
    await h.runtime.run({ prompt: "first" });
    expect(h.asked).toHaveLength(1);

    h.provider.say([{ toolCalls: [call("write", { path: "b.md", content: "2" })] }, { text: "two" }]);
    await h.runtime.run({ prompt: "second" });
    expect(h.asked).toHaveLength(1); // still one: the standing answer covered it
    expect(fs.readSync("workspace/b.md")).toBe("2");
  });
});

describe("abort", () => {
  it("stops mid-tool when the runtime is aborted", async () => {
    let started = false;
    let sawAbort = false;
    const waits: Tool = {
      tier: "safe",
      schema: { name: "waits", description: "waits", parameters: { type: "object", properties: {} } },
      async run(_args, ctx) {
        started = true;
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        sawAbort = ctx.signal.aborted;
        return { output: "interrupted" };
      },
    };
    const { runtime } = harness({
      tools: [waits],
      script: [{ toolCalls: [call("waits")] }, { text: "never reached" }],
    });
    const running = runtime.run({ prompt: "go" });
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    runtime.abort();

    const result = await running;
    expect(sawAbort).toBe(true);
    expect(result.stopped).toBe("aborted");
    expect(result.text).toBe("");
  });

  it("honours a signal handed in with the run, including one already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtime, provider } = harness({ script: [{ text: "should not run" }] });
    const result = await runtime.run({ prompt: "x", signal: controller.signal });
    expect(result.stopped).toBe("aborted");
    expect(provider.requests).toHaveLength(0);
  });

  it("aborting between runs is harmless", async () => {
    const { runtime } = harness();
    expect(() => runtime.abort()).not.toThrow();
    expect((await runtime.run({ prompt: "hi" })).stopped).toBe("final");
  });
});

describe("sessions through the runtime", () => {
  it("writes the turn to sessions/ and lists it by its first user line", async () => {
    const fs = new MemoryFs();
    const { runtime } = harness({ fs, script: [{ toolCalls: [call("ls")] }, { text: "one folder" }] });
    const result = await runtime.run({ prompt: "what is in here?" });

    const file = fs.paths().find((p) => p.startsWith("sessions/"))!;
    expect(file).toMatch(/^sessions\/2026-09-10T10-00-00-000Z_[0-9a-f-]+\.jsonl$/);
    const kinds = parseSessionEntries(fs.readSync(file)!).map((e) =>
      e.type === "session" ? "session" : (e as { message: { role: string } }).message.role,
    );
    expect(kinds).toEqual(["session", "user", "assistant", "toolResult", "assistant"]);

    expect(await runtime.listSessions()).toEqual([
      { id: result.sessionId, title: "what is in here?", updatedAt: expect.any(Number) },
    ]);
    expect((await runtime.loadSession(result.sessionId)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("resuming by sessionId continues the same file and replays the history to the model", async () => {
    const fs = new MemoryFs();
    const h = harness({ fs, script: [{ text: "first answer" }] });
    const first = await h.runtime.run({ prompt: "first question" });

    h.provider.say([{ text: "second answer" }]);
    const second = await h.runtime.run({ prompt: "second question", sessionId: first.sessionId });

    expect(second.sessionId).toBe(first.sessionId);
    expect(fs.paths().filter((p) => p.startsWith("sessions/"))).toHaveLength(1);
    expect(h.provider.requests[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      expect.stringContaining("system:"),
      "user:first question",
      "assistant:first answer",
      "user:second question",
    ]);
  });

  it("a NEW session clears the read-before-overwrite guard; resuming keeps it", async () => {
    const fs = new MemoryFs({ "workspace/NOTES.md": "old" });
    const h = harness({ fs, script: [{ toolCalls: [call("read", { path: "NOTES.md" })] }, { text: "read it" }] });
    const first = await h.runtime.run({ prompt: "read the notes" });

    // Resuming: the file counts as read, so the write goes through.
    h.provider.say([{ toolCalls: [call("write", { path: "NOTES.md", content: "new" })] }, { text: "written" }]);
    await h.runtime.run({ prompt: "now change it", sessionId: first.sessionId });
    expect(fs.readSync("workspace/NOTES.md")).toBe("new");

    // A fresh session forgets, and the guard refuses.
    h.provider.say([{ toolCalls: [call("write", { path: "NOTES.md", content: "newer" })] }, { text: "refused" }]);
    await h.runtime.run({ prompt: "change it again" });
    expect(fs.readSync("workspace/NOTES.md")).toBe("new");
  });
});

describe("the light agent through the runtime", () => {
  it("gets the light prompt, its own sandbox and only the allowlisted tools", async () => {
    const fs = new MemoryFs({
      "workspace/MEMORY.md": "PRIVATE-MEMORY",
      "workspace/public/PERSONA.md": "I am the front desk.",
      "threads-fs/web/42/conversation.md": "visitor: hello",
    });
    const provider = new FakeProvider("local", [
      { toolCalls: [call("read_public", { path: "PERSONA.md" })] },
      { text: "I am the front desk." },
    ]);
    const runtime = createAgentRuntime({
      fs,
      providers: [provider],
      tools: lightTools(),
      trust: "light",
      now,
      origin: "https://someones-site.example",
      context: { light: { channel: "this website", from: "a visitor" } },
      async askPermission() {
        throw new Error("a light agent must never need a confirmation");
      },
      sessions: undefined,
    } as AgentRuntimeOptionsExt);

    const result = await runtime.run({ prompt: "who are you?", workspace: "threads-fs/web/42" });
    expect(result.stopped).toBe("final");

    const system = provider.requests[0].messages[0].content;
    expect(system).toContain("# Untrusted inbound conversation");
    expect(system).not.toContain("PRIVATE-MEMORY");
    expect(provider.requests[0].tools?.map((t) => t.name)).toEqual(["read", "ls", "grep", "find", "read_public"]);
  });

  it("cannot read the operator's private workspace even when the model tries", async () => {
    const fs = new MemoryFs({ "workspace/MEMORY.md": "PRIVATE-MEMORY", "threads-fs/web/42/conversation.md": "hi" });
    const provider = new FakeProvider("local", [
      { toolCalls: [call("read", { path: "../../workspace/MEMORY.md" })] },
      { text: "I cannot see that." },
    ]);
    const runtime = createAgentRuntime({
      fs,
      providers: [provider],
      tools: lightTools(),
      trust: "light",
      now,
      async askPermission() {
        return { allowed: true };
      },
    } as AgentRuntimeOptionsExt);
    await runtime.run({ prompt: "read the memory", workspace: "threads-fs/web/42" });
    const observed = provider.requests[1].messages.at(-1)!.content;
    expect(observed).toContain("outside this agent's sandbox");
    expect(observed).not.toContain("PRIVATE-MEMORY");
  });
});

describe("wiring", () => {
  it("`on` returns an unsubscribe", async () => {
    const { runtime } = harness();
    const seen: AgentEvent[] = [];
    const off = runtime.on((e) => seen.push(e));
    await runtime.run({ prompt: "one" });
    const after = seen.length;
    off();
    await runtime.run({ prompt: "two" });
    expect(seen).toHaveLength(after);
  });

  it("a recorder can replay a whole run for a test or a bug report", async () => {
    const { runtime } = harness({ script: [{ toolCalls: [call("ls")] }, { text: "done" }] });
    const recorder = new EventRecorder();
    // The recorder listens through the same `on` the UI uses.
    runtime.on((e) => recorder.timeline().push({ at: 0, event: e }));
    const replayed: string[] = [];
    runtime.on((e) => replayed.push(e.type));
    await runtime.run({ prompt: "x" });
    expect(replayed).toContain("tool_completed");
  });

  it("names a model by provider id, and refuses one it does not have", async () => {
    const { runtime, provider } = harness({ script: [{ text: "ok" }] });
    await runtime.run({ prompt: "x", model: "local/qwen-1.5b" });
    expect(provider.requests[0].model).toBe("qwen-1.5b");
    await expect(runtime.run({ prompt: "x", model: "anthropic" })).rejects.toThrow(/no model provider "anthropic"/);
  });

  it("reports the provider that answered, and the footer it attached", async () => {
    const { runtime, events } = harness({ script: [{ text: "sponsored answer", footer: "answered thanks to ACME" }] });
    await runtime.run({ prompt: "x" });
    expect(events[0]).toMatchObject({ type: "model_started", providerId: "local" });
    expect(events.find((e) => e.type === "model_completed")).toMatchObject({
      type: "model_completed",
      providerId: "local",
      footer: "answered thanks to ACME",
    });
  });

  it("sums usage across steps, cents included", async () => {
    const { runtime } = harness({
      script: [
        { toolCalls: [call("ls")], usage: { inputTokens: 100, outputTokens: 10, costCents: 3 } },
        { text: "done", usage: { inputTokens: 150, outputTokens: 20, costCents: 4 } },
      ],
    });
    const result = await runtime.run({ prompt: "x" });
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 30, costCents: 7 });
  });
});

describe("ToolRegistry and ModelRouter", () => {
  it("refuses a second tool under an existing name — the name is the contract", () => {
    const registry = new ToolRegistry(fullTools());
    expect(() => registry.register(fullTools()[0])).toThrow(/already registered/);
    expect(registry.has("read")).toBe(true);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("auto picks the first READY provider, in the caller's order", async () => {
    const notReady = new FakeProvider("local", [], { ready: false, reason: "download" });
    const ready = new FakeProvider("sponsored", []);
    expect((await new ModelRouter([notReady, ready]).pick()).provider.id).toBe("sponsored");
    expect((await new ModelRouter([notReady, ready]).pick("auto")).provider.id).toBe("sponsored");
  });

  it("falls back to the first provider when nothing is ready, so the failure carries its own words", async () => {
    const a = new FakeProvider("local", [], { ready: false, reason: "download" });
    const b = new FakeProvider("byok:openai", [], { ready: false, reason: "credential" });
    expect((await new ModelRouter([a, b]).pick()).provider.id).toBe("local");
  });

  it("needs at least one provider", () => {
    expect(() => new ModelRouter([])).toThrow(/at least one ModelProvider/);
  });
});

// ── The contract revision of 2026-09-10 ─────────────────────────────────────────────────────────

describe("setProviders", () => {
  it("hands the loop a new brain without rebuilding it — and the listeners never notice", async () => {
    const { runtime, events } = harness({ script: [{ text: "from local" }] });
    await runtime.run({ prompt: "one" });

    const other = new FakeProvider("byok:openai", [{ text: "from your key" }]);
    runtime.setProviders([other]);
    const second = await runtime.run({ prompt: "two" });

    expect(second.text).toBe("from your key");
    expect(second.providerId).toBe("byok:openai");
    // One subscription, taken before the swap, saw both runs.
    expect(events.filter((e) => e.type === "model_started").map((e) => (e as { providerId: string }).providerId)).toEqual([
      "local",
      "byok:openai",
    ]);
  });

  it("leaves a run in flight on the brain it started with", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new FakeProvider("local", [{ toolCalls: [call("ls")], delay: gate }, { text: "still local" }]);
    const { runtime } = harness({ providers: [first] });
    const running = runtime.run({ prompt: "go" });

    runtime.setProviders([new FakeProvider("sponsored", [{ text: "from sponsored" }])]);
    release();
    const result = await running;

    // Two turns, both answered by the provider the run began with: a turn planned by one model and
    // finished by another is a corrupted turn, not a fallback.
    expect(result).toMatchObject({ text: "still local", providerId: "local", steps: 2 });
    expect(first.requests).toHaveLength(2);
  });

  it("refuses an empty list, where the caller can see it", () => {
    const { runtime } = harness();
    expect(() => runtime.setProviders([])).toThrow(/at least one ModelProvider/);
  });
});

describe("the run's receipt", () => {
  it("names the provider and the model that answered", async () => {
    const { runtime } = harness({ script: [{ text: "done" }] });
    const result = await runtime.run({ prompt: "x", model: "local/some-model" });
    expect(result).toMatchObject({ providerId: "local", model: "some-model" });
  });

  it("has no provider when the run was aborted before a model was reached", async () => {
    const { runtime } = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.run({ prompt: "x", signal: controller.signal });
    expect(result.stopped).toBe("aborted");
    expect(result.providerId).toBeUndefined();
  });
});

describe("agent_message and agent_delta", () => {
  it("emits the deltas as they arrive and then ONE whole message per assistant turn", async () => {
    const { runtime, events } = harness({
      script: [{ text: "looking", toolCalls: [call("ls")] }, { text: "here it is" }],
    });
    await runtime.run({ prompt: "x" });
    const messages = events.filter((e) => e.type === "agent_message") as { text: string; final: boolean }[];
    expect(messages).toEqual([
      { type: "agent_message", text: "looking", final: true },
      { type: "agent_message", text: "here it is", final: true },
    ]);
    // This test used to assert the opposite ("the loop buffers, so it says nothing"). The loop now
    // takes `stream()` (gap B11), so each message arrives twice by design: in pieces, then whole. A
    // consumer REPLACES its accumulation with the whole one rather than appending it.
    const deltas = events.filter((e) => e.type === "agent_delta") as { text: string }[];
    expect(deltas.map((d) => d.text)).toEqual(["looking", "here it is"]);
    const order = events.map((e) => e.type);
    expect(order.indexOf("agent_delta")).toBeLessThan(order.indexOf("agent_message"));
  });

  it("streams a multi-chunk answer in pieces and closes it with the joined whole", async () => {
    const chunked = new ChunkedProvider("local", [["Hel", "lo ", "there"]]);
    const { runtime, events } = harness({ providers: [chunked] });
    const result = await runtime.run({ prompt: "hi" });

    expect((events.filter((e) => e.type === "agent_delta") as { text: string }[]).map((d) => d.text)).toEqual([
      "Hel",
      "lo ",
      "there",
    ]);
    expect(events.at(-1)).toEqual({ type: "agent_message", text: "Hello there", final: true });
    expect(result.text).toBe("Hello there");
  });

  it("assembles tool calls out of the stream, not out of the closing response", async () => {
    const chunked = new ChunkedProvider("local", [
      ["one moment"],
      ["done"],
    ]);
    chunked.callsOnTurn(0, [call("ls")]);
    const { runtime, provider } = harness({ providers: [chunked] });
    const result = await runtime.run({ prompt: "list it" });
    expect(result.steps).toBe(2);
    expect(chunked.requests[1].messages.at(-1)).toMatchObject({ role: "tool", name: "ls" });
    expect(provider.requests).toHaveLength(0); // the harness's own provider was not used
  });

  it("falls back to chat() for a provider that has no stream at all", async () => {
    const noStream = new FakeProvider("legacy", [{ text: "buffered" }]);
    // A provider written against an older copy of the interface, or a façade that never had one.
    (noStream as { stream?: unknown }).stream = undefined;
    const { runtime, events } = harness({ providers: [noStream] });
    const result = await runtime.run({ prompt: "hi" });
    expect(result.text).toBe("buffered");
    expect(events.some((e) => e.type === "agent_delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "agent_message", text: "buffered" });
  });
});

// ── The context budget (2026-09-11) ─────────────────────────────────────────────────────────────

/**
 * The loop is the only place that holds BOTH the prompt it is about to build and the brain that is
 * about to read it, which is why the budget is derived here. What is tested is the wiring: the row
 * that is read, the share that is handed over, the event that reports what it cost, and the fact
 * that a run which never switches brains still builds its prompt exactly once.
 */
describe("fitting the prompt to the brain that will read it", () => {
  /** An agent big enough that a 4096-token row cannot hold its prompt, and an 8192-token one can. */
  function bigAgent(): MemoryFs {
    const seed: Record<string, string> = {
      "workspace/AGENTS.md": "be brief",
      "workspace/IDENTITY.md": "Name: Ada",
      "workspace/USER.md": `USER-HEAD${"u".repeat(6000)}USER-TAIL`,
      "workspace/TOOLS.md": "NOTES-ABOUT-TOOLS",
    };
    for (let i = 0; i < 9; i++) seed[`workspace/projects/site/page${i}.html`] = "x";
    return new MemoryFs(seed);
  }

  it("reads the picked row's contextTokens and gives the system prompt 45% of it", async () => {
    const narrow = new FakeProvider("local", [{ text: "ok" }], { contextTokens: 4096 });
    const { runtime, events } = harness({ fs: bigAgent(), providers: [narrow] });
    await runtime.run({ prompt: "hi" });

    const trimmed = events.filter((e) => e.type === "context_trimmed");
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toMatchObject({ budgetTokens: Math.floor(4096 * SYSTEM_PROMPT_SHARE) });
    expect((trimmed[0] as { dropped: string[] }).dropped[0]).toBe("tree-children");
    const system = String(narrow.requests[0].messages[0].content);
    expect(estimateTokens(system)).toBeLessThanOrEqual(Math.floor(4096 * SYSTEM_PROMPT_SHARE));
    // The receipt belongs to the brain that caused it: `model_started` comes first.
    expect(events.findIndex((e) => e.type === "model_started")).toBeLessThan(events.findIndex((e) => e.type === "context_trimmed"));
  });

  it("drops NOTHING, and says nothing, when the brain has the room", async () => {
    const wide = new FakeProvider("cloud", [{ text: "ok" }], { contextTokens: 131072 });
    const { runtime, events } = harness({ fs: bigAgent(), providers: [wide] });
    await runtime.run({ prompt: "hi" });
    expect(events.some((e) => e.type === "context_trimmed")).toBe(false);
    expect(String(wide.requests[0].messages[0].content)).toContain("USER-TAIL");
  });

  it("treats a catalogue that declares no context as the generous default", async () => {
    // Every cloud peer in @00/agent-models is this shape, and they are the ones with the room.
    const quiet = new FakeProvider("cloud", [{ text: "ok" }]);
    const { runtime, events } = harness({ fs: bigAgent(), providers: [quiet] });
    await runtime.run({ prompt: "hi" });
    expect(await contextTokensOf(quiet)).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(events.some((e) => e.type === "context_trimmed")).toBe(false);
  });

  it("builds the prompt ONCE for a run that keeps the same brain, however many steps it takes", async () => {
    const narrow = new FakeProvider("local", [{ toolCalls: [call("ls", { path: "." })] }, { text: "done" }], {
      contextTokens: 4096,
    });
    const { runtime, events } = harness({ fs: bigAgent(), providers: [narrow] });
    await runtime.run({ prompt: "hi" });
    expect(narrow.requests).toHaveLength(2);
    // Same system turn on both calls, and ONE trim event rather than one per step.
    expect(narrow.requests[1].messages[0].content).toBe(narrow.requests[0].messages[0].content);
    expect(events.filter((e) => e.type === "context_trimmed")).toHaveLength(1);
  });

  it("re-fits when a dead credential falls through to a narrower brain", async () => {
    const dead = new FakeProvider("cloud", [{ throws: "unauthorized" }], { contextTokens: 131072 });
    (dead as unknown as { chat: unknown }).chat = async () => {
      throw new ProviderError({ status: 401, code: "credential", message: "key is dead", providerId: "cloud" });
    };
    const local = new FakeProvider("local", [{ text: "I have it" }], { contextTokens: 4096 });
    const { runtime, events } = harness({ fs: bigAgent(), providers: [dead, local] });
    const result = await runtime.run({ prompt: "hi" });

    expect(result.providerId).toBe("local");
    // The wide brain was asked WITHOUT a trim; the narrow one that answered got a fitted prompt.
    const trimmed = events.filter((e) => e.type === "context_trimmed");
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toMatchObject({ budgetTokens: Math.floor(4096 * SYSTEM_PROMPT_SHARE) });
    expect(estimateTokens(String(local.requests[0].messages[0].content))).toBeLessThanOrEqual(Math.floor(4096 * SYSTEM_PROMPT_SHARE));
  });
});

describe("which row's context is read", () => {
  /** A provider fixed to one model, the shape both local brains have. */
  function fixed(modelId: string, rows: { id: string; contextTokens?: number }[]): ModelProvider {
    return {
      id: "local",
      modelId,
      async models() {
        return rows.map((row) => ({ label: row.id, class: "small" as const, local: true, supportsTools: true, ...row }));
      },
      async readiness() {
        return { ready: true as const };
      },
      async chat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
      async *stream() {
        /* never asked */
      },
    } as unknown as ModelProvider;
  }

  it("takes the row the spec named", async () => {
    const provider = fixed("a", [{ id: "a", contextTokens: 2048 }, { id: "b", contextTokens: 8192 }]);
    expect(await contextTokensOf(provider, "b")).toBe(8192);
  });

  it("takes the row the provider itself is loaded with", async () => {
    const provider = fixed("b", [{ id: "a", contextTokens: 2048 }, { id: "b", contextTokens: 8192 }]);
    expect(await contextTokensOf(provider)).toBe(8192);
  });

  it("takes the NARROWEST declared row when it cannot tell which one will answer", async () => {
    // If we do not know which row answers, the prompt has to fit the one that could hold the least.
    const provider = fixed("unknown-to-the-catalogue", [{ id: "a", contextTokens: 8192 }, { id: "b", contextTokens: 2048 }]);
    expect(await contextTokensOf(provider)).toBe(2048);
  });

  it("falls back to the default for a row with no number, and for a catalogue that throws", async () => {
    expect(await contextTokensOf(fixed("a", [{ id: "a" }]))).toBe(DEFAULT_CONTEXT_TOKENS);
    const angry = { id: "x", async models() { throw new Error("no catalogue"); } } as unknown as ModelProvider;
    expect(await contextTokensOf(angry)).toBe(DEFAULT_CONTEXT_TOKENS);
  });
});
