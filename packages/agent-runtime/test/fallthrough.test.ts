// A dead credential must not end a run (gap B16) — and a live stream must not be abandoned halfway.
//
// The two halves of one rule, and the tests are written as the pair they are: switch BEFORE the
// first token, never after it.

import { describe, expect, it } from "vitest";
import { ProviderError } from "@00/agent-models";
import { createAgentRuntime, fullTools, type AgentEvent, type AgentRuntimeOptionsExt } from "../src/index.js";
import { ChunkedProvider, FakeProvider } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

function harness(providers: Parameters<typeof createAgentRuntime>[0]["providers"]) {
  const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief" });
  const runtime = createAgentRuntime({
    fs,
    providers,
    tools: fullTools({ now }),
    trust: "full",
    now,
    async askPermission() {
      return { allowed: true };
    },
  } as AgentRuntimeOptionsExt);
  const events: AgentEvent[] = [];
  runtime.on((e) => events.push(e));
  return { runtime, events, fs };
}

const refuses = (code: "credential" | "insufficient_credits" | "rate_limited" | "server_error", id: string) =>
  new ProviderError({ status: code === "credential" ? 401 : 402, code, message: `${id} says no`, providerId: id });

/** A provider that throws the given error instead of answering, before emitting anything. */
function broken(id: string, error: unknown, classes?: ("small" | "strong")[]): FakeProvider {
  const provider = new FakeProvider(id, [], classes ? { classes } : {});
  provider.chat = async () => {
    throw error;
  };
  provider.stream = async function* () {
    throw error;
  };
  return provider;
}

describe("credential fallthrough in the loop", () => {
  it("moves to the next ready brain on a dead key, and says `model_started` again", async () => {
    const dead = broken("byok:openai", refuses("credential", "byok:openai"));
    const local = new FakeProvider("local", [{ text: "answered locally" }]);
    const { runtime, events } = harness([dead, local]);

    const result = await runtime.run({ prompt: "hi" });

    expect(result).toMatchObject({ text: "answered locally", providerId: "local", stopped: "final" });
    // TWO model_started events, in order: the UI's chip must never claim the wrong brain answered.
    expect(events.filter((e) => e.type === "model_started").map((e) => (e as { providerId: string }).providerId)).toEqual([
      "byok:openai",
      "local",
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("does the same for an empty purse", async () => {
    const empty = broken("overblast", refuses("insufficient_credits", "overblast"));
    const local = new FakeProvider("local", [{ text: "still answered" }]);
    const { runtime } = harness([empty, local]);
    expect((await runtime.run({ prompt: "hi" })).providerId).toBe("local");
  });

  it("does NOT switch on a rate limit or a server error — those are a retry, not a switch", async () => {
    for (const code of ["rate_limited", "server_error"] as const) {
      const busy = broken("overblast", refuses(code, "overblast"));
      const local = new FakeProvider("local", [{ text: "never asked" }]);
      const { runtime, events } = harness([busy, local]);
      const result = await runtime.run({ prompt: "hi" });
      expect(result.stopped).toBe("error");
      expect(events.filter((e) => e.type === "model_started")).toHaveLength(1);
    }
  });

  it("does not switch on a plain Error either — only the named codes are switchable", async () => {
    const odd = broken("overblast", new Error("something went wrong"));
    const local = new FakeProvider("local", [{ text: "never asked" }]);
    const { runtime, events } = harness([odd, local]);
    expect((await runtime.run({ prompt: "hi" })).stopped).toBe("error");
    expect(events.at(-1)).toMatchObject({ type: "error", message: "model failed: something went wrong" });
  });

  it("ends with the LAST provider's error when every brain refuses", async () => {
    const a = broken("byok:openai", refuses("credential", "byok:openai"));
    const b = broken("overblast", refuses("insufficient_credits", "overblast"));
    const { runtime, events } = harness([a, b]);
    const result = await runtime.run({ prompt: "hi" });
    expect(result.stopped).toBe("error");
    expect(events.at(-1)).toMatchObject({ type: "error", message: "model failed: overblast says no" });
    expect(events.filter((e) => e.type === "model_started")).toHaveLength(2);
  });

  it("NEVER switches once a token is out — half an answer plus another answer is a corrupted turn", async () => {
    const half = new ChunkedProvider("local", [["I was thinking ", "about"]]);
    half.failsOnTurn(0, 2, refuses("credential", "local"));
    const other = new FakeProvider("byok:openai", [{ text: "a completely different answer" }]);
    const { runtime, events } = harness([half, other]);

    const result = await runtime.run({ prompt: "hi" });

    expect(result.stopped).toBe("error");
    expect(events.filter((e) => e.type === "model_started")).toHaveLength(1);
    expect((events.filter((e) => e.type === "agent_delta") as { text: string }[]).map((d) => d.text)).toEqual([
      "I was thinking ",
      "about",
    ]);
  });

  it("does not fall through when the person NAMED a brain — they chose it", async () => {
    const dead = broken("byok:openai", refuses("credential", "byok:openai"));
    const local = new FakeProvider("local", [{ text: "would have answered" }]);
    const { runtime, events } = harness([dead, local]);
    const result = await runtime.run({ prompt: "hi", model: "byok:openai" });
    expect(result.stopped).toBe("error");
    expect(events.filter((e) => e.type === "model_started")).toHaveLength(1);
  });

  it("skips a provider that is not ready before it spends a request, as it always did", async () => {
    const downloading = new FakeProvider("local", [{ text: "not me" }], { ready: false, reason: "download" });
    const cloud = new FakeProvider("overblast", [{ text: "from the cloud" }]);
    const { runtime, events } = harness([downloading, cloud]);
    expect((await runtime.run({ prompt: "hi" })).providerId).toBe("overblast");
    expect(events.filter((e) => e.type === "model_started")).toHaveLength(1);
  });

  it("falls through per STEP: a brain that dies on the second turn is replaced for that turn", async () => {
    // The first turn answers with a tool call; the second refuses with a dead credential.
    const flaky = new FakeProvider("overblast", []);
    let turn = 0;
    flaky.stream = async function* () {
      turn++;
      if (turn === 1) {
        yield { type: "tool_call", call: { id: "c1", name: "ls", arguments: {} } };
        yield {
          type: "done",
          response: {
            message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ls", arguments: {} }] },
            finishReason: "tool_calls",
          },
        };
        return;
      }
      throw refuses("credential", "overblast");
    };
    const local = new FakeProvider("local", [{ text: "I read the folder for you" }]);
    const { runtime, events } = harness([flaky, local]);

    const result = await runtime.run({ prompt: "what is here?" });

    expect(result).toMatchObject({ steps: 2, stopped: "final", providerId: "local" });
    expect(events.filter((e) => e.type === "model_started").map((e) => (e as { providerId: string }).providerId)).toEqual([
      "overblast",
      "overblast",
      "local",
    ]);
  });
});

describe("the walk order the fallthrough uses", () => {
  it("prefers the asked class, then falls back to a ready brain of the other class", async () => {
    // The strong brain refuses; the only other ready one is small, and a small answer beats none.
    const strongDead = broken("overblast", refuses("credential", "overblast"), ["strong"]);
    const small = new FakeProvider("local", [{ text: "small brain answered" }], { classes: ["small"] });
    const { runtime, events } = harness([strongDead, small]);

    const result = await runtime.run({ prompt: "plan something for me", brain: "strong" });

    expect(result).toMatchObject({ text: "small brain answered", providerId: "local" });
    const started = events.filter((e) => e.type === "model_started") as { providerId: string; brainClass?: string }[];
    expect(started.map((e) => e.providerId)).toEqual(["overblast", "local"]);
    // And the chip tells the truth about what actually answered.
    expect(started[1].brainClass).toBe("small");
  });

  it("treats a provider that cannot answer readiness as not ready, and walks past it", async () => {
    const confused = new FakeProvider("local", [{ text: "never" }]);
    confused.readiness = async () => {
      throw new Error("WebGPU is on fire");
    };
    const cloud = new FakeProvider("overblast", [{ text: "from the cloud" }]);
    const { runtime, events } = harness([confused, cloud]);
    expect((await runtime.run({ prompt: "hi" })).providerId).toBe("overblast");
    expect(events.filter((e) => e.type === "model_started")).toHaveLength(1);
  });
});
