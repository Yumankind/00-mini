/**
 * The optional brain: the real `@00/agent-runtime` loop, and the local model that is never loaded
 * until a visitor asks for it (§5.2.3).
 *
 * WHY the model lives behind a URL and not behind an import: `@00/agent-models`' WebLLM provider
 * pulls `@mlc-ai/web-llm` with it — 2.1 MB gzipped, measured. The loader's whole budget is 60 KB
 * (§10) and level 0 must work with NO model at all, so the loader imports the RUNTIME (9.6 KB gz,
 * measured) and reaches the model only through `embed/src/model-entry.ts`, built separately by
 * `embed/vite.model.config.ts` into `m/m.js`. A site nobody asks a model for never fetches a byte
 * of it. Everything else here is the real thing:
 *
 *   `createAgentRuntime`  — @00/agent-runtime, `trust: "light"` (read-only public knowledge, its own
 *                           thread sandbox, no shell, no secrets — ruling 2 of §0)
 *   `MemoryFs`            — @00/agent-fs, in memory ON PURPOSE: the light agent's thread folder on a
 *                           stranger's website must not outlive the tab, so its sessions, its
 *                           permissions and anything it writes die with the visit.
 *   `WebLLMProvider`      — @00/agent-models, through the module above.
 *
 * The one thing still injectable is the provider (`useModelProvider`), so the PWA — which does
 * bundle the models package — and the tests can hand one in without the URL dance.
 */

import { createAgentRuntime, type AgentEvent, type PermissionDecision, type RunResult, type Tool } from "@00/agent-runtime";
import { MemoryFs } from "@00/agent-fs";
import type { ModelProvider } from "@00/agent-models";

/** The shape `m/m.js` exposes. Named here so the dynamic import is typed rather than `any`. */
export interface LocalModelModule {
  WebLLMProvider: new (opts?: { modelId?: string; onProgress?: (r: { text?: string; progress?: number }) => void }) => ModelProvider & {
    load(): Promise<unknown>;
  };
  WEBLLM_DEFAULT_MODEL_ID: string;
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
 * The "Load local AI" path, and the ONLY place the model module is fetched. Returns null when the
 * browser cannot run one (no WebGPU) or the module will not load — the panel then stays a search,
 * which is a working product, not an error state.
 */
export async function loadLocalProvider(
  moduleUrl: string,
  onProgress?: (line: string) => void,
): Promise<ModelProvider | null> {
  if (providerFactory) return providerFactory();
  try {
    // A computed specifier on purpose: the bundler must NOT resolve this, or the loader inherits
    // the whole WebGPU runtime it exists to avoid.
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as LocalModelModule;
    const provider = new mod.WebLLMProvider({
      onProgress: (r) => onProgress?.(r.text ?? `${Math.round((r.progress ?? 0) * 100)}%`),
    });
    const ready = await provider.readiness();
    if (!ready.ready && ready.reason === "unsupported") {
      onProgress?.(ready.detail ?? "This browser cannot run a local model.");
      return null;
    }
    await provider.load();
    return provider;
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
