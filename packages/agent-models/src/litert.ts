/**
 * THE PREFERRED LOCAL BRAIN — LiteRT through MediaPipe's LLM Inference API, level 0 of §6.1.
 *
 * WHY A SECOND LOCAL PROVIDER. The ruling of 2026-09-10: LiteRT is faster and more stable than
 * web-llm's Gemma builds, and web-llm errors outright on some Windows machines. Both sit behind the
 * one `ModelProvider` door and the router falls through, so a browser LiteRT cannot serve still gets
 * an answer from WebLLM instead of getting nothing. `localProviders()` in `router.ts` is the pair,
 * in that order.
 *
 * FOUR THINGS SHAPE THIS FILE, and each one is a fact about the installed package rather than a
 * preference:
 *
 * 1. NO CDN, EVER. `FilesetResolver.forGenAiTasks(basePath)` loads a ~27 MB wasm binary and its
 *    loader from `basePath`. Every Google sample points it at jsdelivr; this is an offline-first
 *    PWA, so the app must COPY `node_modules/@mediapipe/tasks-genai/wasm/` into what it serves and
 *    pass that path as `wasmBaseUrl`. The default here is a relative `/mediapipe/genai/wasm` — a
 *    path on the app's own origin, which is cacheable by the service worker and works on a plane.
 *    A CDN default would be a provider that silently stops working the moment the network does.
 *
 * 2. THE MODEL IS FETCHED AS BYTES AND KEPT IN CACHE STORAGE. `createFromModelPath` would make the
 *    wasm runtime fetch the asset itself, with no progress and no reuse: half a gigabyte re-fetched
 *    on every open. So the asset is fetched here, reported on while it downloads, stored in a named
 *    Cache Storage cache, and handed over as `modelAssetBuffer`. `clearCache()` is the way back out,
 *    because a person who chose a different model should be able to get the disk back.
 *
 * 3. NO HOSTING URL IS HARDCODED. `modelBaseUrl` is a REQUIRED option. Where a Gemma asset is served
 *    from is the owner's decision and it carries an obligation: Gemma's terms travel with the
 *    weights, so whoever redistributes them must carry them too. This package ships the mechanism
 *    and the asset FILE NAMES; the host is configuration (the house rule in CLAUDE.md).
 *
 * 4. TOOL CALLS ALWAYS TAKE THE PROMPT FALLBACK. `@mediapipe/tasks-genai@0.10.29` exposes NO
 *    function-calling and NO constrained-decoding surface in the web build: the whole generation
 *    door is `generateResponse(query: Prompt, progressListener?)` → `Promise<string>`, and the
 *    words `constraint`, `grammar`, `schema`, `tool` and `function_call` do not appear in its
 *    `genai.d.ts` or its bundle at all. So `usesFallbackTools` is `true` for every model here, and
 *    `LITERT_NATIVE_TOOLS` is a constant a test pins, so the day a release ships one the guard says
 *    so rather than the behaviour drifting.
 */

import { ProviderError, providerErrorFromThrow, throwIfAborted } from "./errors.js";
import { mapFinishReason } from "./openai-compatible.js";
import type { FetchLike, Readiness } from "./openai-compatible.js";
import { renderPrompt, stopAtTurnEnd, TURN_MARKER_MAX_LENGTH, turnMarkerIndex } from "./templates.js";
import type { PromptFamily } from "./templates.js";
import { fallbackToolPrompt, parseFallbackToolCalls } from "./tool-fallback.js";
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall, Usage } from "./types.js";

/** The installed runtime this file was written against. Pinned by test to the installed package.json. */
export const LITERT_VERSION = "0.10.29";

/** Whether the installed web build can call tools natively. It cannot; see rule 4 above. */
export const LITERT_NATIVE_TOOLS = false;

/** The Cache Storage bucket the model assets live in. One bucket, so `clearCache()` frees all of it. */
export const LITERT_MODEL_CACHE = "00-litert-models";

/**
 * Where the app serves MediaPipe's `wasm/` folder from, when the caller names no other path.
 *
 * Relative to the app's origin ON PURPOSE (rule 1). The PWA copies the folder out of the installed
 * package at build time; nothing is fetched from a CDN.
 */
export const LITERT_DEFAULT_WASM_PATH = "/mediapipe/genai/wasm";

/** A catalogue row: `ModelInfo` plus what it costs in video memory and which file to fetch. */
export interface LiteRtModelInfo extends ModelInfo {
  /** Rough working-set size on the GPU. See the warning on `LITERT_CATALOG`. */
  vramMb: number;
  /** The file name under `modelBaseUrl`. The host is the owner's; the NAME is the model's. */
  assetFile: string;
  /** Which turn format to build the prompt in (`templates.ts`). */
  family: PromptFamily;
}

/**
 * The rows whose `assetFile` this package could NOT verify against anything installed.
 *
 * The installed `@mediapipe/tasks-genai@0.10.29` README names four assets by full file name; every
 * other name below was derived from the convention that README states ("files named `-web.task`
 * … are specially converted to run optimally in the browser") and must be checked against the model
 * repository before it is offered to a person, because a wrong name is a 404 minutes into a first
 * visit. `test/litert.test.ts` reads the installed README and fails if a row claiming to be
 * verified is not in it.
 */
export const LITERT_UNVERIFIED_ASSETS = ["gemma3-1b-it-int4-web"] as const;

/**
 * The curated LiteRT models.
 *
 * ⚠️ `vramMb` IS AN ESTIMATE. Unlike web-llm, MediaPipe publishes no manifest of memory
 * requirements — there is no `vram_required_MB` to pin a twin guard against — so these are the
 * int4 weight size plus KV-cache headroom, rounded, and they exist so `litertCatalogFor()` can keep
 * §12.6's promise that a phone is offered one model and not a wall. Measure them on a device before
 * anyone treats them as fact.
 *
 * `contextTokens` is what this package asks for at load (`maxTokens`), not a ceiling the model
 * imposes: LLM Inference counts input and output together against one number.
 */
export const LITERT_CATALOG: LiteRtModelInfo[] = [
  // VERIFIED name? No — derived from the README's "-web.task" convention for the text-only Gemma 3
  // variants it says are published on the LiteRT community. Listed in LITERT_UNVERIFIED_ASSETS.
  {
    id: "gemma3-1b-it-int4-web",
    label: "Gemma 3 1B (int4)",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 2048,
    vramMb: 1200,
    assetFile: "gemma3-1b-it-int4-web.task",
    family: "gemma",
  },
  // VERIFIED: named in full in the installed package's README.md.
  {
    id: "gemma-3n-E2B-it-int4-Web",
    label: "Gemma 3n E2B (int4)",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 4096,
    vramMb: 3600,
    assetFile: "gemma-3n-E2B-it-int4-Web.litertlm",
    family: "gemma",
  },
  // VERIFIED: the installed README's first download link. The owner's "Gemma 4" — it exists, and
  // this is the name it exists under.
  {
    id: "gemma-4-E2B-it-web",
    label: "Gemma 4 E2B",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 4096,
    vramMb: 3600,
    assetFile: "gemma-4-E2B-it-web.task",
    family: "gemma",
  },
  // VERIFIED: the installed README's second download link. Desktop-class; never offered to a phone.
  {
    id: "gemma-4-E4B-it-web",
    label: "Gemma 4 E4B",
    class: "strong",
    local: true,
    supportsTools: true,
    contextTokens: 4096,
    vramMb: 6800,
    assetFile: "gemma-4-E4B-it-web.task",
    family: "gemma",
  },
];

/** The smallest row: the one a first visit downloads when the caller names none. */
export const LITERT_DEFAULT_MODEL_ID = "gemma3-1b-it-int4-web";

/** §12.6: a phone gets one model, not a picker. Same filter as the WebLLM catalogue's. */
export function litertCatalogFor(options: { maxVramMb?: number } = {}): LiteRtModelInfo[] {
  const cap = options.maxVramMb ?? Number.POSITIVE_INFINITY;
  return LITERT_CATALOG.filter((m) => m.vramMb <= cap);
}

/** `<base>/<file>`, with exactly one slash between them whatever the caller passed. */
export function litertAssetUrl(baseUrl: string, assetFile: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${assetFile.replace(/^\/+/, "")}`;
}

// ── The task and the cache, behind interfaces so Node can hold them ─────────────────────────────

export interface LiteRtProgress {
  /** 0…1 while bytes are known, 1 when the asset is in hand. `undefined` total ⇒ this stays 0. */
  progress: number;
  loadedBytes: number;
  /** What `Content-Length` said, when the host sent one. */
  totalBytes?: number;
  /** A sentence for a UI, so the caller need not compose one. */
  text: string;
}

/** The sliver of `LlmInference` this provider uses. Everything else would be untestable in Node. */
export interface LiteRtTaskLike {
  generateResponse(query: string, progressListener?: (partial: string, done: boolean) => unknown): Promise<string>;
  /** Synchronous in the real task, and only legal between generations. */
  sizeInTokens?(query: string): number | undefined;
  /** "Sends a signal to cancel any current decoding when the engine is able to." */
  cancelProcessing?(): void;
  setOptions?(options: Record<string, unknown>): Promise<void>;
  close?(): void;
}

export interface LiteRtTaskOptions {
  modelAssetBuffer: Uint8Array;
  wasmBaseUrl: string;
  maxTokens?: number;
  topK?: number;
  temperature?: number;
  randomSeed?: number;
}

export type LiteRtTaskFactory = (options: LiteRtTaskOptions) => Promise<LiteRtTaskLike>;

/**
 * The real one: `@mediapipe/tasks-genai`, imported HERE and nowhere else in this package.
 *
 * Dynamic, inside the factory, for the same reason web-llm is: the bundle is megabytes and it
 * probes for WebGPU on load, so a page that merely lists its providers must never pull it in, and a
 * Node test must never reach it at all. The delegate is `GPU` because the README is explicit —
 * "only models encoded for the GPU backend are currently supported".
 */
const importTask: LiteRtTaskFactory = async (options) => {
  const genai = (await import("@mediapipe/tasks-genai")) as unknown as {
    FilesetResolver: { forGenAiTasks(basePath?: string): Promise<unknown> };
    LlmInference: { createFromOptions(fileset: unknown, options: Record<string, unknown>): Promise<LiteRtTaskLike> };
  };
  const fileset = await genai.FilesetResolver.forGenAiTasks(options.wasmBaseUrl);
  return genai.LlmInference.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: options.modelAssetBuffer, delegate: "GPU" },
    maxTokens: options.maxTokens,
    topK: options.topK,
    temperature: options.temperature,
    randomSeed: options.randomSeed,
  });
};

/** The two Cache Storage calls this provider makes, so a test can hand it a Map. */
export interface LiteRtCacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface LiteRtCacheStorageLike {
  open(cacheName: string): Promise<LiteRtCacheLike>;
  delete(cacheName: string): Promise<boolean>;
}

export interface LiteRtProviderOptions {
  /** A row of `LITERT_CATALOG`, or any id when `family` and `assetFile` are given. */
  modelId?: string;
  /**
   * REQUIRED: where the owner serves the model assets from. No default exists and none should: the
   * weights are Gemma's and their terms travel with whoever hosts them (rule 3).
   */
  modelBaseUrl: string;
  /** Where the app serves MediaPipe's own `wasm/` folder from. Defaults to `LITERT_DEFAULT_WASM_PATH`. */
  wasmBaseUrl?: string;
  onProgress?: (report: LiteRtProgress) => void;
  fetch?: FetchLike;
  /** Injected by tests; in a browser the global `caches` is what runs. */
  caches?: LiteRtCacheStorageLike;
  cacheName?: string;
  /** Injected by tests; in a browser the dynamic import above is what runs. */
  createTask?: LiteRtTaskFactory;
  catalog?: LiteRtModelInfo[];
  /** For a model that is not in the catalogue. */
  assetFile?: string;
  family?: PromptFamily;
  id?: string;
  maxTokens?: number;
  topK?: number;
  temperature?: number;
  randomSeed?: number;
}

/** The neutral usage shape, from the only counter the task offers. Estimated, and only when it answers. */
function countUsage(task: LiteRtTaskLike, prompt: string, answer: string): Usage | undefined {
  const input = task.sizeInTokens?.(prompt);
  const output = task.sizeInTokens?.(answer);
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { inputTokens: input, outputTokens: output };
}

export class LiteRtProvider implements ModelProvider {
  readonly id: string;
  readonly modelId: string;
  readonly model: LiteRtModelInfo | undefined;
  readonly assetUrl: string;
  readonly wasmBaseUrl: string;
  readonly family: PromptFamily;
  private readonly opts: LiteRtProviderOptions;
  private readonly createTask: LiteRtTaskFactory;
  private readonly cacheName: string;
  private task: LiteRtTaskLike | null = null;
  private loading: Promise<LiteRtTaskLike> | null = null;
  /** Remembered so `readiness()` need not re-open the cache on every poll of a settings screen. */
  private cached: boolean | null = null;
  private applied: { temperature?: number; maxTokens?: number };

  constructor(opts: LiteRtProviderOptions) {
    if (!opts.modelBaseUrl) {
      throw new Error("LiteRtProvider needs a modelBaseUrl: this package hardcodes no host for the model weights.");
    }
    this.opts = opts;
    this.id = opts.id ?? "local-litert";
    this.modelId = opts.modelId ?? LITERT_DEFAULT_MODEL_ID;
    this.model = (opts.catalog ?? LITERT_CATALOG).find((m) => m.id === this.modelId);
    const assetFile = opts.assetFile ?? this.model?.assetFile;
    if (!assetFile) {
      throw new Error(`LiteRtProvider does not know the asset file for ${this.modelId}: name it in the catalog or pass assetFile.`);
    }
    this.assetUrl = litertAssetUrl(opts.modelBaseUrl, assetFile);
    this.wasmBaseUrl = opts.wasmBaseUrl ?? LITERT_DEFAULT_WASM_PATH;
    this.family = opts.family ?? this.model?.family ?? "plain";
    this.createTask = opts.createTask ?? importTask;
    this.cacheName = opts.cacheName ?? LITERT_MODEL_CACHE;
    this.applied = { temperature: opts.temperature, maxTokens: opts.maxTokens ?? this.model?.contextTokens };
  }

  async models(): Promise<ModelInfo[]> {
    return (this.opts.catalog ?? LITERT_CATALOG).slice();
  }

  /** Always true at 0.10.29: the web build has no function calling to take instead (rule 4). */
  get usesFallbackTools(): boolean {
    return !LITERT_NATIVE_TOOLS;
  }

  private hasWebGpu(): boolean {
    return Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);
  }

  private cacheStorage(): LiteRtCacheStorageLike | undefined {
    return this.opts.caches ?? (globalThis as { caches?: LiteRtCacheStorageLike }).caches;
  }

  private get doFetch(): FetchLike {
    return this.opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Is the asset already on this device? Answered from Cache Storage, and remembered. */
  private async isCached(): Promise<boolean> {
    if (this.cached !== null) return this.cached;
    const storage = this.cacheStorage();
    if (!storage) return (this.cached = false);
    try {
      const cache = await storage.open(this.cacheName);
      this.cached = Boolean(await cache.match(this.assetUrl));
    } catch {
      // A browser with Cache Storage disabled (private mode, some embedded webviews) is not broken:
      // it just has nothing cached, and the download path will tell the person so.
      this.cached = false;
    }
    return this.cached;
  }

  async readiness(): Promise<Readiness> {
    if (!this.hasWebGpu()) {
      return { ready: false, reason: "unsupported", detail: "This browser has no WebGPU, so it cannot run a local model." };
    }
    if (this.task) return { ready: true };
    if (await this.isCached()) return { ready: true };
    return { ready: false, reason: "download", detail: `${this.modelId} has not been downloaded to this browser yet.` };
  }

  /**
   * The asset, cache first.
   *
   * The download is read as a stream rather than as one `arrayBuffer()` so a person watching a
   * half-gigabyte download sees it move. A host that sends no `Content-Length` still gets byte
   * counts, just no percentage — which is the honest thing to show when the total is unknown.
   */
  private async assetBytes(signal?: AbortSignal): Promise<Uint8Array> {
    const storage = this.cacheStorage();
    let cache: LiteRtCacheLike | undefined;
    if (storage) {
      try {
        cache = await storage.open(this.cacheName);
        const hit = await cache.match(this.assetUrl);
        if (hit) {
          this.cached = true;
          this.opts.onProgress?.({ progress: 1, loadedBytes: 0, text: `${this.modelId} is already on this device.` });
          return new Uint8Array(await hit.arrayBuffer());
        }
      } catch {
        cache = undefined;
      }
    }

    const response = await this.doFetch(this.assetUrl, { signal });
    if (!response.ok) {
      throw new ProviderError({
        status: response.status,
        code: response.status === 404 ? "bad_request" : "server_error",
        message: `The model asset ${this.assetUrl} could not be fetched (HTTP ${response.status}).`,
        providerId: this.id,
      });
    }
    const header = response.headers.get("content-length");
    const totalBytes = header ? Number(header) : undefined;
    const total = typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : undefined;

    let bytes: Uint8Array;
    const body = response.body;
    if (body) {
      const reader = body.getReader();
      const parts: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        parts.push(value);
        loaded += value.byteLength;
        this.opts.onProgress?.({
          progress: total ? loaded / total : 0,
          loadedBytes: loaded,
          totalBytes: total,
          text: `Downloading ${this.modelId}…`,
        });
      }
      bytes = new Uint8Array(loaded);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.byteLength;
      }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }

    if (cache) {
      try {
        // A fresh Response over a COPY of the bytes: the buffer handed to the task must not be one
        // the cache still owns.
        await cache.put(this.assetUrl, new Response(bytes.slice().buffer, { headers: { "Content-Type": "application/octet-stream" } }));
        this.cached = true;
      } catch {
        // Out of quota is not a reason to refuse the answer: the model is in hand, it just will not
        // survive the tab. The next open downloads it again, which is slow, not broken.
      }
    }
    this.opts.onProgress?.({ progress: 1, loadedBytes: bytes.byteLength, totalBytes: total, text: `${this.modelId} is ready.` });
    return bytes;
  }

  /** Download, cache and compile. Safe to call twice: the second caller waits on the first's promise. */
  async load(signal?: AbortSignal): Promise<LiteRtTaskLike> {
    if (this.task) return this.task;
    if (!this.hasWebGpu()) {
      throw new ProviderError({
        status: 0,
        code: "unsupported",
        message: "This browser has no WebGPU, so it cannot run a local model.",
        providerId: this.id,
      });
    }
    this.loading ??= (async () => {
      const modelAssetBuffer = await this.assetBytes(signal);
      return this.createTask({
        modelAssetBuffer,
        wasmBaseUrl: this.wasmBaseUrl,
        maxTokens: this.applied.maxTokens,
        topK: this.opts.topK,
        temperature: this.applied.temperature,
        randomSeed: this.opts.randomSeed,
      });
    })().then(
      (task) => {
        this.task = task;
        this.loading = null;
        return task;
      },
      (err: unknown) => {
        // A failed load must not latch: the person may be offline now and online in a minute.
        this.loading = null;
        throw providerErrorFromThrow(this.id, err, signal);
      },
    );
    return this.loading;
  }

  /**
   * Close the task and give the GPU back. ADDITIVE to the frozen `ModelProvider` (finding 4 of the
   * handoff Status asks for it); calling it twice is a no-op, which is what a settings screen needs.
   */
  async unload(): Promise<void> {
    const task = this.task;
    this.task = null;
    task?.close?.();
  }

  /** Forget the downloaded asset. The disk back, and the next `load()` downloads again. */
  async clearCache(): Promise<boolean> {
    this.cached = null;
    const storage = this.cacheStorage();
    if (!storage) return false;
    try {
      const deleted = await storage.delete(this.cacheName);
      this.cached = false;
      return deleted;
    } catch {
      return false;
    }
  }

  /**
   * A MediaPipe task is configured when it is CREATED, not per request. `temperature` and
   * `maxTokens` on a `ChatRequest` are therefore applied by re-configuring the task, and only when
   * they actually changed — a reconfigure is not free, and doing it on every turn would tax every
   * caller that passes the same number twice.
   */
  private async applyRequestOptions(task: LiteRtTaskLike, req: ChatRequest): Promise<void> {
    const next: Record<string, unknown> = {};
    if (typeof req.temperature === "number" && req.temperature !== this.applied.temperature) {
      next.temperature = req.temperature;
      this.applied = { ...this.applied, temperature: req.temperature };
    }
    if (typeof req.maxTokens === "number" && req.maxTokens !== this.applied.maxTokens) {
      next.maxTokens = req.maxTokens;
      this.applied = { ...this.applied, maxTokens: req.maxTokens };
    }
    if (!Object.keys(next).length || !task.setOptions) return;
    await task.setOptions(next);
  }

  /** The transcript as one prompt, with the fallback instruction folded into the system turn. */
  private buildPrompt(req: ChatRequest): string {
    const messages = req.tools?.length ? withToolInstruction(req.messages, fallbackToolPrompt(req.tools)) : req.messages;
    return renderPrompt(messages, this.family);
  }

  private finish(raw: string, fallback: boolean): ChatResponse {
    const text = stopAtTurnEnd(raw, this.family);
    const parsed = fallback ? parseFallbackToolCalls(text) : { text, calls: [] as ToolCall[] };
    const message: ChatMessage = { role: "assistant", content: parsed.text };
    if (parsed.calls.length) message.toolCalls = parsed.calls;
    return { message, finishReason: mapFinishReason(undefined, parsed.calls.length > 0) };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    throwIfAborted(this.id, req);
    const task = await this.load(req.signal);
    // The download may have taken a minute; an abort that landed during it must not now start a
    // generation, and `addEventListener` on an already-aborted signal never fires.
    throwIfAborted(this.id, req);
    await this.applyRequestOptions(task, req);
    const prompt = this.buildPrompt(req);
    const onAbort = () => task.cancelProcessing?.();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let raw: string;
    try {
      raw = await task.generateResponse(prompt);
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
    throwIfAborted(this.id, req);
    const response = this.finish(raw, Boolean(req.tools?.length));
    const usage = countUsage(task, prompt, raw);
    return usage ? { ...response, usage } : response;
  }

  /**
   * The streaming twin, over a CALLBACK rather than an async iterator.
   *
   * `generateResponse(query, progressListener)` calls back with each new piece and resolves with the
   * whole answer, so the bridge here is a queue the loop drains and a promise that says when there
   * will be no more. Two details are not decoration:
   *
   * · a delta is held back until it CANNOT be the first half of a turn marker, because a model that
   *   runs past its own `<end_of_turn>` would otherwise stream that marker to a reader before the
   *   cut is made;
   * · an abort wakes the loop through a listener, since a queue with nothing in it would otherwise
   *   wait for a generation the person already stopped.
   */
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    throwIfAborted(this.id, req);
    const task = await this.load(req.signal);
    await this.applyRequestOptions(task, req);
    const prompt = this.buildPrompt(req);
    const fallback = Boolean(req.tools?.length);

    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const bump = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    let settled = false;
    let failure: unknown;
    let whole = "";
    const generation = task
      .generateResponse(prompt, (partial, _done) => {
        if (partial) queue.push(partial);
        bump();
      })
      .then(
        (text) => {
          whole = text;
        },
        (err: unknown) => {
          failure = err ?? new Error("The local model failed.");
        },
      )
      .finally(() => {
        settled = true;
        bump();
      });

    const onAbort = (): void => {
      task.cancelProcessing?.();
      bump();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    let emitted = 0;
    let cut = false;
    let stop = false;
    try {
      for (;;) {
        while (queue.length && !stop) {
          // Checked BEFORE the delta is handed on: a person who pressed stop should not be shown
          // three more sentences that were already in flight.
          if (req.signal?.aborted) {
            stop = true;
            break;
          }
          buffer += queue.shift() ?? "";
          const marker = turnMarkerIndex(buffer, this.family);
          if (marker !== -1) {
            const upTo = stopAtTurnEnd(buffer, this.family);
            if (upTo.length > emitted) yield { type: "text", delta: upTo.slice(emitted) };
            emitted = upTo.length;
            buffer = upTo;
            cut = true;
            stop = true;
            task.cancelProcessing?.();
            break;
          }
          // Everything except a possible half-written marker at the tail is safe to hand on.
          const safe = Math.max(0, buffer.length - (TURN_MARKER_MAX_LENGTH - 1));
          if (safe > emitted) {
            yield { type: "text", delta: buffer.slice(emitted, safe) };
            emitted = safe;
          }
        }
        if (stop || settled || req.signal?.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    if (req.signal?.aborted) {
      await generation.catch(() => undefined);
      throw providerErrorFromThrow(this.id, new Error("aborted"), req.signal);
    }
    await generation;
    if (failure) throw providerErrorFromThrow(this.id, failure, req.signal);

    // The listener is the source of truth when it produced anything; the resolved string is the
    // fallback for a task that only answers at the end.
    const raw = cut ? buffer : buffer || whole;
    const text = stopAtTurnEnd(raw, this.family);
    if (text.length > emitted) yield { type: "text", delta: text.slice(emitted) };
    const response = this.finish(raw, fallback);
    for (const call of response.message.toolCalls ?? []) yield { type: "tool_call", call };
    const usage = countUsage(task, prompt, raw);
    yield { type: "done", response: usage ? { ...response, usage } : response };
  }
}

/**
 * The fallback instruction, folded into the FIRST system turn rather than pushed as a second one:
 * `templates.ts` merges every system turn into the first user turn anyway, and an instruction that
 * arrives after the identity prompt is one a 1B model reads late.
 */
function withToolInstruction(messages: ChatMessage[], instruction: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.role === "system");
  if (at === -1) return [{ role: "system", content: instruction }, ...messages];
  const out = messages.slice();
  const first = out[at] as ChatMessage;
  out[at] = { ...first, content: `${first.content}\n\n${instruction}` };
  return out;
}
