/**
 * THE SEAM THE BRAIN IS BEHIND — and the reason `e.js` has no agent runtime in it (§5.2.3, §10).
 *
 * This file used to BE the brain: it imported `@00/agent-runtime`, `@00/agent-fs` and the local
 * model pair, and every page load of every site running the embed paid for all three. Measured on
 * 2026-09-11, that was the runtime's loop, its prompt text, its context builder, its sessions, its
 * vault and its permissions, plus agent-fs' git-ops, OPFS and node-dir adapters — in a script whose
 * budget is 60 KB gz and whose level-0 job is a site search (§5.2).
 *
 * So the implementation moved to `brain-impl.ts`, which is bundled into `m/brain.js`
 * (`embed/vite.modules.config.ts`) together with the local providers, and THIS file is what stays
 * in the loader: the types, the injected-provider seam, and two functions that fetch that module
 * the moment a person asks for a brain and not one instant before.
 *
 * WHAT IS LEFT HERE MAY ONLY EVER BE `import type`. `test/embed/bundle-budget.test.ts` walks the
 * import graph from `loader.ts` and fails if a VALUE import of @00/agent-runtime, @00/agent-fs,
 * @00/agent-models or @00/shared can be reached from it. That test is the pin; this paragraph is
 * the reason.
 */

import type { AgentEvent, PermissionDecision, RunResult, Tool } from "@00/agent-runtime";
import type { ModelProvider } from "@00/agent-models";
import { BRAIN_MODULE, loadModule } from "./modules.js";
import { localAiOffer, type LocalAiOffer } from "./local-ai.js";

/** What came up, and which row describes it — the panel relabels itself from this. */
export interface LocalPick {
  provider: ModelProvider;
  offer: LocalAiOffer;
}

export interface BrainOptions {
  provider: ModelProvider;
  tools: Tool[];
  /** The site map and the owner's intro, appended verbatim to the light agent's rules (§5.2.2). */
  systemContext: () => string;
  /** The site the embed sits on: the permission scope, per `RuntimeExtensions.origin`. */
  origin: string;
  askPermission(req: { name: string; tier: string; args: Record<string, unknown> }): Promise<PermissionDecision>;
  onEvent(event: AgentEvent): void;
}

export interface Brain {
  readiness(): Promise<{ ready: true } | { ready: false; reason: string; detail?: string }>;
  ask(prompt: string, signal?: AbortSignal): Promise<RunResult>;
  abort(): void;
}

/** The shape `m/brain.js` exposes. Named here so the dynamic import is typed rather than `any`. */
export interface BrainModule {
  createBrain(opts: BrainOptions): Brain;
  pickLocalProvider(options: {
    onProgress?: (line: string) => void;
  }): Promise<{ provider: ModelProvider; providerId: string; offer: LocalAiOffer } | null>;
}

export type ProviderFactory = () => ModelProvider;

let providerFactory: ProviderFactory | null = null;

/** Hand in a provider directly (the PWA bundles one; a test fakes one). */
export function useModelProvider(factory: ProviderFactory | null): void {
  providerFactory = factory;
}

export function hasModelProvider(): boolean {
  return providerFactory != null;
}

/**
 * Fetch `m/brain.js` — the agent loop, the in-memory thread filesystem and the local providers.
 *
 * Called from exactly two places, both of them a person asking for a brain: the panel's
 * "Load local AI" button, and a site whose owner configured one. `null` with a sentence is the
 * answer when it cannot be had; the panel stays a site search, which is a working product.
 */
export function loadBrainModule(
  productHost: string,
  onError?: (message: string) => void,
): Promise<BrainModule | null> {
  return loadModule<BrainModule>(productHost, BRAIN_MODULE, onError);
}

/**
 * The "Load local AI" path.
 *
 * The module walks the pair (LiteRT, then WebLLM) and hands back whichever came up, so what returns
 * here carries the row that describes what was actually downloaded — which is not always the row the
 * button promised, and the panel says so rather than leaving the wrong label up. `null` means
 * neither could run.
 *
 * An INJECTED provider short-circuits the walk but not the module: the loop itself lives in
 * `m/brain.js` too, so `createBrain` still needs it. That is the PWA's and the tests' path, and
 * both of those import `brain-impl.ts` directly rather than over a URL.
 */
export async function loadLocalProvider(
  productHost: string,
  onProgress?: (line: string) => void,
): Promise<LocalPick | null> {
  if (providerFactory) return { provider: providerFactory(), offer: localAiOffer() };
  const mod = await loadBrainModule(productHost, (message) => onProgress?.(message));
  if (!mod) return null;
  try {
    const picked = await mod.pickLocalProvider({ ...(onProgress ? { onProgress } : {}) });
    if (!picked) {
      onProgress?.("This browser cannot run a local model.");
      return null;
    }
    return { provider: picked.provider, offer: picked.offer };
  } catch (err) {
    onProgress?.(`The local model did not load (${String(err)}).`);
    return null;
  }
}
