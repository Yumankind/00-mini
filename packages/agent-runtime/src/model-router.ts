/**
 * Which brain answers this turn — and the rule that the agent never finds out.
 *
 * Four peers sit behind one `ModelProvider` interface (docs/HANDOFF-infinite-agent.md §6.1): a local
 * WebGPU model, sponsoredtokens, Overblast credits, and the person's own key. The router picks; the
 * loop reports WHICH ONE ANSWERED in `model_started`/`model_completed` for the UI's chip, and puts
 * nothing about it in the prompt. A prompt that says "you are running on a 1B local model" is a
 * prompt that talks about itself instead of doing the work.
 *
 * `auto` today means "the first provider in the caller's order that says it is ready". The order is
 * the caller's preference, and readiness is the provider's own answer (a missing key, an undownloaded
 * model, offline). THE CLASS-AWARE ROUTE — small model for search and navigation, strong model for
 * planning and code, as §6 describes — is NOT here yet: it needs a per-request class the loop does
 * not compute, and guessing one from the message would be worse than the honest order. Named as a
 * gap so nobody reads `auto` as more than it is.
 */
import type { ModelProvider } from "@00/agent-models";

export interface RoutedModel {
  provider: ModelProvider;
  /** The provider-specific model id, when the spec named one. */
  model?: string;
}

export class ModelRouter {
  constructor(private readonly providers: ModelProvider[]) {
    if (!providers.length) throw new Error("a runtime needs at least one ModelProvider");
  }

  ids(): string[] {
    return this.providers.map((p) => p.id);
  }

  /**
   * `spec` is `auto` (or absent), a provider id, or `<providerId>/<modelId>`.
   * An unknown id throws by name rather than falling back: a person who picked a brain and silently
   * got another one has been lied to, and that is the failure the fleet's borrowed-model guard in
   * the engine exists to prevent (agent-manager.ts, `borrowedModelBlocked`).
   */
  async pick(spec?: string): Promise<RoutedModel> {
    if (!spec || spec === "auto") return { provider: await this.firstReady() };
    const slash = spec.indexOf("/");
    const id = slash === -1 ? spec : spec.slice(0, slash);
    const model = slash === -1 ? undefined : spec.slice(slash + 1);
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) {
      throw new Error(`no model provider "${id}" — this runtime has: ${this.ids().join(", ")}`);
    }
    return { provider, model };
  }

  private async firstReady(): Promise<ModelProvider> {
    for (const provider of this.providers) {
      try {
        if ((await provider.readiness()).ready) return provider;
      } catch {
        /* a provider that cannot even answer readiness is not ready */
      }
    }
    // Nothing is ready — hand back the first anyway so the failure comes from the provider, with its
    // own words about what is missing (a key, a download, the network), rather than from here.
    return this.providers[0];
  }
}
