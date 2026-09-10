/**
 * The optional brain: the real `@00/agent-runtime` loop, and the local model that is never loaded
 * until a visitor asks for it (§5.2.3).
 *
 * WHY the model lives behind a URL and not behind an import: `@00/agent-models`' local providers
 * pull `@mlc-ai/web-llm` (2.1 MB gzipped, measured) and `@mediapipe/tasks-genai` with them. The
 * loader's whole budget is 60 KB (§10) and level 0 must work with NO model at all, so the loader
 * imports the RUNTIME (9.6 KB gz, measured) and reaches the model only through
 * `embed/src/model-entry.ts`, built separately by `embed/vite.model.config.ts` into `m/m.js`. A
 * site nobody asks a model for never fetches a byte of it. Everything else here is the real thing:
 *
 *   `createAgentRuntime`  — @00/agent-runtime, `trust: "light"` (read-only public knowledge, its own
 *                           thread sandbox, no shell, no secrets — ruling 2 of §0)
 *   `MemoryFs`            — @00/agent-fs, in memory ON PURPOSE: the light agent's thread folder on a
 *                           stranger's website must not outlive the tab, so its sessions, its
 *                           permissions and anything it writes die with the visit.
 *   the local pair        — @00/agent-models, through the module above: LiteRT's Gemma 3 270m from
 *                           the §12.7 mirror, and web-llm's Llama 3.2 1B behind it.
 *
 * The one thing still injectable is the provider (`useModelProvider`), so the PWA — which does
 * bundle the models package — and the tests can hand one in without the URL dance.
 */

import { createAgentRuntime, type AgentEvent, type PermissionDecision, type RunResult, type Tool } from "@00/agent-runtime";
import { MemoryFs } from "@00/agent-fs";
import type { ModelProvider } from "@00/agent-models";
import { localAiOffer, type LocalAiOffer } from "./local-ai.js";

/** The shape `m/m.js` exposes. Named here so the dynamic import is typed rather than `any`. */
export interface LocalModelModule {
  pickLocalProvider(options: {
    onProgress?: (line: string) => void;
  }): Promise<{ provider: ModelProvider; providerId: string; offer: LocalAiOffer } | null>;
}

/** What came up, and which row describes it — the panel relabels itself from this. */
export interface LocalPick {
  provider: ModelProvider;
  offer: LocalAiOffer;
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
 * The "Load local AI" path, and the ONLY place the model module is fetched.
 *
 * The module walks the pair (LiteRT, then WebLLM) and hands back whichever came up, so what
 * returns here carries the row that describes what was actually downloaded — which is not always
 * the row the button promised, and the panel says so rather than leaving the wrong label up.
 * `null` means neither could run: the panel then stays a site search, which is a working product
 * at level 0, not an error state.
 */
export async function loadLocalProvider(
  moduleUrl: string,
  onProgress?: (line: string) => void,
): Promise<LocalPick | null> {
  if (providerFactory) return { provider: providerFactory(), offer: localAiOffer() };
  try {
    // A computed specifier on purpose: the bundler must NOT resolve this, or the loader inherits
    // the whole WebGPU runtime it exists to avoid.
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as LocalModelModule;
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

export function createBrain(opts: BrainOptions): Brain {
  // Mutable, and read on every run: the runtime spreads `opts.context` per run, so the site map the
  // agent sees is the one the crawl has reached by then, not the one it had when the panel opened.
  const context: { extra: string; light: { channel: string; from: string } } = {
    extra: opts.systemContext(),
    light: { channel: "this website", from: "a visitor to this website" },
  };

  const runtime = createAgentRuntime({
    // In memory: nothing the light agent writes on somebody else's website survives the tab.
    fs: new MemoryFs(),
    providers: [opts.provider],
    tools: opts.tools,
    askPermission: (req) => opts.askPermission(req),
    trust: "light",
    origin: opts.origin,
    /** The light agent's sandbox is its own thread folder, never a workspace (§0, ruling 2). */
    workspace: "threads/embed",
    context,
  });
  runtime.on(opts.onEvent);

  return {
    async readiness() {
      try {
        const r = await opts.provider.readiness();
        return r.ready ? { ready: true } : { ready: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
      } catch (err) {
        return { ready: false, reason: "unsupported", detail: String(err) };
      }
    },
    ask(prompt, signal) {
      context.extra = opts.systemContext();
      return runtime.run(signal ? { prompt, signal } : { prompt });
    },
    abort: () => runtime.abort(),
  };
}

/** A thread-scoped, in-memory filesystem for tools the panel runs itself, outside a model turn. */
export function threadFs(): MemoryFs {
  return new MemoryFs();
}
