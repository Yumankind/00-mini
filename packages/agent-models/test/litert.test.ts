/**
 * WebGPU does not exist in Node and neither does Cache Storage, so what is testable here is exactly
 * what this provider decides BEFORE it touches a GPU: the catalogue, the readiness gate, the
 * download-and-cache path, the prompt it builds, and the mapping either side of a mocked task. The
 * MediaPipe module itself is never imported — `createTask` is injected, the same way `createEngine`
 * is for WebLLM — because importing it would pull a 27 MB wasm probe into a Node run.
 *
 * Two twin guards read the INSTALLED package rather than a memory of it: its version, and its
 * README's asset names. An `assetFile` that does not exist is a 404 minutes into a first visit.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LITERT_CATALOG,
  LITERT_DEFAULT_MODEL_ID,
  LITERT_DEFAULT_WASM_PATH,
  LITERT_MODEL_CACHE,
  LITERT_NATIVE_TOOLS,
  LITERT_UNVERIFIED_ASSETS,
  LITERT_VERSION,
  LiteRtProvider,
  litertAssetUrl,
  litertCatalogFor,
} from "../src/litert.js";
import type { LiteRtCacheLike, LiteRtCacheStorageLike, LiteRtProgress, LiteRtTaskLike } from "../src/litert.js";
import { collect } from "./helpers.js";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("@mediapipe/tasks-genai"));
const installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version: string };
const installedReadme = readFileSync(join(packageDir, "README.md"), "utf8");

const BASE = "https://models.example/litert";

afterEach(() => {
  vi.unstubAllGlobals();
});

function withWebGpu(): void {
  vi.stubGlobal("navigator", { gpu: {} });
}

/** Cache Storage, as a Map of Maps. `put` copies, exactly as the real one does. */
function memoryCaches(): LiteRtCacheStorageLike & { buckets: Map<string, Map<string, ArrayBuffer>> } {
  const buckets = new Map<string, Map<string, ArrayBuffer>>();
  return {
    buckets,
    async open(name: string): Promise<LiteRtCacheLike> {
      const bucket = buckets.get(name) ?? new Map<string, ArrayBuffer>();
      buckets.set(name, bucket);
      return {
        async match(request: string) {
          const hit = bucket.get(request);
          return hit ? new Response(hit.slice(0)) : undefined;
        },
        async put(request: string, response: Response) {
          bucket.set(request, await response.arrayBuffer());
        },
      };
    },
    async delete(name: string) {
      return buckets.delete(name);
    },
  };
}

/** A `fetch` that answers with a streamed body, and counts how often it was asked. */
function assetFetch(bytes: number[], init: { status?: number; length?: boolean; body?: boolean } = {}): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const status = init.status ?? 200;
      const headers: Record<string, string> = init.length === false ? {} : { "Content-Length": String(bytes.length) };
      if (status !== 200) return new Response("no", { status, headers: {} });
      if (init.body === false) {
        // A `Response` whose `body` is null — which Node never produces but a browser does (a cache
        // hit replayed by a service worker, a `Response` built from a string in some engines).
        return {
          ok: true,
          status,
          headers: new Headers(headers),
          body: null,
          async arrayBuffer() {
            return new Uint8Array(bytes).buffer;
          },
        } as unknown as Response;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      });
      return new Response(stream, { status, headers });
    },
  };
}

interface MockTask extends LiteRtTaskLike {
  prompts: string[];
  options: Record<string, unknown>[];
  cancels: number;
  closes: number;
}

/** A task that replays `chunks` through the progress listener and resolves with their concatenation. */
function mockTask(chunks: string[], opts: { fail?: unknown; tokens?: number; silent?: boolean; whole?: string; slow?: boolean } = {}): MockTask {
  let cancelled = false;
  const task: MockTask = {
    prompts: [],
    options: [],
    cancels: 0,
    closes: 0,
    async generateResponse(query: string, listener?: (partial: string, done: boolean) => unknown) {
      task.prompts.push(query);
      if (opts.fail) throw opts.fail;
      let out = "";
      for (const [i, chunk] of chunks.entries()) {
        // `slow` puts a macrotask between the pieces, which is the only way a test can act while a
        // generation is genuinely in flight.
        await (opts.slow ? new Promise((resolve) => setTimeout(resolve, 2)) : Promise.resolve());
        if (cancelled) break;
        out += chunk;
        if (!opts.silent) listener?.(chunk, i === chunks.length - 1);
      }
      return opts.whole ?? out;
    },
    sizeInTokens(query: string) {
      return opts.tokens === undefined ? undefined : query.length;
    },
    cancelProcessing() {
      cancelled = true;
      task.cancels++;
    },
    async setOptions(options: Record<string, unknown>) {
      task.options.push(options);
    },
    close() {
      task.closes++;
    },
  };
  return task;
}

function provider(overrides: Partial<ConstructorParameters<typeof LiteRtProvider>[0]> = {}, task?: LiteRtTaskLike) {
  const caches = memoryCaches();
  const fetcher = assetFetch([1, 2, 3, 4]);
  const made = task ?? mockTask(["ok"]);
  const instance = new LiteRtProvider({
    modelBaseUrl: BASE,
    caches,
    fetch: fetcher.fetch,
    createTask: async () => made,
    ...overrides,
  });
  return { instance, caches, fetcher, task: made as MockTask };
}

// ── The catalogue ───────────────────────────────────────────────────────────────────────────────

describe("the curated catalogue", () => {
  it("TWIN GUARD: names the version of MediaPipe that is actually installed", () => {
    expect(LITERT_VERSION).toBe(installed.version);
  });

  it("TWIN GUARD: every asset name it claims to have verified is in the installed README, verbatim", () => {
    const unverified = new Set<string>(LITERT_UNVERIFIED_ASSETS);
    const verified = LITERT_CATALOG.filter((m) => !unverified.has(m.id));
    expect(verified.length).toBeGreaterThan(0);
    for (const model of verified) {
      expect(installedReadme.includes(model.assetFile), `${model.assetFile} is not named in the installed README`).toBe(true);
    }
  });

  it("declares the unverified rows as unverified, and they are rows", () => {
    for (const id of LITERT_UNVERIFIED_ASSETS) {
      const model = LITERT_CATALOG.find((m) => m.id === id);
      expect(model, `${id} is flagged unverified but is not in the catalogue`).toBeDefined();
      // Being unverified means exactly this: the installed package does not name the file.
      expect(installedReadme.includes(model?.assetFile ?? "")).toBe(false);
    }
  });

  it("carries the Gemma 4 assets the installed package points at", () => {
    const ids = LITERT_CATALOG.map((m) => m.id);
    expect(ids).toContain("gemma-4-E2B-it-web");
    expect(ids).toContain("gemma-3n-E2B-it-int4-Web");
    expect(ids).toContain(LITERT_DEFAULT_MODEL_ID);
  });

  it("is local, tool-capable through the fallback, and prompted in a family this package knows", () => {
    const ids = new Set<string>();
    for (const model of LITERT_CATALOG) {
      expect(model.local).toBe(true);
      expect(model.supportsTools).toBe(true);
      expect(model.family).toBe("gemma");
      expect(model.assetFile).toMatch(/\.(task|litertlm)$/);
      expect(ids.has(model.id), `${model.id} is listed twice`).toBe(false);
      ids.add(model.id);
    }
  });

  it("filters to a phone's cap, so a phone is offered one model and not a wall", () => {
    const phone = litertCatalogFor({ maxVramMb: 2000 });
    expect(phone.map((m) => m.id)).toEqual([LITERT_DEFAULT_MODEL_ID]);
    expect(litertCatalogFor()).toHaveLength(LITERT_CATALOG.length);
  });

  it("joins a host and a file name with exactly one slash, whatever the caller passed", () => {
    expect(litertAssetUrl("https://h/x/", "/a.task")).toBe("https://h/x/a.task");
    expect(litertAssetUrl("https://h/x", "a.task")).toBe("https://h/x/a.task");
  });

  it("says out loud that the installed web build has no native function calling", async () => {
    expect(LITERT_NATIVE_TOOLS).toBe(false);
    const { instance } = provider();
    expect(instance.usesFallbackTools).toBe(true);
    await expect(instance.models()).resolves.toEqual(LITERT_CATALOG);
  });
});

// ── Construction ────────────────────────────────────────────────────────────────────────────────

describe("construction", () => {
  it("refuses to invent a host for the weights", () => {
    expect(() => new LiteRtProvider({ modelBaseUrl: "" })).toThrow(/modelBaseUrl/);
  });

  it("refuses a model whose asset file nobody named", () => {
    expect(() => new LiteRtProvider({ modelBaseUrl: BASE, modelId: "who-knows" })).toThrow(/asset file/);
  });

  it("takes a model that is not in the catalogue when the caller names the file and the family", () => {
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, modelId: "custom", assetFile: "custom.task", family: "plain" });
    expect(instance.assetUrl).toBe(`${BASE}/custom.task`);
    expect(instance.family).toBe("plain");
    expect(instance.model).toBeUndefined();
  });

  it("defaults its id, its wasm path and its model", () => {
    const { instance } = provider();
    expect(instance.id).toBe("local-litert");
    expect(instance.wasmBaseUrl).toBe(LITERT_DEFAULT_WASM_PATH);
    expect(LITERT_DEFAULT_WASM_PATH.startsWith("/")).toBe(true);
    expect(instance.modelId).toBe(LITERT_DEFAULT_MODEL_ID);
    expect(instance.assetUrl).toBe(`${BASE}/${LITERT_CATALOG[0]?.assetFile}`);
  });
});

// ── Readiness and the download ──────────────────────────────────────────────────────────────────

describe("readiness", () => {
  it("says `unsupported` with no navigator.gpu, and never fetches a byte", async () => {
    const { instance, fetcher } = provider();
    await expect(instance.readiness()).resolves.toMatchObject({ ready: false, reason: "unsupported" });
    await expect(instance.load()).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher.calls).toEqual([]);
  });

  it("says `download` until the asset is in Cache Storage, and `ready` once it is", async () => {
    withWebGpu();
    const { instance, caches, fetcher } = provider();
    await expect(instance.readiness()).resolves.toMatchObject({ ready: false, reason: "download" });
    await instance.load();
    expect(fetcher.calls).toEqual([`${BASE}/${LITERT_CATALOG[0]?.assetFile}`]);
    await expect(instance.readiness()).resolves.toEqual({ ready: true });

    // A SECOND provider over the same cache is ready before it has loaded anything: that is the
    // point of the named cache — one download serves every open.
    const second = new LiteRtProvider({ modelBaseUrl: BASE, caches, fetch: fetcher.fetch, createTask: async () => mockTask(["ok"]) });
    await expect(second.readiness()).resolves.toEqual({ ready: true });
    await second.load();
    expect(fetcher.calls).toHaveLength(1);
  });

  it("reports bytes as they arrive, and a percentage only when the host said how many there are", async () => {
    withWebGpu();
    const reports: LiteRtProgress[] = [];
    const { instance } = provider({ onProgress: (r) => reports.push(r) });
    await instance.load();
    expect(reports.at(0)).toMatchObject({ loadedBytes: 1, totalBytes: 4, progress: 0.25 });
    expect(reports.at(-1)).toMatchObject({ progress: 1, loadedBytes: 4 });

    const lengthless = assetFetch([1, 2], { length: false });
    const blind: LiteRtProgress[] = [];
    const other = new LiteRtProvider({
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: lengthless.fetch,
      onProgress: (r) => blind.push(r),
      createTask: async () => mockTask(["ok"]),
    });
    await other.load();
    expect(blind.at(0)).toMatchObject({ progress: 0, loadedBytes: 1, totalBytes: undefined });
  });

  it("says so when the asset is already on the device rather than reporting a download", async () => {
    withWebGpu();
    const { instance, caches, fetcher } = provider();
    await instance.load();
    const reports: LiteRtProgress[] = [];
    const again = new LiteRtProvider({
      modelBaseUrl: BASE,
      caches,
      fetch: fetcher.fetch,
      onProgress: (r) => reports.push(r),
      createTask: async () => mockTask(["ok"]),
    });
    await again.load();
    expect(reports).toEqual([{ progress: 1, loadedBytes: 0, text: expect.stringContaining("already on this device") }]);
  });

  it("reads the whole body at once when the response has no stream to read", async () => {
    withWebGpu();
    const whole = assetFetch([7, 8, 9], { body: false });
    let handed: Uint8Array | undefined;
    const instance = new LiteRtProvider({
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: whole.fetch,
      createTask: async (options) => {
        handed = options.modelAssetBuffer;
        return mockTask(["ok"]);
      },
    });
    await instance.load();
    expect([...(handed ?? [])]).toEqual([7, 8, 9]);
  });

  it("types a missing asset as a refusal with the URL in it, rather than a raw fetch failure", async () => {
    withWebGpu();
    const missing = assetFetch([], { status: 404 });
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, caches: memoryCaches(), fetch: missing.fetch, createTask: async () => mockTask([]) });
    await expect(instance.load()).rejects.toMatchObject({ code: "bad_request", providerId: "local-litert" });
    const broken = assetFetch([], { status: 500 });
    const other = new LiteRtProvider({ modelBaseUrl: BASE, caches: memoryCaches(), fetch: broken.fetch, createTask: async () => mockTask([]) });
    await expect(other.load()).rejects.toMatchObject({ code: "server_error" });
  });

  it("works with no Cache Storage at all, and downloads again each time", async () => {
    withWebGpu();
    const fetcher = assetFetch([1]);
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, fetch: fetcher.fetch, createTask: async () => mockTask(["ok"]) });
    await expect(instance.readiness()).resolves.toMatchObject({ reason: "download" });
    await instance.load();
    await expect(instance.clearCache()).resolves.toBe(false);
    expect(fetcher.calls).toHaveLength(1);
  });

  it("treats a Cache Storage that throws as one that holds nothing", async () => {
    withWebGpu();
    const angry: LiteRtCacheStorageLike = {
      async open() {
        throw new Error("private mode");
      },
      async delete() {
        throw new Error("private mode");
      },
    };
    const fetcher = assetFetch([1]);
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, caches: angry, fetch: fetcher.fetch, createTask: async () => mockTask(["ok"]) });
    await expect(instance.readiness()).resolves.toMatchObject({ reason: "download" });
    await instance.load();
    await expect(instance.clearCache()).resolves.toBe(false);
    expect(fetcher.calls).toHaveLength(1);
  });

  it("answers the answer anyway when the cache is full", async () => {
    withWebGpu();
    const storage = memoryCaches();
    const full: LiteRtCacheStorageLike = {
      async open() {
        return {
          async match() {
            return undefined;
          },
          async put() {
            throw new Error("QuotaExceededError");
          },
        };
      },
      delete: storage.delete.bind(storage),
    };
    const fetcher = assetFetch([1]);
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, caches: full, fetch: fetcher.fetch, createTask: async () => mockTask(["ok"]) });
    await expect(instance.load()).resolves.toBeDefined();
  });

  it("uses the global caches when the caller injects none", async () => {
    withWebGpu();
    const storage = memoryCaches();
    vi.stubGlobal("caches", storage);
    const fetcher = assetFetch([1]);
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, fetch: fetcher.fetch, createTask: async () => mockTask(["ok"]) });
    await instance.load();
    expect(storage.buckets.get(LITERT_MODEL_CACHE)?.size).toBe(1);
  });

  it("loads once, forgets a failed load, and gives the GPU back on unload — twice is fine", async () => {
    withWebGpu();
    let calls = 0;
    const task = mockTask(["ok"]);
    const fetcher = assetFetch([1]);
    const instance = new LiteRtProvider({
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: fetcher.fetch,
      createTask: async () => {
        calls++;
        if (calls === 1) throw new Error("no GPU adapter");
        return task;
      },
    });
    await expect(instance.load()).rejects.toMatchObject({ code: "network" });
    const [a, b] = await Promise.all([instance.load(), instance.load()]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    await instance.unload();
    await instance.unload();
    expect(task.closes).toBe(1);
    // Unloaded but still cached: nothing to download, so it is ready again without a byte moving.
    await expect(instance.readiness()).resolves.toEqual({ ready: true });
  });

  it("gives the disk back, and then needs the download again", async () => {
    withWebGpu();
    const { instance, caches, fetcher } = provider();
    await instance.load();
    await instance.unload();
    await expect(instance.clearCache()).resolves.toBe(true);
    expect(caches.buckets.has(LITERT_MODEL_CACHE)).toBe(false);
    await expect(instance.readiness()).resolves.toMatchObject({ reason: "download" });
    await instance.load();
    expect(fetcher.calls).toHaveLength(2);
  });
});

// ── chat ────────────────────────────────────────────────────────────────────────────────────────

describe("chat", () => {
  it("hands the task ONE prompt in the model's turn format, ending with the open model turn", async () => {
    withWebGpu();
    const task = mockTask(["hello there"]);
    const { instance } = provider({}, task);
    const res = await instance.chat({
      messages: [
        { role: "system", content: "you are 00" },
        { role: "user", content: "hi" },
      ],
    });
    expect(task.prompts[0]).toBe("<start_of_turn>user\nyou are 00\n\nhi<end_of_turn>\n<start_of_turn>model\n");
    expect(res.message.content).toBe("hello there");
    expect(res.finishReason).toBe("stop");
  });

  it("folds the fallback instruction into the system turn and parses the call back out", async () => {
    withWebGpu();
    const task = mockTask(['{"tool_call": {"name": "ls", "arguments": {"path": "."}}}']);
    const { instance } = provider({}, task);
    const res = await instance.chat({
      messages: [
        { role: "system", content: "you are 00" },
        { role: "user", content: "list" },
      ],
      tools: [{ name: "ls", description: "list", parameters: { type: "object" } }],
    });
    expect(task.prompts[0]).toContain("you are 00");
    expect(task.prompts[0]).toContain("- ls: list");
    expect(task.prompts[0]?.indexOf("you are 00")).toBeLessThan(task.prompts[0]?.indexOf("- ls: list") ?? 0);
    expect(res.message.toolCalls).toEqual([{ id: "call_0", name: "ls", arguments: { path: "." } }]);
    expect(res.finishReason).toBe("tool_calls");
  });

  it("adds a system turn when the history has none", async () => {
    withWebGpu();
    const task = mockTask(["nothing to call"]);
    const { instance } = provider({}, task);
    await instance.chat({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "ls", description: "l", parameters: {} }] });
    expect(task.prompts[0]?.startsWith("<start_of_turn>user\nYou can use tools.")).toBe(true);
  });

  it("cuts the answer at the turn the model wrote past its own", async () => {
    withWebGpu();
    const task = mockTask(["the answer.<end_of_turn>\n<start_of_turn>user\nand then I asked"]);
    const { instance } = provider({}, task);
    const res = await instance.chat({ messages: [{ role: "user", content: "?" }] });
    expect(res.message.content).toBe("the answer.");
  });

  it("counts tokens when the task can, and reports none when it cannot", async () => {
    withWebGpu();
    const counting = mockTask(["hey"], { tokens: 1 });
    const { instance } = provider({}, counting);
    const res = await instance.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.usage).toEqual({ inputTokens: (counting.prompts[0] ?? "").length, outputTokens: 3 });

    const silent = mockTask(["hey"]);
    const { instance: other } = provider({}, silent);
    expect((await other.chat({ messages: [] })).usage).toBeUndefined();
  });

  it("re-configures the task only when a request actually changes a sampler value", async () => {
    withWebGpu();
    const task = mockTask(["ok"]);
    const { instance } = provider({ temperature: 0.2 }, task);
    await instance.chat({ messages: [], temperature: 0.2 });
    expect(task.options).toEqual([]);
    await instance.chat({ messages: [], temperature: 0.9, maxTokens: 128 });
    expect(task.options).toEqual([{ temperature: 0.9, maxTokens: 128 }]);
    await instance.chat({ messages: [], temperature: 0.9, maxTokens: 128 });
    expect(task.options).toHaveLength(1);
  });

  it("refuses on an aborted signal without loading anything", async () => {
    withWebGpu();
    const controller = new AbortController();
    controller.abort();
    const createTask = vi.fn();
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, caches: memoryCaches(), createTask });
    await expect(instance.chat({ messages: [], signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("cancels the decode when the signal fires mid-answer", async () => {
    withWebGpu();
    const task = mockTask(["a", "b", "c", "d"], { slow: true });
    const { instance } = provider({}, task);
    await instance.load();
    const controller = new AbortController();
    const answer = instance.chat({ messages: [], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(answer).rejects.toMatchObject({ code: "aborted" });
    expect(task.cancels).toBe(1);
  });

  it("types a failed generation rather than leaking it raw", async () => {
    withWebGpu();
    const { instance } = provider({}, mockTask([], { fail: new Error("out of memory") }));
    await expect(instance.chat({ messages: [] })).rejects.toMatchObject({ code: "network", providerId: "local-litert" });
  });
});

// ── stream ──────────────────────────────────────────────────────────────────────────────────────

describe("stream", () => {
  it("streams the answer and closes with the whole of it", async () => {
    withWebGpu();
    const task = mockTask(["The quick brown fox ", "jumps over the lazy dog."]);
    const { instance } = provider({}, task);
    const out = await collect(instance.stream({ messages: [{ role: "user", content: "?" }] }));
    const text = out
      .filter((c): c is { type: "text"; delta: string } => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text).toBe("The quick brown fox jumps over the lazy dog.");
    const done = out.at(-1);
    expect(done).toMatchObject({ type: "done" });
    expect(done?.type === "done" && done.response.message.content).toBe("The quick brown fox jumps over the lazy dog.");
  });

  it("never streams a turn marker to a reader, and stops the decode when it sees one", async () => {
    withWebGpu();
    const task = mockTask(["Here is the answer that is long enough to flush.", "<end_of_turn>\n<start_of_turn>user\nnot mine"]);
    const { instance } = provider({}, task);
    const out = await collect(instance.stream({ messages: [] }));
    const text = out
      .filter((c): c is { type: "text"; delta: string } => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text).toBe("Here is the answer that is long enough to flush.");
    expect(text).not.toContain("<");
    expect(task.cancels).toBeGreaterThan(0);
  });

  it("yields the tool call the fallback found, then the done chunk", async () => {
    withWebGpu();
    const task = mockTask(['{"tool_call": {"name": "ls", ', '"arguments": {}}}']);
    const { instance } = provider({}, task);
    const out = await collect(instance.stream({ messages: [], tools: [{ name: "ls", description: "l", parameters: {} }] }));
    expect(out.find((c) => c.type === "tool_call")).toEqual({ type: "tool_call", call: { id: "call_0", name: "ls", arguments: {} } });
    const done = out.at(-1);
    expect(done?.type === "done" && done.response.finishReason).toBe("tool_calls");
    expect(done?.type === "done" && done.response.message.content).toBe("");
  });

  it("falls back to the resolved string for a task that streams nothing", async () => {
    withWebGpu();
    const task = mockTask(["quiet"], { silent: true, whole: "the whole answer" });
    const { instance } = provider({}, task);
    const out = await collect(instance.stream({ messages: [] }));
    expect(out.filter((c) => c.type === "text")).toEqual([{ type: "text", delta: "the whole answer" }]);
  });

  it("stops the decode when the person does, rather than generating into a stream nobody reads", async () => {
    withWebGpu();
    const task = mockTask(["one two three four five six seven", " eight nine ten"]);
    const { instance } = provider({}, task);
    const controller = new AbortController();
    const iterator = instance.stream({ messages: [], signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    expect(task.cancels).toBe(1);
  });

  it("refuses before it loads when the signal is already aborted", async () => {
    withWebGpu();
    const controller = new AbortController();
    controller.abort();
    const createTask = vi.fn();
    const instance = new LiteRtProvider({ modelBaseUrl: BASE, caches: memoryCaches(), createTask });
    await expect(collect(instance.stream({ messages: [], signal: controller.signal }))).rejects.toMatchObject({ code: "aborted" });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("types a failed generation rather than leaking it raw", async () => {
    withWebGpu();
    const { instance } = provider({}, mockTask([], { fail: new Error("device lost") }));
    await expect(collect(instance.stream({ messages: [] }))).rejects.toMatchObject({ code: "network" });
  });
});
