/**
 * THE LOCAL BRAIN — WebLLM on WebGPU, level 0 of §6.1: needs nothing, works offline, costs nothing.
 *
 * TWO RULES SHAPE THIS FILE.
 *
 * 1. THE PACKAGE MUST LOAD WITHOUT WEBGPU. `@mlc-ai/web-llm` is imported dynamically, inside
 *    `load()`, and never at module scope — importing it eagerly would pull a multi-megabyte runtime
 *    into every page that merely lists its providers, and would run its own feature probes in a
 *    Node test that has no `navigator` at all. `readiness()` answers `unsupported` before any of
 *    that is reached, so a browser with no WebGPU learns the truth for free.
 *
 * 2. TOOL CALLS ARE HONEST ABOUT WHICH PATH THEY TOOK. web-llm ships a real function-calling path,
 *    and at 0.2.85 its `functionCallingModelIds` list holds FIVE MODELS, all of them 7B–8B Hermes
 *    builds. Every model in the curated catalogue below is 0.5B–3B, so NONE of them takes that
 *    path: they all take the prompt-based fallback, which asks for a JSON tool call in the system
 *    prompt and parses it out of the answer. That is a weaker mechanism and it is marked as one
 *    everywhere it appears — `usedFallback` on the provider, a constant naming the native list, and
 *    a test that pins the list against the installed package so the day a small model joins it, the
 *    test says so rather than the behaviour silently changing.
 *
 * 3. NOTHING HERE SEES A PICTURE, AND IT SAYS SO. The installed prebuilt list holds exactly two
 *    vision builds — `Phi-3.5-vision-instruct-q4f16_1-MLC` (3952 MB of VRAM) and its q4f32_1 twin —
 *    and neither is in this catalogue: both are past §12.6's phone cap by a factor of two, and the
 *    local vision brain of §6.1 is LiteRT's Gemma 3n, which this provider is the FALLBACK behind. So
 *    every row carries `vision: false` — stated rather than left absent, because absent means
 *    "nobody said" everywhere else in this package — and a message that arrives with images loses
 *    them and gains the one line of image-parts.ts rule 3. The day a small vision build joins the
 *    catalogue, that row's flag is the only thing that changes.
 *
 * The catalogue is curated, not the whole prebuilt list of 163: a picker with 163 rows is not a
 * choice, it is a wall. Every id here is copied from the installed package's `prebuiltAppConfig`
 * and pinned by `test/webllm.test.ts` against it, because an id that does not exist is a download
 * that 404s minutes into a person's first visit. §12.6 caps phones at 1.5B; `vramMb` is what a
 * caller filters on to keep that promise.
 */

import { ProviderError, providerErrorFromThrow, throwIfAborted } from "./errors.js";
import { withoutImages } from "./image-parts.js";
import { mapFinishReason, mapUsage, parseToolArguments } from "./openai-compatible.js";
import { FALLBACK_SCHEMAS_MIN_CONTEXT, fallbackToolPrompt, parseFallbackToolCalls } from "./tool-fallback.js";
import type { Readiness } from "./openai-compatible.js";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  ReadinessProgress,
  ToolCall,
  Usage,
} from "./types.js";

/** The installed runtime this catalogue was read off. Pinned by test against `package.json`. */
export const WEBLLM_VERSION = "0.2.85";

/**
 * The models web-llm can call tools on NATIVELY, copied from its `functionCallingModelIds` at
 * 0.2.85. All five are 7B–8B, i.e. none of them is in the catalogue below. A twin guard in
 * `test/webllm.test.ts` reads the installed package's own list and fails when this one drifts.
 */
export const WEBLLM_NATIVE_TOOL_MODEL_IDS = [
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
] as const;

/** A catalogue row, with the one fact `ModelInfo` has no room for: what it costs in video memory. */
export interface WebLLMModelInfo extends ModelInfo {
  vramMb: number;
}

/**
 * The curated small models. 0.5B–3B, `q4f16_1` builds (half the download of `q4f32_1` and the same
 * answers on any GPU that does 16-bit), every one of them `low_resource_required` in the prebuilt
 * config so a laptop integrated GPU can hold it.
 */
export const WEBLLM_CATALOG: WebLLMModelInfo[] = [
  { id: "Qwen3-0.6B-q4f16_1-MLC", label: "Qwen3 0.6B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 1403 },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 879 },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 1630 },
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen3 1.7B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 2037 },
  { id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC", label: "SmolLM2 1.7B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 1774 },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 1895 },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 2264 },
  { id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC", label: "Hermes 3 Llama 3.2 3B", class: "small", local: true, supportsTools: true, vision: false, contextTokens: 4096, vramMb: 2264 },
];

/** The one this package loads when the caller names none. Smallest that still follows instructions. */
export const WEBLLM_DEFAULT_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/** §12.6: a phone gets one model, not a picker, and it is capped at 1.5B. */
export function webllmCatalogFor(options: { maxVramMb?: number } = {}): WebLLMModelInfo[] {
  const cap = options.maxVramMb ?? Number.POSITIVE_INFINITY;
  return WEBLLM_CATALOG.filter((m) => m.vramMb <= cap);
}

export function supportsNativeTools(modelId: string): boolean {
  return (WEBLLM_NATIVE_TOOL_MODEL_IDS as readonly string[]).includes(modelId);
}

// ── The prompt-based fallback lives in tool-fallback.ts ────────────────────────────────────────

/**
 * `fallbackToolPrompt` and `parseFallbackToolCalls` moved to `./tool-fallback.js` when the LiteRT
 * provider arrived and needed the same mechanism: MediaPipe's web build has no function calling at
 * all, so a copy here would have been the version that drifted.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ── The engine, behind an interface so it can be mocked in Node ─────────────────────────────────

export interface WebLLMProgress {
  progress: number;
  timeElapsed: number;
  text: string;
}

/** The sliver of `MLCEngineInterface` this provider uses. Anything more would be untestable. */
export interface WebLLMEngineLike {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<unknown>;
    };
  };
  interruptGenerate?: () => void;
  unload?: () => Promise<void>;
}

export type WebLLMEngineFactory = (
  modelId: string,
  options: { initProgressCallback?: (report: WebLLMProgress) => void },
) => Promise<WebLLMEngineLike>;

/** The real one: `@mlc-ai/web-llm`, imported here and nowhere else in this package. */
const importEngine: WebLLMEngineFactory = async (modelId, options) => {
  const webllm = (await import("@mlc-ai/web-llm")) as unknown as {
    CreateMLCEngine: (id: string, opts: Record<string, unknown>) => Promise<WebLLMEngineLike>;
  };
  return webllm.CreateMLCEngine(modelId, { initProgressCallback: options.initProgressCallback });
};

export interface WebLLMProviderOptions {
  modelId?: string;
  onProgress?: (report: WebLLMProgress) => void;
  /** Injected by tests. In a browser the default dynamic import is what runs. */
  createEngine?: WebLLMEngineFactory;
  catalog?: WebLLMModelInfo[];
  id?: string;
}

export class WebLLMProvider implements ModelProvider {
  readonly id: string;
  readonly modelId: string;
  private readonly opts: WebLLMProviderOptions;
  private readonly createEngine: WebLLMEngineFactory;
  private engine: WebLLMEngineLike | null = null;
  private loading: Promise<WebLLMEngineLike> | null = null;
  /** Set by `abortLoad()` while a load is in flight; read when the engine arrives. */
  private loadAbandoned = false;
  /**
   * The last init report, for the typed `progress` of the 2026-09-10 contract revision.
   *
   * WEB-LLM COUNTS WORK, NOT BYTES. `initProgressCallback` reports a fraction and a sentence
   * ("Fetching param cache[12/24]") and never a size, so `loadedBytes` here is 0 and `totalBytes` is
   * absent — the honest reading of the contract, and the reason `percent` is a field of its own
   * rather than something a consumer divides out of the two. A bar draws `percent`; a byte counter
   * must show nothing when `totalBytes` is undefined.
   */
  private progress: ReadinessProgress | null = null;

  constructor(opts: WebLLMProviderOptions = {}) {
    this.opts = opts;
    this.id = opts.id ?? "local";
    this.modelId = opts.modelId ?? WEBLLM_DEFAULT_MODEL_ID;
    this.createEngine = opts.createEngine ?? importEngine;
  }

  async models(): Promise<ModelInfo[]> {
    return (this.opts.catalog ?? WEBLLM_CATALOG).slice();
  }

  /** True when this model's tools go through the prompt-based fallback rather than web-llm's own. */
  get usesFallbackTools(): boolean {
    return !supportsNativeTools(this.modelId);
  }

  /**
   * Can this row afford the raw JSON schemas? Read off its OWN `contextTokens`, not off a constant:
   * every row this package ships says 4096, where the schema dump is most of the context, so the
   * answer here is no — and stays no unless a caller brings a catalogue with the room.
   */
  private get fallbackSchemas(): boolean {
    const row = (this.opts.catalog ?? WEBLLM_CATALOG).find((m) => m.id === this.modelId);
    return (row?.contextTokens ?? 0) >= FALLBACK_SCHEMAS_MIN_CONTEXT;
  }

  private hasWebGpu(): boolean {
    return Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);
  }

  async readiness(): Promise<Readiness> {
    if (!this.hasWebGpu()) {
      return { ready: false, reason: "unsupported", detail: "This browser has no WebGPU, so it cannot run a local model." };
    }
    if (!this.engine) {
      return {
        ready: false,
        reason: "download",
        detail: this.progress?.percent === undefined ? `${this.modelId} has not been downloaded to this browser yet.` : `Loading ${this.modelId}…`,
        ...(this.progress ? { progress: this.progress } : {}),
      };
    }
    return { ready: true };
  }

  /** Remember what the engine reported, then hand it to the caller's listener unchanged. */
  private report(report: WebLLMProgress): void {
    const fraction = Number.isFinite(report.progress) ? Math.min(1, Math.max(0, report.progress)) : 0;
    this.progress = { loadedBytes: 0, percent: Math.round(fraction * 100) };
    this.opts.onProgress?.(report);
  }

  /** Download and compile. Safe to call twice: the second caller waits on the first one's promise. */
  async load(): Promise<WebLLMEngineLike> {
    if (this.engine) return this.engine;
    if (!this.hasWebGpu()) {
      throw new ProviderError({
        status: 0,
        code: "unsupported",
        message: "This browser has no WebGPU, so it cannot run a local model.",
        providerId: this.id,
      });
    }
    if (!this.loading) this.loadAbandoned = false;
    this.loading ??= this.createEngine(this.modelId, { initProgressCallback: (report) => this.report(report) }).then(
      (engine) => {
        this.loading = null;
        if (this.loadAbandoned) {
          // web-llm's engine creation cannot be interrupted; a stop during it means the engine is
          // let go the moment it arrives and the caller hears "stopped".
          void engine.unload?.();
          throw providerErrorFromThrow(this.id, new DOMException("The model load was stopped.", "AbortError"));
        }
        this.engine = engine;
        return engine;
      },
      (err: unknown) => {
        // A failed load must not latch: the person may be offline now and online in a minute.
        this.loading = null;
        throw providerErrorFromThrow(this.id, err);
      },
    );
    return this.loading;
  }

  /** Best effort (contract addition of 2026-09-11): the engine arriving after this is released, not kept. */
  abortLoad(): void {
    if (this.loading) this.loadAbandoned = true;
  }

  async unload(): Promise<void> {
    this.abortLoad();
    await this.engine?.unload?.();
    this.engine = null;
  }

  /**
   * The messages as the engine wants them, with the fallback instruction folded in when needed.
   *
   * `withoutImages` first, and unconditionally: every model in this catalogue is text-only (rule 3),
   * so a picture cannot be sent — but it is named in the text, so the model answers "I cannot see
   * pictures" instead of "I see no image" to a person who is looking at the one they attached.
   */
  private buildMessages(req: ChatRequest, fallback: boolean): Record<string, unknown>[] {
    const messages = withoutImages(req.messages).map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.role === "assistant" && m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      }
      return out;
    });
    if (!fallback) return messages;
    // Appended to the FIRST system turn rather than pushed as a second one: several of these models
    // only honour one system message, and the identity prompt must stay at the top of it.
    const instruction = fallbackToolPrompt(req.tools ?? [], { schemas: this.fallbackSchemas });
    const first = messages[0];
    if (first && first.role === "system") {
      messages[0] = { ...first, content: `${String(first.content ?? "")}\n\n${instruction}` };
      return messages;
    }
    return [{ role: "system", content: instruction }, ...messages];
  }

  private buildRequest(req: ChatRequest, stream: boolean): { body: Record<string, unknown>; fallback: boolean } {
    const wantsTools = Boolean(req.tools?.length);
    const fallback = wantsTools && this.usesFallbackTools;
    const body: Record<string, unknown> = {
      messages: this.buildMessages(req, fallback),
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (typeof req.temperature === "number") body.temperature = req.temperature;
    if (typeof req.maxTokens === "number") body.max_tokens = req.maxTokens;
    if (wantsTools && !fallback) {
      body.tools = req.tools?.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    return { body, fallback };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    throwIfAborted(this.id, req);
    const engine = await this.load();
    const { body, fallback } = this.buildRequest(req, false);
    let json: unknown;
    try {
      json = await engine.chat.completions.create(body);
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }
    const root = asRecord(json);
    const choice = asRecord((root?.choices as unknown[] | undefined)?.[0]);
    const message = asRecord(choice?.message);
    const rawContent = typeof message?.content === "string" ? message.content : "";
    const native = Array.isArray(message?.tool_calls)
      ? (message?.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[]).map((c, i) => ({
          id: c.id ?? `call_${i}`,
          name: c.function?.name ?? "",
          arguments: parseToolArguments(c.function?.arguments),
        }))
      : [];
    const parsed = fallback ? parseFallbackToolCalls(rawContent) : { text: rawContent, calls: [] as ToolCall[] };
    const toolCalls = native.length ? native : parsed.calls;
    const out: ChatMessage = { role: "assistant", content: parsed.text };
    if (toolCalls.length) out.toolCalls = toolCalls;
    return { message: out, usage: mapUsage(root?.usage), finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0) };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    throwIfAborted(this.id, req);
    const engine = await this.load();
    const { body, fallback } = this.buildRequest(req, true);
    let iterable: unknown;
    try {
      iterable = await engine.chat.completions.create(body);
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }
    const source = iterable as AsyncIterable<unknown> | undefined;
    if (!source || typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
      throw new ProviderError({ status: 0, code: "server_error", message: "The local engine did not answer with a stream.", providerId: this.id });
    }

    const pending = new Map<number, { id?: string; name: string; args: string }>();
    let content = "";
    let finish: unknown;
    let usage: Usage | undefined;
    try {
      for await (const raw of source) {
        if (req.signal?.aborted) {
          // The engine has no `AbortSignal`; `interruptGenerate` is how it is stopped, and without
          // it the GPU keeps generating into a stream nobody is reading.
          engine.interruptGenerate?.();
          throw providerErrorFromThrow(this.id, new Error("aborted"), req.signal);
        }
        const root = asRecord(raw);
        const chunkUsage = mapUsage(root?.usage);
        if (chunkUsage) usage = chunkUsage;
        const choice = asRecord((root?.choices as unknown[] | undefined)?.[0]);
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = asRecord(choice.delta);
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          // On the fallback path the JSON call is streamed as ordinary text; it is emitted anyway
          // rather than buffered, because holding every delta back on the chance that the answer
          // turns out to be a tool call would make an ordinary answer arrive all at once.
          yield { type: "text", delta: delta.content };
        }
        for (const [i, call] of (Array.isArray(delta.tool_calls) ? (delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) : []).entries()) {
          const index = typeof call.index === "number" ? call.index : i;
          const slot = pending.get(index) ?? { name: "", args: "" };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (typeof call.function?.arguments === "string") slot.args += call.function.arguments;
          pending.set(index, slot);
        }
      }
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }

    const native: ToolCall[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot]) => ({ id: slot.id ?? `call_${index}`, name: slot.name, arguments: parseToolArguments(slot.args) }));
    const parsed = fallback ? parseFallbackToolCalls(content) : { text: content, calls: [] as ToolCall[] };
    const toolCalls = native.length ? native : parsed.calls;
    for (const call of toolCalls) yield { type: "tool_call", call };
    const message: ChatMessage = { role: "assistant", content: parsed.text };
    if (toolCalls.length) message.toolCalls = toolCalls;
    yield { type: "done", response: { message, usage, finishReason: mapFinishReason(finish, toolCalls.length > 0) } };
  }
}
