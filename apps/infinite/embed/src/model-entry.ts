/**
 * The local model, in its OWN module — never in the loader.
 *
 * WHY it is a separate file: `@00/agent-models`' two local providers pull `@mlc-ai/web-llm`
 * (2.1 MB gzipped) and `@mediapipe/tasks-genai` in behind them, and `vite.embed.config.ts` inlines
 * dynamic imports, so an import of the package from the loader would land the whole of both
 * runtimes in `e.js`. The loader's budget is 60 KB (§10) and level 0 must work with NO model at
 * all (§5.2.3). So `e.js` never imports this; the "Load local AI" button does, at the moment the
 * visitor asks for it, and a site that is never asked never fetches a byte of it.
 *
 * WHAT IT DOES BEYOND RE-EXPORTING. It builds BOTH local providers in the order the ruling of
 * 2026-09-10 names (`localProviders()`: LiteRT first, WebLLM behind it) and hands back the first
 * one that actually comes up, together with the offer row that describes it — so the panel can
 * correct its own label when the fallback is what loaded.
 */

import {
  LiteRtProvider,
  WebLLMProvider,
  localProviders,
  type LocalProvider,
  type ModelProvider,
} from "@00/agent-models";
import { LITERT_EMBED_MODEL_ID, LITERT_MODEL_BASE_URL, LITERT_OFFER, LITERT_WASM_BASE_URL, WEBLLM_EMBED_MODEL_ID, WEBLLM_OFFER, type LocalAiOffer } from "./local-ai.js";

export { LITERT_CATALOG, LiteRtProvider, WEBLLM_CATALOG, WEBLLM_DEFAULT_MODEL_ID, WebLLMProvider, litertCatalogFor, localProviders, webllmCatalogFor } from "@00/agent-models";

/** A line for the button, composed from whichever progress shape the provider emits. */
export type LocalProgress = (line: string) => void;

export interface LocalPick {
  provider: ModelProvider;
  /** The provider's own id: `local-litert` or `local`. */
  providerId: string;
  /** The row that describes what was actually downloaded, for the panel's label. */
  offer: LocalAiOffer;
}

export interface PickOptions {
  onProgress?: LocalProgress;
  /** Overridden only by a test; production takes the §12.7 mirror from `local-ai.ts`. */
  modelBaseUrl?: string;
  wasmBaseUrl?: string;
  /** Injected by a test, so the pick can be walked without WebGPU or a network. */
  providers?: { provider: LocalProvider; offer: LocalAiOffer }[];
}

/**
 * The two progress shapes, flattened to one line.
 *
 * web-llm reports `{ progress, timeElapsed, text }`; LiteRT reports
 * `{ progress, loadedBytes, totalBytes, text }` — and a `progress` field is being added to
 * `readiness()` upstream while this is written, so nothing here may assume a field exists. Read
 * defensively, prefer the sentence the provider composed, fall back to a percentage, and never
 * throw inside a progress callback.
 */
export function progressLine(report: unknown): string {
  const r = (report ?? {}) as { text?: unknown; progress?: unknown; loadedBytes?: unknown; totalBytes?: unknown };
  if (typeof r.text === "string" && r.text) return r.text;
  if (typeof r.progress === "number" && Number.isFinite(r.progress)) return `${Math.round(r.progress * 100)}%`;
  if (typeof r.loadedBytes === "number" && Number.isFinite(r.loadedBytes)) return `${Math.round(r.loadedBytes / 1e6)} MB`;
  return "Loading…";
}

/** True when the provider itself says this browser cannot run it at all. */
function isUnsupported(readiness: unknown): boolean {
  const r = (readiness ?? {}) as { ready?: unknown; reason?: unknown };
  return r.ready !== true && r.reason === "unsupported";
}

/** `load()` is additive to the frozen `ModelProvider`; both local ones have it, a fake may not. */
async function loadIfPossible(provider: LocalProvider): Promise<void> {
  const loader = (provider as { load?: () => Promise<unknown> }).load;
  if (typeof loader === "function") await loader.call(provider);
}

/**
 * Build the pair, walk it, return the first that comes up. `null` when neither can run.
 *
 * TWO REASONS THE WALK IS NOT JUST A READINESS CHECK. `readiness()` on both providers gates on the
 * same thing — `navigator.gpu` — so on the machines this fallback exists for it answers the same
 * for both, and a readiness-only walk would never reach WebLLM. The differences show up at LOAD:
 * the cross-origin wasm fileset, the GPU delegate refusing a `.task`, an asset the mirror does not
 * hold. So a failed `load()` also walks on, exactly as `ModelRouter` walks on a switchable error,
 * and only the last failure is reported to the person.
 */
export async function pickLocalProvider(options: PickOptions = {}): Promise<LocalPick | null> {
  const onProgress = options.onProgress;
  const report = (r: unknown): void => {
    try {
      onProgress?.(progressLine(r));
    } catch {
      /* a UI that throws in a progress callback must not abort a download */
    }
  };

  const candidates =
    options.providers ??
    (() => {
      // WHERE THE 250 MB ENDS UP, and the known cost of §5.2.3. The provider fetches the asset
      // itself and keeps it in Cache Storage under `LITERT_MODEL_CACHE`, keyed by its absolute
      // `dl.0-0.chat` URL. This script runs in the HOST PAGE's context, so that cache belongs to
      // the website the visitor is on — and browser storage is partitioned per top-level site, so
      // the same file is downloaded again on the next website that offers it. There is no shared
      // cache to have: a cross-site one is exactly what partitioning exists to prevent. It is why
      // the plan offers a quarter of a gigabyte here and two gigabytes in the PWA.
      const litert = new LiteRtProvider({
        modelId: LITERT_EMBED_MODEL_ID,
        modelBaseUrl: options.modelBaseUrl ?? LITERT_MODEL_BASE_URL,
        wasmBaseUrl: options.wasmBaseUrl ?? LITERT_WASM_BASE_URL,
        onProgress: report,
      });
      const webllm = new WebLLMProvider({ modelId: WEBLLM_EMBED_MODEL_ID, onProgress: report });
      // The order is the ruling's, and it is not spelled out here: `localProviders()` owns it, so a
      // caller cannot get it wrong by listing the two the other way round.
      const ordered = localProviders({ litert, webllm });
      const offers = new Map<LocalProvider, LocalAiOffer>([
        [litert, LITERT_OFFER],
        [webllm, WEBLLM_OFFER],
      ]);
      return ordered.map((provider) => ({ provider, offer: offers.get(provider)! }));
    })();

  let lastError: unknown;
  for (const { provider, offer } of candidates) {
    const readiness = await provider.readiness().catch((err: unknown) => {
      lastError = err;
      return { ready: false as const, reason: "unsupported" as const };
    });
    if (isUnsupported(readiness)) continue;
    try {
      await loadIfPossible(provider);
      return { provider, providerId: provider.id, offer };
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError && onProgress) report({ text: `The local model did not start (${String(lastError)}).` });
  return null;
}
