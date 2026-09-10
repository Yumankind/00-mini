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
 * PICTURES ADD A SECOND RANKING, never a filter (gap B10). When the turn carries images the walk
 * prefers a peer whose catalogue says it can see them, and falls through to one that cannot rather
 * than refusing the turn — the blind peer is told in words that a picture was attached, which is a
 * worse answer than looking at it and a far better one than none. `SwitchEvent.vision` carries what
 * actually happened, so the UI can say it.
 *
 * `onSwitch` exists so the UI can say WHY the answer came from somewhere else — "your credits ran
 * out, this answer is from the local model" is a sentence a person can act on; a silent downgrade
 * is the thing that makes people distrust a router.
 */

import { isAborted, isSwitchable, ProviderError } from "./errors.js";
import { hasImages } from "./image-parts.js";
import type { ChatChunk, ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "./types.js";

export type ModelClass = "small" | "strong";

/**
 * WHAT CLASS A PROVIDER CAN ANSWER IN — one rule, one place (§6, class-aware routing 2026-09-10).
 *
 * `ModelInfo.class` is required, so a catalogue row always says which it is; the only interesting
 * case is a catalogue that is EMPTY or a `models()` that throws, and the honest answer there is
 * `strong`. An empty catalogue is not "I have nothing", it is "nobody listed me": `byokProvider()`
 * takes `catalog?` and defaults it to `[]`, and Overblast's rows only arrive with the mint call, so
 * the providers most likely to answer with an empty list are exactly the cloud brains — and a cloud
 * brain is the strong one. Guessing `small` there would route planning to a frontier model and then
 * refuse to admit it; guessing `strong` names the peer for what it is.
 *
 * A provider whose `models()` throws is treated the same way rather than being dropped: readiness is
 * the door, and a catalogue read is not allowed to become a second, quieter one.
 */
export async function providerClasses(provider: ModelProvider): Promise<Set<ModelClass>> {
  let rows: ModelInfo[];
  try {
    rows = await provider.models();
  } catch {
    return new Set<ModelClass>(["strong"]);
  }
  const out = new Set<ModelClass>();
  for (const row of rows) out.add(row.class);
  return out.size ? out : new Set<ModelClass>(["strong"]);
}

/** The class a provider will actually be answering in when it was asked for `wanted`. */
export function classActuallyUsed(offered: ReadonlySet<ModelClass>, wanted: ModelClass): ModelClass {
  if (offered.has(wanted)) return wanted;
  const other: ModelClass = wanted === "strong" ? "small" : "strong";
  return offered.has(other) ? other : wanted;
}

/**
 * CAN THIS PROVIDER SEE — the vision twin of `providerClasses`, with the OPPOSITE default.
 *
 * An empty or unreadable catalogue means `strong` for the class question, because a peer nobody
 * listed is almost always a cloud brain. It means NO for this one, because the two guesses fail in
 * opposite ways: guessing `strong` costs a slightly better answer than asked for, while guessing
 * "it can see" puts five megabytes of base64 on a wire that answers 400, in the middle of the turn,
 * with a message about a field the person has never heard of. Not seeing is recoverable and it is
 * announced (image-parts.ts rule 3); a failed turn is not.
 */
export async function providerVision(provider: ModelProvider): Promise<boolean> {
  let rows: ModelInfo[];
  try {
    rows = await provider.models();
  } catch {
    return false;
  }
  return rows.some((row) => row.vision === true);
}

/**
 * What happened to the pictures — the fact `classActuallyUsed` is for the class, in the shape
 * `model_started`'s consumer needs (gap B10).
 *
 * It is a separate function rather than a wider return from `classActuallyUsed` because that one is
 * called by `@00/agent-runtime` today and its answer is a `ModelClass`; a twin keeps both additive.
 * `dropped` is the field a UI acts on: it is the moment to say "this brain cannot see, so the
 * picture was described instead of shown".
 */
export interface VisionFact {
  /** The request carried at least one picture. */
  needed: boolean;
  /** The provider that answered can take one. */
  seen: boolean;
  /** There was a picture and the brain that answered could not see it. */
  dropped: boolean;
}

export function visionActuallyUsed(offersVision: boolean, needsVision: boolean): VisionFact {
  return { needed: needsVision, seen: needsVision && offersVision, dropped: needsVision && !offersVision };
}

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
  /**
   * What became of the pictures, when the turn carried any (2026-09-10, gap B10). ADDITIVE and
   * absent for a turn with no images at all, so a listener written before this field still reads
   * every event it used to.
   */
  vision?: VisionFact;
}

export interface ModelRouterOptions {
  providers: ModelProvider[];
  /**
   * Provider ids, best first, per class. An id with no provider behind it is simply skipped.
   *
   * OPTIONAL since the class-aware round of 2026-09-10. Leave it out and **the order of `providers`
   * IS the preference**, for both classes — which is the shape the PWA already speaks: it calls
   * `setProviders([litert, webllm])` and means "in that order". In that mode the router does not
   * throw a provider away for being the wrong class, it RANKS: the ones whose catalogue offers the
   * asked class come first, in the caller's order, and the ones that do not follow behind them. So a
   * setup where nothing offers `strong` still answers from the small brain, and a single-provider
   * setup behaves exactly as it did before this field existed.
   */
  preference?: { small: string[]; strong: string[] };
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
  private readonly preference?: { small: string[]; strong: string[] };
  private readonly onSwitch?: (event: SwitchEvent) => void;
  /** One catalogue read per provider per router. A router is built per run, so this stays fresh. */
  private readonly classCache = new Map<string, Promise<Set<ModelClass>>>();
  private readonly visionCache = new Map<string, Promise<boolean>>();

  constructor(options: ModelRouterOptions) {
    for (const provider of options.providers) this.providers.set(provider.id, provider);
    this.preference = options.preference;
    this.onSwitch = options.onSwitch;
  }

  /** What this provider can answer in, asked once. */
  classesOf(provider: ModelProvider): Promise<Set<ModelClass>> {
    let pending = this.classCache.get(provider.id);
    if (!pending) {
      pending = providerClasses(provider);
      this.classCache.set(provider.id, pending);
    }
    return pending;
  }

  /** Whether this provider can be shown a picture, asked once. */
  visionOf(provider: ModelProvider): Promise<boolean> {
    let pending = this.visionCache.get(provider.id);
    if (!pending) {
      pending = providerVision(provider);
      this.visionCache.set(provider.id, pending);
    }
    return pending;
  }

  /**
   * Give the machine back what every provider behind this router is holding (contract revision
   * 2026-09-10, §6 finding 4).
   *
   * Two decisions in five lines. It walks EVERY provider the router holds rather than only the ones
   * in the preference lists, because a provider that is no longer preferred is exactly the one still
   * sitting on a gigabyte of GPU memory. And a provider that throws on the way out does not stop the
   * others being released: unloading is cleanup, and cleanup that gives up half way is worse than
   * cleanup that is noisy.
   */
  async unloadAll(): Promise<void> {
    await Promise.all([...this.providers.values()].map(async (p) => p.unload?.().catch(() => undefined)));
  }

  /**
   * The providers named for a class, in order, that this router actually holds.
   *
   * With no preference list the answer is every provider in the caller's order — the class ranking
   * of `ordered()` needs a catalogue read and this stays synchronous, because it is what a caller
   * asks to find out WHO is behind this router, not who will answer next.
   */
  candidates(cls: ModelClass): ModelProvider[] {
    if (!this.preference) return [...this.providers.values()];
    const out: ModelProvider[] = [];
    for (const id of this.preference[cls] ?? []) {
      const provider = this.providers.get(id);
      if (provider) out.push(provider);
    }
    return out;
  }

  /**
   * The walk order for one class, and for a turn that may be carrying pictures.
   *
   * An explicit preference list is TRUSTED as written FOR THE CLASS: the caller already said which
   * peers serve which class, and second-guessing that against a catalogue would make a deliberate
   * list silently wrong. Without one, the caller's provider order is ranked by class — offers-it
   * first, the rest behind — so nothing is ever removed and the fallback needs no separate branch.
   *
   * VISION RANKS IN BOTH MODES, and after the class ranking, so it is the tie-break rather than the
   * rule: a preference list says which peers serve which CLASS, and it cannot say which of them was
   * meant to be shown a photograph, because the person only just attached one. The partition is
   * stable, so a list where every peer sees (or none does) is walked in exactly the order it was
   * given, and nothing is ever dropped for being blind — a described picture beats no answer, which
   * is what the note in image-parts.ts exists to make survivable.
   */
  private async ordered(cls: ModelClass, needsVision = false): Promise<ModelProvider[]> {
    const all = this.candidates(cls);
    let ranked = all;
    if (!this.preference) {
      const offers: ModelProvider[] = [];
      const rest: ModelProvider[] = [];
      for (const provider of all) ((await this.classesOf(provider)).has(cls) ? offers : rest).push(provider);
      ranked = [...offers, ...rest];
    }
    if (!needsVision) return ranked;
    const sighted: ModelProvider[] = [];
    const blind: ModelProvider[] = [];
    for (const provider of ranked) ((await this.visionOf(provider)) ? sighted : blind).push(provider);
    return [...sighted, ...blind];
  }

  /** The event a pick or a switch reports, with the vision fact attached when there was a picture. */
  private async chosen(cls: ModelClass, provider: ModelProvider, from: string | undefined, needsVision: boolean): Promise<void> {
    this.emit({
      cls,
      from,
      to: provider.id,
      reason: from ? "readiness" : "initial",
      ...(needsVision ? { vision: visionActuallyUsed(await this.visionOf(provider), true) } : {}),
    });
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
   * The first ready provider for a class, in the walk order `ordered()` settled.
   *
   * Readiness is asked for one at a time rather than in parallel: the answers are cheap, and asking
   * the local model whether it is loaded is free while asking a sponsored device store is a read.
   * Walking in order also means the preferred peer is never woken up by a probe it did not need.
   */
  async pick(cls: ModelClass, options: { needsVision?: boolean } = {}): Promise<ModelProvider> {
    const needsVision = Boolean(options.needsVision);
    const tried: string[] = [];
    let previous: string | undefined;
    for (const provider of await this.ordered(cls, needsVision)) {
      const readiness = await provider.readiness().catch(() => ({ ready: false as const, reason: "offline" as const }));
      if (readiness.ready) {
        await this.chosen(cls, provider, previous, needsVision);
        return provider;
      }
      tried.push(`${provider.id} (${readiness.reason})`);
      previous = provider.id;
    }
    throw noBrain(cls, tried);
  }

  async chat(req: ChatRequest, cls: ModelClass = "strong"): Promise<ChatResponse> {
    // The request itself says whether this turn needs eyes; no caller has to remember to say so.
    const needsVision = hasImages(req.messages);
    const tried: string[] = [];
    let previous: string | undefined;
    for (const provider of await this.ordered(cls, needsVision)) {
      const readiness = await provider.readiness().catch(() => ({ ready: false as const, reason: "offline" as const }));
      if (!readiness.ready) {
        tried.push(`${provider.id} (${readiness.reason})`);
        previous = provider.id;
        continue;
      }
      await this.chosen(cls, provider, previous, needsVision);
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
    const needsVision = hasImages(req.messages);
    const tried: string[] = [];
    let previous: string | undefined;
    for (const provider of await this.ordered(cls, needsVision)) {
      const readiness = await provider.readiness().catch(() => ({ ready: false as const, reason: "offline" as const }));
      if (!readiness.ready) {
        tried.push(`${provider.id} (${readiness.reason})`);
        previous = provider.id;
        continue;
      }
      await this.chosen(cls, provider, previous, needsVision);
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

// ── The two local brains ────────────────────────────────────────────────────────────────────────

/**
 * A local provider is a `ModelProvider` that can also give the GPU back.
 *
 * `unload` became part of `ModelProvider` itself in the contract revision of 2026-09-10, so this
 * alias no longer ADDS anything — it is kept because it says, at every call site, which providers are
 * the ones that hold a GPU, and because deleting a name the PWA imports buys nothing.
 */
export type LocalProvider = ModelProvider;

/**
 * THE LOCAL PAIR, in preference order: LiteRT first, WebLLM second.
 *
 * The ruling of 2026-09-10 (§6.1): LiteRT is faster and more stable than web-llm's Gemma builds and
 * web-llm errors outright on some Windows machines, so LiteRT leads — but a browser that cannot run
 * it (no WebGPU, no served wasm folder, an asset the owner does not host) must still get an answer,
 * and `readiness()` returning `unsupported` is exactly what makes the router walk on to the next
 * one. Nothing here is special-cased in `ModelRouter`: this helper only puts the two in the order
 * the ruling names, so a caller cannot get it wrong by listing them the other way round.
 *
 * A caller with only one of them passes only one; the order of what is left does not change.
 */
export function localProviders(options: { litert?: LocalProvider; webllm?: LocalProvider }): LocalProvider[] {
  return [options.litert, options.webllm].filter((p): p is LocalProvider => Boolean(p));
}
