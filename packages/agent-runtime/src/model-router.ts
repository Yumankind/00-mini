/**
 * Which brain answers this call — and the rule that the agent never finds out.
 *
 * Four peers sit behind one `ModelProvider` interface (docs/HANDOFF-infinite-agent.md §6.1): a local
 * WebGPU model, sponsoredtokens, Overblast credits, and the person's own key. The router picks; the
 * loop reports WHICH ONE ANSWERED in `model_started`/`model_completed` for the UI's chip, and puts
 * nothing about it in the prompt. A prompt that says "you are running on a 1B local model" is a
 * prompt that talks about itself instead of doing the work.
 *
 * `auto` USED TO MEAN "the first provider in the caller's order that says it is ready", and §6's
 * class-aware route — small for search, edits and navigation, the strongest available for planning
 * and code — was a named gap (Status finding 5). It is closed here, and the shape of the fix is the
 * point: the class is not guessed from the message, it is computed from the shape of the call by
 * `classifyCall` in brain-class.ts, and this file only honours it.
 *
 * HOW IT HONOURS IT — rank, never filter:
 *
 *   Walk the providers in the caller's order (which is what `setProviders` means). Skip the ones
 *   that are not ready, exactly as before. Return the first READY one whose catalogue offers the
 *   asked class; if no ready provider offers it, return the first ready one anyway and report the
 *   class it actually answers in.
 *
 * That one sentence carries both fallbacks the contract asks for — no `strong` anywhere means the
 * small brain answers, and `small` asked of a setup that only has a cloud brain uses the cloud brain,
 * because a stronger answer is better than no answer. It also carries the property that matters most
 * for a change to a shipped loop: WITH ONE READY PROVIDER THE ANSWER IS THE SAME PROVIDER IT WAS
 * BEFORE, for every class, because a rank of one is a list of one. A test pins that.
 *
 * The class a provider offers comes from `providerClasses()` in `@00/agent-models`, so the runtime
 * and the models package read a catalogue the same way (including the empty-catalogue-is-strong rule
 * a BYOK or pre-mint cloud provider lands on). It is asked once per provider per router, and a
 * router is built per run, so a run costs at most one extra catalogue read per brain.
 */
import { classActuallyUsed, providerClasses, type ModelClass, type ModelProvider } from "@00/agent-models";

export interface RoutedModel {
  provider: ModelProvider;
  /** The provider-specific model id, when the spec named one. */
  model?: string;
  /**
   * The class this call is actually being answered in — the asked one when the provider offers it,
   * the one it does offer when it does not. It is the caller's receipt (`model_started.brainClass`),
   * never the model's context.
   */
  brainClass: ModelClass;
}

export class ModelRouter {
  /** One catalogue read per provider per router; a router is built per run. */
  private readonly classCache = new Map<string, Promise<Set<ModelClass>>>();

  constructor(private readonly providers: ModelProvider[]) {
    if (!providers.length) throw new Error("a runtime needs at least one ModelProvider");
  }

  ids(): string[] {
    return this.providers.map((p) => p.id);
  }

  private classesOf(provider: ModelProvider): Promise<Set<ModelClass>> {
    let pending = this.classCache.get(provider.id);
    if (!pending) {
      pending = providerClasses(provider);
      this.classCache.set(provider.id, pending);
    }
    return pending;
  }

  /**
   * `spec` is `auto` (or absent), a provider id, or `<providerId>/<modelId>`.
   * An unknown id throws by name rather than falling back: a person who picked a brain and silently
   * got another one has been lied to, and that is the failure the fleet's borrowed-model guard in
   * the engine exists to prevent (agent-manager.ts, `borrowedModelBlocked`).
   *
   * `cls` is the class this call wants, `strong` when the caller names none. A NAMED provider is
   * still the one that answers — the person chose a brain and the class does not overrule that; the
   * class only labels what that brain turns out to be.
   */
  async pick(spec?: string, cls: ModelClass = "strong"): Promise<RoutedModel> {
    if (!spec || spec === "auto") return this.firstReady(cls);
    const slash = spec.indexOf("/");
    const id = slash === -1 ? spec : spec.slice(0, slash);
    const model = slash === -1 ? undefined : spec.slice(slash + 1);
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) {
      throw new Error(`no model provider "${id}" — this runtime has: ${this.ids().join(", ")}`);
    }
    return { provider, model, brainClass: classActuallyUsed(await this.classesOf(provider), cls) };
  }

  private async firstReady(cls: ModelClass): Promise<RoutedModel> {
    /** The first ready provider of the wrong class — the answer when no ready one is the right one. */
    let secondBest: ModelProvider | undefined;
    for (const provider of this.providers) {
      try {
        if (!(await provider.readiness()).ready) continue;
      } catch {
        /* a provider that cannot even answer readiness is not ready */
        continue;
      }
      const offered = await this.classesOf(provider);
      if (offered.has(cls)) return { provider, brainClass: cls };
      secondBest ??= provider;
    }
    if (secondBest) return { provider: secondBest, brainClass: classActuallyUsed(await this.classesOf(secondBest), cls) };
    // Nothing is ready — hand back the first anyway so the failure comes from the provider, with its
    // own words about what is missing (a key, a download, the network), rather than from here.
    return { provider: this.providers[0], brainClass: cls };
  }
}
