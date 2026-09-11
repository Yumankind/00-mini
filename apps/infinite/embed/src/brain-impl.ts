/**
 * The optional brain, for real — the `@00/agent-runtime` loop, in the module that is fetched only
 * when somebody asks for a brain (§5.2.3).
 *
 * THIS FILE IS NOT IN `e.js` AND MUST NEVER BE. It is reachable only through `brain.ts`'s seam,
 * which loads `m/brain.js` over a URL; the split is what keeps the runtime, agent-fs and the two
 * WebGPU providers out of the script every page load fetches. `embed/src/entries/brain.ts` is the
 * module's entry and bundles this together with `model-entry.ts`.
 *
 *   `createAgentRuntime`  — @00/agent-runtime, `trust: "light"` (read-only public knowledge, its own
 *                           thread sandbox, no shell, no secrets — ruling 2 of §0)
 *   `MemoryFs`            — @00/agent-fs, in memory ON PURPOSE: the light agent's thread folder on a
 *                           stranger's website must not outlive the tab, so its sessions, its
 *                           permissions and anything it writes die with the visit.
 *   the local pair        — @00/agent-models, through `model-entry.ts`: LiteRT's Gemma 3 270m from
 *                           the §12.7 mirror, and web-llm's Llama 3.2 1B behind it.
 */

import { createAgentRuntime } from "@00/agent-runtime";
import { MemoryFs } from "@00/agent-fs";
import type { Brain, BrainOptions } from "./brain.js";

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

/**
 * A thread-scoped, in-memory filesystem — the real one, for the runtime's own turns.
 *
 * The PANEL does not use this: it runs tools outside a model turn and has `tools/scratch-fs.ts`,
 * forty lines of Map, because importing agent-fs for it would put the whole package back in `e.js`.
 */
export function threadFs(): MemoryFs {
  return new MemoryFs();
}
