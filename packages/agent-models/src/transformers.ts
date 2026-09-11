/**
 * THE THIRD LOCAL BRAIN — Transformers.js on ONNX Runtime Web, and the only one that SEES (§6.1).
 *
 * WHY A THIRD LOCAL PROVIDER, when there are already two. Bruno asked for Gemma 4 E2B with pictures
 * in the tab, and the two runtimes we had cannot both give him that:
 *
 *   · LiteRT's Gemma 4 web builds are TEXT ONLY — the `litert-community` cards say so, and
 *     `LITERT_CATALOG`'s Gemma 4 rows carry no `vision` flag because of it. LiteRT's vision rows are
 *     Gemma 3n, a generation behind, and gated at their source.
 *   · web-llm's only vision builds are Phi-3.5-vision at ~4 GB of VRAM, which is not Gemma and is
 *     not in that catalogue either (see rule 3 of webllm.ts).
 *
 * `onnx-community/gemma-4-E2B-it-ONNX` is the same weights as LiteRT's Gemma 4 E2B, exported to ONNX,
 * ungated, Apache-2.0, and it runs on WebGPU through Transformers.js WITH the vision encoder. So the
 * picture road exists; it just runs on a third runtime. All three sit behind the one `ModelProvider`
 * door and the router ranks a sighted peer first for a turn that carries an image (router.ts,
 * `ordered()`), so this row is reached exactly when it is the one that can answer.
 *
 * SIX FACTS ABOUT THE INSTALLED LIBRARY SHAPE THIS FILE, and every one of them is read out of
 * `@huggingface/transformers@4.2.0` in `node_modules`, not remembered:
 *
 * 1. THE LIBRARY FETCHES ITS OWN FILES, AND ITS `env` IS A GLOBAL SINGLETON. There is no per-call
 *    host: `buildResourcePaths` in `src/utils/hub.js` composes every URL as
 *    `pathJoin(env.remoteHost, env.remotePathTemplate.replace("{model}", id).replace("{revision}", rev), file)`.
 *    So pointing this provider at our mirror means WRITING TO A MODULE-LEVEL OBJECT, which is a wart
 *    and is treated as one: `applyEnv()` is called at the top of every `load()` so the last provider
 *    to start loading owns the settings, and nothing here assumes they survived.
 *
 * 2. THE WASM COMES FROM OUR ORIGIN, NEVER A CDN — the same rule as MediaPipe's (litert.ts rule 1).
 *    `env.backends.onnx.wasm.wasmPaths` is the prefix ONNX Runtime Web appends its own file names to
 *    (`ort-wasm-simd-threaded.jsep.wasm` + its `.mjs` loader for the WebGPU build). The default here
 *    is the relative `ONNX_DEFAULT_WASM_PATH`; the app copies the pair out of the installed package
 *    at build time (apps/infinite/vite.config.ts, `ortWasm()`), so a local brain still loads on a
 *    plane. A jsdelivr default would be a local brain that stops working when the network does.
 *
 * 3. THE DOWNLOAD DOES NOT RESUME, AND NOTHING HERE CAN MAKE IT. In a browser `loadResourceFile`
 *    reads each file with `readResponse` into ONE `Uint8Array` and then puts it in Cache Storage;
 *    there is no `Range` header and no part file anywhere in the package. `LiteRtProvider`'s
 *    part-wise resumable download cannot be lent to it, because the fetching happens inside the
 *    library. Two consequences, both stated rather than hidden: the row's `note` says the download
 *    starts over if it is interrupted, and the biggest single buffer this path allocates is the
 *    1.52 GB decoder data file — under Chrome's ArrayBuffer ceiling, but the same class of
 *    allocation that failed at 3 GB on 2026-09-11 and the reason the row is desktop-only.
 *
 * 4. PROGRESS IS AGGREGATED FOR US, AGAINST A DENOMINATOR THAT GROWS. `DefaultProgressCallback` in
 *    `src/utils/core.js` emits `progress_total` with `loaded`/`total` summed over the files that have
 *    STARTED — so its `total` climbs as each file begins and a percentage derived from it alone would
 *    walk backwards. The row's own `sizeBytes` is the honest denominator (it is the sum of the exact
 *    Hub sizes, pinned below), so `totalBytes` is the larger of the two and the bar only ever fills.
 *
 * 5. THE SESSIONS ARE NOT NEGOTIABLE. `MODEL_SESSION_CONFIG[ImageAudioTextToText]` in
 *    `src/models/session_config.js` builds `embed_tokens`, `decoder_model_merged`, `vision_encoder`
 *    AND `audio_encoder` unless the caller loads through a `…ForCausalLM` class, which drops vision
 *    with it. There is no vision-without-audio load. So the audio encoder is mirrored and downloaded
 *    (171 MB of the 3.40 GB) even though nothing sends audio yet — `audio: true` on the row records
 *    that the capability is paid for and unused, and `ChatMessage` has no audio part to send it.
 *
 * 6. TOOL CALLS TAKE THE PROMPT FALLBACK, DELIBERATELY. The repo's `chat_template.jinja` DOES have a
 *    native function-calling path (`format_function_declaration`, `declaration:` blocks), so unlike
 *    LiteRT this is a choice and not an absence: its output is a bespoke `<|"|>`-quoted syntax that
 *    would need its own parser, while `parseFallbackToolCalls` is the mechanism both other local
 *    brains already use and the one the runtime's tests cover. `TRANSFORMERS_NATIVE_TOOLS` is the
 *    constant that says the road exists and is not taken, so the day someone takes it the test that
 *    pins it says so rather than the behaviour drifting.
 */

import { ProviderError, providerErrorFromThrow, throwIfAborted } from "./errors.js";
import { decodeImage, withoutImages } from "./image-parts.js";
import { APACHE_2, LITERT_CATALOG, LLAMA_3_2, MIT, type LiteRtModelInfo } from "./litert.js";
import { mapFinishReason } from "./openai-compatible.js";
import type { FetchLike, Readiness } from "./openai-compatible.js";
import { assistantTurnText, stopAtTurnEnd, toolTurnText, turnMarkerIndex, turnMarkerMaxLength } from "./templates.js";
import type { PromptFamily } from "./templates.js";
import { FALLBACK_SCHEMAS_MIN_CONTEXT, fallbackToolPrompt, parseFallbackToolCalls } from "./tool-fallback.js";
import { offeredOn } from "./types.js";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Host,
  ImagePart,
  ModelInfo,
  ModelProvider,
  ReadinessProgress,
  ToolCall,
} from "./types.js";

/** The installed runtime this file was written against. Pinned by test to the installed package.json. */
export const TRANSFORMERS_VERSION = "4.2.0";

/**
 * Whether this provider takes the model's OWN function-calling path. It does not, and that is a
 * decision rather than a limit — see fact 6 in the module header.
 */
export const TRANSFORMERS_NATIVE_TOOLS = false;

/** The provider id. Distinct from `local` and `local-litert` so a chip can name WHICH runtime answered. */
export const TRANSFORMERS_PROVIDER_ID = "local-onnx";

/**
 * The Cache Storage bucket the library is told to use (`env.cacheKey`). Ours rather than its default
 * `transformers-cache`, so `clearCache()` can give the three gigabytes back without touching a cache
 * some other script on the origin put there.
 */
export const TRANSFORMERS_MODEL_CACHE = "00-onnx-models";

/**
 * Where ONNX Runtime Web's wasm is served from when the caller names no other path.
 *
 * Relative to the app's origin ON PURPOSE (fact 2). ORT appends its own file name, so this is a
 * PREFIX and must end in a slash — `wasmPaths` is documented as such, and a prefix without the slash
 * silently becomes part of the file name.
 */
export const ONNX_DEFAULT_WASM_PATH = "/ort/";

/** The Hub, for the one case where a deploy points straight at it (a dev check; see `pathTemplateFor`). */
export const TRANSFORMERS_HUB_HOST = "https://huggingface.co";
/** The Hub's own layout: `<host>/<repo>/resolve/<revision>/<file>`. The library's default. */
export const TRANSFORMERS_HUB_PATH_TEMPLATE = "{model}/resolve/{revision}/";
/** Our mirror's layout: `<host>/<repo>/<file>`, because R2 keys are the repo path and nothing else. */
export const TRANSFORMERS_MIRROR_PATH_TEMPLATE = "{model}/";

/**
 * Which layout a host speaks, guessed from the host and overridable.
 *
 * TWO LAYOUTS EXIST AND NEITHER IS WRONG. Our mirror stores a repo's files under their own relative
 * paths (`onnx/<org>/<repo>/<path>`), so the template is `{model}/`. The Hub puts a `resolve/<rev>`
 * segment in the middle. A deploy that points `modelBaseUrl` at the Hub — which is how the row is
 * checked live before a publish has happened — needs the second one, and making that a separate
 * environment variable nobody remembers to set is how a live check turns into an afternoon of 404s.
 */
export function pathTemplateFor(baseUrl: string): string {
  return /(^|\/\/|\.)(huggingface\.co|hf\.co)(\/|$)/.test(baseUrl) ? TRANSFORMERS_HUB_PATH_TEMPLATE : TRANSFORMERS_MIRROR_PATH_TEMPLATE;
}

// ── The catalogue ────────────────────────────────────────────────────────────────────────────────

/**
 * A row this runtime can load.
 *
 * It EXTENDS `LiteRtModelInfo` rather than inventing a second row shape, because the app's picker
 * (`apps/infinite/src/lib/litert-catalog.ts`, `mergeMirrorCatalog`) joins the mirror's catalogue to
 * the package's on ONE field — `assetFile` — and a second shape would mean a second join, a second
 * phone filter and a second consent line. `assetFile` here is the repo's DIRECTORY name on the
 * mirror, not a file: a Transformers.js model is fifteen files, and the directory is the thing a
 * person picks. `runtime` is what tells the app which provider to build for it.
 */
export interface TransformersModelInfo extends LiteRtModelInfo {
  runtime: "transformers";
  /** The Hub-style repo id, which is also its path on the mirror: `<org>/<name>`. */
  repo: string;
  /** The quantisation the row loads (`dtype` on `from_pretrained`). */
  dtype: string;
  /** The exact sum of the Hub's sizes for the files this dtype needs. The download bar's denominator. */
  sizeBytes: number;
  /** The commit the sizes and hashes below were read at, and the one the mirror pins. */
  revision: string;
  /** Paid for and unused: the load builds an audio encoder it is given no audio for (fact 5). */
  audio?: boolean;
  /**
   * What one picture may cost this row, and the only lever that made a vision turn usable
   * (2026-09-11, later still). Absent on a text row, and absent means "whatever the repo's
   * `processor_config.json` says" — which is the 280-token default that cost twenty-five minutes.
   */
  visionBudget?: TransformersVisionBudget;
  /** Said out loud on the picker row, because both halves of it are surprising. */
  note?: string;
  /**
   * EXACTLY THE FILES THIS ROW'S LOAD FETCHES, with the Hub's own sizes and sha256.
   *
   * Per row since the five rows of 2026-09-11, because no two of them have the same set: a vision row
   * is four graphs or three (Gemma 4 has an audio encoder, Qwen3.5 has none), a text row is one, and
   * how many `_data` chunks a graph has is `use_external_data_format` in its own `config.json` and
   * nothing else. `sizeBytes` is the sum of this list and a test adds it up, so a file added here
   * without its bytes cannot silently shrink the download bar's denominator.
   */
  files: readonly TransformersFileRow[];
  /**
   * The ONE file the readiness probe asks Cache Storage about: the biggest, and the last to land.
   * Fifteen `match` calls would be fifteen times the work for the same answer, and a partial set is
   * not a usable model anyway.
   */
  probeFile: string;
}

// WHICH DOOR A ROW LOADS THROUGH is DERIVED from `vision` and never stored: `AutoProcessor` +
// `AutoModelForImageTextToText` for a row that sees, `AutoTokenizer` + `AutoModelForCausalLM` for one
// that does not. Two fields that must agree is one field — and the installed library draws the same
// line, `MODEL_SESSION_CONFIG[ImageTextToText]` building embed_tokens/decoder_model_merged/
// vision_encoder where `DecoderOnly` builds a single `model` session.

/** One file of a row, as the Hub records it. `sha256` is the LFS hash, or ours for a small text file. */
export interface TransformersFileRow {
  file: string;
  bytes: number;
  sha256: string;
}

// ── The visual token budget ──────────────────────────────────────────────────────────────────────

/**
 * WHAT ONE PICTURE COSTS, AND WHERE THE NUMBER IS WRITTEN.
 *
 * THE DEFAULTS, AND WHY NEITHER IS A LIMIT ANYBODY MEANT FOR A TAB. Gemma 4's export ships
 * `max_soft_tokens: 280` — the largest of the five its card lists (70 / 140 / 280 / 560 / 1120) —
 * and the Qwen3.5 exports ship `size.longest_edge: 16777216`, sixteen MEGApixels, which is 16 384
 * visual tokens against a row whose whole context budget here is 8192. Neither is wrong on a
 * workstation. Both are wrong where this runs.
 *
 * MEASURED, on the Gemma 4 E2B row over WebGPU on an M-series Mac, 2026-09-11, a 400 × 300 picture on
 * a short prompt, time from `generate()` to the first token, three runs each:
 *
 *     280 tokens (the export's default) → 1662 / 1667 ms, prompt 318 tokens
 *     140 tokens (this row's budget)    →  885 /  888 ms, prompt 182 tokens
 *      70 tokens                        →  571 /  567 ms, prompt 115 tokens
 *
 * — so the default costs 1.9× what 140 does, and the processor's own encode falls with it (84 → 48 ms).
 * What it is NOT is the twenty-five-minute turn of the round before: that was measured again here and
 * is prefill against the agent's ~5k-token system prompt, which on this row grows superlinearly
 * (43 tokens → 0.37 s, 537 → 1.7 s, 1317 → 4.6 s, 2617 → 15.8 s, and ~3600 fails outright). The
 * picture rides on the worst part of that curve, which is why halving its share is worth doing and
 * why it is not on its own the fix. See docs/HANDOFF-infinite-agent.md for the rest.
 *
 * ONE ARITHMETIC FOR TWO FAMILIES. A visual token covers a square of `patchSize * pool` pixels in
 * both processors, so `tokens * (patchSize * pool)²` is the pixel budget for either — the two
 * families differ only in WHICH end of that identity their field takes. Gemma's `max_soft_tokens`
 * takes the token count; Qwen's `max_pixels` takes the pixels. `pool` is Gemma's
 * `pooling_kernel_size` (3) and Qwen's `merge_size` (2), read out of the repos' own configs on
 * 2026-09-11 and pinned by a test against the shape the installed processors compute.
 *
 * THE DIFFERENCE THAT MATTERS WHEN CHOOSING A NUMBER. Qwen's cost SCALES with the picture:
 * `smart_resize` only shrinks past `max_pixels`, so a small photo is cheap on its own. Gemma's does
 * not: `Gemma4ImageProcessor` resizes every image — UP as readily as down — to
 * `max_soft_tokens * pooling_kernel_size² * patch_size²` pixels and then zero-pads the patch tensor to
 * `max_soft_tokens * pooling_kernel_size²` rows regardless. So a Gemma vision turn costs the same
 * whether it is shown a thumbnail or a poster, and the budget is the ONLY lever there is.
 */
export interface TransformersVisionBudget {
  /** Visual tokens ONE picture may cost this model. */
  tokens: number;
  /**
   * Which field on the processor's image half carries it — and it IS a field, not a call-time kwarg;
   * see `applyVisionBudget` for why, and for the two lines of the installed library that decide it.
   */
  knob: "max_soft_tokens" | "max_pixels";
  /** `patch_size` from the repo's own image-processor config. 16 on all four vision rows. */
  patchSize: number;
  /** Gemma's `pooling_kernel_size` (3), Qwen's `merge_size` (2): the side, in patches, of one token. */
  pool: number;
}

/** The pixels a picture may carry before it costs more than `tokens`. One token is a
 *  `patchSize * pool` square, which is the one identity both image processors are built on. */
export function visionBudgetPixels(budget: TransformersVisionBudget): number {
  return budget.tokens * (budget.patchSize * budget.pool) ** 2;
}

/** The inverse — what a picture of this many pixels costs a row whose processor SCALES (the Qwen
 *  rows). Gemma's does not scale, which is the whole point of `knob`; see the interface. */
export function visionTokensForPixels(pixels: number, budget: TransformersVisionBudget): number {
  return Math.floor(pixels / (budget.patchSize * budget.pool) ** 2);
}

/** The number the knob itself takes: a token count for `max_soft_tokens`, a pixel count for
 *  `max_pixels`. Two fields, one budget, and nowhere for the conversion to be done twice. */
export function visionBudgetValue(budget: TransformersVisionBudget): number {
  return budget.knob === "max_soft_tokens" ? budget.tokens : visionBudgetPixels(budget);
}

/**
 * GEMMA 4: 140 TOKENS, THE CARD'S MIDDLE SETTING.
 *
 * The card offers 70 / 140 / 280 / 560 / 1120 and the export ships 280. 140 is taken rather than 70
 * because 70 is the FAST one and not the good one — it is what the repo's own `video_processor` uses,
 * where a frame is one of thirty-two and nobody reads text off it — while a person attaching a
 * screenshot has usually attached it to be read. 140 halves the tokens a picture adds to the prefill
 * and quarters the vision encoder's attention, and at `140 * 9 * 16²` pixels it still resizes a square
 * picture to about 568 px a side rather than 803 px, which is legible.
 */
export const GEMMA_4_VISION_BUDGET: TransformersVisionBudget = { tokens: 140, knob: "max_soft_tokens", patchSize: 16, pool: 3 };

/**
 * QWEN3.5: 256 TOKENS, EXPRESSED AS PIXELS BECAUSE THAT IS THE FIELD.
 *
 * `256 * (16 * 2)² = 262144` pixels — a 512 × 512 picture, or any other shape of the same area, since
 * `smart_resize` preserves the aspect ratio. The export's own default is `longest_edge: 16777216`,
 * which is not a limit anybody meant: sixteen megapixels is 16384 visual tokens against the row's
 * 8192-token budget, so the FIRST screenshot a person attached would overflow the context before a
 * word of it was read. 256 is chosen to sit where Gemma's 140 does in wall-clock terms rather than in
 * token terms — Qwen's tokens are `merge_size² = 4` patches where Gemma's are 9, so the same picture
 * area buys more of them.
 */
export const QWEN3_5_VISION_BUDGET: TransformersVisionBudget = { tokens: 256, knob: "max_pixels", patchSize: 16, pool: 2 };

/**
 * THE FILES ONE q4f16 VISION LOAD FETCHES, with the Hub's own sizes and LFS hashes (read from
 * `https://huggingface.co/api/models/onnx-community/gemma-4-E2B-it-ONNX?blobs=true` on 2026-09-11 at
 * commit 9f4bef82). Exported because two things need exactly this list and must not each guess it:
 * `scripts/publish-litert-models.sh`, which mirrors them, and the test that adds them up and checks
 * the sum against the row's `sizeBytes`.
 *
 * WHY THESE FIFTEEN AND NOT OTHERS. `config.json`'s `transformers.js_config.use_external_data_format`
 * names one `_data` chunk for each of the four q4f16 graphs; `Gemma4Processor` declares
 * `uses_processor_config` and `uses_chat_template_file`, which is `processor_config.json` and
 * `chat_template.jinja`; the tokenizer is `tokenizer.json` + `tokenizer_config.json`;
 * `generation_config.json` is the type's one optional config and `preprocessor_config.json` is the
 * 43-byte file that names the processor class. Nothing else in the repo is touched, and the other
 * five dtypes (fp16, q4, quantized, and the unquantised 12 GB set) are deliberately not mirrored.
 */
export const GEMMA_4_E2B_ONNX_FILES: readonly { file: string; bytes: number; sha256: string }[] = [
  { file: "config.json", bytes: 5549, sha256: "5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa" },
  { file: "generation_config.json", bytes: 238, sha256: "e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155" },
  { file: "preprocessor_config.json", bytes: 43, sha256: "4457c6e8a09070d7d5d1cd983fbfb67ebafe602bd98120c3543a024f5d07056b" },
  { file: "processor_config.json", bytes: 1689, sha256: "32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c" },
  { file: "chat_template.jinja", bytes: 16317, sha256: "781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf" },
  { file: "tokenizer_config.json", bytes: 18807, sha256: "06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3" },
  { file: "tokenizer.json", bytes: 19439251, sha256: "47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566" },
  { file: "onnx/embed_tokens_q4f16.onnx", bytes: 5621, sha256: "d7ca53f6a169471b5699b2f57ee4c7aa2c73732b0152f3909e64b71384444825" },
  { file: "onnx/embed_tokens_q4f16.onnx_data", bytes: 1590689792, sha256: "024b199e6358ed42970f807686add5f9430d7e254ca7ce22fc9c83f015b9c517" },
  { file: "onnx/decoder_model_merged_q4f16.onnx", bytes: 673231, sha256: "73c0f1fe04f9a3a048fb3319c0671b6cf0346bf33a3a8624c853bcffe01c24a4" },
  { file: "onnx/decoder_model_merged_q4f16.onnx_data", bytes: 1519700992, sha256: "3b27245a7396cb7039a4e4118bd2a8aa35106bae381522edf7c4867b5f22bb10" },
  { file: "onnx/vision_encoder_q4f16.onnx", bytes: 189124, sha256: "e0a4e48e519ade4eeddbb4cdadb812a7251aea871f7fb5f50576615fd3af22a3" },
  { file: "onnx/vision_encoder_q4f16.onnx_data", bytes: 99189440, sha256: "0835071d2c79c105f8e1b549b7f8dd8c9af07fa95f01ead2e7add280602d3c6d" },
  { file: "onnx/audio_encoder_q4f16.onnx", bytes: 260446, sha256: "5e0deb22791685c792d4b8e089deef9670fa4a4cecde434213d6a742e58fc3fa" },
  { file: "onnx/audio_encoder_q4f16.onnx_data", bytes: 171258112, sha256: "df58e61a00bafa9449ee5fd52895ce952f158bbdd1fe38df8a68f48f36842e62" },
];


/**
 * THE FIVE ROWS BRUNO PICKED ON 2026-09-11, and the files each one's q4f16 load fetches.
 *
 * Every list below was read from `https://huggingface.co/api/models/<repo>?blobs=true` at the commit
 * named on the row: the sizes and the LFS sha256 come from that document, and the half-dozen small
 * text files it records no LFS hash for (`config.json`, the tokenizer config, `chat_template.jinja`)
 * were fetched at that same commit and hashed here. The same numbers are the publish script's rows,
 * and the Worker re-verifies each hash on the way into the bucket.
 *
 * WHAT DECIDES A LIST. `transformers.js_config.use_external_data_format` in each repo's own
 * `config.json` says how many `_data` chunks a graph has — ONE for the small Qwen rows, TWO for the
 * 4B decoder and for both text rows, which is why `…onnx_data_1` appears there and nowhere else. The
 * session set is the library's, not ours: the Qwen3.5 rows are `ImageTextToText`
 * (embed_tokens + decoder_model_merged + vision_encoder — and NO audio encoder, unlike Gemma 4's
 * `ImageAudioTextToText`), the Phi and Llama rows are `DecoderOnly` and load one `model` graph. The
 * other dtypes in each repo (fp16, q4, quantized, unquantised) are deliberately not mirrored.
 */

/** Qwen3.5 0.8B, vision, Apache-2.0. The first phone row that SEES — 0.67 GB, three graphs. */
export const QWEN3_5_0_8B_ONNX_FILES: readonly TransformersFileRow[] = [
  { file: "config.json", bytes: 2849, sha256: "36fed6a902ccd06ef19a452bd5a0750bd88fe347d06ab75ef515615bac5b296d" },
  { file: "generation_config.json", bytes: 248, sha256: "dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48" },
  { file: "preprocessor_config.json", bytes: 336, sha256: "6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8" },
  { file: "processor_config.json", bytes: 1300, sha256: "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b" },
  { file: "chat_template.jinja", bytes: 7755, sha256: "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80" },
  { file: "tokenizer_config.json", bytes: 9161, sha256: "fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d" },
  { file: "tokenizer.json", bytes: 19226111, sha256: "89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b" },
  { file: "onnx/embed_tokens_q4f16.onnx", bytes: 1064, sha256: "8218531ac44ae9978d50647f1d907c53c308f758514b992504238c77843c254d" },
  { file: "onnx/embed_tokens_q4f16.onnx_data", bytes: 147005440, sha256: "ec4a1f13ff942653b52000a7a0ec40504110d8be9a0ecab2da4d3063588ed563" },
  { file: "onnx/decoder_model_merged_q4f16.onnx", bytes: 1036898, sha256: "34e17c8e2035919df86ab1f52b41999a1bd18ba96b49dba6ac8d340aae652006" },
  { file: "onnx/decoder_model_merged_q4f16.onnx_data", bytes: 436662272, sha256: "468cf83a51e81e27ffb4210268b1b09979e68dd128ad5fe347e5d08721cecc41" },
  { file: "onnx/vision_encoder_q4f16.onnx", bytes: 212694, sha256: "38af0f1a2ef1d1d9c80ba4fd3bb59db8481b03b5e062999b4d6d9d14e9e0fc7b" },
  { file: "onnx/vision_encoder_q4f16.onnx_data", bytes: 61919744, sha256: "0847376fcef41cb3874a21f0eb1b75428502537e16f360bdbf854e71ef552319" },
];

/** Qwen3.5 2B, vision, Apache-2.0 (the base repo's tag — the export carries none; see the row). */
export const QWEN3_5_2B_ONNX_FILES: readonly TransformersFileRow[] = [
  { file: "config.json", bytes: 2993, sha256: "b028de63b0ed8b37107acaaf1475d40d6d4feb5721153674e7d1d0bdbfd0f258" },
  { file: "generation_config.json", bytes: 248, sha256: "dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48" },
  { file: "preprocessor_config.json", bytes: 336, sha256: "6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8" },
  { file: "processor_config.json", bytes: 1300, sha256: "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b" },
  { file: "chat_template.jinja", bytes: 7755, sha256: "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80" },
  { file: "tokenizer_config.json", bytes: 9161, sha256: "fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d" },
  { file: "tokenizer.json", bytes: 19226111, sha256: "89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b" },
  { file: "onnx/embed_tokens_q4f16.onnx", bytes: 1064, sha256: "802a072ff21f540eda7f343aa71dbb0354c8859caaf34f09b3bf8117725d7de8" },
  { file: "onnx/embed_tokens_q4f16.onnx_data", bytes: 294010880, sha256: "650aa8eb39b7404ca2c908d78243c82b6fd88321feeb8fca175745806c6b3a81" },
  { file: "onnx/decoder_model_merged_q4f16.onnx", bytes: 707377, sha256: "c567d4d34dc97185e85bb40c9c30d6f73133858b1f8a32b90166b7fea4b653bf" },
  { file: "onnx/decoder_model_merged_q4f16.onnx_data", bytes: 1088892928, sha256: "06dd7841f90e5c4ecc029193a29478750ae9dcbfeaf8cfb223cf8b69cc5666d6" },
  { file: "onnx/vision_encoder_q4f16.onnx", bytes: 394142, sha256: "2999a8fb031d394a0697c5413eb0bb624e45e4c3aacefd67524d4627679423d5" },
  { file: "onnx/vision_encoder_q4f16.onnx_data", bytes: 196945920, sha256: "c54ed06141904a99fa05a9ffaf460ee05441d50dde54f784ec2ae71a43c58314" },
];

/** Qwen3.5 4B, vision, Apache-2.0. Its decoder is the one q4f16 graph here with TWO data chunks. */
export const QWEN3_5_4B_ONNX_FILES: readonly TransformersFileRow[] = [
  { file: "config.json", bytes: 3198, sha256: "c6f9834460177e3821e035900320fa24bd11ad1c9f14bfe2e78e4398e38c4937" },
  { file: "generation_config.json", bytes: 248, sha256: "dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48" },
  { file: "preprocessor_config.json", bytes: 336, sha256: "6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8" },
  { file: "processor_config.json", bytes: 1300, sha256: "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b" },
  { file: "chat_template.jinja", bytes: 7756, sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715" },
  { file: "tokenizer_config.json", bytes: 9162, sha256: "2de621ec071dd61438efdd6d0183bd3d612e98d05ac10d19ed75f1fef9299bc9" },
  { file: "tokenizer.json", bytes: 19226111, sha256: "89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b" },
  { file: "onnx/embed_tokens_q4f16.onnx", bytes: 1064, sha256: "0e5fe965e5575b6428b7dea82661ed09bf7abadf29450c279e46e8113745110e" },
  { file: "onnx/embed_tokens_q4f16.onnx_data", bytes: 367513600, sha256: "fc1bb145d8839272a87c71e0cb4d34832a0d7bb4de06ab4fb74fea1aa6ddf7e5" },
  { file: "onnx/decoder_model_merged_q4f16.onnx", bytes: 933554, sha256: "8f159924389ced435ff445b9aaf1604d7de7756961299568f106990415bedcbb" },
  { file: "onnx/decoder_model_merged_q4f16.onnx_data", bytes: 2065635328, sha256: "83a2b12931978d2a3577f1f1a19e7ec42b87a760e87567dd26313fd933dcddd3" },
  { file: "onnx/decoder_model_merged_q4f16.onnx_data_1", bytes: 367513600, sha256: "fc1bb145d8839272a87c71e0cb4d34832a0d7bb4de06ab4fb74fea1aa6ddf7e5" },
  { file: "onnx/vision_encoder_q4f16.onnx", bytes: 394142, sha256: "68b093637448ec24a8f364546be8ce1d7ce6712b2c6df3de033e38382138ba32" },
  { file: "onnx/vision_encoder_q4f16.onnx_data", bytes: 198159360, sha256: "c52931db472718a0b045b03487497e01b29a63028944bcc57019c20ef4ea15ff" },
];

/** Phi-4-mini, text only, MIT (microsoft/Phi-4-mini-instruct's tag — the export carries none). */
export const PHI_4_MINI_ONNX_FILES: readonly TransformersFileRow[] = [
  { file: "config.json", bytes: 2735, sha256: "13f196a6d99bfe053c183adf47a8ff772b1d70802a1927206a705d3fd99b132f" },
  { file: "generation_config.json", bytes: 168, sha256: "4d8c499900ee9a4c4b1bca1887bc5a5c5ac9b01a57a364f30c583cdd1019cc72" },
  { file: "chat_template.jinja", bytes: 423, sha256: "febf589225c9728ab791f52e8897d7607a823d45368f0a4c92fa68997b40cce9" },
  { file: "tokenizer_config.json", bytes: 766, sha256: "e263ca0b737a5e1ffc6bcb8ca1b0c85ae7febc90ecbf1aac968170f0f79b4feb" },
  { file: "tokenizer.json", bytes: 13303196, sha256: "9ca5aa723a31a7a122497e059bd48dd67a5bd03ad16b3ffcf16093fd3021c1eb" },
  { file: "onnx/model_q4f16.onnx", bytes: 26270832, sha256: "ca26127777adf1df99b5fc1a3b4d1e0c426a6bf56626889873bfc4a6a095b4fc" },
  { file: "onnx/model_q4f16.onnx_data", bytes: 2087043072, sha256: "385526d648e4b3e361f3117564a6bd3cad7712a5c06fa23401763187674fd46c" },
  { file: "onnx/model_q4f16.onnx_data_1", bytes: 438239232, sha256: "b9a5d6f40fde30e9155d671dc630d2ea554f903f01c4ef8bbdc64c5b38035923" },
];

/**
 * Llama 3.2 3B Instruct, text only, and the one row in this package whose licence asks for something
 * beyond a link: `LLAMA_3_2` carries the Acceptable Use Policy and the "Built with Llama" line the
 * Community Licence §1.b.i requires, and the picker shows both before the download.
 */
export const LLAMA_3_2_3B_ONNX_FILES: readonly TransformersFileRow[] = [
  { file: "config.json", bytes: 1162, sha256: "93104420bd10292f1db7f2a0d940f431d760096b46bfa5de64cd6efa613a9e5c" },
  { file: "generation_config.json", bytes: 218, sha256: "8baea8f248b53e37390f42aa732068b887668357bc09fd1a3361ba91e7b67cda" },
  { file: "chat_template.jinja", bytes: 3827, sha256: "5816fce10444e03c2e9ee1ef8a4a1ea61ae7e69e438613f3b17b69d0426223a4" },
  { file: "special_tokens_map.json", bytes: 296, sha256: "6f38c73729248f6c127296386e3cdde96e254636cc58b4169d3fd32328d9a8ec" },
  { file: "tokenizer_config.json", bytes: 54557, sha256: "fb8e113b6240ab997fe87464b8b58697cc769a8df40699356e8524d0dfc60c0e" },
  { file: "tokenizer.json", bytes: 11574638, sha256: "3a223ade375cc1d13b04e897ce1d36a04f50140e1ba3d107021ea68d4b5e614c" },
  { file: "onnx/model_q4f16.onnx", bytes: 260899, sha256: "43648be8ff45ed7bc75c75ea0d495beffa8a8632910e53d3aa824d6bfffaae46" },
  { file: "onnx/model_q4f16.onnx_data", bytes: 2095929344, sha256: "0669c8c258ea5437b82cc17e5ca87bb91a9ede5b2f5ff80675c0b8e51f1b6043" },
  { file: "onnx/model_q4f16.onnx_data_1", bytes: 311427072, sha256: "63b1b82298ad66f940b4f918f81c386fbe4e15a4e178efb14bc558d127185113" },
];

/** The single file a readiness probe asks Cache Storage about: the biggest, and the last to land. */
export const GEMMA_4_E2B_ONNX_PROBE_FILE = "onnx/decoder_model_merged_q4f16.onnx_data";

/**
 * The curated Transformers.js rows. SIX, since 2026-09-11.
 *
 * `contextTokens` IS A BUDGET, NOT THE WEIGHTS' LIMIT, exactly as it is for the LiteRT rows. Every
 * one of these repos could claim six figures — `max_position_embeddings` is 131072 on the Phi and
 * Llama rows and 262144 on the three Qwen3.5 rows, read out of their own `config.json` on 2026-09-11
 * — and the ONNX decoder's KV cache grows as it generates rather than being asked for at load, so
 * nothing caps anything. 4096, since the afternoon of 2026-09-11: measured on this runtime, prefill
 * grows superlinearly with the prompt — 537 tokens in 1.7 s, 1317 in 4.6 s, 2617 in 15.8 s, and
 * ~3600 FAILS outright ("Failed to allocate memory for buffer mapping", after which only a reload
 * recovers the GPU device). The runtime's prompt budget is 45 % of this number (SYSTEM_PROMPT_SHARE),
 * so 4096 keeps the agent's system prompt under ~1850 tokens and a turn under ten seconds of
 * prefill; 8192 let a ~3.6k prompt through and that was the "25-minute picture turn". It is also the
 * number the prompt fallback reads to decide whether to dump raw JSON schemas at the model
 * (`FALLBACK_SCHEMAS_MIN_CONTEXT` is 16384, so it does not). Claiming the weights' number here would
 * be true about the weights and a lie about all of that.
 *
 * `vramMb` IS AN ESTIMATE, like every number in `LITERT_CATALOG`: the q4f16 weights plus the KV cache
 * and ORT's working set, which the measured rows put between 1.2× and 1.5× the download. Measure it
 * before anyone treats it as fact. It no longer decides who is offered what — `hosts` does.
 *
 * `family` IS ONLY FOR THE CUT. This provider does not render a prompt: `apply_chat_template` on the
 * repo's own tokenizer does, from the repo's own `chat_template.jinja`, which is the model's real
 * template rather than our reading of a model card. What `family` is read for is `stopAtTurnEnd` and
 * the stream's hold-back — which strings mean "the turn is over" if the model types one as text. So
 * the Qwen rows say `chatml` (`<|im_start|>` / `<|im_end|>`), Phi says `phi` (`<|user|>` … `<|end|>`)
 * and Llama says `llama3` (`<|start_header_id|>` … `<|eot_id|>`), each read out of that repo's
 * template on 2026-09-11 (templates.ts).
 *
 * WHAT A VISION ROW COSTS IN CONTEXT DIFFERS BY FAMILY, and since 2026-09-11 every one of them says
 * so in a `visionBudget` rather than taking its export's default: Gemma 4's processor spends a FIXED
 * number per image whatever it is shown, while the Qwen3.5 rows' `Qwen2VLImageProcessorFast` scales
 * with the picture's own resolution up to a ceiling. The section above that defines the budgets has
 * the arithmetic, the two defaults, and the measurement. `TRANSFORMERS_MAX_IMAGES` caps the count
 * either way.
 */
export const TRANSFORMERS_CATALOG: TransformersModelInfo[] = [
  {
    id: "gemma-4-E2B-it-onnx-q4f16",
    label: "Gemma 4 E2B · vision (ONNX)",
    // Desktop only, and measured rather than assumed: the biggest single buffer this load allocates
    // is 1.52 GB (fact 3), and a phone's tab is killed long before that.
    hosts: ["browser-desktop"],
    class: "small",
    local: true,
    supportsTools: true,
    vision: true,
    visionBudget: GEMMA_4_VISION_BUDGET,
    audio: true,
    contextTokens: 4096,
    vramMb: 4600,
    // The mirror's directory, and the picker's join key. Not a file: see `TransformersModelInfo`.
    assetFile: "gemma-4-E2B-it-ONNX",
    repo: "onnx-community/gemma-4-E2B-it-ONNX",
    revision: "9f4bef82ea6e296bc69f8a2f5939f73af81b07a6",
    dtype: "q4f16",
    files: GEMMA_4_E2B_ONNX_FILES,
    probeFile: GEMMA_4_E2B_ONNX_PROBE_FILE,
    sizeBytes: GEMMA_4_E2B_ONNX_FILES.reduce((n, f) => n + f.bytes, 0),
    family: "gemma",
    runtime: "transformers",
    // The Hub declares Apache-2.0 on this repo (read 2026-09-11), so no Gemma-terms consent line.
    license: APACHE_2,
    /**
     * Both halves of this are surprising, and the second one was measured rather than guessed: on
     * 2026-09-11 a browser profile granted a 3.0 GB Cache Storage quota, and the library's own
     * `cache.put` for the two 1.5 GB data files failed with "Unexpected internal error" — it warns
     * and carries on with the buffers in hand, so the model still LOADS, and then downloads again on
     * the next open. Nothing here can fix that; saying it is the honest thing to do.
     */
    note: "Sees pictures · ONNX runtime, slower than LiteRT · needs 3.4 GB of browser storage, and the download does not resume",
  },
  /**
   * THE FIRST PHONE ROW THAT SEES — and the reason `hosts` exists rather than a size comparison.
   *
   * 0.67 GB of q4f16 weights, three graphs, no audio encoder, and the same ChatML template the other
   * two Qwen rows use. It is offered beside Gemma 3 270m on a phone: 270m answers faster and is a
   * quarter of the download, this one can be shown a photograph, and neither is the right answer for
   * everyone — which is why the phone gets a short list rather than one row chosen for it.
   */
  {
    id: "qwen3.5-0.8B-onnx-q4f16",
    label: "Qwen3.5 0.8B · vision (ONNX)",
    hosts: ["browser-desktop", "browser-phone"],
    class: "small",
    local: true,
    supportsTools: true,
    vision: true,
    visionBudget: QWEN3_5_VISION_BUDGET,
    contextTokens: 4096,
    vramMb: 1500,
    assetFile: "Qwen3.5-0.8B-ONNX",
    repo: "onnx-community/Qwen3.5-0.8B-ONNX",
    revision: "c0d619322dad7c4441a8841a53fc59772ddddcc0",
    dtype: "q4f16",
    files: QWEN3_5_0_8B_ONNX_FILES,
    probeFile: "onnx/decoder_model_merged_q4f16.onnx_data",
    sizeBytes: QWEN3_5_0_8B_ONNX_FILES.reduce((n, f) => n + f.bytes, 0),
    family: "chatml",
    runtime: "transformers",
    // Declared on the export itself: `license: apache-2.0` with a link to the base model's LICENSE
    // (read from the Hub's model API on 2026-09-11). No use restrictions, so no consent line.
    license: APACHE_2,
    note: "Sees pictures · small enough for a phone · ONNX runtime, and the download does not resume",
  },
  {
    id: "qwen3.5-2B-onnx-q4f16",
    label: "Qwen3.5 2B · vision (ONNX)",
    hosts: ["browser-desktop"],
    class: "small",
    local: true,
    supportsTools: true,
    vision: true,
    visionBudget: QWEN3_5_VISION_BUDGET,
    contextTokens: 4096,
    vramMb: 2600,
    assetFile: "Qwen3.5-2B-ONNX-OPT",
    repo: "onnx-community/Qwen3.5-2B-ONNX-OPT",
    revision: "2ea7886f48b926aca97de8b0e041ffca7e3ebaa9",
    dtype: "q4f16",
    files: QWEN3_5_2B_ONNX_FILES,
    probeFile: "onnx/decoder_model_merged_q4f16.onnx_data",
    sizeBytes: QWEN3_5_2B_ONNX_FILES.reduce((n, f) => n + f.bytes, 0),
    family: "chatml",
    runtime: "transformers",
    /**
     * VERIFIED AT THE BASE MODEL, because the export declares nothing. The `-OPT` repo's README is
     * three lines of front matter naming `base_model: Qwen/Qwen3.5-2B` and no `license:` at all; the
     * Hub's model API for `Qwen/Qwen3.5-2B` answers `apache-2.0` with a LICENSE beside the weights
     * (both read 2026-09-11). So the licence shown is the weights' licence, reached through the
     * pointer the export itself gives, and it is written down here rather than assumed from the name.
     */
    license: APACHE_2,
    note: "Sees pictures · 1.6 GB, desktop only · ONNX runtime, and the download does not resume",
  },
  {
    id: "qwen3.5-4B-onnx-q4f16",
    label: "Qwen3.5 4B · vision (ONNX)",
    hosts: ["browser-desktop"],
    class: "strong",
    local: true,
    supportsTools: true,
    vision: true,
    visionBudget: QWEN3_5_VISION_BUDGET,
    contextTokens: 4096,
    vramMb: 4200,
    assetFile: "Qwen3.5-4B-ONNX-OPT",
    repo: "onnx-community/Qwen3.5-4B-ONNX-OPT",
    revision: "57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7",
    dtype: "q4f16",
    files: QWEN3_5_4B_ONNX_FILES,
    probeFile: "onnx/decoder_model_merged_q4f16.onnx_data",
    sizeBytes: QWEN3_5_4B_ONNX_FILES.reduce((n, f) => n + f.bytes, 0),
    family: "chatml",
    runtime: "transformers",
    // Same verification as the 2B: no tag on the export, `apache-2.0` on `Qwen/Qwen3.5-4B`.
    license: APACHE_2,
    note: "Sees pictures · 3.0 GB, the largest local row that fits a laptop GPU · the download does not resume",
  },
  /**
   * TEXT ONLY, AND A DIFFERENT DOOR. Phi-4-mini is `Phi3ForCausalLM` — the library's `DecoderOnly`
   * session config, one `model` graph — so this row loads through `AutoTokenizer` and
   * `AutoModelForCausalLM`. It sees nothing, and `withoutImages` says so in words rather than losing
   * a picture silently (image-parts.ts rule 3).
   */
  {
    id: "phi-4-mini-instruct-onnx-q4f16",
    label: "Phi-4 mini (ONNX)",
    hosts: ["browser-desktop"],
    class: "small",
    local: true,
    supportsTools: true,
    vision: false,
    contextTokens: 4096,
    vramMb: 3600,
    assetFile: "Phi-4-mini-instruct-ONNX",
    repo: "onnx-community/Phi-4-mini-instruct-ONNX",
    revision: "e61f45fc5fabba2aee31ff85ba4cf99219b4bf28",
    dtype: "q4f16",
    files: PHI_4_MINI_ONNX_FILES,
    probeFile: "onnx/model_q4f16.onnx_data",
    sizeBytes: PHI_4_MINI_ONNX_FILES.reduce((n, f) => n + f.bytes, 0),
    family: "phi",
    runtime: "transformers",
    // The export carries no licence tag (its README is `base_model: microsoft/Phi-4-mini-instruct`
    // and nothing else); the base model's Hub entry answers `mit`, read 2026-09-11. MIT asks for the
    // notice to travel with the bytes and nothing of the person using it, so there is no consent line.
    license: MIT,
    note: "Text only · 2.6 GB · ONNX runtime, and the download does not resume",
  },
  /**
   * THE ROW WITH AN OBLIGATION. Llama 3.2's Community Licence is not Apache: §1.b.i asks that
   * "Built with Llama" be displayed, and §5 incorporates an Acceptable Use Policy. `LLAMA_3_2`
   * carries all three (licence, policy, attribution line) and the picker shows all three before the
   * download, the same way the Gemma-terms rows do. The mirror carries the verbatim copies too —
   * `LLAMA_3_2_LICENSE.txt` and `LLAMA_3_2_USE_POLICY.md`, published from scripts/litert-notices/.
   */
  {
    id: "llama-3.2-3B-instruct-onnx-q4f16",
    label: "Llama 3.2 3B (ONNX)",
    hosts: ["browser-desktop"],
    class: "small",
    local: true,
    supportsTools: true,
    vision: false,
    contextTokens: 4096,
    vramMb: 3400,
    assetFile: "Llama-3.2-3B-Instruct-ONNX",
    repo: "onnx-community/Llama-3.2-3B-Instruct-ONNX",
    revision: "cab364e7d0e1de7aa09e3abc932be92361c5b55f",
    dtype: "q4f16",
    files: LLAMA_3_2_3B_ONNX_FILES,
    probeFile: "onnx/model_q4f16.onnx_data",
    sizeBytes: LLAMA_3_2_3B_ONNX_FILES.reduce((n, f) => n + f.bytes, 0),
    family: "llama3",
    runtime: "transformers",
    license: LLAMA_3_2,
    note: "Text only · 2.4 GB · built with Llama, under Meta's community licence · the download does not resume",
  },
];

export const TRANSFORMERS_DEFAULT_MODEL_ID = "gemma-4-E2B-it-onnx-q4f16";

/**
 * EVERY LOCAL ROW, ACROSS RUNTIMES — what a picker joins the mirror's catalogue to.
 *
 * It lives here rather than in `litert.ts` because this module already imports that one and the
 * reverse would be a cycle. `mergeMirrorCatalog` still defaults to `LITERT_CATALOG`, so nothing that
 * existed before this line changed behaviour; a caller that wants all three runtimes' rows — which
 * is the app's picker, and only the app's picker — passes this.
 *
 * LiteRT rows first, deliberately: offline (where this order is the only order, since a mirror that
 * answered decides the order itself) the preferred runtime's rows should be the ones a person sees at
 * the top, and the 3.4 GB ONNX row should be the one they scroll to.
 */
export const LOCAL_MODEL_CATALOG: LiteRtModelInfo[] = [...LITERT_CATALOG, ...TRANSFORMERS_CATALOG];

/**
 * The rows this harness may be offered, and — still — the ones under a memory cap.
 *
 * `host` is the gate (§12.6 is `browser-phone`); `maxVramMb` is kept because it answers a different
 * question, one about a machine rather than about a class of device, and a caller that asks it is
 * asking about memory on purpose. Both, when both are given.
 */
export function transformersCatalogFor(options: { maxVramMb?: number; host?: Host } = {}): TransformersModelInfo[] {
  const cap = options.maxVramMb ?? Number.POSITIVE_INFINITY;
  return TRANSFORMERS_CATALOG.filter((m) => m.vramMb <= cap && (!options.host || offeredOn(m, options.host)));
}

/** The URL one of a row's files lands on, given a host and its layout. Exported because the readiness
 *  probe and the test both need to agree with the library's own `buildResourcePaths`. */
export function transformersFileUrl(baseUrl: string, repo: string, revision: string, file: string, pathTemplate?: string): string {
  const template = pathTemplate ?? pathTemplateFor(baseUrl);
  const middle = template.replaceAll("{model}", repo).replaceAll("{revision}", encodeURIComponent(revision));
  return [baseUrl, middle, file]
    .map((part, i) => (i === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+/, "").replace(/\/+$/, "")))
    .filter((part) => part.length)
    .join("/");
}

// ── The library, behind interfaces so Node can hold it ───────────────────────────────────────────
//
// Nothing in this package imports `@huggingface/transformers` for a TYPE, for the same reason
// litert.ts declares its own `LiteRtTaskLike`: a type import resolves the package's `exports` map,
// which on Node points at `transformers.node.mjs` and pulls in `onnxruntime-node` and `sharp`. These
// structural interfaces are the SLIVER this provider uses, and a test hands over a fake that fits.

/** `progress_callback`'s payload, as `src/utils/core.js` documents it. Only two statuses are read. */
export type TransformersProgress =
  | { status: "initiate" | "download" | "done"; name: string; file: string }
  | { status: "progress"; name: string; file: string; progress: number; loaded: number; total: number }
  | { status: "progress_total"; name: string; progress: number; loaded: number; total: number }
  | { status: "ready"; task: string; model: string };

/** The library's global settings object (fact 1). Every field is optional: it is somebody else's. */
export interface TransformersEnvLike {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  remoteHost?: string;
  remotePathTemplate?: string;
  useBrowserCache?: boolean;
  useWasmCache?: boolean;
  cacheKey?: string;
  fetch?: FetchLike;
  backends?: { onnx?: { wasm?: { wasmPaths?: string; proxy?: boolean } } };
}

/** A chat message in the library's own shape: content is either a string or a list of parts. */
export type TransformersContentPart = { type: "text"; text: string } | { type: "image" } | { type: "audio" };
export interface TransformersChatMessage {
  role: "system" | "user" | "assistant";
  content: string | TransformersContentPart[];
}

/** `Processor` is `Callable`, so the instance itself is the call. The door a VISION row loads through. */
export interface TransformersProcessorLike {
  (text: string, images?: unknown, audio?: unknown, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  apply_chat_template(messages: TransformersChatMessage[], options?: Record<string, unknown>): string;
  /** Handed straight to `TextStreamer`; this package never calls it. */
  tokenizer: unknown;
  /**
   * THE IMAGE HALF, AND THE ONLY PLACE A VISION BUDGET CAN BE WRITTEN.
   *
   * This is the surprising half of the whole change, and it was read out of the installed library
   * rather than remembered. There is NO call-time kwarg for image sizing in `@huggingface/transformers`
   * 4.2.0, on either family:
   *
   *   · `Gemma4Processor._call(text, images, audio, options)` DOES pass the options down —
   *     `this.image_processor(images, options)` — but `Gemma4ImageProcessor._call(images)` declares one
   *     parameter and drops the second on the floor.
   *   · `Qwen2VLProcessor._call` does not even pass them: `this.image_processor(images)`.
   *
   * Both read their budget off `this` — `max_soft_tokens` set in `Gemma4ImageProcessor`'s constructor,
   * `max_pixels` (falling back to `size.longest_edge`) in `Qwen2VLImageProcessor`'s — and
   * `AutoProcessor.from_pretrained` takes no config override, only a revision and a progress callback.
   * So the budget is assigned onto the loaded instance or it is not applied at all, and this field is
   * that instance. Optional because a fake in a test need not have one, and `applyVisionBudget` says
   * so rather than throwing.
   */
  image_processor?: Record<string, unknown>;
}

/**
 * `PreTrainedTokenizer`, which is also `Callable` — the door a TEXT row loads through.
 *
 * TWO DOORS, NOT ONE WITH A FLAG, because the library draws the line itself: a `…ForCausalLM` class
 * builds one `model` session and has no processor, and `AutoProcessor.from_pretrained` on a repo with
 * no `processor_config.json` (Phi-4-mini and Llama 3.2 have none) has nothing to build. The call
 * signature differs too — a processor takes `(text, images, audio, options)` and answers a promise, a
 * tokenizer takes `(text, options)` and answers synchronously — which is why `PromptSide` below
 * exists rather than a cast.
 */
export interface TransformersTokenizerLike {
  (text: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  apply_chat_template(messages: TransformersChatMessage[], options?: Record<string, unknown>): string;
}

/**
 * The half of a load that turns a transcript into tensors, whichever door it came through.
 *
 * One shape so `chat()` and `stream()` are written once: `tokenizer` is what `TextStreamer` takes
 * (the processor's own, or the tokenizer itself), `template` renders the transcript, and `encode`
 * makes the model's inputs — taking pictures where the row can see and ignoring them where it cannot.
 */
export interface PromptSide {
  tokenizer: unknown;
  template(messages: TransformersChatMessage[], options: Record<string, unknown>): string;
  encode(prompt: string, images: unknown[] | null): Promise<Record<string, unknown>>;
}

export interface TransformersModelLike {
  generate(options: Record<string, unknown>): Promise<unknown>;
  /** Releases every ONNX session. Optional, because a fake need not have one. */
  dispose?(): Promise<unknown>;
  /**
   * The built sessions, by name — `embed_tokens`, `decoder_model_merged`, `vision_encoder` and (on
   * Gemma 4) `audio_encoder`, or the single `model` of a text row.
   *
   * READ FOR ONE REASON: to be able to SAY which device each graph got. `createInferenceSession` in
   * `src/backends/onnx.js` stamps `session.config = { dtype, device }` on every session it builds, and
   * that stamp is the only record anywhere that a load asked for WebGPU and got it. `sessionDevices()`
   * below reads it; nothing in this file decides anything from it.
   */
  sessions?: Record<string, { config?: { device?: string; dtype?: string } }>;
}

/** `InterruptableStoppingCriteria` — the only way to stop a generation in flight. */
export interface TransformersStopperLike {
  interrupt(): void;
}

/** The whole of the library this provider touches. One object, so one fake replaces all of it. */
export interface TransformersLibrary {
  env: TransformersEnvLike;
  AutoProcessor: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<TransformersProcessorLike> };
  /**
   * `AutoModelForImageTextToText` rather than `Gemma4ForConditionalGeneration` by name: the installed
   * registry maps `gemma4` → `Gemma4ForConditionalGeneration` in
   * `MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING_NAMES`, so the auto class reaches the same constructor
   * without this file naming a model-specific export that a future row would have to change.
   */
  AutoModelForImageTextToText: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<TransformersModelLike> };
  /**
   * The text rows' pair (2026-09-11). `AutoModelForCausalLM` reaches `Phi3ForCausalLM` and
   * `LlamaForCausalLM` through `MODEL_FOR_CAUSAL_LM_MAPPING_NAMES`, and `AutoTokenizer` is where
   * `apply_chat_template` lives when there is no processor. Both are `?`-free here but a fake that
   * only ever loads a vision row need not implement them — which is exactly what the older tests do.
   */
  AutoTokenizer: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<TransformersTokenizerLike> };
  AutoModelForCausalLM: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<TransformersModelLike> };
  TextStreamer: new (tokenizer: unknown, options: Record<string, unknown>) => unknown;
  InterruptableStoppingCriteria: new () => TransformersStopperLike;
  load_image(input: Blob | string): Promise<unknown>;
}

export type TransformersLibraryFactory = () => Promise<TransformersLibrary>;

/**
 * The real one, imported HERE and nowhere else in this package.
 *
 * Dynamic and inside a function, for the same reason web-llm and MediaPipe are: the web bundle is
 * megabytes, it probes for WebGPU on load, and a Node test must never reach it — resolving it in Node
 * would pull `onnxruntime-node` and `sharp` in with it.
 */
const importLibrary: TransformersLibraryFactory = async () =>
  (await import("@huggingface/transformers")) as unknown as TransformersLibrary;

/**
 * WRITE THE ROW'S BUDGET ONTO A LOADED PROCESSOR. The one road there is; see
 * `TransformersProcessorLike.image_processor` for why there is no other.
 *
 * Answers WHAT IT DID rather than nothing, because two of the three ways this can fail are silent:
 * a processor with no image half (a repo whose `processor_config.json` declares none), and a field
 * name that a future version of the library renamed. A budget that did not apply is the export's own
 * 280 back — twice the prefill, measured — so the provider records the answer and the tests read it.
 *
 * `min_pixels` is CLAMPED rather than left alone: `smart_resize` treats it as a floor and would
 * enlarge a picture back past a `max_pixels` smaller than it. Today's rows are nowhere near that
 * (Qwen's floor is 65 536 pixels against a 262 144 budget), which is exactly why it would be found
 * the day somebody tried a 32-token budget and not before.
 */
export function applyVisionBudget(processor: TransformersProcessorLike, budget: TransformersVisionBudget): boolean {
  const image = processor.image_processor;
  if (!image || !(budget.knob in image)) return false;
  const value = visionBudgetValue(budget);
  image[budget.knob] = value;
  if (budget.knob === "max_pixels" && typeof image.min_pixels === "number" && image.min_pixels > value) {
    image.min_pixels = value;
  }
  return true;
}

/** The two Cache Storage calls the readiness probe makes. A test hands over a Map. */
export interface TransformersCacheLike {
  match(request: string): Promise<Response | undefined>;
}

export interface TransformersCacheStorageLike {
  open(cacheName: string): Promise<TransformersCacheLike>;
  delete(cacheName: string): Promise<boolean>;
}

export interface TransformersProviderOptions {
  /** A row of `TRANSFORMERS_CATALOG`, or any id when `repo`, `dtype` and `revision` are given. */
  modelId?: string;
  /**
   * REQUIRED: where the owner serves the model files from. No default exists and none should — the
   * same rule as `LiteRtProvider`'s, for the same reason (litert.ts rule 3), even though these
   * weights are Apache-2.0: whoever redistributes three gigabytes decides where they live.
   */
  modelBaseUrl: string;
  /** `{model}/` for the mirror, `{model}/resolve/{revision}/` for the Hub. Guessed by `pathTemplateFor`. */
  pathTemplate?: string;
  /** Where the app serves ONNX Runtime Web's wasm from. Defaults to `ONNX_DEFAULT_WASM_PATH`. */
  wasmBaseUrl?: string;
  onProgress?: (report: TransformersLoadProgress) => void;
  /** Injected by tests; in a browser the dynamic import above is what runs. */
  createLibrary?: TransformersLibraryFactory;
  /** Injected by tests; in a browser the global `caches` is what runs. */
  caches?: TransformersCacheStorageLike;
  /** Overrides the row's. `null` turns the budget OFF and takes the repo's own default back. */
  visionBudget?: TransformersVisionBudget | null;
  cacheName?: string;
  catalog?: TransformersModelInfo[];
  id?: string;
  /** For a model that is not in the catalogue. */
  repo?: string;
  dtype?: string;
  revision?: string;
  family?: PromptFamily;
  vision?: boolean;
  /** The file `readiness()` asks Cache Storage about, for a row that is in no catalogue. */
  probeFile?: string;
  maxTokens?: number;
  temperature?: number;
}

/** The same report shape `LiteRtProgress` has, so a host can draw one bar for either runtime. */
export interface TransformersLoadProgress {
  /** 0…1 against the row's own `sizeBytes`, which is known before the first byte arrives. */
  progress: number;
  loadedBytes: number;
  totalBytes?: number;
  text: string;
}

/** How many pictures one turn may carry to this model. A cap, because the context is 8192 tokens and
 *  each image is the row's whole `visionBudget` of them before the words start — 140 on Gemma 4 and
 *  256 on the Qwen rows, so four pictures is a tenth to an eighth of the context. */
export const TRANSFORMERS_MAX_IMAGES = 4;

export class TransformersProvider implements ModelProvider {
  readonly id: string;
  readonly modelId: string;
  readonly model: TransformersModelInfo | undefined;
  readonly repo: string;
  readonly dtype: string;
  readonly revision: string;
  readonly modelBaseUrl: string;
  readonly pathTemplate: string;
  readonly wasmBaseUrl: string;
  readonly family: PromptFamily;
  /** Whether this row takes pictures at all — the catalogue's `vision`, or the caller's override. */
  readonly seesImages: boolean;
  /**
   * What one picture may cost this row — the catalogue's, the caller's, or `undefined` for the repo's
   * own default. A CONSTANT PER ROW and deliberately not a per-request knob: the processor's budget is
   * an instance field (see `applyVisionBudget`), so raising it mid-conversation would change what an
   * already-templated transcript meant, and no caller has asked.
   */
  readonly visionBudget: TransformersVisionBudget | undefined;
  /**
   * Whether `applyVisionBudget` actually found the field, recorded at load. `null` before a load and
   * for a row with no budget. A budget that silently did not apply is the export's default back and
   * twice the prefill with it, so it is remembered rather than assumed.
   */
  private visionBudgetApplied: boolean | null = null;
  private readonly opts: TransformersProviderOptions;
  private readonly createLibrary: TransformersLibraryFactory;
  private readonly cacheName: string;
  private loaded: { library: TransformersLibrary; prompt: PromptSide; model: TransformersModelLike } | null = null;
  private loading: Promise<NonNullable<TransformersProvider["loaded"]>> | null = null;
  /** Set by `abortLoad()` while a load is in flight; read when the engine arrives (fact 3's cousin). */
  private loadAbandoned = false;
  /** Aborts the library's own fetches, through the `env.fetch` we install. */
  private loadController: AbortController | null = null;
  /** Remembered so `readiness()` need not re-open the cache on every poll of a settings screen. */
  private cached: boolean | null = null;
  private progress: ReadinessProgress | null = null;
  /** Per-file bytes across BOTH `from_pretrained` calls, which the library never sums together. */
  private files = new Map<string, { loaded: number; total: number }>();

  constructor(opts: TransformersProviderOptions) {
    if (!opts.modelBaseUrl) {
      throw new Error("TransformersProvider needs a modelBaseUrl: this package hardcodes no host for the model files.");
    }
    this.opts = opts;
    this.id = opts.id ?? TRANSFORMERS_PROVIDER_ID;
    this.modelId = opts.modelId ?? TRANSFORMERS_DEFAULT_MODEL_ID;
    this.model = (opts.catalog ?? TRANSFORMERS_CATALOG).find((m) => m.id === this.modelId);
    const repo = opts.repo ?? this.model?.repo;
    if (!repo) {
      throw new Error(`TransformersProvider does not know the repo for ${this.modelId}: name it in the catalog or pass repo.`);
    }
    this.repo = repo;
    this.dtype = opts.dtype ?? this.model?.dtype ?? "q4f16";
    this.revision = opts.revision ?? this.model?.revision ?? "main";
    this.modelBaseUrl = opts.modelBaseUrl.replace(/\/+$/, "");
    this.pathTemplate = opts.pathTemplate ?? pathTemplateFor(this.modelBaseUrl);
    this.wasmBaseUrl = opts.wasmBaseUrl ?? ONNX_DEFAULT_WASM_PATH;
    this.family = opts.family ?? this.model?.family ?? "gemma";
    this.seesImages = opts.vision ?? this.model?.vision === true;
    // `?? undefined` rather than `||`: an explicit `null` means "the repo's own default", which is a
    // different instruction from "not given" and is how a caller measures the before-state.
    this.visionBudget = (opts.visionBudget === undefined ? this.model?.visionBudget : (opts.visionBudget ?? undefined)) ?? undefined;
    this.createLibrary = opts.createLibrary ?? importLibrary;
    this.cacheName = opts.cacheName ?? TRANSFORMERS_MODEL_CACHE;
  }

  async models(): Promise<ModelInfo[]> {
    return (this.opts.catalog ?? TRANSFORMERS_CATALOG).slice();
  }

  /** Always true: the native road exists and is not taken (fact 6). */
  get usesFallbackTools(): boolean {
    return !TRANSFORMERS_NATIVE_TOOLS;
  }

  /** The URL a given file of this row lands on. The probe and the tests both read it from here. */
  fileUrl(file: string): string {
    return transformersFileUrl(this.modelBaseUrl, this.repo, this.revision, file, this.pathTemplate);
  }

  private hasWebGpu(): boolean {
    return Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);
  }

  private cacheStorage(): TransformersCacheStorageLike | undefined {
    return this.opts.caches ?? (globalThis as { caches?: TransformersCacheStorageLike }).caches;
  }

  /**
   * Is this row already on the device? Asked of ONE file — the decoder's 1.52 GB data blob, the
   * biggest and the last to be written — under the key the library itself would use, which
   * `buildResourcePaths` says is the remote URL. Fifteen `match` calls would be fifteen times the
   * work for the same answer, and a partial set is not a usable model anyway.
   */
  private async isCached(): Promise<boolean> {
    if (this.cached !== null) return this.cached;
    const storage = this.cacheStorage();
    if (!storage) return (this.cached = false);
    // The ROW's own probe since 2026-09-11: the rows no longer share a file name (a text row has one
    // `model_q4f16.onnx_data`, a vision row has a decoder's). A row that names none — one built by
    // hand for a repo in no catalogue — answers "not downloaded" rather than probing a wrong key.
    const probe = this.opts.probeFile ?? this.model?.probeFile ?? null;
    if (!probe) return (this.cached = false);
    try {
      const cache = await storage.open(this.cacheName);
      this.cached = Boolean(await cache.match(this.fileUrl(probe)));
    } catch {
      // Cache Storage refused (private mode, some embedded webviews): nothing is cached, and the
      // download path will say so rather than this looking broken.
      this.cached = false;
    }
    return this.cached;
  }

  async readiness(): Promise<Readiness> {
    if (!this.hasWebGpu()) {
      return { ready: false, reason: "unsupported", detail: "This browser has no WebGPU, so it cannot run a local model." };
    }
    if (this.loaded) return { ready: true };
    // Bytes in hand, sessions not built: ORT is compiling 3.4 GB for the GPU, which is a wait a
    // person watches. `phase: "load"` is what stops that reading as a download stuck at 100 %.
    if (this.loading && this.progress?.phase === "load") {
      return { ready: false, reason: "download", detail: `Loading ${this.modelId} into the GPU…`, progress: this.progress };
    }
    if (this.progress) return { ready: false, reason: "download", detail: `Downloading ${this.modelId}…`, progress: this.progress };
    if (await this.isCached()) return { ready: true };
    return {
      ready: false,
      reason: "download",
      detail: `${this.modelId} has not been downloaded to this browser yet — ${Math.round((this.model?.sizeBytes ?? 0) / 1e8) / 10} GB, and it does not resume if it is interrupted.`,
    };
  }

  /**
   * PER-FILE BYTES, SUMMED HERE — not the library's own `progress_total`.
   *
   * WHY NOT THE AGGREGATE IT ALREADY COMPUTES. `DefaultProgressCallback` wraps the callback PER
   * `from_pretrained` CALL, so the processor's seven files (19.5 MB of tokenizer and templates) and
   * the model's eight are counted in two separate maps that never see each other. Taking its
   * `progress_total` meant the bar was denominated against the row's full 3.40 GB while only the
   * model's 3.38 GB was ever counted — seen live on 2026-09-11: the chip sat at
   * "99 % · 3.4 of 3.4 GB" through the entire compile, because the last 0.6 % was fetched by a call
   * whose aggregate this provider was not reading. Two aggregates that must add up is one aggregate,
   * kept here, over the `progress` events both calls emit.
   *
   * `totalBytes` is still the LARGER of the row's own sum and what has been seen (fact 4): the count
   * of started files climbs, so a percentage derived from it alone walks backwards.
   */
  private report(file: string, loaded: number, total: number): void {
    this.files.set(file, { loaded, total });
    let loadedBytes = 0;
    let seenTotal = 0;
    for (const entry of this.files.values()) {
      loadedBytes += entry.loaded;
      seenTotal += entry.total;
    }
    const known = this.model?.sizeBytes ?? 0;
    const totalBytes = Math.max(known, seenTotal) || undefined;
    const percent = totalBytes ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : undefined;
    // The flip to `load` happens on the last byte, which is the only moment we can name:
    // `from_pretrained` does not say when it stops fetching and starts compiling.
    const phase: ReadinessProgress["phase"] = totalBytes && loadedBytes >= totalBytes ? "load" : "download";
    this.progress = { loadedBytes, totalBytes, percent, phase };
    this.opts.onProgress?.({
      progress: totalBytes ? Math.min(1, loadedBytes / totalBytes) : 0,
      loadedBytes,
      totalBytes,
      text: phase === "load" ? `Loading ${this.modelId} into the GPU…` : `Downloading ${this.modelId}…`,
    });
  }

  /**
   * Point the library's GLOBAL `env` at our host, our wasm and our cache (fact 1).
   *
   * Called at the top of every `load()` rather than once, because the object is module-level and
   * shared: a second provider, or any other script on the origin that imported the library, may have
   * written to it since. `env.fetch` is wrapped so that `abortLoad()` actually stops the bytes —
   * without it a stopped download keeps arriving, which is what "Stop" not working looks like.
   */
  private applyEnv(library: TransformersLibrary, signal: AbortSignal): void {
    const env = library.env;
    // No `/models/` lookup on our own origin: every file comes from the host, and a 404 on a path we
    // never published is a confusing first error.
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = `${this.modelBaseUrl}/`;
    env.remotePathTemplate = this.pathTemplate;
    env.useBrowserCache = true;
    env.useWasmCache = true;
    env.cacheKey = this.cacheName;
    env.fetch = (input, init) => fetch(input as string, { ...init, signal });
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
      wasm.wasmPaths = this.wasmBaseUrl;
      // No proxy worker: it would fetch the wasm again from its own scope, and the app already runs
      // this off the page's critical path.
      wasm.proxy = false;
    }
  }

  /** Download and compile. Safe to call twice: the second caller waits on the first's promise. */
  async load(): Promise<NonNullable<TransformersProvider["loaded"]>> {
    if (this.loaded) return this.loaded;
    if (!this.hasWebGpu()) {
      throw new ProviderError({
        status: 0,
        code: "unsupported",
        message: "This browser has no WebGPU, so it cannot run a local model.",
        providerId: this.id,
      });
    }
    if (!this.loading) {
      this.loadAbandoned = false;
      this.loadController = new AbortController();
    }
    const controller = this.loadController as AbortController;
    this.loading ??= (async () => {
      const library = await this.createLibrary();
      this.applyEnv(library, controller.signal);
      this.files.clear();
      const progress_callback = (info: TransformersProgress): void => {
        if (info.status === "progress") this.report(info.file, info.loaded, info.total);
      };
      // The tokenising half first and on its own: it is the tokenizer, the chat template and two or
      // three small JSON files, so a host that is wrong 404s in a second rather than three gigabytes
      // later. It takes the SAME callback as the model — its files are ~19 MB of the row's total, and
      // a bar denominated against a total it never counts cannot reach the end (see `report`).
      const prompt = await this.loadPromptSide(library, progress_callback);
      // The model through the door this row's `vision` names. Both auto classes rather than a
      // model-specific export: the registry maps `gemma4`/`qwen3_5` into the image-text-to-text table
      // and `phi3`/`llama` into the causal one, and a test pins all four mappings.
      const load = this.seesImages ? library.AutoModelForImageTextToText : library.AutoModelForCausalLM;
      const model = await load.from_pretrained(this.repo, {
        revision: this.revision,
        dtype: this.dtype,
        device: "webgpu",
        progress_callback,
      });
      return { library, prompt, model };
    })().then(
      (ready) => {
        this.loading = null;
        this.loadController = null;
        if (this.loadAbandoned) {
          // The library has no cancel for a load in progress, so a stop lands here: the sessions are
          // released the moment they exist, never kept, and the caller hears "stopped".
          void ready.model.dispose?.();
          this.progress = null;
          throw providerErrorFromThrow(this.id, new DOMException("The model load was stopped.", "AbortError"));
        }
        this.loaded = ready;
        this.cached = true;
        return ready;
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
   * Best effort, and honestly so (the contract addition of 2026-09-11 asks for exactly that).
   *
   * Two halves. The fetches DO stop, because `applyEnv` handed the library an `env.fetch` bound to
   * this controller. The compile does not: ORT gives no way to interrupt a session build, so a model
   * that arrives after the stop is disposed rather than kept, and the bytes already written stay in
   * Cache Storage — the next load re-reads them from there, which is the only resume this runtime
   * has (fact 3).
   */
  abortLoad(): void {
    if (!this.loading) return;
    this.loadAbandoned = true;
    this.loadController?.abort(new DOMException("The model load was stopped.", "AbortError"));
  }

  async unload(): Promise<void> {
    this.abortLoad();
    const held = this.loaded;
    this.loaded = null;
    await held?.model.dispose?.();
  }

  /** Forget the downloaded files. The disk back, and the next `load()` downloads again. */
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

  // ── The turn ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The transcript in the library's own message shape, with the pictures kept out of it.
   *
   * THE PICTURES TRAVEL SEPARATELY, which is the one thing about this wire that is not obvious:
   * `apply_chat_template` is handed `{ type: "image" }` PLACEHOLDERS and emits the model's image
   * token for each, and the pixels go to the processor as a second argument, in the order the
   * placeholders appeared. So this function returns both halves and they must stay in step.
   *
   * Images go BEFORE the text of their turn — the model card's "Modality order" note says so, and it
   * is also the only order in which the words can refer to the picture.
   *
   * A `tool` turn becomes a USER turn reading `Result of <name>: …`, and an assistant turn that asked
   * for a tool is replayed as the JSON it wrote. Both use `templates.ts`'s wording rather than a
   * second copy of it: the chat template has no `tool` role, and inventing one would put a message in
   * the transcript the model was never trained to see.
   */
  private buildMessages(req: ChatRequest): { messages: TransformersChatMessage[]; images: ImagePart[] } {
    const instruction = req.tools?.length
      ? fallbackToolPrompt(req.tools, { schemas: (this.model?.contextTokens ?? 0) >= FALLBACK_SCHEMAS_MIN_CONTEXT })
      : "";
    let source = instruction ? withToolInstruction(req.messages, instruction) : req.messages;
    // Rule 3 of image-parts.ts: a row that cannot see does not silently lose the picture, it is told
    // in words that one was attached. `withoutImages` returns the array unchanged when there is
    // nothing to drop, so a text-only turn costs no copy.
    if (!this.seesImages) source = withoutImages(source);

    const images: ImagePart[] = [];
    const messages: TransformersChatMessage[] = [];
    for (const message of source) {
      const role: TransformersChatMessage["role"] = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
      const text =
        message.role === "assistant" ? assistantTurnText(message) : message.role === "tool" ? toolTurnText(message) : message.content;
      const mine = (message.images ?? []).slice(0, Math.max(0, TRANSFORMERS_MAX_IMAGES - images.length));
      if (!mine.length) {
        messages.push({ role, content: text });
        continue;
      }
      const parts: TransformersContentPart[] = mine.map(() => ({ type: "image" }) as TransformersContentPart);
      images.push(...mine);
      parts.push({ type: "text", text });
      messages.push({ role, content: parts });
    }
    return { messages, images };
  }

  /**
   * `ImagePart` bytes → what `load_image` takes. The cap and the magic-byte sniff happen in
   * `decodeImage`, so a picture that is too big fails BEFORE the generation starts.
   *
   * THERE IS NO SECOND DOWNSCALE HERE, AND THAT IS A MEASUREMENT RATHER THAN AN OVERSIGHT
   * (2026-09-11, on the Gemma 4 E2B row, WebGPU, this Mac). The obvious idea is to shrink a picture
   * to `visionBudgetPixels(row)` before handing it over, since the processor is going to resize it
   * anyway. It buys nothing:
   *
   *   · It cannot change the TOKEN count. `Gemma4ImageProcessor` resizes to its budget in either
   *     direction and zero-pads the patch tensor to `max_soft_tokens * pooling_kernel_size²` rows
   *     whatever it was given; `Qwen2VLImageProcessor`'s `smart_resize` already caps at `max_pixels`.
   *     Once the budget above is applied, both cost the same for any picture.
   *   · The work it saves is the processor's own decode and resize, and that was TIMED: 50 ms for the
   *     1568 px attachment `apps/infinite/src/lib/attachments.ts` actually writes, 124 ms for a
   *     4000 × 3000 one, 232 ms for 6000 × 4500 — against 50 ms for a picture already at the budget.
   *     So the ceiling on the saving is under 200 ms, and only for a picture no attachment path
   *     produces (`IMAGE_MAX_BYTES` refuses 4 MB, which a 27-megapixel PNG is five times over).
   *   · The shrink itself costs a decode and a re-encode. A canvas round-trip is not free, and one
   *     that is slower than the thing it optimises is a bug with good intentions.
   *
   * The 1568 px cap on attach is the right cap and it is in the right place — it is what the two
   * cloud wires want, and it already lands every attachment within ~50 ms of optimal here.
   */
  private async toImages(library: TransformersLibrary, images: ImagePart[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const image of images) {
      const { bytes, mime } = decodeImage(image, { providerId: this.id });
      // `.slice()` rather than the view: TS types a `Uint8Array`'s buffer as possibly SHARED and a
      // `Blob` takes an `ArrayBuffer`. A few hundred kilobytes, once per picture.
      out.push(await library.load_image(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })));
    }
    return out;
  }

  /**
   * WHICH DEVICE EACH GRAPH ACTUALLY GOT, and what this provider asked the processor for. `null`
   * before a load.
   *
   * It exists because "is it really on the GPU?" was answered by argument for a day. It is not: the
   * library stamps `session.config = { dtype, device }` on every session it builds
   * (`createInferenceSession`), and `deviceToExecutionProviders` THROWS for a device the browser does
   * not have rather than quietly choosing wasm — so a load that says `webgpu` here really did get the
   * WebGPU execution provider. What this CANNOT see, and what nothing in the library exposes, is ORT's
   * per-NODE fallback: the WebGPU EP hands any operator it has no kernel for back to the CPU, and says
   * so only in a `VerifyEachNodeIsAssignedToAnEp` warning on the console at `logLevel: "warning"`.
   */
  sessionDevices(): { sessions: Record<string, { device?: string; dtype?: string }>; visionBudget: number | null; visionBudgetApplied: boolean | null } | null {
    if (!this.loaded) return null;
    const sessions: Record<string, { device?: string; dtype?: string }> = {};
    for (const [name, session] of Object.entries(this.loaded.model.sessions ?? {})) {
      sessions[name] = { device: session.config?.device, dtype: session.config?.dtype };
    }
    return {
      sessions,
      visionBudget: this.visionBudget ? this.visionBudget.tokens : null,
      visionBudgetApplied: this.visionBudgetApplied,
    };
  }

  /**
   * THE PROMPT SIDE OF A LOAD — the processor for a row that sees, the tokenizer for one that does not.
   *
   * Both ends are the library's, and neither is this file's idea of a chat format:
   * `apply_chat_template` renders the REPO's own `chat_template.jinja` (ChatML for the Qwen rows,
   * `<|user|>…<|end|>` for Phi, `<|start_header_id|>` for Llama), which is why adding three model
   * families cost no renderer here. `templates.ts` is still read for the CUT — what a model might
   * type as text past the end of its turn — and for nothing else on this road.
   */
  private async loadPromptSide(
    library: TransformersLibrary,
    progress_callback: (info: TransformersProgress) => void,
  ): Promise<PromptSide> {
    const options = { revision: this.revision, progress_callback };
    if (this.seesImages) {
      const processor = await library.AutoProcessor.from_pretrained(this.repo, options);
      // THE BUDGET, WRITTEN ONTO THE INSTANCE, because there is nowhere else to write it: no
      // `from_pretrained` config override and no call-time kwarg (`TransformersProcessorLike`).
      // Recorded rather than assumed — a budget that did not land is the slow turn coming back.
      this.visionBudgetApplied = this.visionBudget ? applyVisionBudget(processor, this.visionBudget) : null;
      return {
        tokenizer: processor.tokenizer,
        template: (messages, opts) => processor.apply_chat_template(messages, opts),
        // `add_special_tokens: false` because `apply_chat_template` already wrote them, and the
        // README's own example passes it for exactly that reason.
        encode: async (prompt, images) => await processor(prompt, images, null, { add_special_tokens: false }),
      };
    }
    const tokenizer = await library.AutoTokenizer.from_pretrained(this.repo, options);
    return {
      tokenizer,
      template: (messages, opts) => tokenizer.apply_chat_template(messages, opts),
      // A tokenizer's call is synchronous in the installed library; `await` on a plain object is a
      // microtask and keeps ONE shape for both doors, which is cheaper than two generation paths.
      encode: async (prompt) => await tokenizer(prompt, { add_special_tokens: false }),
    };
  }

  /** The model's inputs for one request: the templated transcript plus the decoded pictures. */
  private async buildInputs(library: TransformersLibrary, prompt: PromptSide, req: ChatRequest): Promise<Record<string, unknown>> {
    const { messages, images } = this.buildMessages(req);
    const text = prompt.template(messages, {
      // Gemma 4's and Qwen3.5's thinking modes are opt-in through a token their templates write; an
      // agent loop wants the answer, not the reasoning. A template that has never heard of the
      // variable (Phi's four lines, Llama's) simply ignores it, which is why it is passed to both.
      enable_thinking: false,
      add_generation_prompt: true,
    });
    const decoded = images.length ? await this.toImages(library, images) : null;
    return await prompt.encode(text, decoded);
  }

  /** What the sampler is asked for. Greedy by default: an agent's tool JSON is not a place for luck. */
  private generationOptions(req: ChatRequest): Record<string, unknown> {
    const temperature = req.temperature ?? this.opts.temperature;
    const maxTokens = req.maxTokens ?? this.opts.maxTokens;
    const out: Record<string, unknown> = {
      max_new_tokens: maxTokens ?? 1024,
      do_sample: typeof temperature === "number" && temperature > 0,
    };
    if (typeof temperature === "number" && temperature > 0) {
      // The model card's standardised sampling configuration, with the caller's temperature.
      out.temperature = temperature;
      out.top_p = 0.95;
      out.top_k = 64;
    }
    return out;
  }

  private finish(raw: string, fallback: boolean): ChatResponse {
    // `skip_special_tokens` already drops the real markers; this catches a model that TYPED one as
    // text and ran past the end of its own turn, which no tokenizer setting can prevent.
    const text = stopAtTurnEnd(raw, this.family);
    const parsed = fallback ? parseFallbackToolCalls(text) : { text, calls: [] as ToolCall[] };
    const message: ChatMessage = { role: "assistant", content: parsed.text };
    if (parsed.calls.length) message.toolCalls = parsed.calls;
    return { message, finishReason: mapFinishReason(undefined, parsed.calls.length > 0) };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    throwIfAborted(this.id, req);
    const { library, prompt, model } = await this.load();
    // The download may have taken minutes; an abort that landed during it must not now start a
    // generation, and `addEventListener` on an already-aborted signal never fires.
    throwIfAborted(this.id, req);
    const inputs = await this.buildInputs(library, prompt, req);
    const stopper = new library.InterruptableStoppingCriteria();
    const onAbort = (): void => stopper.interrupt();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let raw = "";
    const streamer = new library.TextStreamer(prompt.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (piece: string) => {
        raw += piece;
      },
    });
    try {
      await model.generate({ ...inputs, ...this.generationOptions(req), streamer, stopping_criteria: stopper });
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
    throwIfAborted(this.id, req);
    return this.finish(raw, Boolean(req.tools?.length));
  }

  /**
   * The streaming twin, over a CALLBACK rather than an async iterator — the same bridge
   * `LiteRtProvider.stream` builds, for the same reason: `generate()` resolves once, and
   * `TextStreamer` is what arrives in between.
   *
   * Two details are not decoration:
   *
   * · a delta is held back until it CANNOT be the first half of a turn marker, so a model that types
   *   `<end_of_turn>` as text never streams it to a reader before the cut is made;
   * · an abort wakes the loop through a listener, since a queue with nothing in it would otherwise
   *   wait for a generation the person already stopped.
   */
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    throwIfAborted(this.id, req);
    const { library, prompt, model } = await this.load();
    throwIfAborted(this.id, req);
    const inputs = await this.buildInputs(library, prompt, req);
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
    const stopper = new library.InterruptableStoppingCriteria();
    const streamer = new library.TextStreamer(prompt.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (piece: string) => {
        if (piece) queue.push(piece);
        bump();
      },
    });
    const generation = model
      .generate({ ...inputs, ...this.generationOptions(req), streamer, stopping_criteria: stopper })
      .then(
        () => undefined,
        (err: unknown) => {
          failure = err ?? new Error("The local model failed.");
        },
      )
      .finally(() => {
        settled = true;
        bump();
      });

    const onAbort = (): void => {
      stopper.interrupt();
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
            stopper.interrupt();
            break;
          }
          const safe = Math.max(0, buffer.length - (turnMarkerMaxLength(this.family) - 1));
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

    // The streamer is the ONLY source here — `generate()` resolves with token ids, and decoding them
    // a second time would be a second answer to reconcile. `cut` is therefore not a branch on where
    // the text came from (as it is in litert.ts), only a record that the marker cut already happened.
    const raw = buffer;
    const text = cut ? raw : stopAtTurnEnd(raw, this.family);
    if (text.length > emitted) yield { type: "text", delta: text.slice(emitted) };
    const response = this.finish(raw, fallback);
    for (const call of response.message.toolCalls ?? []) yield { type: "tool_call", call };
    yield { type: "done", response };
  }
}

/**
 * The fallback instruction, folded into the FIRST system turn rather than pushed as a second one.
 *
 * Unlike the LiteRT road this model HAS a native `system` role (the model card: "Gemma 4 introduces
 * native support for the `system` role"), so the turn is real rather than merged into the first user
 * message — but the instruction still joins the identity prompt instead of following it, because a
 * 2B model reads a second system turn late.
 */
function withToolInstruction(messages: ChatMessage[], instruction: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.role === "system");
  if (at === -1) return [{ role: "system", content: instruction }, ...messages];
  const out = messages.slice();
  const first = out[at] as ChatMessage;
  out[at] = { ...first, content: `${first.content}\n\n${instruction}` };
  return out;
}
