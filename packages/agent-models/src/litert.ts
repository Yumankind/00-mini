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
 * 4a. PICTURES ONLY WHERE THE ROW SAYS SO. The installed README is explicit — "For Gemma 3n models,
 *    it can process input images and audio as well" — and the runtime is explicit about the price:
 *    `LlmInferenceOptions.maxNumImages` "when set > 0, will enable vision modality usage. Will also
 *    enable streaming loading, and therefore is not compatible with 'converted' models". So it is
 *    set at CREATION and only for a catalogue row flagged `vision`; a text row created with it would
 *    be a text row that stops loading. The images themselves ride as `PromptPart`s
 *    (`Prompt = PromptPart | PromptPart[]`, `PromptPart = string | Image | Audio`, `Image` being
 *    `{ imageSource: ImageSource }`), which is why `templates.ts` renders segments. A row WITHOUT
 *    vision drops the pictures and says so in the text — never silently (image-parts.ts, rule 3).
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
import { decodeImage, hasImages, imageDataUrl } from "./image-parts.js";
import { mapFinishReason } from "./openai-compatible.js";
import type { FetchLike, Readiness } from "./openai-compatible.js";
import { renderPrompt, renderPromptSegments, stopAtTurnEnd, TURN_MARKER_MAX_LENGTH, turnMarkerIndex } from "./templates.js";
import type { PromptFamily } from "./templates.js";
import { FALLBACK_SCHEMAS_MIN_CONTEXT, fallbackToolPrompt, parseFallbackToolCalls } from "./tool-fallback.js";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ImagePart,
  ModelInfo,
  ModelProvider,
  ReadinessProgress,
  ToolCall,
  Usage,
} from "./types.js";

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
  /** Accepts images in the prompt (the runtime's `maxNumImages`). The Gemma 4 web builds are text-only
   *  per their card; the Gemma 3n web builds are the vision rows. */
  vision?: boolean;
  /** The publisher's licence, as the Hub declares it. Gemma rows carry use restrictions the app must
   *  show before the download (docs/HANDOFF-infinite-agent.md §12.7); Apache rows do not. */
  license: ModelLicense;
}

export interface ModelLicense {
  /** `gemma` and `apache-2.0` are what this package's own rows carry; a mirror may name another. */
  id: string;
  name: string;
  url: string;
  /** Present when the licence incorporates use restrictions the person must be pointed at. */
  useRestrictionsUrl?: string;
  /**
   * Where the HOST keeps its verbatim copy of the terms, when it keeps one (§12.7 puts
   * `GEMMA_TERMS.md` beside the weights). Never a constant here: the copy belongs to whoever
   * redistributes the weights, which is exactly the thing this package refuses to hardcode.
   */
  termsCopyUrl?: string;
}

export const GEMMA_TERMS: ModelLicense = {
  id: "gemma",
  name: "Gemma Terms of Use",
  url: "https://ai.google.dev/gemma/terms",
  useRestrictionsUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
};
export const APACHE_2: ModelLicense = { id: "apache-2.0", name: "Apache License 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" };

/**
 * The rows whose `assetFile` NOTHING vouches for. Two things can: the installed
 * `@mediapipe/tasks-genai` README, which names the Gemma 4 and 3n web assets by full file name, and
 * the mirror we publish to (docs/HANDOFF-infinite-agent.md §12.7), whose catalog is snapshotted at
 * `test/fixtures/litert-mirror-catalog.json` — every file in it was sha256-checked against the Hub's
 * record on the way up. The twin guard in test/litert.test.ts accepts either; a row in neither must
 * be listed here, and is offered to nobody until it is in one of them. Empty since 2026-09-10.
 */
export const LITERT_UNVERIFIED_ASSETS: readonly string[] = [];

/**
 * The curated LiteRT models.
 *
 * ⚠️ `vramMb` IS AN ESTIMATE. Unlike web-llm, MediaPipe publishes no manifest of memory
 * requirements — there is no `vram_required_MB` to pin a twin guard against — so these are the
 * int4 weight size plus KV-cache headroom, rounded, and they exist so `litertCatalogFor()` can keep
 * §12.6's promise that a phone is offered one model and not a wall. Measure them on a device before
 * anyone treats them as fact.
 *
 * `contextTokens` IS THE KV-CACHE BUDGET ASKED FOR AT LOAD (`maxTokens`), not a ceiling the model
 * imposes: LLM Inference counts input and output together against one number, and `LiteRtProvider`
 * passes this row's value straight into `createFromOptions` (see the constructor and `load()`).
 *
 * So a number here is a trade, not a fact about the weights. Raised to 8192 on 2026-09-11 for the
 * Gemma 4 and Gemma 3n rows, after a 5.2k-token system prompt made the default local brain fail on
 * every turn against the old 4096: those models support far more than 4096, and 8192 is what can be
 * asked of a laptop GPU without the cache itself exhausting it. The 270m and 1B rows — the phone
 * rows of §12.6, where the KV cache competes with the browser for a few hundred megabytes — went to
 * 4096 later the same day: at 2048 the full agent's FIRST turn did not fit (the named refusal said
 * "needs about 2479 tokens; the window holds 2048" on a phone), and a brain that refuses every turn
 * is not smaller than one whose cache costs 40–110 MB more. The 45 % prompt share of the runtime
 * (`SYSTEM_PROMPT_SHARE`) then leaves ~1800 tokens of prompt and ~2200 of conversation.
 */
export const LITERT_CATALOG: LiteRtModelInfo[] = [
  // VERIFIED on the mirror (sha256 a642cc7b…), not in the README. The phone row: a quarter of a
  // gigabyte, the one an embed's "Load local AI" can honestly offer.
  {
    id: "gemma3-270m-it-q4_0-web",
    label: "Gemma 3 270m (q4)",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 4096,
    vramMb: 600,
    assetFile: "gemma3-270m-it-q4_0-web.task",
    family: "gemma",
    license: GEMMA_TERMS,
  },
  // VERIFIED on the mirror (sha256 74f37adc…), not in the README.
  {
    id: "gemma3-1b-it-int4-web",
    label: "Gemma 3 1B (int4)",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 4096,
    vramMb: 1200,
    assetFile: "gemma3-1b-it-int4-web.task",
    family: "gemma",
    license: GEMMA_TERMS,
  },
  // VERIFIED: named in full in the installed package's README.md.
  {
    id: "gemma-3n-E2B-it-int4-Web",
    label: "Gemma 3n E2B (int4, vision)",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 8192,
    vramMb: 3600,
    assetFile: "gemma-3n-E2B-it-int4-Web.litertlm",
    family: "gemma",
    vision: true,
    license: GEMMA_TERMS,
  },
  // VERIFIED: the installed README's fourth download link. The larger vision row; desktop-class.
  {
    id: "gemma-3n-E4B-it-int4-Web",
    label: "Gemma 3n E4B (int4, vision)",
    class: "strong",
    local: true,
    supportsTools: true,
    contextTokens: 8192,
    vramMb: 5200,
    assetFile: "gemma-3n-E4B-it-int4-Web.litertlm",
    family: "gemma",
    vision: true,
    license: GEMMA_TERMS,
  },
  // VERIFIED: the installed README's first download link. The owner's "Gemma 4" — it exists, and
  // this is the name it exists under.
  {
    id: "gemma-4-E2B-it-web",
    label: "Gemma 4 E2B",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 8192,
    vramMb: 3600,
    assetFile: "gemma-4-E2B-it-web.task",
    family: "gemma",
    // The litert-community repo declares Apache-2.0 on the Hub (read 2026-09-10), not the Gemma terms.
    license: APACHE_2,
  },
  // VERIFIED: the installed README's second download link. Desktop-class; never offered to a phone.
  {
    id: "gemma-4-E4B-it-web",
    label: "Gemma 4 E4B",
    class: "strong",
    local: true,
    supportsTools: true,
    contextTokens: 8192,
    vramMb: 6800,
    assetFile: "gemma-4-E4B-it-web.task",
    family: "gemma",
    license: APACHE_2,
  },
  // VERIFIED on the mirror (sha256 d37f9392…). Six gigabytes: the "power users with the VRAM" row of
  // §12.7. It is listed so the OFFLINE fallback catalogue holds the same seven rows the mirror serves
  // — a picker that shrinks when the network drops looks broken rather than offline.
  {
    id: "gemma-4-12B-it-web",
    label: "Gemma 4 12B",
    class: "strong",
    local: true,
    supportsTools: true,
    contextTokens: 8192,
    vramMb: 9000,
    assetFile: "gemma-4-12B-it-web.litertlm",
    family: "gemma",
    license: APACHE_2,
  },
];

/** The row a first visit downloads when the caller names none. Gemma 4 E2B rather than the smaller
 *  Gemma 3 1B because it is what the mirror serves today (the 1B is gated at its source and lands
 *  with the next publish), and because its licence carries no use restrictions to show first. */
export const LITERT_DEFAULT_MODEL_ID = "gemma-4-E2B-it-web";

/** §12.6: a phone gets one model, not a picker. Same filter as the WebLLM catalogue's. */
export function litertCatalogFor(options: { maxVramMb?: number } = {}): LiteRtModelInfo[] {
  const cap = options.maxVramMb ?? Number.POSITIVE_INFINITY;
  return LITERT_CATALOG.filter((m) => m.vramMb <= cap);
}

/** `<base>/<file>`, with exactly one slash between them whatever the caller passed. */
export function litertAssetUrl(baseUrl: string, assetFile: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${assetFile.replace(/^\/+/, "")}`;
}

// ── The mirror's own catalogue, and the join ────────────────────────────────────────────────────
//
// WHY A SECOND CATALOGUE AT ALL. `LITERT_CATALOG` above is what this PACKAGE vouches for: file names
// read out of the installed README or the mirror's snapshot, and `vramMb` estimates a human wrote.
// `litert/catalog.json` on the host (§12.7) is what the MIRROR actually serves: exact bytes, a
// sha256, the licence the publisher declared and whether the row does vision. Neither is a superset
// of the other, so a picker joins them on the file name — the mirror decides WHAT IS THERE (a row
// that has been published, a row that has been withdrawn), the package supplies WHAT IT COSTS to run
// and how to prompt it. A row on the mirror the package has never heard of is still offered, with
// its numbers derived and marked `estimated`, because the alternative is a model nobody can pick
// until this file is edited and released.
//
// Parsing is defensive to the point of rudeness: this JSON is fetched over the network from a bucket,
// so every field is checked and an unusable document answers `null` rather than half a catalogue.

export interface LiteRtMirrorAsset {
  file: string;
  bytes?: number;
  sha256?: string;
  source?: string;
  license?: string;
  licenseName?: string;
  licenseUrl?: string;
  termsCopyUrl?: string;
  useRestrictionsUrl?: string;
  gatedAtSource?: boolean;
  vision?: boolean;
}

export interface LiteRtMirrorCatalog {
  version: number;
  /** The `modelBaseUrl` every asset below is served from. */
  base: string;
  publishedAt?: string;
  notice?: string;
  noticeUrl?: string;
  gemmaTermsUrl?: string;
  gemmaProhibitedUseUrl?: string;
  assets: LiteRtMirrorAsset[];
}

/** A row a picker draws: the package's model info, plus what the mirror knows about the file. */
export interface LiteRtCatalogRow extends LiteRtModelInfo {
  /** Exact size from the mirror. Absent offline, where only the package's rows exist. */
  bytes?: number;
  sha256?: string;
  gatedAtSource?: boolean;
  /** True when the host actually serves this file today. */
  onMirror: boolean;
  /** True when `vramMb`, `class` and `label` were derived from the file rather than measured. */
  estimated?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `litert/catalog.json` → the shape above, or `null` when it is not that document. */
export function parseMirrorCatalog(raw: unknown): LiteRtMirrorCatalog | null {
  const doc = raw as Partial<LiteRtMirrorCatalog> | null;
  if (!doc || typeof doc !== "object") return null;
  const base = str(doc.base);
  if (!base || !Array.isArray(doc.assets)) return null;
  const assets: LiteRtMirrorAsset[] = [];
  for (const entry of doc.assets as unknown[]) {
    const asset = entry as Partial<LiteRtMirrorAsset>;
    const file = str(asset?.file);
    // A file name with a path separator in it would escape the base URL the host published; a row
    // without a name is not a row at all. Both are dropped rather than repaired.
    if (!file || file.includes("/") || file.includes("..")) continue;
    assets.push({
      file,
      bytes: num(asset.bytes),
      sha256: str(asset.sha256),
      source: str(asset.source),
      license: str(asset.license),
      licenseName: str(asset.licenseName),
      licenseUrl: str(asset.licenseUrl),
      termsCopyUrl: str(asset.termsCopyUrl),
      useRestrictionsUrl: str(asset.useRestrictionsUrl),
      gatedAtSource: typeof asset.gatedAtSource === "boolean" ? asset.gatedAtSource : undefined,
      vision: typeof asset.vision === "boolean" ? asset.vision : undefined,
    });
  }
  if (!assets.length) return null;
  return {
    version: num(doc.version) ?? 1,
    base,
    publishedAt: str(doc.publishedAt),
    notice: str(doc.notice),
    noticeUrl: str(doc.noticeUrl),
    gemmaTermsUrl: str(doc.gemmaTermsUrl),
    gemmaProhibitedUseUrl: str(doc.gemmaProhibitedUseUrl),
    assets,
  };
}

/**
 * VRAM for a row nobody measured: the file's own size plus half again for the KV cache and the
 * runtime's working set. The measured rows sit between 1.2× and 2.4× their asset, so this is the
 * middle of a wide range and is marked `estimated` wherever it is used — §12.6's phone cap is kept
 * with the package's own rows, never with one of these.
 */
function estimateVramMb(bytes?: number): number {
  return bytes ? Math.round((bytes / 1_000_000) * 1.5) : 0;
}

function licenceFrom(asset: LiteRtMirrorAsset, fallback?: ModelLicense): ModelLicense | undefined {
  const url = asset.licenseUrl ?? fallback?.url;
  const name = asset.licenseName ?? fallback?.name;
  if (!url || !name) return fallback;
  return {
    id: asset.license ?? fallback?.id ?? "unknown",
    name,
    url,
    useRestrictionsUrl: asset.useRestrictionsUrl ?? fallback?.useRestrictionsUrl,
    termsCopyUrl: asset.termsCopyUrl ?? fallback?.termsCopyUrl,
  };
}

/**
 * The mirror's rows, in the mirror's order, enriched from the package's catalogue.
 *
 * With no mirror (offline, unreachable, or a document that did not parse) the package's own rows are
 * the answer, flagged `onMirror: false` so a UI can say the size and the download are unconfirmed.
 * A package row the mirror does NOT list is left out when a mirror was given: it is a file the host
 * would answer 404 for, and offering a download that cannot happen is worse than offering fewer.
 */
export function mergeMirrorCatalog(
  mirror: LiteRtMirrorCatalog | null,
  packageCatalog: LiteRtModelInfo[] = LITERT_CATALOG,
): LiteRtCatalogRow[] {
  if (!mirror) return packageCatalog.map((m) => ({ ...m, onMirror: false }));
  const byFile = new Map(packageCatalog.map((m) => [m.assetFile, m]));
  const rows: LiteRtCatalogRow[] = [];
  for (const asset of mirror.assets) {
    const known = byFile.get(asset.file);
    const licence = licenceFrom(asset, known?.license);
    if (known) {
      rows.push({
        ...known,
        ...(licence ? { license: licence } : {}),
        ...(typeof asset.vision === "boolean" ? { vision: asset.vision } : {}),
        ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
        ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
        ...(asset.gatedAtSource === undefined ? {} : { gatedAtSource: asset.gatedAtSource }),
        onMirror: true,
      });
      continue;
    }
    // A row this package has never heard of. It is offered anyway; everything the package would have
    // supplied is derived, and `estimated` says so out loud.
    if (!licence) continue;
    const id = asset.file.replace(/\.(task|litertlm)$/i, "");
    const vramMb = estimateVramMb(asset.bytes);
    rows.push({
      id,
      label: id,
      class: asset.bytes && asset.bytes > 3_500_000_000 ? "strong" : "small",
      local: true,
      supportsTools: true,
      contextTokens: 4096,
      vramMb,
      assetFile: asset.file,
      family: "gemma",
      ...(typeof asset.vision === "boolean" ? { vision: asset.vision } : {}),
      license: licence,
      ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
      ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
      ...(asset.gatedAtSource === undefined ? {} : { gatedAtSource: asset.gatedAtSource }),
      onMirror: true,
      estimated: true,
    });
  }
  return rows;
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

/**
 * A picture, as MediaPipe takes one: `ImageSource` is `Exclude<CanvasImageSource, SVGElement> | string`
 * in the installed `genai.d.ts`, i.e. a decoded bitmap or element — or a URL, which is what makes a
 * `data:` URL a legal fallback on a host with no `createImageBitmap`.
 */
export type LiteRtImageSource = Exclude<CanvasImageSource, SVGElement> | string;

/** `Image` in the installed typings. Named here so nothing in this package imports MediaPipe for a type. */
export interface LiteRtImage {
  imageSource: LiteRtImageSource;
}

/** `PromptPart` minus audio, which this package does not send: `string | Image`. */
export type LiteRtPromptPart = string | LiteRtImage;

/** `Prompt` in the installed typings: one part, or a list of them. */
export type LiteRtPrompt = LiteRtPromptPart | LiteRtPromptPart[];

/**
 * Bytes → something the wasm runtime can read, ISOLATED so a Node test can fake it.
 *
 * The real conversion is `createImageBitmap`, which exists in a window and in a worker and in
 * neither Node nor a test. Everything either side of it — the cap, the sniff, the position of the
 * picture in the turn — is ordinary logic that must be testable, so the one browser-only line lives
 * behind this function and `createImageSource` replaces it in the tests.
 */
export type LiteRtImageSourceFactory = (image: ImagePart, providerId: string) => Promise<LiteRtImageSource>;

/** The number of pictures a vision task is created to accept in one prompt (`maxNumImages`). */
export const LITERT_MAX_IMAGES = 4;

const importImageSource: LiteRtImageSourceFactory = async (image, providerId) => {
  const maker = (globalThis as { createImageBitmap?: (source: Blob) => Promise<ImageBitmap> }).createImageBitmap;
  if (!maker) {
    // No decoder on this host: hand the runtime the URL form, which its own `ImageSource` allows.
    return imageDataUrl(image, { providerId });
  }
  const { bytes, mime } = decodeImage(image, { providerId });
  // `.slice()` rather than the view itself: TS types a `Uint8Array`'s buffer as possibly SHARED, and
  // a `Blob` takes an `ArrayBuffer`. The copy is a few hundred kilobytes and happens once per picture.
  return maker(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
};

/** The sliver of `LlmInference` this provider uses. Everything else would be untestable in Node. */
export interface LiteRtTaskLike {
  generateResponse(query: LiteRtPrompt, progressListener?: (partial: string, done: boolean) => unknown): Promise<string>;
  /** Synchronous in the real task, and only legal between generations. */
  sizeInTokens?(query: LiteRtPrompt): number | undefined;
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
  /** Set only for a `vision` row: > 0 turns the vision modality on, and streaming loading with it. */
  maxNumImages?: number;
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
    // Omitted entirely for a text row: the option is not "how many pictures at most", it is the
    // switch that turns the vision modality (and streaming loading) on.
    ...(options.maxNumImages ? { maxNumImages: options.maxNumImages } : {}),
  });
};

/** The two Cache Storage calls this provider makes, so a test can hand it a Map. */
export interface LiteRtCacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  /** Optional: a resumable download's parts are deleted once the whole asset is in. A real `Cache` has it. */
  delete?(request: string): Promise<boolean>;
}

/** The slice size of a resumable download: 64 MiB, so a 2 GB model is 32 writes and a loss of at most one. */
export const LITERT_PART_BYTES = 64 * 1024 * 1024;

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
  /** Resumable-download slice size; default 64 MiB (`LITERT_PART_BYTES`). Tests set a few bytes. */
  partBytes?: number;
  /** Injected by tests; in a browser the dynamic import above is what runs. */
  createTask?: LiteRtTaskFactory;
  /** Injected by tests; in a browser `createImageBitmap` is what runs. */
  createImageSource?: LiteRtImageSourceFactory;
  /** Overrides the catalogue row's `vision` — for a model that is not in any catalogue. */
  vision?: boolean;
  /** How many pictures the task is created to accept. Defaults to `LITERT_MAX_IMAGES`. */
  maxNumImages?: number;
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
function countUsage(task: LiteRtTaskLike, prompt: LiteRtPrompt, answer: string): Usage | undefined {
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
  /** Whether this row takes pictures at all — the catalogue's `vision`, or the caller's override. */
  readonly seesImages: boolean;
  private readonly opts: LiteRtProviderOptions;
  private readonly createTask: LiteRtTaskFactory;
  private readonly createImageSource: LiteRtImageSourceFactory;
  private readonly cacheName: string;
  /** The slice a resumable download is written to disk in; a test makes it tiny. */
  private readonly partBytes: number;
  private task: LiteRtTaskLike | null = null;
  private loading: Promise<LiteRtTaskLike> | null = null;
  /** The load in flight, so `abortLoad()` can pull it: the download's fetch, or a compile to abandon. */
  private loadController: AbortController | null = null;
  /** Remembered so `readiness()` need not re-open the cache on every poll of a settings screen. */
  private cached: boolean | null = null;
  /**
   * The last download report, so `readiness()` can carry the typed `progress` of the 2026-09-10
   * contract revision. A settings screen polls readiness on a timer and has no way to be handed the
   * `onProgress` callback of a provider it did not construct; without this, a two-gigabyte download
   * looks identical to one that has not started.
   */
  private progress: ReadinessProgress | null = null;
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
    this.createImageSource = opts.createImageSource ?? importImageSource;
    this.seesImages = opts.vision ?? this.model?.vision === true;
    this.cacheName = opts.cacheName ?? LITERT_MODEL_CACHE;
    this.partBytes = Math.max(1, Math.floor(opts.partBytes ?? LITERT_PART_BYTES));
    // THE ROW'S `contextTokens` IS WHAT IS ASKED FOR AT LOAD: `load()` hands `applied.maxTokens`
    // straight to `createFromOptions`, so raising a row's number raises the KV cache the task is
    // built with. A caller's explicit `maxTokens` still wins, for a host that knows its device.
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
    // Bytes in hand, task not built: the runtime is compiling the model for the GPU. That is a wait
    // a person sees (tens of seconds for a 2 GB model) and it is not "ready", whatever the cache
    // says — before this check the chip said 100 % and sat there, which reads as stuck.
    if (this.loading && this.progress?.phase === "load") {
      return { ready: false, reason: "download", detail: `Loading ${this.modelId} into the GPU…`, progress: this.progress };
    }
    if (await this.isCached()) return { ready: true };
    if (this.progress) return { ready: false, reason: "download", detail: `Downloading ${this.modelId}…`, progress: this.progress };
    // An earlier download that was stopped or cut off: say how far it got, and that it resumes.
    const partial = await this.partialProgress();
    if (partial) {
      const pct = partial.percent !== undefined ? `${partial.percent} %` : `${Math.round(partial.loadedBytes / 1048576)} MB`;
      return {
        ready: false,
        reason: "download",
        detail: `${this.modelId} is ${pct} downloaded — it resumes with your next message.`,
        progress: partial,
      };
    }
    return { ready: false, reason: "download", detail: `${this.modelId} has not been downloaded to this browser yet.` };
  }

  /** One place that both calls the caller's listener and remembers the numbers for `readiness()`. */
  private report(report: LiteRtProgress): void {
    this.progress = {
      loadedBytes: report.loadedBytes,
      totalBytes: report.totalBytes,
      // Only when it can be computed honestly: a host that sent no `Content-Length` knows how much
      // has arrived and cannot know how much is left, and a made-up bar is worse than no bar.
      percent: report.totalBytes ? Math.min(100, Math.round((report.loadedBytes / report.totalBytes) * 100)) : undefined,
    };
    this.opts.onProgress?.(report);
  }

  /** `<asset>?part=<i>` — one complete slice of an interrupted download, kept so the next try resumes. */
  private partKey(i: number): string {
    return `${this.assetUrl}?part=${i}`;
  }
  /** `<asset>?meta` — `{ totalBytes, parts }`, so readiness can say "42 % downloaded" without reading the parts. */
  private metaKey(): string {
    return `${this.assetUrl}?meta`;
  }

  private async readMeta(cache: LiteRtCacheLike): Promise<{ totalBytes?: number; parts: number }> {
    try {
      const hit = await cache.match(this.metaKey());
      if (!hit) return { parts: 0 };
      const meta = (await hit.json()) as { totalBytes?: number; parts?: number };
      return { totalBytes: typeof meta.totalBytes === "number" ? meta.totalBytes : undefined, parts: typeof meta.parts === "number" ? meta.parts : 0 };
    } catch {
      return { parts: 0 };
    }
  }

  private async writeMeta(cache: LiteRtCacheLike, meta: { totalBytes?: number; parts: number }): Promise<void> {
    try {
      await cache.put(this.metaKey(), new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    } catch {
      /* a meta that will not write only costs the resume its readiness line */
    }
  }

  private async dropParts(cache: LiteRtCacheLike, count: number): Promise<void> {
    if (!cache.delete) return;
    for (let i = 0; i < count; i++) await cache.delete(this.partKey(i)).catch(() => false);
    await cache.delete(this.metaKey()).catch(() => false);
  }

  /**
   * What an interrupted download left behind, for `readiness()`: how far it got, from the meta alone.
   * `null` when nothing is on disk, or when the full asset is (then it is simply cached).
   */
  private async partialProgress(): Promise<ReadinessProgress | null> {
    const storage = this.cacheStorage();
    if (!storage) return null;
    try {
      const cache = await storage.open(this.cacheName);
      const meta = await this.readMeta(cache);
      if (!meta.parts) return null;
      const loadedBytes = meta.parts * this.partBytes;
      return {
        loadedBytes,
        totalBytes: meta.totalBytes,
        percent: meta.totalBytes ? Math.min(100, Math.round((loadedBytes / meta.totalBytes) * 100)) : undefined,
        phase: "paused",
      };
    } catch {
      return null;
    }
  }

  /**
   * The asset, cache first — and RESUMABLE (2026-09-11, Bruno: "is a download interrupted when I
   * leave the tab?" — it was, and it started over).
   *
   * The download is read as a stream so a person watching a half-gigabyte download sees it move,
   * and every complete `partBytes` slice (64 MiB by default) is written to Cache Storage as it
   * lands. A stop, a closed tab, a phone that froze the page: the next `load()` reads the parts
   * back, asks the host for the rest with a `Range` header, and continues. A host that ignores the
   * range (answers 200 instead of 206) gets a fresh start and the parts are dropped, because bytes
   * from two different answers must never be stitched. When the last byte is in, the whole asset is
   * written under its own key and the parts are deleted — nothing half-right stays on the disk.
   * A host that sends no `Content-Length` still gets byte counts, just no percentage.
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
          this.report({ progress: 1, loadedBytes: 0, text: `${this.modelId} is already on this device.` });
          return new Uint8Array(await hit.arrayBuffer());
        }
      } catch {
        cache = undefined;
      }
    }

    // What an earlier try left behind: complete parts, in order, until the first gap.
    let parts: Uint8Array[] = [];
    let loaded = 0;
    let total: number | undefined;
    if (cache) {
      const meta = await this.readMeta(cache);
      total = meta.totalBytes;
      for (let i = 0; i < meta.parts; i++) {
        const hit = await cache.match(this.partKey(i)).catch(() => undefined);
        if (!hit) break;
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.byteLength !== this.partBytes) break;
        parts.push(bytes);
        loaded += bytes.byteLength;
      }
      if (loaded) this.report({ progress: total ? loaded / total : 0, loadedBytes: loaded, totalBytes: total, text: `Resuming ${this.modelId}…` });
    }

    const headers: Record<string, string> = loaded ? { Range: `bytes=${loaded}-` } : {};
    const response = await this.doFetch(this.assetUrl, { signal, headers });
    if (loaded && response.status === 200) {
      // The host does not do ranges: start over rather than stitch two answers together.
      if (cache) await this.dropParts(cache, parts.length);
      parts = [];
      loaded = 0;
      total = undefined;
    } else if (loaded && response.status !== 206) {
      throw new ProviderError({
        status: response.status,
        code: response.status === 404 ? "bad_request" : "server_error",
        message: `The model asset ${this.assetUrl} could not be resumed (HTTP ${response.status}).`,
        providerId: this.id,
      });
    }
    if (!response.ok) {
      throw new ProviderError({
        status: response.status,
        code: response.status === 404 ? "bad_request" : "server_error",
        message: `The model asset ${this.assetUrl} could not be fetched (HTTP ${response.status}).`,
        providerId: this.id,
      });
    }
    if (response.status === 206) {
      const range = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
      if (range) total = Number(range[1]);
    } else {
      const header = response.headers.get("content-length");
      const n = header ? Number(header) : NaN;
      total = Number.isFinite(n) && n > 0 ? n : undefined;
    }
    if (cache && total && parts.length === 0) await this.writeMeta(cache, { totalBytes: total, parts: 0 });

    const body = response.body;
    if (body) {
      const reader = body.getReader();
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        pending.push(value);
        pendingBytes += value.byteLength;
        loaded += value.byteLength;
        this.report({ progress: total ? loaded / total : 0, loadedBytes: loaded, totalBytes: total, text: `Downloading ${this.modelId}…` });
        // Every complete part goes to disk as it lands: that is what the next try resumes from.
        while (pendingBytes >= this.partBytes) {
          const part = new Uint8Array(this.partBytes);
          let at = 0;
          const rest: Uint8Array[] = [];
          for (const chunk of pending) {
            const room = this.partBytes - at;
            if (room <= 0) {
              rest.push(chunk);
              continue;
            }
            if (chunk.byteLength <= room) {
              part.set(chunk, at);
              at += chunk.byteLength;
            } else {
              part.set(chunk.subarray(0, room), at);
              at += room;
              rest.push(chunk.subarray(room));
            }
          }
          pending = rest;
          pendingBytes -= this.partBytes;
          parts.push(part);
          if (cache) {
            try {
              await cache.put(this.partKey(parts.length - 1), new Response(part.slice().buffer, { headers: { "Content-Type": "application/octet-stream" } }));
              await this.writeMeta(cache, { totalBytes: total, parts: parts.length });
            } catch {
              // Out of quota mid-way: the download still completes in memory; only the resume is lost.
            }
          }
        }
      }
      if (pendingBytes) {
        const tail = new Uint8Array(pendingBytes);
        let at = 0;
        for (const chunk of pending) {
          tail.set(chunk, at);
          at += chunk.byteLength;
        }
        parts.push(tail);
      }
    } else {
      const rest = new Uint8Array(await response.arrayBuffer());
      parts.push(rest);
      loaded += rest.byteLength;
    }

    const bytes = new Uint8Array(loaded);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }

    if (cache) {
      try {
        // A fresh Response over a COPY of the bytes: the buffer handed to the task must not be one
        // the cache still owns. Then the parts go: the asset is whole, and nothing half-right stays.
        await cache.put(this.assetUrl, new Response(bytes.slice().buffer, { headers: { "Content-Type": "application/octet-stream" } }));
        this.cached = true;
        await this.dropParts(cache, parts.length);
      } catch {
        // Out of quota is not a reason to refuse the answer: the model is in hand, it just will not
        // survive the tab. The next open downloads it again, which is slow, not broken.
      }
    }
    this.report({ progress: 1, loadedBytes: bytes.byteLength, totalBytes: total, text: `${this.modelId} is ready.` });
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
    if (!this.loading) this.loadController = new AbortController();
    const controller = this.loadController!;
    // The caller's signal joins the load's own: a run that is stopped aborts the download it started,
    // and `abortLoad()` aborts it for everyone waiting — both roads end in one controller.
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    this.loading ??= (async () => {
      const modelAssetBuffer = await this.assetBytes(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("The model load was stopped.", "AbortError");
      // The download is over; what follows is the compile. Say so, with the bytes as a full bar and
      // the phase set, so a host draws "loading" rather than a download stuck at 100 %.
      this.progress = {
        loadedBytes: modelAssetBuffer.byteLength,
        totalBytes: modelAssetBuffer.byteLength,
        percent: 100,
        phase: "load",
      };
      this.opts.onProgress?.({ progress: 1, loadedBytes: modelAssetBuffer.byteLength, totalBytes: modelAssetBuffer.byteLength, text: `Loading ${this.modelId} into the GPU…` });
      return this.createTask({
        modelAssetBuffer,
        wasmBaseUrl: this.wasmBaseUrl,
        maxTokens: this.applied.maxTokens,
        topK: this.opts.topK,
        temperature: this.applied.temperature,
        randomSeed: this.opts.randomSeed,
        ...(this.seesImages ? { maxNumImages: this.opts.maxNumImages ?? LITERT_MAX_IMAGES } : {}),
      });
    })().then(
      (task) => {
        this.loading = null;
        this.loadController = null;
        if (controller.signal.aborted) {
          // The compile cannot be interrupted, so a stop during it lands here: the task is closed the
          // moment it exists, never kept, and the caller hears "stopped", not "ready".
          task.close?.();
          this.progress = null;
          throw providerErrorFromThrow(this.id, controller.signal.reason ?? new DOMException("The model load was stopped.", "AbortError"), controller.signal);
        }
        this.task = task;
        return task;
      },
      (err: unknown) => {
        // A failed load must not latch: the person may be offline now and online in a minute.
        this.loading = null;
        this.loadController = null;
        this.progress = null;
        throw providerErrorFromThrow(this.id, err, controller.signal);
      },
    );
    return this.loading;
  }

  /**
   * Close the task and give the GPU back. ADDITIVE to the frozen `ModelProvider` (finding 4 of the
   * handoff Status asks for it); calling it twice is a no-op, which is what a settings screen needs.
   */
  async unload(): Promise<void> {
    this.abortLoad();
    const task = this.task;
    this.task = null;
    task?.close?.();
  }

  /** Stop the load in flight (contract addition of 2026-09-11). Nothing loading, nothing happens. */
  abortLoad(): void {
    this.loadController?.abort(new DOMException("The model load was stopped.", "AbortError"));
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

  /**
   * The transcript as one prompt, with the fallback instruction folded into the system turn.
   *
   * A text row gets the string it always got — `renderPrompt` drops any pictures and writes the note
   * in their place. A vision row gets the part LIST, because that is the only shape a picture can
   * travel in (`Prompt = PromptPart | PromptPart[]`), and the conversion of each one happens here so
   * that a picture too big to send fails BEFORE the generation starts rather than half way through.
   */
  private async buildPrompt(req: ChatRequest): Promise<LiteRtPrompt> {
    /**
     * Signatures, not schemas — unless this row's `contextTokens` says it has the room. Every row
     * this package ships is 2048–8192, where the raw dump is a third of the whole KV cache.
     */
    const instruction = req.tools?.length
      ? fallbackToolPrompt(req.tools, { schemas: (this.model?.contextTokens ?? 0) >= FALLBACK_SCHEMAS_MIN_CONTEXT })
      : "";
    const messages = instruction ? withToolInstruction(req.messages, instruction) : req.messages;
    if (!this.seesImages || !hasImages(messages)) return renderPrompt(messages, this.family);
    const parts: LiteRtPromptPart[] = [];
    for (const segment of renderPromptSegments(messages, this.family)) {
      if (segment.kind === "text") parts.push(segment.text);
      else parts.push({ imageSource: await this.createImageSource(segment.image, this.id) });
    }
    return parts;
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
    const prompt = await this.buildPrompt(req);
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
    const prompt = await this.buildPrompt(req);
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
