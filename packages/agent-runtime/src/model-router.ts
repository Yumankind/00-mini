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
 *
 * ┌─ AND THE OTHER `ModelRouter`, the one in `@00/agent-models` ────────────────────────────────┐
 * │ It is NOT dead code and it is NOT this class's rival: it is a PROVIDER-SHAPED FAÇADE — you   │
 * │ hand it providers and call `chat()`/`stream()` on it as if it were one brain, and it walks   │
 * │ the list itself. That is the right tool for a caller that has no loop of its own (the PWA's  │
 * │ "answer this one question" paths, the embed's level-0 turn), and the audit's finding that it │
 * │ had no production consumer is answered by naming it as the APP'S OPTIONAL PICKER rather than │
 * │ by wiring it under this loop.                                                                │
 * │ THE LOOP CANNOT USE IT, for three reasons that are all contract: the loop needs a class PER  │
 * │ CALL (brain-class.ts) rather than per construction; it must emit `model_started` for EVERY   │
 * │ attempt, including the ones that then failed, which a façade hides by design; and it must    │
 * │ honour `RunOptions.model` naming ONE provider, which that class has no way to express. The   │
 * │ switching RULE is shared, and shared where it belongs: both read `isSwitchable` from          │
 * │ `@00/agent-models/errors`, so there is exactly one definition of "a switch could fix this".  │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
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
    for await (const routed of this.walk(spec, cls)) return routed;
    // Unreachable: `walk` always yields at least one candidate (see its last line).
    return { provider: this.providers[0], brainClass: cls };
  }

  /**
   * EVERY BRAIN THAT COULD ANSWER THIS CALL, best first — the fallthrough of gap B16.
   *
   * `pick()` answers "who answers now" and was the whole story until a provider was allowed to FAIL
   * mid-run: a dead key or an empty purse ended the run, although the person had a local model
   * sitting ready. The fix is not a second router, it is one more question asked of this one — "and
   * who else?" — so the loop can walk on when, and only when, `isSwitchable` says a switch could
   * actually fix it and nothing has been emitted yet (the rule is stated in runtime.ts).
   *
   * It is a GENERATOR because readiness costs something: asking the local brain whether it has
   * finished downloading is cheap, asking a sponsored device store is a read, and a run that never
   * fails must not pay for probing the peers it never needed. Yielding lazily makes the first
   * candidate cost exactly what `pick()` used to cost, to the call.
   *
   * A NAMED provider yields ONCE and never falls through. The person chose that brain; answering
   * from another one because the chosen one refused is precisely the lie `pick()`'s throw exists to
   * prevent (see above). `auto` is the mode where the runtime is allowed to choose, so `auto` is the
   * mode where it is allowed to choose again.
   */
  async *walk(spec?: string, cls: ModelClass = "strong"): AsyncGenerator<RoutedModel> {
    if (spec && spec !== "auto") {
      const slash = spec.indexOf("/");
      const id = slash === -1 ? spec : spec.slice(0, slash);
      const model = slash === -1 ? undefined : spec.slice(slash + 1);
      const provider = this.providers.find((p) => p.id === id);
      if (!provider) {
        throw new Error(`no model provider "${id}" — this runtime has: ${this.ids().join(", ")}`);
      }
      yield { provider, model, brainClass: classActuallyUsed(await this.classesOf(provider), cls) };
      return;
    }

    /** Ready providers whose catalogue does NOT offer the class — behind the ones that do. */
    const secondBest: ModelProvider[] = [];
    let yielded = false;
    for (const provider of this.providers) {
      try {
        if (!(await provider.readiness()).ready) continue;
      } catch {
        /* a provider that cannot even answer readiness is not ready */
        continue;
      }
      const offered = await this.classesOf(provider);
      if (!offered.has(cls)) {
        secondBest.push(provider);
        continue;
      }
      yielded = true;
      yield { provider, brainClass: cls };
    }
    for (const provider of secondBest) {
      yielded = true;
      yield { provider, brainClass: classActuallyUsed(await this.classesOf(provider), cls) };
    }
    // Nothing is ready — hand back the first anyway so the failure comes from the provider, with its
    // own words about what is missing (a key, a download, the network), rather than from here.
    if (!yielded) yield { provider: this.providers[0], brainClass: cls };
  }
}
