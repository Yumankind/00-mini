/**
 * WebGPU does not exist in Node and neither does Cache Storage, so what is testable here is exactly
 * what this provider decides BEFORE it touches a GPU: the catalogue, the readiness gate, the settings
 * it writes into the library's global `env`, the messages and pictures it hands the processor, the
 * progress it maps, and the two generation paths either side of a mocked `generate()`.
 *
 * THE LIBRARY IS NEVER IMPORTED. `createLibrary` is injected, the same way `createTask` is for LiteRT
 * and `createEngine` for WebLLM — and here the stake is higher than a slow test: resolving
 * `@huggingface/transformers` in Node takes its `node` export condition, which pulls in
 * `onnxruntime-node` (a native addon) and `sharp`. A test that touched it would be testing the wrong
 * build of the library on a platform the browser provider never runs on.
 *
 * THREE TWIN GUARDS read the INSTALLED package rather than a memory of it: its version, the fact that
 * `AutoModelForImageTextToText` and `AutoProcessor` are still exported under those names, and that the
 * repo's four q4f16 graphs still each need exactly one external-data chunk. A file name this provider
 * is wrong about is fifteen 404s minutes into a first visit.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  GEMMA_4_E2B_ONNX_FILES,
  GEMMA_4_E2B_ONNX_PROBE_FILE,
  LOCAL_MODEL_CATALOG,
  ONNX_DEFAULT_WASM_PATH,
  TRANSFORMERS_CATALOG,
  TRANSFORMERS_DEFAULT_MODEL_ID,
  TRANSFORMERS_HUB_HOST,
  TRANSFORMERS_HUB_PATH_TEMPLATE,
  TRANSFORMERS_MAX_IMAGES,
  TRANSFORMERS_MIRROR_PATH_TEMPLATE,
  TRANSFORMERS_MODEL_CACHE,
  TRANSFORMERS_NATIVE_TOOLS,
  TRANSFORMERS_PROVIDER_ID,
  TRANSFORMERS_VERSION,
  TransformersProvider,
  pathTemplateFor,
  transformersCatalogFor,
  transformersFileUrl,
} from "../src/transformers.js";
import type {
  TransformersCacheLike,
  TransformersCacheStorageLike,
  TransformersChatMessage,
  TransformersLibrary,
  TransformersProgress,
} from "../src/transformers.js";
import { LITERT_CATALOG } from "../src/litert.js";
import { collect } from "./helpers.js";

/**
 * The installed package, reached BY PATH and not by `require.resolve`: its `exports` map defines
 * neither `./package.json` nor `./src`, and resolving the module itself would take the `node`
 * condition and load `onnxruntime-node`. The link in `node_modules` is read straight through, which is
 * what the vite plugin does for the same package's wasm.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/@huggingface/transformers");
const installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };

const BASE = "https://models.example/onnx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function withWebGpu(): void {
  vi.stubGlobal("navigator", { gpu: {} });
}

// ── The fake library ─────────────────────────────────────────────────────────────────────────────

interface FakeLibrary extends TransformersLibrary {
  /** Every `apply_chat_template` call, so a test can read the transcript that was built. */
  templated: { messages: TransformersChatMessage[]; options: Record<string, unknown> }[];
  /** Every processor call: `[prompt, images, audio, options]`. */
  processed: { prompt: string; images: unknown; audio: unknown; options: Record<string, unknown> }[];
  /** Every `generate()` call's options, so the sampler and the streamer can be asserted. */
  generated: Record<string, unknown>[];
  /** What `from_pretrained` was asked for. */
  loads: { repo: string; options: Record<string, unknown> }[];
  /** Blobs handed to `load_image`, in order. */
  loadedImages: Blob[];
  disposals: number;
  interrupts: number;
  /** The last `progress_callback` the model load was given, so a test can drive it. */
  emit: (info: TransformersProgress) => void;
}

function fakeLibrary(
  pieces: string[],
  opts: { fail?: unknown; slow?: boolean; failProcessor?: unknown } = {},
): FakeLibrary {
  const lib = {
    env: { backends: { onnx: { wasm: {} } } },
    templated: [],
    processed: [],
    generated: [],
    loads: [],
    loadedImages: [],
    disposals: 0,
    interrupts: 0,
    emit: () => {},
  } as unknown as FakeLibrary;

  const processor = Object.assign(
    async (prompt: string, images: unknown, audio: unknown, options: Record<string, unknown> = {}) => {
      lib.processed.push({ prompt, images, audio, options });
      if (opts.failProcessor) throw opts.failProcessor;
      return { input_ids: `ids(${prompt.length})`, pixel_values: images ? "pixels" : undefined };
    },
    {
      apply_chat_template(messages: TransformersChatMessage[], options: Record<string, unknown> = {}) {
        lib.templated.push({ messages, options });
        // A stand-in for the real Jinja: the roles and the placeholders, which is all any assertion
        // here is about. `<image>` stands where the template would write the image token.
        return messages
          .map((m) => {
            const body =
              typeof m.content === "string"
                ? m.content
                : m.content.map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join("");
            return `<${m.role}>${body}`;
          })
          .join("");
      },
      tokenizer: { name: "fake-tokenizer" },
    },
  );

  lib.AutoProcessor = {
    async from_pretrained(repo: string, options: Record<string, unknown> = {}) {
      lib.loads.push({ repo, options });
      return processor as unknown as TransformersLibrary["AutoProcessor"] extends never ? never : Awaited<ReturnType<TransformersLibrary["AutoProcessor"]["from_pretrained"]>>;
    },
  };

  lib.AutoModelForImageTextToText = {
    async from_pretrained(repo: string, options: Record<string, unknown> = {}) {
      lib.loads.push({ repo, options });
      lib.emit = options.progress_callback as (info: TransformersProgress) => void;
      return {
        async generate(generateOptions: Record<string, unknown>) {
          lib.generated.push(generateOptions);
          if (opts.fail) throw opts.fail;
          const streamer = generateOptions.streamer as { push(piece: string): void } | undefined;
          for (const piece of pieces) {
            // `slow` puts a macrotask between pieces, the only way a test can act while a generation
            // is genuinely in flight.
            await (opts.slow ? new Promise((resolve) => setTimeout(resolve, 2)) : Promise.resolve());
            if ((generateOptions.stopping_criteria as { stopped?: boolean } | undefined)?.stopped) break;
            streamer?.push(piece);
          }
          return { done: true };
        },
        async dispose() {
          lib.disposals += 1;
        },
      };
    },
  };

  // The two library classes, as the shapes this provider actually uses.
  lib.TextStreamer = class {
    private readonly cb: (piece: string) => void;
    constructor(_tokenizer: unknown, options: Record<string, unknown>) {
      this.cb = options.callback_function as (piece: string) => void;
    }
    push(piece: string): void {
      this.cb(piece);
    }
  } as unknown as TransformersLibrary["TextStreamer"];

  lib.InterruptableStoppingCriteria = class {
    stopped = false;
    interrupt(): void {
      this.stopped = true;
      lib.interrupts += 1;
    }
  } as unknown as TransformersLibrary["InterruptableStoppingCriteria"];

  lib.load_image = async (input: Blob | string) => {
    lib.loadedImages.push(input as Blob);
    return { width: 1, height: 1 };
  };

  return lib;
}

/** Cache Storage, as a Map of Sets of keys. Only `match` and `delete` are used. */
function memoryCaches(seeded: string[] = []): TransformersCacheStorageLike & { buckets: Map<string, Set<string>> } {
  const buckets = new Map<string, Set<string>>([[TRANSFORMERS_MODEL_CACHE, new Set(seeded)]]);
  return {
    buckets,
    async open(name: string): Promise<TransformersCacheLike> {
      const bucket = buckets.get(name) ?? new Set<string>();
      buckets.set(name, bucket);
      return {
        async match(request: string) {
          return bucket.has(request) ? new Response("cached") : undefined;
        },
      };
    },
    async delete(name: string) {
      return buckets.delete(name);
    },
  };
}

function provider(
  overrides: Partial<ConstructorParameters<typeof TransformersProvider>[0]> = {},
  library?: FakeLibrary,
): { p: TransformersProvider; lib: FakeLibrary } {
  const lib = library ?? fakeLibrary(["hello"]);
  const p = new TransformersProvider({
    modelBaseUrl: BASE,
    createLibrary: async () => lib,
    caches: memoryCaches(),
    ...overrides,
  });
  return { p, lib };
}

// ── The installed package, as the twin guards read it ────────────────────────────────────────────

describe("what the installed library actually is", () => {
  it("pins the version this provider was written against", () => {
    expect(TRANSFORMERS_VERSION).toBe(installed.version);
  });

  it("still declares onnxruntime-web as the runtime the app must serve wasm for", () => {
    // The vite plugin copies `onnxruntime-web/dist/*` to `/ort/`; if this dependency ever vanishes the
    // plugin would silently copy nothing and the model would fail at session creation.
    expect(installed.dependencies["onnxruntime-web"]).toBeTruthy();
  });

  it("still declares every name this provider reaches for, in the file that declares it", () => {
    // Read out of the type declarations rather than imported: importing the module would pull the Node
    // build (onnxruntime-node, sharp) into this run. The `.d.ts` set is the same contract, and each
    // name is checked in ITS OWN file — `types/transformers.d.ts` is re-exports only, so asserting
    // against that one would have passed on a package that declared none of these.
    const declares = (file: string, name: string): void => {
      expect(readFileSync(join(packageDir, file), "utf8"), `${name} in ${file}`).toContain(name);
    };
    declares("types/models/auto/processing_auto.d.ts", "class AutoProcessor");
    declares("types/models/auto/modeling_auto.d.ts", "class AutoModelForImageTextToText");
    declares("types/generation/stopping_criteria.d.ts", "class InterruptableStoppingCriteria");
    declares("types/generation/streamers.d.ts", "class TextStreamer");
    declares("types/transformers.d.ts", "load_image");
    // The two option names the provider writes into `env`, and the one it reads a callback from.
    declares("types/env.d.ts", "remotePathTemplate");
    declares("types/env.d.ts", "cacheKey");
    declares("types/utils/core.d.ts", "progress_total");
  });

  it("still maps gemma4 to the class the auto model reaches", () => {
    // `AutoModelForImageTextToText` is only the right door while the registry maps `gemma4` into
    // `MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING_NAMES`. The day it moves, this row loads nothing.
    const registry = readFileSync(join(packageDir, "src/models/registry.js"), "utf8");
    const table = registry.slice(registry.indexOf("MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING_NAMES = new Map"));
    expect(table.slice(0, table.indexOf("]);"))).toContain("'gemma4', 'Gemma4ForConditionalGeneration'");
  });

  it("still builds the audio encoder for a vision load, which is why it is mirrored", () => {
    // Fact 5 of the provider's header: there is no vision-without-audio load, so the 171 MB audio
    // encoder is in `GEMMA_4_E2B_ONNX_FILES` on purpose. If the library ever splits them, the file
    // list can shrink — and this test is what says so.
    const config = readFileSync(join(packageDir, "src/models/session_config.js"), "utf8");
    const block = config.slice(config.indexOf("MODEL_TYPES.ImageAudioTextToText]: {"));
    const sessions = block.slice(0, block.indexOf("optional_configs"));
    expect(sessions).toContain("audio_encoder");
    expect(sessions).toContain("vision_encoder");
  });
});

// ── The catalogue ────────────────────────────────────────────────────────────────────────────────

describe("the catalogue", () => {
  it("offers one row, and it is the vision row", () => {
    expect(TRANSFORMERS_CATALOG).toHaveLength(1);
    const row = TRANSFORMERS_CATALOG[0]!;
    expect(row).toMatchObject({
      id: "gemma-4-E2B-it-onnx-q4f16",
      label: "Gemma 4 E2B · vision (ONNX)",
      class: "small",
      local: true,
      vision: true,
      audio: true,
      supportsTools: true,
      contextTokens: 8192,
      runtime: "transformers",
      assetFile: "gemma-4-E2B-it-ONNX",
      repo: "onnx-community/gemma-4-E2B-it-ONNX",
      dtype: "q4f16",
      family: "gemma",
    });
    expect(row.license.id).toBe("apache-2.0");
    // Apache-2.0 carries no use restrictions to show first, unlike the Gemma-terms rows.
    expect(row.license.useRestrictionsUrl).toBeUndefined();
    expect(row.id).toBe(TRANSFORMERS_DEFAULT_MODEL_ID);
  });

  it("says out loud what the row costs, because both halves are surprising", () => {
    const note = TRANSFORMERS_CATALOG[0]!.note ?? "";
    expect(note).toContain("Sees pictures");
    expect(note).toContain("slower than LiteRT");
    expect(note).toContain("does not resume");
    // Measured, not guessed: a 3.0 GB Cache Storage quota refused the two 1.5 GB files on 2026-09-11.
    expect(note).toContain("3.4 GB of browser storage");
  });

  it("adds its file list up to the row's own sizeBytes, which is the download bar's denominator", () => {
    const sum = GEMMA_4_E2B_ONNX_FILES.reduce((n, f) => n + f.bytes, 0);
    expect(TRANSFORMERS_CATALOG[0]!.sizeBytes).toBe(sum);
    expect(sum).toBe(3_401_448_652);
  });

  it("lists exactly the fifteen files one q4f16 vision load fetches, each with a hash", () => {
    expect(GEMMA_4_E2B_ONNX_FILES).toHaveLength(15);
    for (const entry of GEMMA_4_E2B_ONNX_FILES) {
      expect(entry.sha256, entry.file).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes, entry.file).toBeGreaterThan(0);
    }
    // The four graphs, each with exactly one external-data chunk (`use_external_data_format`).
    for (const graph of ["embed_tokens", "decoder_model_merged", "vision_encoder", "audio_encoder"]) {
      const names = GEMMA_4_E2B_ONNX_FILES.map((f) => f.file);
      expect(names).toContain(`onnx/${graph}_q4f16.onnx`);
      expect(names).toContain(`onnx/${graph}_q4f16.onnx_data`);
    }
    // The probe readiness asks about must be one of them, or "already downloaded" is never true.
    expect(GEMMA_4_E2B_ONNX_FILES.map((f) => f.file)).toContain(GEMMA_4_E2B_ONNX_PROBE_FILE);
  });

  it("is far past the phone cap, so §12.6 never offers it to a phone", () => {
    expect(transformersCatalogFor({ maxVramMb: 2000 })).toEqual([]);
    expect(transformersCatalogFor()).toHaveLength(1);
  });

  it("joins the LiteRT rows into one list for the picker, LiteRT first", () => {
    expect(LOCAL_MODEL_CATALOG).toHaveLength(LITERT_CATALOG.length + TRANSFORMERS_CATALOG.length);
    expect(LOCAL_MODEL_CATALOG.slice(0, LITERT_CATALOG.length)).toEqual(LITERT_CATALOG);
    expect(LOCAL_MODEL_CATALOG.at(-1)).toBe(TRANSFORMERS_CATALOG[0]);
    // Every LiteRT row means `litert` by saying nothing, which is what keeps the field additive.
    for (const row of LITERT_CATALOG) expect(row.runtime).toBeUndefined();
  });

  it("takes the prompt fallback, and says the native road exists", () => {
    expect(TRANSFORMERS_NATIVE_TOOLS).toBe(false);
    expect(provider().p.usesFallbackTools).toBe(true);
  });
});

// ── The URLs ─────────────────────────────────────────────────────────────────────────────────────

describe("where the files come from", () => {
  it("speaks the mirror's flat-repo layout by default", () => {
    expect(pathTemplateFor("https://dl.0-0.chat/onnx")).toBe(TRANSFORMERS_MIRROR_PATH_TEMPLATE);
    expect(transformersFileUrl("https://dl.0-0.chat/onnx", "org/model", "abc", "onnx/x.onnx_data")).toBe(
      "https://dl.0-0.chat/onnx/org/model/onnx/x.onnx_data",
    );
  });

  it("switches to the Hub's layout when the host IS the Hub, so a live check needs no second setting", () => {
    expect(pathTemplateFor(TRANSFORMERS_HUB_HOST)).toBe(TRANSFORMERS_HUB_PATH_TEMPLATE);
    expect(pathTemplateFor("https://hf.co")).toBe(TRANSFORMERS_HUB_PATH_TEMPLATE);
    expect(transformersFileUrl(TRANSFORMERS_HUB_HOST, "org/model", "abc123", "config.json")).toBe(
      "https://huggingface.co/org/model/resolve/abc123/config.json",
    );
  });

  it("joins with exactly one slash however the caller spelled the base", () => {
    for (const base of ["https://h/onnx", "https://h/onnx/", "https://h/onnx///"]) {
      expect(transformersFileUrl(base, "o/m", "r", "f.json")).toBe("https://h/onnx/o/m/f.json");
    }
  });

  it("refuses to invent a host: the weights are somebody's and their terms travel with them", () => {
    expect(() => new TransformersProvider({ modelBaseUrl: "" })).toThrow(/modelBaseUrl/);
  });

  it("refuses a model id it has no repo for", () => {
    expect(() => new TransformersProvider({ modelBaseUrl: BASE, modelId: "nope" })).toThrow(/does not know the repo/);
  });

  it("takes a repo, dtype and revision for a model that is in no catalogue", () => {
    const p = new TransformersProvider({ modelBaseUrl: BASE, modelId: "x", repo: "o/m", dtype: "q4", revision: "v1" });
    expect(p.fileUrl("config.json")).toBe(`${BASE}/o/m/config.json`);
    expect(p.dtype).toBe("q4");
    expect(p.revision).toBe("v1");
  });
});

// ── Readiness ────────────────────────────────────────────────────────────────────────────────────

describe("readiness", () => {
  it("is unsupported without WebGPU, before anything is fetched or imported", async () => {
    vi.stubGlobal("navigator", {});
    const { p, lib } = provider();
    await expect(p.readiness()).resolves.toEqual({
      ready: false,
      reason: "unsupported",
      detail: "This browser has no WebGPU, so it cannot run a local model.",
    });
    expect(lib.loads).toEqual([]);
  });

  it("names the size and the no-resume caveat when nothing is on the device", async () => {
    withWebGpu();
    const { p } = provider();
    const readiness = await p.readiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.reason).toBe("download");
    expect(readiness.detail).toContain("3.4 GB");
    expect(readiness.detail).toContain("does not resume");
  });

  it("is ready when the decoder's data file is already in OUR cache, under the library's own key", async () => {
    withWebGpu();
    const caches = memoryCaches();
    const { p } = provider({ caches });
    const url = p.fileUrl(GEMMA_4_E2B_ONNX_PROBE_FILE);
    expect(url).toBe(`${BASE}/onnx-community/gemma-4-E2B-it-ONNX/${GEMMA_4_E2B_ONNX_PROBE_FILE}`);
    const seeded = provider({ caches: memoryCaches([url]) });
    await expect(seeded.p.readiness()).resolves.toEqual({ ready: true });
  });

  it("answers 'not downloaded' rather than throwing when Cache Storage refuses", async () => {
    withWebGpu();
    const angry: TransformersCacheStorageLike = {
      async open() {
        throw new Error("private mode");
      },
      async delete() {
        return false;
      },
    };
    const { p } = provider({ caches: angry });
    const readiness = await p.readiness();
    expect(readiness.ready).toBe(false);
  });

  it("says `load` while the sessions compile, not a download stuck at 100 %", async () => {
    withWebGpu();
    const lib = fakeLibrary(["hi"]);
    const { p } = provider({}, lib);
    const loading = p.load();
    // `from_pretrained` has handed over the callback by the time the processor resolves.
    await Promise.resolve();
    await Promise.resolve();
    const total = TRANSFORMERS_CATALOG[0]!.sizeBytes;
    lib.emit({ status: "progress", name: "x", file: "a", progress: 50, loaded: total / 2, total: total / 2 });
    let readiness = await p.readiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.progress).toEqual({ loadedBytes: total / 2, totalBytes: total, percent: 50, phase: "download" });
    expect(readiness.detail).toContain("Downloading");

    lib.emit({ status: "progress", name: "x", file: "a", progress: 100, loaded: total, total });
    readiness = await p.readiness();
    if (readiness.ready) throw new Error("still loading");
    expect(readiness.progress?.phase).toBe("load");
    expect(readiness.detail).toContain("into the GPU");
    await loading;
    await expect(p.readiness()).resolves.toEqual({ ready: true });
  });

  it("never lets the library's growing denominator walk the bar backwards", async () => {
    withWebGpu();
    const seen: number[] = [];
    const lib = fakeLibrary(["hi"]);
    const { p } = provider({ onProgress: (r) => seen.push(r.progress) }, lib);
    const loading = p.load();
    await Promise.resolve();
    await Promise.resolve();
    // Only the files that have STARTED are known, so the seen total climbs. The row's own sum is the
    // denominator, so the fraction only ever grows.
    lib.emit({ status: "progress", name: "x", file: "a", progress: 100, loaded: 1_000, total: 1_000 });
    lib.emit({ status: "progress", name: "x", file: "b", progress: 10, loaded: 1_000, total: 10_000 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeLessThan(seen[1]!);
    expect(seen[1]).toBeCloseTo(2_000 / TRANSFORMERS_CATALOG[0]!.sizeBytes, 12);
    await loading;
  });

  it("ignores every status but the per-file byte counts", async () => {
    withWebGpu();
    const lib = fakeLibrary(["hi"]);
    const { p } = provider({}, lib);
    const loading = p.load();
    await Promise.resolve();
    await Promise.resolve();
    lib.emit({ status: "initiate", name: "x", file: "config.json" });
    lib.emit({ status: "download", name: "x", file: "config.json" });
    lib.emit({ status: "done", name: "x", file: "config.json" });
    lib.emit({ status: "ready", task: "t", model: "m" });
    // The library's OWN aggregate is deliberately not read: it is computed per `from_pretrained` call,
    // so two of them never add up (see `report`). Nothing but `progress` moves the bar.
    lib.emit({ status: "progress_total", name: "x", progress: 100, loaded: 9_999, total: 9_999 });
    const readiness = await p.readiness();
    if (readiness.ready) throw new Error("unexpectedly ready");
    expect(readiness.progress).toBeUndefined();
    await loading;
  });

  it("sums the processor's files and the model's, which the library counts in two separate maps", async () => {
    // The live failure of 2026-09-11: the chip sat at "99 % · 3.4 of 3.4 GB" through the whole compile
    // because the processor's seven files (19.5 MB) were fetched by a call whose aggregate this
    // provider was not reading. Both calls now share one callback and one map.
    withWebGpu();
    const lib = fakeLibrary(["hi"]);
    const { p } = provider({}, lib);
    const loading = p.load();
    await Promise.resolve();
    await Promise.resolve();
    const total = TRANSFORMERS_CATALOG[0]!.sizeBytes;
    const small = 19_481_894;
    lib.emit({ status: "progress", name: "x", file: "tokenizer.json", progress: 100, loaded: small, total: small });
    lib.emit({ status: "progress", name: "x", file: "decoder.onnx_data", progress: 100, loaded: total - small, total: total - small });
    const readiness = await p.readiness();
    if (readiness.ready) throw new Error("unexpectedly ready");
    expect(readiness.progress).toEqual({ loadedBytes: total, totalBytes: total, percent: 100, phase: "load" });
    await loading;
  });

  it("gives the processor the same callback as the model, or its files are never counted", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.load();
    expect(typeof lib.loads[0]!.options.progress_callback).toBe("function");
    expect(lib.loads[1]!.options.progress_callback).toBe(lib.loads[0]!.options.progress_callback);
  });
});

// ── The env the library is pointed at ────────────────────────────────────────────────────────────

describe("the library's global env", () => {
  it("points every file at OUR host and the wasm at OUR origin", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.load();
    expect(lib.env).toMatchObject({
      allowLocalModels: false,
      allowRemoteModels: true,
      remoteHost: `${BASE}/`,
      remotePathTemplate: TRANSFORMERS_MIRROR_PATH_TEMPLATE,
      useBrowserCache: true,
      useWasmCache: true,
      cacheKey: TRANSFORMERS_MODEL_CACHE,
    });
    expect(lib.env.backends?.onnx?.wasm).toEqual({ wasmPaths: ONNX_DEFAULT_WASM_PATH, proxy: false });
    // The default is a PREFIX and must end in a slash, or ORT makes it part of the file name.
    expect(ONNX_DEFAULT_WASM_PATH.endsWith("/")).toBe(true);
  });

  it("re-applies the settings on every load, because the env is a module-level singleton", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.load();
    // Somebody else on the origin wrote to the shared object.
    lib.env.remoteHost = "https://elsewhere.example/";
    await p.unload();
    await p.load();
    expect(lib.env.remoteHost).toBe(`${BASE}/`);
  });

  it("hands the library a fetch bound to the load, so a stop really stops the bytes", async () => {
    withWebGpu();
    const { p, lib } = provider();
    const loading = p.load();
    await Promise.resolve();
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return Promise.resolve(new Response("x"));
    });
    await lib.env.fetch?.("https://x.example/f", {});
    expect(signals[0]?.aborted).toBe(false);
    await loading;
  });

  it("survives a library whose env has no onnx backend at all", async () => {
    withWebGpu();
    const lib = fakeLibrary(["hi"]);
    lib.env = { };
    const { p } = provider({}, lib);
    await expect(p.load()).resolves.toBeTruthy();
  });

  it("takes the caller's wasm path and path template when it is given them", async () => {
    withWebGpu();
    const { p, lib } = provider({ wasmBaseUrl: "/vendor/ort/", pathTemplate: "{model}/x/" });
    await p.load();
    expect(lib.env.backends?.onnx?.wasm?.wasmPaths).toBe("/vendor/ort/");
    expect(lib.env.remotePathTemplate).toBe("{model}/x/");
  });

  it("asks for the processor first, then the model with webgpu and the row's dtype", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.load();
    expect(lib.loads).toHaveLength(2);
    expect(lib.loads[0]).toMatchObject({ repo: "onnx-community/gemma-4-E2B-it-ONNX" });
    expect(lib.loads[1]!.options).toMatchObject({ device: "webgpu", dtype: "q4f16", revision: TRANSFORMERS_CATALOG[0]!.revision });
  });

  it("refuses to load at all without WebGPU, with the provider's own words", async () => {
    vi.stubGlobal("navigator", {});
    const { p } = provider();
    await expect(p.load()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("shares one load between two callers, and does not latch a failure", async () => {
    withWebGpu();
    let attempt = 0;
    const lib = fakeLibrary(["hi"]);
    const p = new TransformersProvider({
      modelBaseUrl: BASE,
      caches: memoryCaches(),
      createLibrary: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("offline");
        return lib;
      },
    });
    await expect(p.load()).rejects.toThrow(/offline/);
    const [a, b] = await Promise.all([p.load(), p.load()]);
    expect(a).toBe(b);
    expect(attempt).toBe(2);
  });
});

// ── The turn ─────────────────────────────────────────────────────────────────────────────────────

const HELLO = { role: "user" as const, content: "hi" };

describe("the prompt and the pictures", () => {
  it("templates with thinking off and a generation prompt on, and passes no special tokens twice", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.chat({ messages: [HELLO] });
    expect(lib.templated[0]!.options).toEqual({ enable_thinking: false, add_generation_prompt: true });
    expect(lib.processed[0]!.options).toEqual({ add_special_tokens: false });
    expect(lib.processed[0]!.images).toBeNull();
    expect(lib.processed[0]!.audio).toBeNull();
  });

  it("keeps a system turn as a system turn — Gemma 4 has the role, unlike Gemma 3", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.chat({ messages: [{ role: "system", content: "you are Zero" }, HELLO] });
    expect(lib.templated[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("sends the placeholders and the pixels SEPARATELY, image before text, in step", async () => {
    withWebGpu();
    const { p, lib } = provider();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await p.chat({ messages: [{ role: "user", content: "what is this?", images: [{ mime: "image/png", data: png }] }] });
    const content = lib.templated[0]!.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([{ type: "image" }, { type: "text", text: "what is this?" }]);
    // One placeholder, one blob, and the blob carries the SNIFFED type rather than the declared one.
    expect(lib.loadedImages).toHaveLength(1);
    expect(lib.loadedImages[0]!.type).toBe("image/png");
    expect(lib.processed[0]!.images).toEqual([{ width: 1, height: 1 }]);
  });

  it("caps the pictures one turn may carry, because each one costs 280 tokens of 8192", async () => {
    withWebGpu();
    const { p, lib } = provider();
    const png = { mime: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
    await p.chat({ messages: [{ role: "user", content: "many", images: Array.from({ length: 9 }, () => png) }] });
    expect(lib.loadedImages).toHaveLength(TRANSFORMERS_MAX_IMAGES);
  });

  it("refuses a picture that is too big BEFORE the generation, by name", async () => {
    withWebGpu();
    const { p, lib } = provider();
    const huge = { mime: "image/png", data: new Uint8Array(5 * 1024 * 1024) };
    await expect(p.chat({ messages: [{ role: "user", content: "x", images: [huge] }] })).rejects.toMatchObject({
      vendorCode: "image_too_large",
    });
    expect(lib.generated).toEqual([]);
  });

  it("drops a picture OUT LOUD on a row that cannot see, rather than in silence", async () => {
    withWebGpu();
    const { p, lib } = provider({ vision: false });
    const png = { mime: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), source: "shot.png" };
    await p.chat({ messages: [{ role: "user", content: "look", images: [png] }] });
    const content = lib.templated[0]!.messages[0]!.content;
    expect(typeof content).toBe("string");
    expect(content).toContain("A picture was attached (shot.png)");
    expect(content).toContain("cannot see pictures");
    expect(lib.loadedImages).toEqual([]);
  });

  it("replays a tool turn as a user turn, in templates.ts's own wording", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.chat({
      messages: [
        HELLO,
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
        { role: "tool", content: "contents", toolCallId: "c1", name: "read_file" },
      ],
    });
    const roles = lib.templated[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(lib.templated[0]!.messages[1]!.content).toContain('"tool_call"');
    expect(lib.templated[0]!.messages[2]!.content).toBe("Result of read_file:\ncontents");
  });

  it("folds the fallback instruction into the FIRST system turn, and makes one when there is none", async () => {
    withWebGpu();
    const tools = [{ name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const { p, lib } = provider();
    await p.chat({ messages: [{ role: "system", content: "you are Zero" }, HELLO], tools });
    expect(lib.templated[0]!.messages[0]!.content).toMatch(/^you are Zero\n\nTo use a tool/);

    const second = provider();
    await second.p.chat({ messages: [HELLO], tools });
    expect(second.lib.templated[0]!.messages[0]!.role).toBe("system");
    expect(second.lib.templated[0]!.messages[0]!.content).toContain("read_file(path: string)");
    // 8192 is under FALLBACK_SCHEMAS_MIN_CONTEXT, so signatures and not raw schemas.
    expect(second.lib.templated[0]!.messages[0]!.content).not.toContain("arguments schema");
  });

  it("is greedy unless a temperature is asked for, and then uses the card's sampling numbers", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.chat({ messages: [HELLO] });
    expect(lib.generated[0]).toMatchObject({ do_sample: false, max_new_tokens: 1024 });
    expect(lib.generated[0]!.temperature).toBeUndefined();

    await p.chat({ messages: [HELLO], temperature: 0.7, maxTokens: 64 });
    expect(lib.generated[1]).toMatchObject({ do_sample: true, temperature: 0.7, top_p: 0.95, top_k: 64, max_new_tokens: 64 });
  });
});

describe("chat", () => {
  it("collects the streamed pieces into one answer", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(["Hel", "lo ", "there"]));
    await expect(p.chat({ messages: [HELLO] })).resolves.toMatchObject({
      message: { role: "assistant", content: "Hello there" },
      finishReason: "stop",
    });
  });

  it("cuts an answer that types its own turn marker as text", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(["Hi.", "<end_of_turn>", "<start_of_turn>user\nnext"]));
    const answer = await p.chat({ messages: [HELLO] });
    expect(answer.message.content).toBe("Hi.");
  });

  it("parses a fallback tool call out of the text and takes it out of the prose", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(['Sure. {"tool_call": {"name": "read_file", "arguments": {"path": "a.txt"}}}']));
    const answer = await p.chat({
      messages: [HELLO],
      tools: [{ name: "read_file", description: "Read.", parameters: { type: "object", properties: {} } }],
    });
    expect(answer.finishReason).toBe("tool_calls");
    expect(answer.message.toolCalls).toEqual([{ id: "call_0", name: "read_file", arguments: { path: "a.txt" } }]);
    expect(answer.message.content).toBe("Sure.");
  });

  it("leaves a JSON object alone when no tools were offered", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(['{"tool_call": {"name": "x", "arguments": {}}}']));
    const answer = await p.chat({ messages: [HELLO] });
    expect(answer.message.toolCalls).toBeUndefined();
    expect(answer.message.content).toContain("tool_call");
  });

  it("turns a generation failure into a ProviderError of this provider's id", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary([], { fail: new Error("shader compile failed") }));
    await expect(p.chat({ messages: [HELLO] })).rejects.toMatchObject({ providerId: TRANSFORMERS_PROVIDER_ID });
  });

  it("refuses before loading anything when the caller has already stopped", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await expect(p.chat({ messages: [HELLO], signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "aborted" });
    expect(lib.loads).toEqual([]);
  });

  it("interrupts the generation when the caller stops mid-answer", async () => {
    withWebGpu();
    const lib = fakeLibrary(["a", "b", "c", "d"], { slow: true });
    const { p } = provider({}, lib);
    const controller = new AbortController();
    const running = p.chat({ messages: [HELLO], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 4));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(lib.interrupts).toBeGreaterThan(0);
  });
});

describe("stream", () => {
  it("yields deltas and then the whole answer", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(["Hello ", "there ", "friend"]));
    const chunks = await collect(p.stream({ messages: [HELLO] }));
    const text = chunks.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.delta : "")).join("");
    expect(text).toBe("Hello there friend");
    const done = chunks.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.response.message.content).toBe("Hello there friend");
  });

  it("never streams a turn marker to a reader before the cut is made", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(["Done.", "<end_of", "_turn>", "<start_of_turn>user"]));
    const chunks = await collect(p.stream({ messages: [HELLO] }));
    const text = chunks.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.delta : "")).join("");
    expect(text).toBe("Done.");
    expect(text).not.toContain("<end_of");
  });

  it("emits a tool call after the text, then done", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary(['{"tool_call": {"name": "ls", "arguments": {}}}']));
    const chunks = await collect(
      p.stream({ messages: [HELLO], tools: [{ name: "ls", description: "List.", parameters: { type: "object", properties: {} } }] }),
    );
    expect(chunks.map((c) => c.type)).toContain("tool_call");
    const call = chunks.find((c) => c.type === "tool_call");
    if (call?.type === "tool_call") expect(call.call.name).toBe("ls");
  });

  it("stops streaming the moment the caller aborts", async () => {
    withWebGpu();
    const lib = fakeLibrary(["one ", "two ", "three ", "four"], { slow: true });
    const { p } = provider({}, lib);
    const controller = new AbortController();
    const iterator = p.stream({ messages: [HELLO], signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    expect(lib.interrupts).toBeGreaterThan(0);
  });

  it("reports a generation failure rather than ending quietly", async () => {
    withWebGpu();
    const { p } = provider({}, fakeLibrary([], { fail: new Error("out of memory") }));
    await expect(collect(p.stream({ messages: [HELLO] }))).rejects.toMatchObject({ providerId: TRANSFORMERS_PROVIDER_ID });
  });
});

// ── Letting go ───────────────────────────────────────────────────────────────────────────────────

describe("abortLoad, unload and clearCache", () => {
  it("does nothing when nothing is loading", () => {
    const { p } = provider();
    expect(() => p.abortLoad()).not.toThrow();
  });

  it("disposes an engine that arrives after the stop, and tells the caller it stopped", async () => {
    withWebGpu();
    const lib = fakeLibrary(["hi"]);
    const { p } = provider({}, lib);
    const loading = p.load();
    p.abortLoad();
    await expect(loading).rejects.toMatchObject({ code: "aborted" });
    expect(lib.disposals).toBe(1);
    // The load did not latch: asking again loads, it does not re-throw.
    await expect(p.load()).resolves.toBeTruthy();
  });

  it("releases the sessions on unload and loads again on the next turn", async () => {
    withWebGpu();
    const { p, lib } = provider();
    await p.load();
    await p.unload();
    expect(lib.disposals).toBe(1);
    await p.unload(); // twice is a no-op, which is what a settings screen needs
    expect(lib.disposals).toBe(1);
    await p.load();
    expect(lib.loads).toHaveLength(4);
  });

  it("gives the three gigabytes back, and answers false when there is no cache to clear", async () => {
    const caches = memoryCaches(["x"]);
    const { p } = provider({ caches });
    await expect(p.clearCache()).resolves.toBe(true);
    expect(caches.buckets.has(TRANSFORMERS_MODEL_CACHE)).toBe(false);
    const none = new TransformersProvider({ modelBaseUrl: BASE });
    await expect(none.clearCache()).resolves.toBe(false);
  });

  it("answers false rather than throwing when Cache Storage refuses the delete", async () => {
    const { p } = provider({
      caches: {
        async open() {
          return { async match() { return undefined; } };
        },
        async delete() {
          throw new Error("nope");
        },
      },
    });
    await expect(p.clearCache()).resolves.toBe(false);
  });

  it("lists its catalogue through the contract's own door", async () => {
    const { p } = provider();
    await expect(p.models()).resolves.toEqual(TRANSFORMERS_CATALOG);
  });
});
