/**
 * WHERE A MODEL MAY BE OFFERED — one vocabulary for the Mac engine and for the browser runtime.
 *
 * Bruno's ask, 2026-09-11: "gate the models to the compatible harness". A model row is a row in
 * several different pickers — the browser agent's local-brain list on a laptop and on a phone, the
 * Mac app's model table, a headless install's — and until now each of those guessed from a number
 * (VRAM, download size) whether the row belonged to it. A guess about a 3.4 GB ONNX bundle on a
 * phone is a guess that ends in a tab being killed, so the ROW says which harnesses it may appear
 * in and the picker filters on that and nothing else.
 *
 *   · `browser-desktop` — a tab on a computer: WebGPU, gigabytes of Cache Storage, a wide screen.
 *   · `browser-phone`   — a tab on a phone: a few hundred megabytes of GPU and no room for a wall
 *                         of rows. §12.6 of docs/HANDOFF-infinite-agent.md is this host.
 *   · `mac`             — the 00 Mac app and the engine it runs (Ollama, LM Studio, cloud keys).
 *   · `headless`        — the same engine with no app around it (00d on a server).
 *
 * TWO THINGS IT IS NOT. It is not readiness: a row offered on `browser-desktop` may still need two
 * gigabytes downloading, and `readiness()` on the provider stays the only truth about that. And it
 * is not a capability list: `vision`, `contextTokens` and `supportsTools` still say what a model can
 * DO — `hosts` says only where it may be SHOWN.
 *
 * A row with no `hosts` at all means "wherever the reader already thought", and each reader spells
 * its own default out loud: the browser picker treats an absent list as `browser-desktop` only (the
 * conservative reading — a row nobody has classified must not reach a phone), and the Mac engine
 * ignores absence entirely, because every model in its own catalogue runs there by construction.
 */
export type Host = "browser-desktop" | "browser-phone" | "mac" | "headless";

/** Every harness, in the order a document lists them. The validator for a `hosts` array off the wire. */
export const HOSTS: readonly Host[] = ["browser-desktop", "browser-phone", "mac", "headless"];

/** Is this one of the four? For parsing a `hosts` array out of JSON somebody else wrote. */
export function isHost(value: unknown): value is Host {
  return typeof value === "string" && (HOSTS as readonly string[]).includes(value);
}

/** Providers whose model runs ON this machine. Mirrors LOCAL_PROVIDER_DEFS in the engine's
 *  local-providers.ts — agents on these are the ones a meeting can take memory away from. */
export const LOCAL_LLM_PROVIDER_IDS = ["ollama", "lmstudio", "jan"] as const;

export function isLocalLlmProvider(provider: string | undefined): boolean {
  return !!provider && (LOCAL_LLM_PROVIDER_IDS as readonly string[]).includes(provider.toLowerCase());
}

/**
 * Providers whose models are served by a daemon ON THE OPERATOR'S MACHINE.
 *
 * Lives here (rather than beside the detection code in the engine) because two very different callers
 * need the same answer: the engine's local-LLM concurrency gate, and the UI/flip's cloud-eligibility
 * check — a public agent running on Ollama cannot be followed into the cloud, because the cloud cannot
 * reach the machine the model is on.
 */
/**
 * What one machine is serving locally (Ollama / LM Studio / Jan), as reported by that machine.
 *
 * A machine only ever answers for itself: the fleet exists on the hub, and a server does not know
 * there is one. `port` is where the provider answered on THAT machine's loopback — the hub forwards
 * to it — and `models` are the ones already pulled there. Nothing here installs anything: borrowing
 * a machine means using what is on it.
 */
export interface LocalProviderInventory {
  id: string;
  label: string;
  port: number;
  models: string[];
  /** The provider answered on that machine's loopback, so a port forward can reach it. */
  loopback: boolean;
}

/** One media model a machine already has installed and can run. Deliberately thin: this is a lending
 *  list, not a store. Nothing in the fleet can install a model on another machine, so the fields that
 *  drive an install (size, license, gating) are none of the borrower's business. */
export interface BorrowableMediaModel {
  id: string;
  label: string;
  kinds: string[];
  /**
   * The far model's own input->output modes ("text→image", "image→video"). Carried rather than
   * inferred from `kinds`: whether a model takes a reference image is the difference between an edit
   * that works and one that fails on the far machine after the borrower already committed to it.
   */
  modes?: string[];
}

/** A machine in the fleet whose local models this hub can borrow, and whether it is answering now. */
export interface BorrowableMachine {
  /** Peer id — the hub's name for the machine. */
  id: string;
  name: string;
  host?: string;
  online: boolean;
  /** Why its models can't be used right now (offline, tunnel down) — absent when they can. */
  reason?: string;
  providers: LocalProviderInventory[];
  /** Media models installed AND runnable there — the ones this hub could ask it to generate with. */
  media: BorrowableMediaModel[];
  /** What that machine is, as it describes itself: its chip (or GPU), memory and free disk. Read from
   *  the machine rather than guessed here, because "16 GB" means different things on different silicon. */
  resources?: { chip: string; ramGB: number; freeDiskGB: number };
  /** Agents that live on that machine, so the list can offer to open one rather than describing it. */
  agents?: { id: string; name: string }[];
  /**
   * That machine is set up to LEND ONLY: it holds no agents and refuses to be given any.
   *
   * Its own statement about itself, read from the machine on every borrow refresh — never inferred
   * from an empty `agents` list, which is the different (and temporary) condition of a machine that
   * simply hasn't got round to it. The hub is meant to ACT on this, not only label it: offering to
   * create an agent on a pure lender is an offer that ends in a refusal, and the machines rented per
   * batch of media work and destroyed when idle will all be this kind.
   */
  resourcesOnly?: boolean;
  /** Dependency problems that machine is currently reporting (missing key, logged-out CLI, ...). */
  problems?: number;
  /** When this was last successfully read, so a machine that has gone quiet still lists what it had. */
  seenAt?: string;
}

export const LOCAL_PROVIDER_IDS: readonly string[] = ["ollama", "lmstudio", "jan"];

const LOCAL_PROVIDER_SET = new Set(LOCAL_PROVIDER_IDS);

/** Whether a provider id is a local-daemon provider (see `LOCAL_PROVIDER_IDS`). */
export function isLocalProviderId(provider: string | undefined): boolean {
  return !!provider && LOCAL_PROVIDER_SET.has(provider);
}

// --- Providers & models (for the New Agent wizard) ---

export interface AvailableModelsResponse {
  /** Providers that currently have a key, with their usable model ids. */
  providers: { id: string; models: string[] }[];
}

/** One row in the model explorer: everything needed to compare models side by side. */
export interface ExploreModel {
  /** `provider/id`, unique across the list. */
  key: string;
  provider: string;
  providerLabel: string;
  /**
   * The SUPPLIER, with 00's `-frontier` plumbing suffix stripped (see frontier-models.ts). Group and
   * filter by this, never by `provider`: `anthropic` and `anthropic-frontier` are one company, and only
   * exist as two registry entries because pi replaces a provider's model list when models are supplied.
   */
  supplier?: string;
  id: string;
  name: string;
  /** USD per million tokens. Absent when the provider does not publish a price (local models). */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** Input modalities the model accepts, e.g. ["text", "image"]. */
  input?: string[];
  /** Runs on this machine (Ollama/LM Studio/Jan) rather than behind an API key. */
  local?: boolean;
  /**
   * Set when the model runs on ANOTHER machine in the fleet — a server whose Ollama this hub borrows.
   * It is local in every way that matters (free, offline, no key) except the one that decides whether
   * it works right now, so the machine travels with the model rather than being inferred from a label.
   */
  machine?: { id: string; name: string; online: boolean; reason?: string };
  /** Usable right now — the provider has a key, or the local runtime is up. */
  ready?: boolean;
  /** Secret name that unlocks this model's provider, when it is a cloud provider. */
  keyName?: string;
  /**
   * 00 knows how to turn this model on — a local runtime, or a cloud provider whose key name we
   * hold. False for the ~20 providers pi lists that 00 has no onboarding for (Bedrock, Cloudflare,
   * GitHub Copilot…): still worth showing for price comparison, but there is no button that works.
   */
  unlockable?: boolean;

  // ── facts from the published model catalog (catalogs/llm-models.json) ──
  /** ISO launch date. */
  released?: string;
  /** ISO date its training data ends — how current its world knowledge is. */
  knowledgeCutoff?: string;
  /** ISO date the provider retires it. Rare, and decisive when present. */
  retiresAt?: string;
  /** Weights are downloadable, so the model can outlive the provider serving it. */
  openWeights?: boolean;
  /** The Hugging Face repo holding the weights ("org/model") — links out from the table. */
  openWeightsRepo?: string;
  /**
   * Where this model came from — the one outbound link on the row.
   *
   * A cloud model is otherwise a dead end: forty rows of price and context with no way to reach the
   * model card, the pricing page or the docs. Resolved server-side (see `modelPageFor` in server.ts)
   * so the UI never guesses a URL, and absent when nothing trustworthy points anywhere.
   *
   * NOT the destination for an open-weights model — `openWeightsRepo` wins there; see the UI.
   */
  modelPage?: string;
  /** True when `modelPage` is only the vendor's model LIST, not this model's own page. */
  modelPageIsVendor?: boolean;
  /** Supports tool/function calling — the line between an agent and a chatbot. */
  tools?: boolean;
  /** Reasoning-effort levels it accepts, when it is a reasoning model. */
  reasoningEfforts?: string[];
  /** Reasoning can't be switched off (it always thinks, and you always pay for it). */
  reasoningMandatory?: boolean;
  /** One-line description from the provider. */
  blurb?: string;
  /**
   * 00's editorial recommendation, from the signed model catalog — the model a picker preselects for
   * somebody who has not chosen one. Data, not code: republishing the catalog moves it (see
   * `resolveRecommendedModel`), so a UI must read this rather than hard-coding an id.
   */
  recommended?: boolean;

  /**
   * Where the model sits relative to the others.
   *
   * `source: "measured"` = Epoch AI's Capabilities Index, a real evaluation (`eci` carries the number).
   * `source: "estimated"` = 00's heuristic over published metadata, for the models Epoch doesn't cover.
   * The UI MUST distinguish them — presenting a guess with a measurement's authority is the one thing
   * this must not do. `score` is a 0–100 sort key spanning both.
   */
  tier?: { score: number; id: string; label: string; blurb: string; source: "measured" | "estimated"; eci?: number };
  /** GPQA Diamond, % — graduate-level science reasoning (Epoch AI). */
  gpqa?: number;
  /** SWE-bench Verified, % — real GitHub issues resolved; the closest thing to an agentic score (Epoch AI). */
  sweBench?: number;
}

/** Credit for measured capability scores. CC BY 4.0 requires it wherever the numbers are shown. */
export interface BenchAttribution {
  text: string;
  url: string;
  licenseUrl: string;
}

/** Counts for one model category, for the summary cards that open the models modal on the right tab. */
export interface ModelCategoryCount {
  /** Usable right now — a key is stored, or it's installed/running here. */
  ready: number;
  /** Everything the catalog knows about. */
  total: number;
  /** How many have a route to being turned on (a key we know how to ask for, or a local install). */
  installable: number;
}

export interface ModelsSummaryResponse {
  /** Keyed `brain`, matching the app's user-facing word for an agent's model (see ModulesPanel). */
  brain: ModelCategoryCount;
  speech: ModelCategoryCount;
  media: ModelCategoryCount;
}

export interface ExploreModelsResponse {
  models: ExploreModel[];
  /** Providers with no key yet, so the UI can offer to add one. */
  lockedProviders: ProviderCatalogEntry[];
  /** Credit for the measured scores — rendered by the UI to satisfy CC BY 4.0. */
  benchAttribution?: BenchAttribution;
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  keyName: string;
  hasKey: boolean;
  /** Local provider (e.g. Ollama) — unlocked by running it, not by adding a key. */
  local?: boolean;
}

export interface ProviderCatalogResponse {
  providers: ProviderCatalogEntry[];
}

/** A custom OpenAI-compatible provider (endpoint + key + model list), as pi's models.json holds it.
 *  `hasKey` and never the key: a provider list is drawn on every settings screen. */
export interface CustomProviderView {
  id: string;
  label: string;
  baseUrl: string;
  api: string;
  models: string[];
  hasKey: boolean;
}
