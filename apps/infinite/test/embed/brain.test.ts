import { describe, expect, it } from "vitest";
import { WEBLLM_CATALOG, WEBLLM_DEFAULT_MODEL_ID } from "@00/agent-models";
import type { ChatChunk, ChatRequest, ChatResponse, ModelProvider } from "@00/agent-models";
import type { Tool } from "@00/agent-runtime";
import { createBrain, hasModelProvider, loadLocalProvider, useModelProvider } from "../../embed/src/brain.js";
import { LOCAL_AI_MB, LOCAL_AI_MODEL, LOCAL_AI_OFFER, LOCAL_MODEL_MODULE } from "../../embed/src/loader.js";

/** A provider that answers from a script, and keeps every request so the prompt can be inspected. */
function scriptedProvider(turns: ChatResponse[]): ModelProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  let turn = 0;
  return {
    id: "test",
    seen,
    async models() {
      return [{ id: "test", label: "Test", class: "small", local: true, supportsTools: true }];
    },
    async chat(req) {
      seen.push(req);
      return turns[Math.min(turn++, turns.length - 1)]!;
    },
    async *stream(req): AsyncIterable<ChatChunk> {
      yield { type: "done", response: await this.chat(req) };
    },
    async readiness() {
      return { ready: true };
    },
  };
}

const echoTool = (calls: string[]): Tool => ({
  schema: { name: "site_search", description: "search", parameters: { type: "object", properties: { query: { type: "string" } } } },
  tier: "safe",
  async run(args) {
    calls.push(String(args.query));
    return { output: "/help/returns · Refunds — five working days" };
  },
});

describe("the brain, on the real runtime", () => {
  it("runs a light-trust turn: tool call, observation, answer", async () => {
    const calls: string[] = [];
    const provider = scriptedProvider([
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "site_search", arguments: { query: "refund" } }] },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "Refunds take five working days." }, finishReason: "stop" },
    ]);

    const brain = createBrain({
      provider,
      tools: [echoTool(calls)],
      systemContext: () => "The site map:\n/help/returns — Returns [anon]",
      origin: "https://shop.example",
      askPermission: async () => ({ allowed: false }),
      onEvent: () => {},
    });

    const result = await brain.ask("how do I get a refund");
    expect(calls).toEqual(["refund"]);
    expect(result.text).toBe("Refunds take five working days.");
    expect(result.stopped).toBe("final");

    // The site map reached the model, and it reached it as part of the LIGHT agent's rules — the
    // prompt frames the visitor as untrusted, which is the whole trust model of the embed.
    const system = provider.seen[0]!.messages[0]!.content;
    expect(system).toContain("/help/returns — Returns [anon]");
    expect(system.toLowerCase()).toContain("untrusted");
  });

  it("re-reads the site map on every turn, so a crawl that finished mid-conversation counts", async () => {
    let pages = 1;
    const provider = scriptedProvider([{ message: { role: "assistant", content: "ok" }, finishReason: "stop" }]);
    const brain = createBrain({
      provider,
      tools: [],
      systemContext: () => `pages: ${pages}`,
      origin: "https://shop.example",
      askPermission: async () => ({ allowed: false }),
      onEvent: () => {},
    });
    await brain.ask("one");
    pages = 42;
    await brain.ask("two");
    expect(provider.seen[0]!.messages[0]!.content).toContain("pages: 1");
    expect(provider.seen[1]!.messages[0]!.content).toContain("pages: 42");
  });
});

describe("the local model is never in the loader", () => {
  it("says nothing is registered until something is", () => {
    expect(hasModelProvider()).toBe(false);
    const provider = scriptedProvider([{ message: { role: "assistant", content: "" }, finishReason: "stop" }]);
    useModelProvider(() => provider);
    expect(hasModelProvider()).toBe(true);
    useModelProvider(null);
    expect(hasModelProvider()).toBe(false);
  });

  it("answers null rather than throwing when the model module will not load", async () => {
    const lines: string[] = [];
    expect(await loadLocalProvider("https://nowhere.invalid/m/m.js", (l) => lines.push(l))).toBeNull();
    expect(lines.join(" ")).toContain("did not load");
  });

  it("derives the button's number from the offer, not from a literal", () => {
    // The loader cannot import the catalogues (it would drag both WebGPU runtimes into a 60 KB
    // script), so the rows live in `embed/src/local-ai.ts` and `local-ai.test.ts` pins them there.
    // What this checks is the LOADER's half: node has no `navigator.gpu`, so the offer it derived
    // at import time is the web-llm fallback — the same row, the same number, nothing retyped.
    const model = WEBLLM_CATALOG.find((m) => m.id === WEBLLM_DEFAULT_MODEL_ID);
    expect(model).toBeDefined();
    expect(LOCAL_AI_OFFER.provider).toBe("webllm");
    expect(LOCAL_AI_MB).toBe(model!.vramMb);
    expect(LOCAL_AI_MODEL.name).toBe(model!.label);
    expect(LOCAL_MODEL_MODULE).toBe("/m/m.js");
  });
});
