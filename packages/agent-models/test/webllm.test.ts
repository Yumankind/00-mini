/**
 * WebGPU does not exist in Node, so what is testable here is exactly what this provider promises to
 * decide BEFORE it touches a GPU: the catalogue, the readiness gate, the fallback parser, and the
 * mapping either side of a mocked engine. The two twin guards read the installed `@mlc-ai/web-llm`
 * itself — the whole point of pinning against the package rather than against a memory of it.
 */
import { functionCallingModelIds, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  supportsNativeTools,
  WEBLLM_CATALOG,
  WEBLLM_DEFAULT_MODEL_ID,
  WEBLLM_NATIVE_TOOL_MODEL_IDS,
  webllmCatalogFor,
  WebLLMProvider,
} from "../src/webllm.js";
import type { WebLLMEngineLike } from "../src/webllm.js";
import { collect } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function withWebGpu(): void {
  vi.stubGlobal("navigator", { gpu: {} });
}

/** An engine that answers whatever it is handed, and records the request it was given. */
function mockEngine(answer: unknown): WebLLMEngineLike & { requests: Record<string, unknown>[]; interrupted: number } {
  const requests: Record<string, unknown>[] = [];
  const engine = {
    requests,
    interrupted: 0,
    chat: {
      completions: {
        async create(request: Record<string, unknown>) {
          requests.push(request);
          return typeof answer === "function" ? (answer as () => unknown)() : answer;
        },
      },
    },
    interruptGenerate() {
      engine.interrupted++;
    },
    async unload() {
      /* nothing to free in a mock */
    },
  };
  return engine;
}

async function* chunks(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

// ── The catalogue ───────────────────────────────────────────────────────────────────────────────

describe("the curated catalogue", () => {
  it("names only models the installed prebuilt config actually carries", () => {
    const known = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
    for (const model of WEBLLM_CATALOG) expect(known.has(model.id), `${model.id} is not in prebuiltAppConfig`).toBe(true);
    expect(known.has(WEBLLM_DEFAULT_MODEL_ID)).toBe(true);
  });

  it("reports every entry as a small local model, since that is what level 0 is", () => {
    for (const model of WEBLLM_CATALOG) {
      expect(model.class).toBe("small");
      expect(model.local).toBe(true);
      expect(model.supportsTools).toBe(true);
      // §6.1: 0.5B–3B. In VRAM terms every curated build fits under 2.5 GB.
      expect(model.vramMb).toBeLessThan(2500);
    }
  });

  it("keeps its own vram figures in step with the prebuilt config's", () => {
    for (const model of WEBLLM_CATALOG) {
      const actual = prebuiltAppConfig.model_list.find((m) => m.model_id === model.id)?.vram_required_MB;
      expect(Math.round(actual ?? 0), `${model.id} vram drifted`).toBe(Math.round(model.vramMb));
    }
  });

  it("TWIN GUARD: web-llm's own native function-calling list is the one this file names", () => {
    expect([...WEBLLM_NATIVE_TOOL_MODEL_IDS].sort()).toEqual([...functionCallingModelIds].sort());
  });

  it("so every curated model takes the prompt-based fallback, and says so", () => {
    for (const model of WEBLLM_CATALOG) expect(supportsNativeTools(model.id)).toBe(false);
    expect(supportsNativeTools("Hermes-2-Pro-Mistral-7B-q4f16_1-MLC")).toBe(true);
    expect(new WebLLMProvider().usesFallbackTools).toBe(true);
    expect(new WebLLMProvider({ modelId: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC" }).usesFallbackTools).toBe(false);
  });

  it("filters to a phone's cap (§12.6: one model, not a picker, at 1.5B)", () => {
    const phone = webllmCatalogFor({ maxVramMb: 1700 });
    expect(phone.length).toBeGreaterThan(0);
    expect(phone.every((m) => m.vramMb <= 1700)).toBe(true);
    expect(webllmCatalogFor()).toHaveLength(WEBLLM_CATALOG.length);
  });
});

// ── Readiness ───────────────────────────────────────────────────────────────────────────────────

describe("readiness", () => {
  it("says `unsupported` with no navigator.gpu, and never reaches for the engine", async () => {
    const createEngine = vi.fn();
    const provider = new WebLLMProvider({ createEngine });
    await expect(provider.readiness()).resolves.toMatchObject({ ready: false, reason: "unsupported" });
    expect(createEngine).not.toHaveBeenCalled();
    await expect(provider.load()).rejects.toMatchObject({ code: "unsupported" });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("says `download` on a WebGPU browser that has not loaded the model yet", async () => {
    withWebGpu();
    const provider = new WebLLMProvider({ createEngine: async () => mockEngine({}) });
    await expect(provider.readiness()).resolves.toMatchObject({ ready: false, reason: "download" });
    await provider.load();
    await expect(provider.readiness()).resolves.toEqual({ ready: true });
  });

  it("loads once, hands the progress callback through, and forgets a failed load", async () => {
    withWebGpu();
    const onProgress = vi.fn();
    let calls = 0;
    const provider = new WebLLMProvider({
      onProgress,
      createEngine: async (_id, opts) => {
        calls++;
        if (calls === 1) throw new Error("weights 404");
        opts.initProgressCallback?.({ progress: 1, timeElapsed: 2, text: "done" });
        return mockEngine({});
      },
    });
    await expect(provider.load()).rejects.toMatchObject({ code: "network" });
    // A failed load must not latch: the person may be offline now and online in a minute.
    await provider.load();
    expect(onProgress).toHaveBeenCalledWith({ progress: 1, timeElapsed: 2, text: "done" });
    const [a, b] = await Promise.all([provider.load(), provider.load()]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    await provider.unload();
    await expect(provider.readiness()).resolves.toMatchObject({ reason: "download" });
  });

  it("carries the typed progress web-llm can honestly report: a percentage and no bytes", async () => {
    withWebGpu();
    // The engine is held open on purpose: readiness has to be asked while the load is genuinely in
    // flight, which is the only moment a settings screen's poll ever sees.
    let finish: (() => void) | undefined;
    const provider = new WebLLMProvider({
      createEngine: async (_id, opts) => {
        opts.initProgressCallback?.({ progress: 0.42, timeElapsed: 1, text: "Fetching param cache[10/24]" });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return mockEngine({});
      },
    });
    const loading = provider.load();
    await Promise.resolve();
    // web-llm counts work, not bytes: `percent` is filled and `totalBytes` deliberately is not, so a
    // byte counter shows nothing rather than "0 B of 0 B".
    const mid = await provider.readiness();
    expect(mid).toMatchObject({ ready: false, reason: "download", progress: { loadedBytes: 0, percent: 42 } });
    expect(mid.ready === false && mid.progress?.totalBytes).toBeUndefined();
    expect(mid.ready === false && mid.detail).toContain("Loading");
    finish?.();
    await loading;
    await expect(provider.readiness()).resolves.toEqual({ ready: true });
  });

  it("hands back the catalogue and a stable id", async () => {
    const provider = new WebLLMProvider();
    expect(provider.id).toBe("local");
    expect(provider.modelId).toBe(WEBLLM_DEFAULT_MODEL_ID);
    await expect(provider.models()).resolves.toEqual(WEBLLM_CATALOG);
  });
});

// ── chat and stream, against a mocked engine ────────────────────────────────────────────────────

describe("chat", () => {
  it("folds the fallback instruction into the FIRST system turn rather than adding a second", async () => {
    withWebGpu();
    const engine = mockEngine({ choices: [{ message: { content: '{"tool_call": {"name": "ls", "arguments": {}}}' }, finish_reason: "stop" }] });
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    const res = await provider.chat({
      messages: [
        { role: "system", content: "you are 00" },
        { role: "user", content: "list files" },
      ],
      tools: [{ name: "ls", description: "list", parameters: { type: "object" } }],
    });

    const sent = engine.requests[0]?.messages as { role: string; content: string }[];
    expect(sent).toHaveLength(2);
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain("you are 00");
    expect(sent[0]?.content).toContain("tool_call");
    // No `tools` array: this model has no native function calling, so sending one would be a lie.
    expect(engine.requests[0]?.tools).toBeUndefined();

    expect(res.message.toolCalls).toEqual([{ id: "call_0", name: "ls", arguments: {} }]);
    expect(res.message.content).toBe("");
    expect(res.finishReason).toBe("tool_calls");
  });

  it("prepends a system turn when the history has none", async () => {
    withWebGpu();
    const engine = mockEngine({ choices: [{ message: { content: "no tool needed" }, finish_reason: "stop" }] });
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    const res = await provider.chat({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "ls", description: "l", parameters: {} }] });
    const sent = engine.requests[0]?.messages as { role: string }[];
    expect(sent.map((m) => m.role)).toEqual(["system", "user"]);
    expect(res.message.content).toBe("no tool needed");
    expect(res.message.toolCalls).toBeUndefined();
  });

  it("sends a real tools array on a model that has native function calling", async () => {
    withWebGpu();
    const engine = mockEngine({
      choices: [
        {
          message: { content: "", tool_calls: [{ id: "c1", function: { name: "ls", arguments: '{"path":"."}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    const provider = new WebLLMProvider({ modelId: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC", createEngine: async () => engine });
    const res = await provider.chat({ messages: [{ role: "user", content: "ls" }], tools: [{ name: "ls", description: "l", parameters: {} }] });
    expect(engine.requests[0]?.tools).toEqual([{ type: "function", function: { name: "ls", description: "l", parameters: {} } }]);
    expect((engine.requests[0]?.messages as { role: string }[])[0]?.role).toBe("user");
    expect(res.message.toolCalls).toEqual([{ id: "c1", name: "ls", arguments: { path: "." } }]);
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it("passes an assistant tool call and its result back down in the OpenAI shape", async () => {
    withWebGpu();
    const engine = mockEngine({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    await provider.chat({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ls", arguments: { path: "." } }] },
        { role: "tool", content: "a.md", toolCallId: "c1" },
      ],
    });
    const sent = engine.requests[0]?.messages as Record<string, unknown>[];
    expect((sent[0]?.tool_calls as { function: { arguments: string } }[])[0]?.function.arguments).toBe('{"path":"."}');
    expect(sent[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "a.md" });
  });

  it("refuses on an aborted signal without loading anything", async () => {
    withWebGpu();
    const controller = new AbortController();
    controller.abort();
    const createEngine = vi.fn();
    await expect(new WebLLMProvider({ createEngine }).chat({ messages: [], signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("types an engine failure rather than leaking it raw", async () => {
    withWebGpu();
    const engine = mockEngine(() => {
      throw new Error("out of memory");
    });
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({ code: "network", providerId: "local" });
  });
});

describe("stream", () => {
  it("streams deltas, then parses the fallback call out of what was accumulated", async () => {
    withWebGpu();
    const engine = mockEngine(() =>
      chunks(
        { choices: [{ delta: { content: 'Sure.\n{"tool_call": ' } }] },
        { choices: [{ delta: { content: '{"name": "ls", "arguments": {}}}' } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 8 } },
      ),
    );
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    const out = await collect(provider.stream({ messages: [], tools: [{ name: "ls", description: "l", parameters: {} }] }));
    expect(engine.requests[0]?.stream).toBe(true);
    expect(out.filter((c) => c.type === "text")).toHaveLength(2);
    expect(out.find((c) => c.type === "tool_call")).toEqual({ type: "tool_call", call: { id: "call_0", name: "ls", arguments: {} } });
    const done = out.at(-1) as { response: { message: { content: string }; usage?: unknown; finishReason: string } };
    expect(done.response.message.content).toBe("Sure.");
    expect(done.response.finishReason).toBe("tool_calls");
    expect(done.response.usage).toEqual({ inputTokens: 2, outputTokens: 8 });
  });

  it("assembles native streamed tool calls when the model has them", async () => {
    withWebGpu();
    const engine = mockEngine(() =>
      chunks(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "re", arguments: '{"p' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ad", arguments: '":"a"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    );
    const provider = new WebLLMProvider({ modelId: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC", createEngine: async () => engine });
    const out = await collect(provider.stream({ messages: [], tools: [{ name: "read", description: "r", parameters: {} }] }));
    expect(out.find((c) => c.type === "tool_call")).toEqual({ type: "tool_call", call: { id: "c1", name: "read", arguments: { p: "a" } } });
  });

  it("interrupts the GPU when the signal fires, instead of generating into a stream nobody reads", async () => {
    withWebGpu();
    const engine = mockEngine(() => chunks({ choices: [{ delta: { content: "a" } }] }, { choices: [{ delta: { content: "b" } }] }));
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    const controller = new AbortController();
    const iterator = provider.stream({ messages: [], signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    expect(engine.interrupted).toBe(1);
  });

  it("says so when the engine did not answer with a stream at all", async () => {
    withWebGpu();
    const provider = new WebLLMProvider({ createEngine: async () => mockEngine({ choices: [] }) });
    await expect(collect(provider.stream({ messages: [] }))).rejects.toMatchObject({ code: "server_error" });
  });
});

// ── Pictures (gap B10) ──────────────────────────────────────────────────────────────────────────

describe("a picture handed to the text-only fallback brain", () => {
  const shot = { mime: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), source: "shot.png" };

  it("says every row is blind, rather than leaving the flag absent", () => {
    for (const model of WEBLLM_CATALOG) expect(model.vision).toBe(false);
    // TWIN GUARD: the two vision builds the installed package DOES carry, and why neither is offered
    // — both want ~4 GB of VRAM, twice §12.6's phone cap, and the local vision brain is LiteRT's 3n.
    const vision = prebuiltAppConfig.model_list.filter((m) => m.model_id.toLowerCase().includes("vision"));
    expect(vision.map((m) => m.model_id)).toEqual(["Phi-3.5-vision-instruct-q4f16_1-MLC", "Phi-3.5-vision-instruct-q4f32_1-MLC"]);
    for (const m of vision) {
      expect(WEBLLM_CATALOG.some((row) => row.id === m.model_id)).toBe(false);
      expect(m.vram_required_MB ?? 0).toBeGreaterThan(2000);
    }
  });

  it("drops it and tells the model so, so the answer is 'I cannot see' and not 'there is no image'", async () => {
    withWebGpu();
    const engine = mockEngine({ choices: [{ message: { content: "I cannot see pictures." }, finish_reason: "stop" }] });
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    await provider.chat({ messages: [{ role: "user", content: "what is this?", images: [shot] }] });
    expect(engine.requests[0]?.messages).toEqual([
      { role: "user", content: "what is this?\n\n[A picture was attached (shot.png), but this model cannot see pictures.]" },
    ]);
  });

  it("does the same on a stream, and leaves a picture-less turn untouched", async () => {
    withWebGpu();
    const engine = mockEngine(() => chunks({ choices: [{ delta: { content: "no" }, finish_reason: "stop" }] }));
    const provider = new WebLLMProvider({ createEngine: async () => engine });
    await collect(provider.stream({ messages: [{ role: "user", content: "?", images: [shot] }] }));
    await collect(provider.stream({ messages: [{ role: "user", content: "plain" }] }));
    expect(String((engine.requests[0]?.messages as { content: string }[])[0]?.content)).toContain("but this model cannot see pictures");
    expect(engine.requests[1]?.messages).toEqual([{ role: "user", content: "plain" }]);
  });
});
