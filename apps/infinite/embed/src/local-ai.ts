/**
 * THE ONE MODULE THAT NAMES A HOST, and the two offers that hang off it (§5.2.3, §12.7).
 *
 * WHY IT EXISTS. The embed runs on somebody else's website, so the local model cannot come from
 * "our origin" the way the PWA's does: there is no our-origin on a stranger's page. Decision §12.7
 * settled where it comes from instead — the public mirror `https://dl.0-0.chat`, `00-downloads`
 * behind Cloudflare, flat keys under `litert/`, MediaPipe's runtime under
 * `mediapipe/genai/<version>/wasm/`, read-only CORS for GET/HEAD from any origin with Range
 * exposed. That is ONE fact about the world, so it is written down ONCE, here. Nothing else under
 * `embed/src/**` may name a network host, and `test/embed/local-ai.test.ts` greps the sources to
 * keep it that way: a second copy of a base URL is how a mirror move turns into a silent 404 on
 * every website that pasted the snippet.
 *
 * WHY THE OFFER IS TWO ROWS AND NOT ONE. `localProviders()` in `@00/agent-models` puts LiteRT
 * first and WebLLM behind it (the ruling of 2026-09-10). The button must not promise the wrong
 * download: it names the row that will ACTUALLY load, so the size, the model's name and its
 * publisher's licence are read off the row this browser is going to take, decided by the one probe
 * that is free and needs no bytes — `navigator.gpu`.
 *
 * WHY THE NUMBERS ARE HERE AND NOT IMPORTED FROM THE CATALOGUES. Importing `@00/agent-models` into
 * the loader would drag the WebGPU runtimes into a script whose whole budget is 60 KB (§10) —
 * `vite.embed.config.ts` inlines dynamic imports, so even the providers' lazy `import()` of
 * `@mlc-ai/web-llm` and `@mediapipe/tasks-genai` would land in `e.js`. So the rows are stated here
 * and PINNED to the real catalogues by the twin guard in `test/embed/local-ai.test.ts`, which reads
 * `LITERT_CATALOG` and `WEBLLM_CATALOG` in node where importing them costs nothing.
 */

/** The mirror of §12.7. `modelBaseUrl` for `LiteRtProvider`; the assets sit flat beneath it. */
export const LITERT_MODEL_BASE_URL = "https://dl.0-0.chat/litert";

/** The `@mediapipe/tasks-genai` release whose `wasm/` folder is published on the mirror. */
export const MEDIAPIPE_VERSION = "0.10.29";

/**
 * MediaPipe's own `wasm/` folder, CROSS-ORIGIN on purpose.
 *
 * The PWA copies that folder next to itself and passes a relative path (the provider's default),
 * because it must work on a plane. An embed cannot: it has no origin of its own on the page it
 * runs on, and asking a website owner to host 27 MB of Google's wasm is not a snippet any more.
 * `FilesetResolver.forGenAiTasks()` takes an absolute base happily — it appends the file names and
 * fetches them — and the bucket answers GET from any origin, which is what makes this legal.
 */
export const LITERT_WASM_BASE_URL = `https://dl.0-0.chat/mediapipe/genai/${MEDIAPIPE_VERSION}/wasm`;

/** The embed's LiteRT row: the smallest thing on the mirror that can hold a conversation (§12.7). */
export const LITERT_EMBED_MODEL_ID = "gemma3-270m-it-q4_0-web";

/** The embed's WebLLM row: web-llm's own default, and the fallback of the ruling. */
export const WEBLLM_EMBED_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

export interface LocalAiModelFacts {
  name: string;
  licenseName: string;
  licenseUrl: string;
  /** Present when the licence carries use restrictions the person must be pointed at BEFORE the
   *  download — Gemma's Prohibited Use Policy, per §12.7's "Gemma terms, met like this". */
  useRestrictionsUrl?: string;
}

export interface LocalAiOffer {
  /** Which of the two the router will reach first in this browser. */
  provider: "litert" | "webllm";
  modelId: string;
  /** Megabytes over the wire, decimal, rounded up — the number on the button. */
  sizeMb: number;
  model: LocalAiModelFacts;
  /** Shown above the button when there is something the person should know first. */
  note?: string;
}

/**
 * The preferred offer: Gemma 3 270m over LiteRT.
 *
 * 250 MB is the mirror's own figure for `gemma3-270m-it-q4_0-web.task` — 249,233,408 bytes in
 * `litert/catalog.json`, the file whose sha256 was checked on the way into the bucket. The licence
 * is the row's (`GEMMA_TERMS` in `@00/agent-models`), and it is named beside the button rather than
 * after the download, because Gemma's terms bind the person who runs the weights.
 */
export const LITERT_OFFER: LocalAiOffer = {
  provider: "litert",
  modelId: LITERT_EMBED_MODEL_ID,
  sizeMb: 250,
  model: {
    name: "Gemma 3 270m",
    licenseName: "Gemma Terms of Use",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    useRestrictionsUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
  },
};

/**
 * The fallback offer: Llama 3.2 1B over web-llm, for a browser LiteRT cannot serve.
 *
 * 879 is `vramMb` of the row in `WEBLLM_CATALOG` — and it is a DIFFERENT QUANTITY from the 250
 * above, which is bytes over the wire. web-llm's manifest publishes `vram_required_MB` and no
 * download size at all, so this is the only number that exists; for a q4f16 1B the weights and the
 * working set are within rounding of each other, and an honest approximation beats no number on a
 * button that starts a download. The twin guard pins it to the catalogue so it cannot drift.
 */
export const WEBLLM_OFFER: LocalAiOffer = {
  provider: "webllm",
  modelId: WEBLLM_EMBED_MODEL_ID,
  sizeMb: 879,
  model: {
    name: "Llama 3.2 1B",
    licenseName: "Llama 3.2 Community License",
    licenseUrl: "https://www.llama.com/llama3_2/license/",
  },
};

/** In the order `localProviders()` puts them; exported so a test can walk the pair. */
export const LOCAL_AI_OFFERS: readonly LocalAiOffer[] = [LITERT_OFFER, WEBLLM_OFFER];

/** What a browser without WebGPU is told, before it is shown the fallback's facts. */
export const NO_WEBGPU_NOTE =
  "This browser has no WebGPU, so a local model may not run here at all — it is worth a try only on a recent Chrome, Edge or Safari.";

interface GpuNavigator {
  gpu?: unknown;
}

/** The free probe. Injectable so a node test can be both browsers without a DOM. */
export function hasWebGpu(nav: GpuNavigator | undefined = (globalThis as { navigator?: GpuNavigator }).navigator): boolean {
  return Boolean(nav?.gpu);
}

/**
 * The offer this browser will actually be able to take.
 *
 * WebGPU present ⇒ LiteRT leads, so the button says 250 MB and names Gemma's terms. Absent ⇒ LiteRT
 * answers `unsupported` and the router walks on, so the button shows the fallback's facts and says
 * plainly that this browser may not manage either. It is never hidden: a person who wants to try
 * should be allowed to, and the load path returns a clean "not available in this browser".
 */
export function localAiOffer(nav?: GpuNavigator | undefined): LocalAiOffer {
  // `undefined` falls through to `hasWebGpu`'s own default, which is the real `navigator`.
  return hasWebGpu(nav) ? LITERT_OFFER : { ...WEBLLM_OFFER, note: NO_WEBGPU_NOTE };
}
