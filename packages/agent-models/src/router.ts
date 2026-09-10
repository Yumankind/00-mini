/**
 * THE ROUTER — three peers behind one door (§6 of docs/HANDOFF-infinite-agent.md).
 *
 * "The agent never knows which answered" is the whole contract, and it has a consequence that shapes
 * this file: the agent also never learns that one refused. A local model that has not finished
 * downloading, a sponsored device that has not been registered, an Overblast wallet that has just
 * run dry — each is a fact about a CONNECTION, not about the turn the person asked for, so the
 * router walks its preference list and the turn happens anyway.
 *
 * WHAT COUNTS AS "TRY THE NEXT ONE", and nothing else does:
 *
 *   · readiness says no — the peer told us before we spent a request;
 *   · `credential` (401/403) — the key, token or device is dead, and no retry fixes that;
 *   · `insufficient_credits` (402) — the purse is empty, and no retry fixes that either.
 *
 * A 429, a 500 and a network drop are NOT switchable: they are this peer being busy or broken, a
 * retry is the right answer, and silently moving a person from the model they chose onto a
 * different one because of a blip is a worse outcome than a visible failure. An abort is never
 * switchable, because the person said stop.
 *
 * `onSwitch` exists so the UI can say WHY the answer came from somewhere else — "your credits ran
 * out, this answer is from the local model" is a sentence a person can act on; a silent downgrade
 * is the thing that makes people distrust a router.
 */

import { isAborted, isSwitchable, ProviderError } from "./errors.js";
import type { ChatChunk, ChatRequest, ChatResponse, ModelProvider } from "./types.js";

export type ModelClass = "small" | "strong";

/** Why the router moved on from a provider. `initial` is the first pick, not a switch. */
export type SwitchReason = "initial" | "readiness" | "credential" | "insufficient_credits";

export interface SwitchEvent {
  cls: ModelClass;
  /** The provider that was skipped, when one was. */
  from?: string;
  /** The provider that answered, or was tried next. */
  to: string;
  reason: SwitchReason;
  /** The provider's own sentence, so the UI need not compose one. */
  detail?: string;
}

export interface ModelRouterOptions {
  providers: ModelProvider[];
  /** Provider ids, best first, per class. An id with no provider behind it is simply skipped. */
  preference: { small: string[]; strong: string[] };
  onSwitch?: (event: SwitchEvent) => void;
}

function noBrain(cls: ModelClass, tried: string[]): ProviderError {
  return new ProviderError({
    status: 0,
    code: "no_brain",
    message: tried.length
      ? `No brain is available for ${cls} work. Tried: ${tried.join(", ")}.`
      : `No brain is configured for ${cls} work.`,
    vendorCode: "no_brain",
  });
}

export class ModelRouter {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly preference: { small: string[]; strong: string[] };
  private readonly onSwitch?: (event: SwitchEvent) => void;

  constructor(options: ModelRouterOptions) {
    for (const provider of options.providers) this.providers.set(provider.id, provider);
    this.preference = options.preference;
    this.onSwitch = options.onSwitch;
  }

  /** The providers named for a class, in order, that this router actually holds. */
  candidates(cls: ModelClass): ModelProvider[] {
    const out: ModelProvider[] = [];
    for (const id of this.preference[cls] ?? []) {
      const provider = this.providers.get(id);
      if (provider) out.push(provider);
    }
    return out;
  }

  private emit(event: SwitchEvent): void {
    // A listener that throws must not take the turn down with it: it is a UI callback.
    try {
      this.onSwitch?.(event);
    } catch {
      /* the UI's problem, not the turn's */
    }
  }

  /**
   * The first ready provider for a class.
   *
   * Readiness is asked for one at a time rather than in parallel: the answers are cheap, and asking
   * the local model whether it is loaded is free while asking a sponsored device store is a read.
   * Walking in order also means the preferred peer is never woken up by a probe it did not need.
   */
  async pick(cls: ModelClass): Promise<ModelProvider> {
    const tried: string[] = [];
    let previous: string | undefined;
    for (const provider of this.candidates(cls)) {
      const readiness = await provider.readiness().catch(() => ({ ready: false as const, reason: "offline" as const }));
      if (readiness.ready) {
        this.emit({ cls, from: previous, to: provider.id, reason: previous ? "readiness" : "initial" });
        return provider;
      }
      tried.push(`${provider.id} (${readiness.reason})`);
      previous = provider.id;
    }
    throw noBrain(cls, tried);
  }

  async chat(req: ChatRequest, cls: ModelClass = "strong"): Promise<ChatResponse> {
    const tried: string[] = [];
    let previous: string | undefined;
    for (const provider of this.candidates(cls)) {
      const readiness = await provider.readiness().catch(() => ({ ready: false as const, reason: "offline" as const }));
      if (!readiness.ready) {
        tried.push(`${provider.id} (${readiness.reason})`);
        previous = provider.id;
        continue;
      }
      this.emit({ cls, from: previous, to: provider.id, reason: previous ? "readiness" : "initial" });
      try {
        return await provider.chat(req);
      } catch (err) {
        if (isAborted(err) || !isSwitchable(err)) throw err;
        tried.push(`${provider.id} (${err.code})`);
        previous = provider.id;
        this.emit({ cls, from: provider.id, to: "", reason: err.code, detail: err.message });
      }
    }
    throw noBrain(cls, tried);
  }

  /**
   * The streaming twin, with one rule the non-streaming path does not need: a peer may only be
   * abandoned BEFORE it has emitted anything. Half an answer from one model followed by a whole
   * answer from another is not a fallback, it is a corrupted turn — so once a chunk is out, an
   * error propagates.
   */
  async *stream(req: ChatRequest, cls: ModelClass = "strong"): AsyncIterable<ChatChunk> {
    const tried: string[] = [];
    let previous: string | undefined;
    for (const provider of this.candidates(cls)) {
      const readiness = await provider.readiness().catch(() => ({ ready: false as const, reason: "offline" as const }));
      if (!readiness.ready) {
        tried.push(`${provider.id} (${readiness.reason})`);
        previous = provider.id;
        continue;
      }
      this.emit({ cls, from: previous, to: provider.id, reason: previous ? "readiness" : "initial" });
      let emitted = false;
      try {
        for await (const chunk of provider.stream(req)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (emitted || isAborted(err) || !isSwitchable(err)) throw err;
        tried.push(`${provider.id} (${err.code})`);
        previous = provider.id;
        this.emit({ cls, from: provider.id, to: "", reason: err.code, detail: err.message });
      }
    }
    throw noBrain(cls, tried);
  }
}
