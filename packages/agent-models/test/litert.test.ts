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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LITERT_CATALOG,
  LITERT_DEFAULT_MODEL_ID,
  LITERT_DEFAULT_WASM_PATH,
  LITERT_MAX_IMAGES,
  LITERT_MODEL_CACHE,
  LITERT_NATIVE_TOOLS,
  LITERT_UNVERIFIED_ASSETS,
  LITERT_VERSION,
  LiteRtProvider,
  GEMMA_TERMS,
  litertAssetUrl,
  litertCatalogFor,
  mergeMirrorCatalog,
  parseMirrorCatalog,
} from "../src/litert.js";
import type {
  LiteRtCacheLike,
  LiteRtCacheStorageLike,
  LiteRtImageSource,
  LiteRtProgress,
  LiteRtPrompt,
  LiteRtTaskLike,
  LiteRtTaskOptions,
} from "../src/litert.js";
import { hostsOf, offeredOn } from "../src/types.js";
import type { ReadinessProgress } from "../src/types.js";
import type { ImagePart } from "../src/types.js";
import { collect } from "./helpers.js";

/** A prompt as one string, with each picture standing in as `<image>`. */
function promptText(query: LiteRtPrompt): string {
  const parts = Array.isArray(query) ? query : [query];
  return parts.map((part) => (typeof part === "string" ? part : "<image>")).join("");
}

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
/** What the runtime was handed, as bytes — a reader since 2026-09-11 (a 3 GB model is never one buffer). */
async function bytesHanded(handed: Uint8Array | ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!handed) return new Uint8Array(0);
  if (handed instanceof Uint8Array) return handed;
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await handed.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

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
          // A real Cache keeps the headers of the put; the provider reads Content-Length back.
          return hit ? new Response(hit.slice(0), { headers: { "content-length": String(hit.byteLength) } }) : undefined;
        },
        async put(request: string, response: Response) {
          bucket.set(request, await response.arrayBuffer());
        },
        async delete(request: string) {
          return bucket.delete(request);
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
  /** The prompt as TEXT — an image part renders as `<image>`, so every text assertion still reads. */
  prompts: string[];
  /** The prompt as it was actually handed over: a string, or the `PromptPart[]` of a vision turn. */
  parts: LiteRtPrompt[];
  options: Record<string, unknown>[];
  cancels: number;
  closes: number;
}

/** A task that replays `chunks` through the progress listener and resolves with their concatenation. */
function mockTask(chunks: string[], opts: { fail?: unknown; tokens?: number; silent?: boolean; whole?: string; slow?: boolean } = {}): MockTask {
  let cancelled = false;
  const task: MockTask = {
    prompts: [],
    parts: [],
    options: [],
    cancels: 0,
    closes: 0,
    async generateResponse(query: LiteRtPrompt, listener?: (partial: string, done: boolean) => unknown) {
      task.parts.push(query);
      task.prompts.push(promptText(query));
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
    sizeInTokens(query: LiteRtPrompt) {
      return opts.tokens === undefined ? undefined : promptText(query).length;
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

  // The second thing that can vouch for a file name: the mirror's own catalog, snapshotted after a
  // publish (every entry in it was sha256-checked against the Hub's record on the way up).
  const mirrorFiles = new Set<string>(
    (JSON.parse(readFileSync(new URL("./fixtures/litert-mirror-catalog.json", import.meta.url), "utf8")) as { assets: { file: string }[] }).assets.map((a) => a.file),
  );

  it("TWIN GUARD: every asset name it claims to have verified is in the installed README or on the mirror, verbatim", () => {
    const unverified = new Set<string>(LITERT_UNVERIFIED_ASSETS);
    const verified = LITERT_CATALOG.filter((m) => !unverified.has(m.id));
    expect(verified.length).toBeGreaterThan(0);
    for (const model of verified) {
      const vouched = installedReadme.includes(model.assetFile) || mirrorFiles.has(model.assetFile);
      expect(vouched, `${model.assetFile} is named neither in the installed README nor in the mirror catalog`).toBe(true);
    }
  });

  it("offers nothing the mirror does not serve", () => {
    for (const model of LITERT_CATALOG) {
      expect(mirrorFiles.has(model.assetFile), `${model.assetFile} is not on dl.0-0.chat/litert`).toBe(true);
    }
  });

  it("declares the unverified rows as unverified, and they are rows", () => {
    for (const id of LITERT_UNVERIFIED_ASSETS) {
      const model = LITERT_CATALOG.find((m) => m.id === id);
      expect(model, `${id} is flagged unverified but is not in the catalogue`).toBeDefined();
      // Being unverified means exactly this: neither source names the file.
      expect(installedReadme.includes(model?.assetFile ?? "") || mirrorFiles.has(model?.assetFile ?? "")).toBe(false);
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
      expect(["gemma", "apache-2.0"]).toContain(model.license.id);
      if (model.license.id === "gemma") expect(model.license.useRestrictionsUrl).toContain("prohibited_use_policy");
      expect(model.assetFile).toMatch(/\.(task|litertlm)$/);
      expect(ids.has(model.id), `${model.id} is listed twice`).toBe(false);
      ids.add(model.id);
    }
  });

  it("gates every row to a harness, and only the two smallest reach a phone", () => {
    // THE ONE GATE (Bruno, 2026-09-11: "gate the models to the compatible harness"). It is a list on
    // the row, not an inequality over `vramMb`: the judgement about a device is written down once.
    for (const model of LITERT_CATALOG) expect(model.hosts, model.id).toBeDefined();
    expect(LITERT_CATALOG.filter((m) => offeredOn(m, "browser-phone")).map((m) => m.id)).toEqual([
      "gemma3-270m-it-q4_0-web",
      "gemma3-1b-it-int4-web",
    ]);
    expect(LITERT_CATALOG.every((m) => offeredOn(m, "browser-desktop"))).toBe(true);
    expect(litertCatalogFor({ host: "browser-phone" }).map((m) => m.id)).toEqual(["gemma3-270m-it-q4_0-web", "gemma3-1b-it-int4-web"]);
    // These weights run in a tab; the Mac engine and a headless install serve their own models.
    expect(litertCatalogFor({ host: "mac" })).toEqual([]);
    expect(litertCatalogFor({ host: "headless" })).toEqual([]);
    // A row that named no harness would be read as desktop-only — the conservative default.
    expect(hostsOf({})).toEqual(["browser-desktop"]);
    expect(offeredOn({}, "browser-phone")).toBe(false);
    expect(hostsOf({ hosts: ["mac"] })).toEqual(["mac"]);
  });

  it("filters to a phone's cap, so a phone is offered one model and not a wall", () => {
    const phone = litertCatalogFor({ maxVramMb: 2000 });
    expect(phone.map((m) => m.id)).toEqual(["gemma3-270m-it-q4_0-web", "gemma3-1b-it-int4-web"]);
    // The default is NOT the phone row: it is the smallest asset the mirror serves today (§12.7),
    // whose licence carries no use restrictions; the 1B joins the mirror with the gated publish.
    expect(LITERT_DEFAULT_MODEL_ID).toBe("gemma-4-E2B-it-web");
    expect(litertCatalogFor()).toHaveLength(LITERT_CATALOG.length);
  });

  /**
   * `contextTokens` is the KV-cache budget asked for at load, so the numbers are a trade and the
   * trade is pinned: the phone rows stay small deliberately, and everything else got the room the
   * 5.2k-token system prompt needed on 2026-09-11.
   */
  it("asks for 8192 tokens on the Gemma 4 and 3n rows, and 4096 on the phone rows", () => {
    const byId = new Map(LITERT_CATALOG.map((m) => [m.id, m.contextTokens]));
    expect(byId.get("gemma3-270m-it-q4_0-web")).toBe(4096);
    expect(byId.get("gemma3-1b-it-int4-web")).toBe(4096);
    for (const id of ["gemma-3n-E2B-it-int4-Web", "gemma-3n-E4B-it-int4-Web", "gemma-4-E2B-it-web", "gemma-4-E4B-it-web", "gemma-4-12B-it-web"]) {
      expect(byId.get(id), id).toBe(8192);
    }
    // Nothing is left unsaid: a row with no budget would be loaded with MediaPipe's own default.
    for (const model of LITERT_CATALOG) expect(typeof model.contextTokens, model.id).toBe("number");
  });

  it("hands the row's contextTokens to the task as `maxTokens` AT LOAD, and lets a caller override", async () => {
    withWebGpu();
    const seen: (number | undefined)[] = [];
    const make = (over: Record<string, unknown>) =>
      new LiteRtProvider({
        modelBaseUrl: BASE,
        caches: memoryCaches(),
        fetch: assetFetch([1, 2, 3]).fetch,
        createTask: async (options: LiteRtTaskOptions) => {
          seen.push(options.maxTokens);
          return mockTask(["ok"]);
        },
        ...over,
      });
    await make({ modelId: "gemma-4-E2B-it-web" }).load();
    await make({ modelId: "gemma3-270m-it-q4_0-web" }).load();
    await make({ modelId: "gemma-4-E2B-it-web", maxTokens: 1024 }).load();
    expect(seen).toEqual([8192, 4096, 1024]);
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
    expect(instance.assetUrl).toBe(`${BASE}/${LITERT_CATALOG.find((m) => m.id === LITERT_DEFAULT_MODEL_ID)?.assetFile}`);
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
    expect(fetcher.calls).toEqual([`${BASE}/${LITERT_CATALOG.find((m) => m.id === LITERT_DEFAULT_MODEL_ID)?.assetFile}`]);
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
    // Two reports: the cache hit, then the compile that follows every load (phase "load", 2026-09-11).
    expect(reports).toEqual([
      { progress: 1, loadedBytes: 0, text: expect.stringContaining("already on this device") },
      expect.objectContaining({ progress: 1, text: expect.stringContaining("into the GPU") }),
    ]);
  });

  it("reads the whole body at once when the response has no stream to read", async () => {
    withWebGpu();
    const whole = assetFetch([7, 8, 9], { body: false });
    let handed: Uint8Array | ReadableStreamDefaultReader<Uint8Array> | undefined;
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
    expect([...(await bytesHanded(handed))]).toEqual([7, 8, 9]);
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
    // A SIGNATURE, not the schema dump (2026-09-11): the whole instruction has to fit beside the
    // conversation in a context this provider itself asks for at load.
    expect(task.prompts[0]).toContain("ls() — list");
    expect(task.prompts[0]).not.toContain("arguments schema:");
    expect(task.prompts[0]?.indexOf("you are 00")).toBeLessThan(task.prompts[0]?.indexOf("ls() — list") ?? 0);
    expect(res.message.toolCalls).toEqual([{ id: "call_0", name: "ls", arguments: { path: "." } }]);
    expect(res.finishReason).toBe("tool_calls");
  });

  it("spends the raw schemas only on a row whose catalogue says it has the context for them", async () => {
    withWebGpu();
    const task = mockTask(["nothing"]);
    const { instance } = provider(
      {
        modelId: "big",
        catalog: [
          { id: "big", label: "Big", class: "strong", local: true, supportsTools: true, contextTokens: 131072, vramMb: 1, assetFile: "big.task", family: "gemma", license: GEMMA_TERMS },
        ],
      },
      task,
    );
    await instance.chat({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "ls", description: "list", parameters: { type: "object" } }] });
    expect(task.prompts[0]).toContain("arguments schema:");
  });

  it("adds a system turn when the history has none", async () => {
    withWebGpu();
    const task = mockTask(["nothing to call"]);
    const { instance } = provider({}, task);
    await instance.chat({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "ls", description: "l", parameters: {} }] });
    expect(task.prompts[0]?.startsWith("<start_of_turn>user\nTo use a tool, reply with ONLY:")).toBe(true);
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

// ── The typed progress, and the mirror's catalogue (contract revision 2026-09-10) ────────────────

/**
 * A fetch whose body the TEST drives: one chunk at a time, so readiness can be asked at a moment
 * that genuinely is "half way down" rather than at whatever moment the microtask queue happened to
 * reach. `push` resolves once the provider has consumed the chunk.
 */
function gatedFetch(total?: number): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  push(byte: number): Promise<void>;
  end(): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    async fetch() {
      const headers: Record<string, string> = total === undefined ? {} : { "Content-Length": String(total) };
      return new Response(stream, { status: 200, headers });
    },
    async push(byte: number) {
      controller?.enqueue(new Uint8Array([byte]));
      // Two turns of the microtask queue is enough for the reader to take it and report.
      await Promise.resolve();
      await Promise.resolve();
    },
    end() {
      controller?.close();
    },
  };
}

describe("readiness carries a typed progress while the asset is coming down", () => {
  it("has none before the download starts, bytes and a percentage during it, and none once ready", async () => {
    withWebGpu();
    const gate = gatedFetch(4);
    const instance = new LiteRtProvider({
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: gate.fetch,
      createTask: async () => mockTask(["ok"]),
    });

    const before = await instance.readiness();
    expect(before).toMatchObject({ ready: false, reason: "download" });
    expect(before.ready === false && before.progress).toBeUndefined();
    expect(before.ready === false && before.detail).toContain("has not been downloaded");

    const loading = instance.load();
    // The resumable download reads its meta from the cache before it fetches; give it that tick.
    await new Promise((r) => setTimeout(r, 5));
    await gate.push(1);
    const quarter = await instance.readiness();
    expect(quarter).toMatchObject({
      ready: false,
      reason: "download",
      progress: { loadedBytes: 1, totalBytes: 4, percent: 25 },
    });
    expect(quarter.ready === false && quarter.detail).toContain("Downloading");

    await gate.push(2);
    await gate.push(3);
    await gate.push(4);
    gate.end();
    await loading;
    await expect(instance.readiness()).resolves.toEqual({ ready: true });
  });

  it("leaves the percentage out when the host sent no Content-Length", async () => {
    withWebGpu();
    const gate = gatedFetch();
    const instance = new LiteRtProvider({
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: gate.fetch,
      createTask: async () => mockTask(["ok"]),
    });
    const loading = instance.load();
    await gate.push(1);
    const mid = await instance.readiness();
    // Bytes are known, the total is not, and nothing is invented in between.
    expect(mid).toMatchObject({ ready: false, progress: { loadedBytes: 1 } });
    const progress: ReadinessProgress | undefined = mid.ready === false ? mid.progress : undefined;
    expect(progress?.totalBytes).toBeUndefined();
    expect(progress?.percent).toBeUndefined();
    gate.end();
    await loading;
  });
});

describe("the mirror's catalogue", () => {
  const mirrorJson: unknown = JSON.parse(
    readFileSync(new URL("./fixtures/litert-mirror-catalog.json", import.meta.url), "utf8"),
  );

  it("parses the document the publish script actually writes", () => {
    const parsed = parseMirrorCatalog(mirrorJson);
    expect(parsed?.base).toBe("https://dl.0-0.chat/litert");
    expect(parsed?.assets).toHaveLength(7);
    expect(parsed?.assets[0]).toMatchObject({ file: "gemma-4-E2B-it-web.task", license: "apache-2.0", vision: false });
  });

  it("refuses a document that is not one, rather than half a catalogue", () => {
    expect(parseMirrorCatalog(null)).toBeNull();
    expect(parseMirrorCatalog("nope")).toBeNull();
    expect(parseMirrorCatalog({ base: "https://h", assets: "no" })).toBeNull();
    expect(parseMirrorCatalog({ assets: [{ file: "a.task" }] })).toBeNull();
    // Every row unusable ⇒ no catalogue at all, so the caller falls back to the package's.
    expect(parseMirrorCatalog({ base: "https://h", assets: [{ file: "../etc/passwd" }, { file: "a/b.task" }, {}] })).toBeNull();
  });

  it("joins the mirror to the package on the file name, keeping the mirror's order and bytes", () => {
    const rows = mergeMirrorCatalog(parseMirrorCatalog(mirrorJson));
    expect(rows.map((r) => r.assetFile)).toEqual([
      "gemma-4-E2B-it-web.task",
      "gemma-4-E4B-it-web.task",
      "gemma-4-12B-it-web.litertlm",
      "gemma-3n-E2B-it-int4-Web.litertlm",
      "gemma-3n-E4B-it-int4-Web.litertlm",
      "gemma3-270m-it-q4_0-web.task",
      "gemma3-1b-it-int4-web.task",
    ]);
    const phone = rows.find((r) => r.id === "gemma3-270m-it-q4_0-web");
    // The package's numbers survive the join…
    expect(phone).toMatchObject({ label: "Gemma 3 270m (q4)", vramMb: 600, family: "gemma", onMirror: true });
    // …and the mirror's facts arrive with it, the licence copy included.
    expect(phone).toMatchObject({ bytes: 249233408, gatedAtSource: true, vision: false });
    expect(phone?.license.termsCopyUrl).toBe("https://dl.0-0.chat/litert/GEMMA_TERMS.md");
    expect(phone?.license.useRestrictionsUrl).toContain("prohibited_use_policy");
    expect(rows.every((r) => r.estimated === undefined)).toBe(true);
    // The fixture predates `hosts`, so the package's own judgement is what survives the join — which
    // is the point of the field being additive on both sides.
    expect(phone?.hosts).toEqual(["browser-desktop", "browser-phone"]);
  });

  it("still offers a row the package has never heard of, with its numbers marked estimated", () => {
    const rows = mergeMirrorCatalog({
      version: 1,
      base: "https://dl.0-0.chat/litert",
      assets: [
        {
          file: "gemma-9-XL-it-web.litertlm",
          bytes: 4_000_000_000,
          license: "gemma",
          licenseName: "Gemma Terms of Use",
          licenseUrl: "https://ai.google.dev/gemma/terms",
          vision: true,
        },
        // No licence at all: nothing can be shown before the download, so it is not offered.
        { file: "mystery.task", bytes: 10 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "gemma-9-XL-it-web",
      label: "gemma-9-XL-it-web",
      class: "strong",
      vision: true,
      estimated: true,
      onMirror: true,
      vramMb: 6000,
    });
  });

  it("falls back to the package's rows, flagged, when there is no mirror to join", () => {
    const rows = mergeMirrorCatalog(null);
    expect(rows).toHaveLength(LITERT_CATALOG.length);
    expect(rows.every((r) => r.onMirror === false)).toBe(true);
    expect(rows.every((r) => r.bytes === undefined)).toBe(true);
  });

  it("takes the mirror's `hosts` and its attribution line when it publishes them, and drops a word it does not know", () => {
    // Through `parseMirrorCatalog`, which is the only road this document ever takes in the app: the
    // sanitising of a field somebody else wrote belongs to the parser, and `mergeMirrorCatalog` is
    // then free to trust what it is handed.
    const rows = mergeMirrorCatalog(parseMirrorCatalog({
      version: 1,
      base: "https://h",
      assets: [
        // A publisher NARROWING a row: the package offers the 270m to a phone, this mirror does not.
        { file: "gemma3-270m-it-q4_0-web.task", bytes: 10, hosts: ["browser-desktop"] },
        // A row of the mirror's own, with an attribution line the licence requires shown.
        {
          file: "llama-ish.task",
          bytes: 2_000_000_000,
          license: "llama3.2",
          licenseName: "Llama 3.2 Community License",
          licenseUrl: "https://www.llama.com/llama3_2/license/",
          attribution: "Built with Llama",
          hosts: ["browser-desktop", "toaster"] as never,
        },
      ],
    }));
    expect(rows[0]?.hosts).toEqual(["browser-desktop"]);
    expect(rows[1]?.license.attribution).toBe("Built with Llama");
    // `toaster` is not a harness this repo has a picker for, so it is dropped rather than passed on.
    expect(rows[1]?.hosts).toEqual(["browser-desktop"]);
  });

  it("offers a row that names NO harness on the desktop only, whatever its size suggests", () => {
    const rows = mergeMirrorCatalog(parseMirrorCatalog({
      version: 1,
      base: "https://h",
      assets: [
        {
          file: "tiny-unknown.task",
          bytes: 100_000_000,
          license: "apache-2.0",
          licenseName: "Apache License 2.0",
          licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
        },
      ],
    }));
    // 100 MB and `estimated` — small enough that an inequality would have put it on a phone. The list
    // does not, because nobody has said it runs there.
    expect(rows[0]).toMatchObject({ estimated: true, hosts: ["browser-desktop"] });
    expect(offeredOn(rows[0]!, "browser-phone")).toBe(false);
    // A `hosts` array with nothing usable in it is the same as none at all.
    const empty = mergeMirrorCatalog(parseMirrorCatalog({ version: 1, base: "https://h", assets: [{ file: "gemma3-1b-it-int4-web.task", hosts: [] }] }));
    expect(empty[0]?.hosts).toEqual(["browser-desktop", "browser-phone"]);
  });

  it("leaves out a package row the host does not serve — a download that would 404", () => {
    const rows = mergeMirrorCatalog({ version: 1, base: "https://h", assets: [{ file: "gemma3-1b-it-int4-web.task" }] });
    expect(rows.map((r) => r.id)).toEqual(["gemma3-1b-it-int4-web"]);
    expect(rows[0].license).toEqual(GEMMA_TERMS);
  });
});

// ── Pictures (gap B10) ──────────────────────────────────────────────────────────────────────────

describe("showing a picture to a local model", () => {
  const shot: ImagePart = { mime: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]), source: "shot.png" };
  const asked = { messages: [{ role: "user" as const, content: "what is this?", images: [shot] }] };

  beforeEach(withWebGpu);

  /** A provider whose task creation is recorded, and whose picture conversion is faked (rule 4a). */
  function visionProvider(overrides: Partial<ConstructorParameters<typeof LiteRtProvider>[0]> = {}) {
    const created: LiteRtTaskOptions[] = [];
    const sources: ImagePart[] = [];
    const task = mockTask(["ok"]);
    const instance = new LiteRtProvider({
      modelBaseUrl: BASE,
      modelId: "gemma-3n-E2B-it-int4-Web",
      caches: memoryCaches(),
      fetch: assetFetch([1, 2, 3, 4]).fetch,
      createTask: async (options) => {
        created.push(options);
        return task;
      },
      createImageSource: async (image): Promise<LiteRtImageSource> => {
        sources.push(image);
        return `bitmap:${image.source ?? "?"}`;
      },
      ...overrides,
    });
    return { instance, created, sources, task };
  }

  it("says which catalogue rows can see, from the flag the mirror publishes", () => {
    const seeing = LITERT_CATALOG.filter((m) => m.vision).map((m) => m.id);
    // The Gemma 3n web builds are the vision rows; the Gemma 4 web builds are text-only per their card.
    expect(seeing).toEqual(["gemma-3n-E2B-it-int4-Web", "gemma-3n-E4B-it-int4-Web"]);
    expect(LITERT_CATALOG.find((m) => m.id === "gemma-4-E2B-it-web")?.vision).toBeUndefined();
    expect(new LiteRtProvider({ modelBaseUrl: BASE, modelId: "gemma-3n-E2B-it-int4-Web" }).seesImages).toBe(true);
    expect(new LiteRtProvider({ modelBaseUrl: BASE }).seesImages).toBe(false);
    // A row that is in no catalogue can still be told what it is.
    expect(new LiteRtProvider({ modelBaseUrl: BASE, modelId: "x", assetFile: "x.task", vision: true }).seesImages).toBe(true);
  });

  it("takes the flag from a MERGED mirror row, which is what the picker builds a provider from", () => {
    const rows = mergeMirrorCatalog(parseMirrorCatalog(JSON.parse(readFileSync(new URL("./fixtures/litert-mirror-catalog.json", import.meta.url), "utf8"))));
    const from = (id: string) => new LiteRtProvider({ modelBaseUrl: BASE, modelId: id, catalog: rows }).seesImages;
    expect(from("gemma-3n-E4B-it-int4-Web")).toBe(true);
    expect(from("gemma3-270m-it-q4_0-web")).toBe(false);
  });

  it("creates the task with maxNumImages ONLY for a vision row, since the option is the modality switch", async () => {
    const seeing = visionProvider();
    await seeing.instance.chat(asked);
    expect(seeing.created[0]?.maxNumImages).toBe(LITERT_MAX_IMAGES);
    expect(LITERT_MAX_IMAGES).toBe(4);

    const text = visionProvider({ modelId: LITERT_DEFAULT_MODEL_ID });
    await text.instance.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(text.created[0]).not.toHaveProperty("maxNumImages");
  });

  it("hands the runtime a PromptPart list with the picture inside the turn", async () => {
    const { instance, task, sources } = visionProvider();
    await instance.chat(asked);
    expect(task.parts[0]).toEqual([
      "<start_of_turn>user\n",
      { imageSource: "bitmap:shot.png" },
      "what is this?<end_of_turn>\n<start_of_turn>model\n",
    ]);
    // The conversion happened once, on the part the caller passed, and nowhere else.
    expect(sources).toEqual([shot]);
  });

  it("streams from the same part list, so a picture is not a second code path", async () => {
    const { instance, task } = visionProvider();
    const chunks = await collect(instance.stream(asked));
    expect(chunks.some((c) => c.type === "done")).toBe(true);
    expect(Array.isArray(task.parts[0])).toBe(true);
  });

  it("sends a plain string when a vision row is asked something with no picture in it", async () => {
    const { instance, task } = visionProvider();
    await instance.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(task.parts[0]).toBe("<start_of_turn>user\nhi<end_of_turn>\n<start_of_turn>model\n");
  });

  it("keeps the tool-call instruction where it was, with the picture beside it", async () => {
    const { instance, task } = visionProvider();
    await instance.chat({ ...asked, tools: [{ name: "ls", description: "list", parameters: { type: "object" } }] });
    expect(task.prompts[0]).toContain("ls() — list");
    expect(task.prompts[0]).toContain("<image>");
  });

  it("tells a text-only row's model that a picture was attached, rather than dropping it in silence", async () => {
    const { instance, task, sources } = visionProvider({ modelId: LITERT_DEFAULT_MODEL_ID });
    await instance.chat(asked);
    expect(typeof task.parts[0]).toBe("string");
    expect(task.prompts[0]).toContain("[A picture was attached (shot.png), but this model cannot see pictures.]");
    expect(task.prompts[0]).not.toContain("<image>");
    expect(sources).toEqual([]);
  });

  it("refuses a picture over the cap BEFORE the generation starts, by name", async () => {
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { instance, task } = visionProvider({ createImageSource: undefined });
    await expect(instance.chat({ messages: [{ role: "user", content: "big", images: [{ mime: "image/png", data: huge }] }] })).rejects.toMatchObject({
      code: "bad_request",
      vendorCode: "image_too_large",
      providerId: "local-litert",
    });
    expect(task.prompts).toEqual([]);
  });

  it("falls back to a data URL where the host has no createImageBitmap — which is every Node run", async () => {
    const { instance, task } = visionProvider({ createImageSource: undefined });
    await instance.chat(asked);
    const parts = task.parts[0] as (string | { imageSource: LiteRtImageSource })[];
    expect(parts[1]).toEqual({ imageSource: "data:image/png;base64,iVBORw0KGgoH" });
  });

  it("uses createImageBitmap when the host has one, so a browser sends a decoded bitmap", async () => {
    const blobs: { type: string; size: number }[] = [];
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      blobs.push({ type: blob.type, size: blob.size });
      return "an-image-bitmap" as unknown as ImageBitmap;
    });
    const { instance, task } = visionProvider({ createImageSource: undefined });
    await instance.chat(asked);
    expect(blobs).toEqual([{ type: "image/png", size: shot.data.length }]);
    expect((task.parts[0] as { imageSource: LiteRtImageSource }[])[1]).toEqual({ imageSource: "an-image-bitmap" });
  });
});

describe("the load phase (2026-09-11: the compile after the download is a wait of its own)", () => {
  it("answers 'download' with phase=load while the task is being built, then ready", async () => {
    withWebGpu();
    let finish: (t: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const seen: string[] = [];
    const provider = new LiteRtProvider({
      modelId: "gemma3-270m-it-q4_0-web",
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: assetFetch([1, 2, 3, 4]).fetch,
      onProgress: (p) => seen.push(p.text),
      createTask: async () => (await gate) as LiteRtTaskLike,
    });
    const loading = provider.load();
    // Let the download finish and the compile begin.
    await new Promise((r) => setTimeout(r, 10));
    const mid = await provider.readiness();
    expect(mid).toMatchObject({
      ready: false,
      reason: "download",
      progress: { phase: "load", percent: 100, loadedBytes: 4, totalBytes: 4 },
    });
    expect((mid as { detail?: string }).detail).toMatch(/Loading .* into the GPU/);
    expect(seen.at(-1)).toMatch(/Loading .* into the GPU/);
    finish(mockTask(["ok"]));
    await loading;
    expect(await provider.readiness()).toEqual({ ready: true });
  });
});

describe("abortLoad (2026-09-11: Stop pulls the download or abandons the compile)", () => {
  it("stops a download in flight: the load rejects as aborted and readiness goes back to 'not downloaded'", async () => {
    withWebGpu();
    let release: () => void = () => {};
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        release = () => controller.close();
      },
    });
    const provider = new LiteRtProvider({
      modelId: "gemma3-270m-it-q4_0-web",
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: async (_url: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              const reader = slowBody.getReader();
              // Once the abort has errored this controller, the source's close and its last chunk
              // have nowhere to go — swallowed, as a real network stream's late bytes would be.
              const pump = (): void => {
                void reader.read().then(({ done, value }) => {
                  try {
                    if (done) return c.close();
                    c.enqueue(value!);
                  } catch {
                    return;
                  }
                  pump();
                });
              };
              pump();
              const signal = init?.signal ?? undefined;
              signal?.addEventListener("abort", () => c.error(signal.reason));
            },
          }),
          { status: 200, headers: { "content-length": "4" } },
        ),
      createTask: async () => mockTask(["ok"]),
    });
    const loading = provider.load();
    await new Promise((r) => setTimeout(r, 10));
    provider.abortLoad();
    await expect(loading).rejects.toMatchObject({ code: "aborted" });
    const after = await provider.readiness();
    expect(after).toMatchObject({ ready: false, reason: "download" });
    expect((after as { progress?: unknown }).progress).toBeUndefined();
    release();
  });

  it("closes a task that arrives after a stop during the compile, and is a no-op with nothing loading", async () => {
    withWebGpu();
    let finish: (t: LiteRtTaskLike) => void = () => {};
    const closed: string[] = [];
    const provider = new LiteRtProvider({
      modelId: "gemma3-270m-it-q4_0-web",
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      fetch: assetFetch([1, 2, 3, 4]).fetch,
      createTask: async () => new Promise((resolve) => (finish = resolve)) as Promise<LiteRtTaskLike>,
    });
    provider.abortLoad(); // nothing loading: nothing happens
    const loading = provider.load();
    await new Promise((r) => setTimeout(r, 10));
    provider.abortLoad();
    const task = mockTask(["ok"]);
    (task as { close?: () => void }).close = () => closed.push("closed");
    finish(task);
    await expect(loading).rejects.toMatchObject({ code: "aborted" });
    expect(closed).toEqual(["closed"]);
    expect(await provider.readiness()).toMatchObject({ ready: true }); // the bytes are cached; a new load compiles again
  });
});


describe("resumable downloads (2026-09-11: a closed tab or a Stop no longer starts a 2 GB download over)", () => {
  /** A host that does ranges: 206 + Content-Range for a Range request, 200 otherwise; an abortable body. */
  function rangeHost(data: number[], opts: { ranges?: boolean } = {}) {
    const calls: { range: string | null }[] = [];
    let abortNext = -1;
    return {
      calls,
      /** Make the NEXT response's body error after `n` bytes, as a dropped connection would. */
      cutAfter(n: number) {
        abortNext = n;
      },
      async fetch(_url: string, init?: RequestInit) {
        const range = new Headers(init?.headers).get("range");
        calls.push({ range });
        const from = range && opts.ranges !== false ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
        const slice = data.slice(from);
        const cut = abortNext;
        abortNext = -1;
        // Pull-based, one byte per read: an `error()` inside `start()` would throw away the bytes
        // already queued, which is not how a dropped connection behaves.
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (cut >= 0 && sent >= cut) {
              c.error(new TypeError("network dropped"));
              return;
            }
            if (sent >= slice.length) {
              c.close();
              return;
            }
            c.enqueue(new Uint8Array([slice[sent]!]));
            sent += 1;
          },
        });
        const headers: Record<string, string> = {};
        if (range && opts.ranges !== false) {
          headers["content-range"] = `bytes ${from}-${data.length - 1}/${data.length}`;
          return new Response(body, { status: 206, headers });
        }
        headers["content-length"] = String(data.length);
        return new Response(body, { status: 200, headers });
      },
    };
  }

  it("keeps the complete parts of a cut-off download, says how far it got, and resumes with a Range", async () => {
    withWebGpu();
    const host = rangeHost([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const caches = memoryCaches();
    const make = () =>
      new LiteRtProvider({ modelBaseUrl: BASE, caches, fetch: host.fetch, partBytes: 2, createTask: async () => mockTask(["ok"]) });
    host.cutAfter(5);
    await expect(make().load()).rejects.toBeTruthy();
    // Two full parts (4 bytes) are on disk; the fifth byte, an incomplete part, is not.
    const bucket = caches.buckets.get(LITERT_MODEL_CACHE)!;
    expect([...bucket.keys()].filter((k) => k.includes("?part=")).length).toBe(2);
    const paused = await make().readiness();
    expect(paused).toMatchObject({ ready: false, reason: "download", progress: { loadedBytes: 4, totalBytes: 9, percent: 44, phase: "paused" } });
    expect((paused as { detail: string }).detail).toContain("44 % downloaded");

    const second = make();
    await second.load();
    expect(host.calls.at(-1)!.range).toBe("bytes=4-");
    expect(await second.readiness()).toEqual({ ready: true });
    // The whole asset, and nothing else, is what stays.
    expect([...bucket.keys()].length).toBe(1);
    expect([...bucket.keys()].some((k) => k.includes("?part=") || k.includes("?meta"))).toBe(false);
    expect(new Uint8Array(bucket.get([...bucket.keys()][0]!)!)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it("starts over when the host ignores the Range, and never stitches two answers", async () => {
    withWebGpu();
    const host = rangeHost([1, 2, 3, 4, 5, 6], { ranges: false });
    const caches = memoryCaches();
    const make = () =>
      new LiteRtProvider({ modelBaseUrl: BASE, caches, fetch: host.fetch, partBytes: 2, createTask: async () => mockTask(["ok"]) });
    host.cutAfter(3);
    await expect(make().load()).rejects.toBeTruthy();
    const second = make();
    await second.load();
    expect(host.calls.at(-1)!.range).toBe("bytes=2-"); // asked for a resume…
    const bucket = caches.buckets.get(LITERT_MODEL_CACHE)!;
    const full = [...bucket.keys()].find((k) => !k.includes("?"))!;
    expect(new Uint8Array(bucket.get(full)!)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6])); // …got the whole file, kept it whole
  });
});

/**
 * The same twin guard the ONNX rows have, for the LiteRT half: `scripts/publish-litert-models.sh`
 * writes `hosts` into `catalog.json` per asset, and the app reads the mirror's word over the
 * package's. Two places holding one judgement about which devices may be offered a model is fine
 * only while something checks they agree.
 */
describe("the publish script offers each LiteRT asset to the same harnesses this package does", () => {
  const script = readFileSync(
    new URL("../../../scripts/publish-litert-models.sh", import.meta.url),
    "utf8",
  );
  const rows = script
    .split("\n")
    .filter((line) => /^[\w.-]+\/[\w.-]+\|[0-9a-f]{6,40}\|/.test(line))
    .map((line) => line.split("|"))
    .filter((parts) => (parts[8] ?? "litert") === "litert");

  it("mirrors every catalogue row, with its hosts", () => {
    const byFile = new Map(rows.map((parts) => [parts[2] as string, parts]));
    for (const model of LITERT_CATALOG) {
      const row = byFile.get(model.assetFile);
      expect(row, model.assetFile).toBeDefined();
      expect((row![10] ?? "").split(","), model.assetFile).toEqual(model.hosts);
    }
    // And nothing is published that the package cannot describe: an asset with no row here would be
    // offered with derived numbers and `estimated`, which is a worse first visit than not at all.
    expect(rows).toHaveLength(LITERT_CATALOG.length);
  });
});
