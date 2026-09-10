/**
 * THE ONE PLACE THE PACKAGES ARE CONSTRUCTED.
 *
 * `@00/agent-fs`, `@00/agent-models` and `@00/agent-runtime` are written in parallel with this app,
 * against the three frozen contracts (`agent-fs/src/types.ts`, `agent-models/src/types.ts`,
 * `agent-runtime/src/api.ts`). Every `new` of a package lives HERE, so the wiring is one file to
 * rewire rather than a hunt through components, and the rest of `src/` knows only the contracts.
 *
 * WHAT IS REAL (re-checked against each package's `index.ts` on 2026-09-10, at the end of this work):
 *   `@00/agent-fs`      OpfsFs, MemoryFs, scaffoldAgent, exportBundle, importBundleInto
 *   `@00/agent-models`  WebLLMProvider, sponsoredProvider, overblastProvider, byokProvider,
 *                       registerDevice, IndexedDbDeviceKeyStore
 *   `@00/agent-runtime` createAgentRuntime, fullTools, createVault
 * Nothing in this app is stubbed any more; `agent.stubs` stays, empty, because the Settings pane
 * prints it and a screen that can say "everything here is real" should be able to say so from the
 * same source that would have said otherwise. It fills up again the moment a capability another
 * builder owns is not there yet — see the wiring block in `createOwnedAgent` (git ops, the workspace
 * index, the WASM shell, the network policy), which is written now and comes alive on its own.
 *
 * THE FAÇADE IS GONE (contract revision 2026-09-10). `createAgentRuntime` used to take its providers
 * at construction, so switching brains mid-session (§4.1's proof) meant rebuilding the runtime under
 * a wrapper that kept the listeners alive. `AgentRuntime.setProviders` now does it in the package,
 * where the rule about WHEN a swap bites (at the next run, never mid-turn) can be stated once and
 * tested. This file just calls it.
 */
import type { AgentFs, FsStat } from "@00/agent-fs";
// Namespace imports beside the named ones, and only for the capabilities the parallel builders own:
// `typeof ns.thing === "function"` is a question a missing export can answer, where an import of it
// is a build failure. See the wiring block in `createOwnedAgent`.
import * as agentFsExports from "@00/agent-fs";
import * as agentRuntimeExports from "@00/agent-runtime";
// `src/power/` is another agent's folder and landed while this wiring was being written; the rest of
// the app imports it statically (PreviewPane, state/terminal), so this file does too — a lazy glob
// bought nothing once the module existed and cost a chunking warning on every build. The GUARD stays
// where it matters: which door that module offers is still asked, never assumed.
import * as powerExports from "../power/index.js";
import {
  MemoryFs,
  OpfsFs,
  exportBundle,
  fullModeInclude,
  ignoreMatcherFor,
  importBundleInto,
  scaffoldAgent,
} from "@00/agent-fs";
import type {
  AgentRuntime,
  GitOps,
  PermissionDecision,
  NetworkPolicy,
  PermissionTier,
  SecretsAccess,
  Shell,
  Tool,
  Vault,
  WorkspaceIndex,
} from "@00/agent-runtime";
import { DEFAULT_WORKSPACE, createAgentRuntime, createVault, fullTools } from "@00/agent-runtime";
import type { ModelInfo, ModelProvider } from "@00/agent-models";
import {
  BYOK_BASE_URLS,
  IndexedDbDeviceKeyStore,
  LiteRtProvider,
  WEBLLM_DEFAULT_MODEL_ID,
  WebLLMProvider,
  byokProvider,
  localProviders,
  mergeMirrorCatalog,
  overblastProvider,
  registerDevice,
  sponsoredProvider,
  type ByokVendor,
  type LiteRtCatalogRow,
  type PromptFamily,
} from "@00/agent-models";
import type { StepId, StepState } from "../lib/boot-steps.js";
import { AGENT_ID_KEY, CREDENTIAL_KEY, SETTINGS_KEY, kvGet, kvSet } from "../lib/kv.js";
import type { BrainId } from "../lib/brains.js";
import { byokSecretName } from "../lib/brains.js";
import { newAgentId } from "../lib/id.js";
import { isPhone, loadLiteRtCatalog, phoneRow, type CatalogResult } from "../lib/litert-catalog.js";
import type { Readiness } from "../lib/readiness.js";
import { VAULT_FILE, includeForExport, type VaultKind } from "../lib/vault-policy.js";
import { createPrfCredential, getPrfSecret, webauthnAvailable } from "../lib/webauthn-prf.js";

/** Where the LiteRT Gemma weights are served from unless the environment says otherwise (§12.7). */
export const DEFAULT_LITERT_MODEL_BASE = "https://dl.0-0.chat/litert";

// ── Shapes this app needs on top of the contracts ─────────────────────────────────────────────────

/** The subset of the engine's `AgentProfile` a browser-scaffolded agent is sure to carry. */
export interface OwnedProfile {
  id: string;
  displayName: string;
  emoji: string;
  createdAt: string;
}

export interface ProviderHandle {
  /** The contract's provider id: `local`, `sponsored`, `overblast`, `byok:<vendor>`. */
  id: string;
  peer: BrainId;
  provider: ModelProvider | null;
  readiness: Readiness;
}

/**
 * WHICH LOCAL MODEL, remembered. Everything a `LiteRtProvider` needs to be rebuilt after a reload is
 * here — including the host, because the mirror's catalogue names its own `base` and a person who
 * downloaded two gigabytes from it must not have that thrown away by an environment variable change.
 * The label is carried only so a screen can name the choice before the catalogue has loaded.
 */
export interface LocalModelChoice {
  id: string;
  assetFile: string;
  base: string;
  family?: PromptFamily;
  label?: string;
}

export interface ConnectionSettings {
  /** A provider id, or `auto` to let the first ready peer answer. */
  selected: string;
  /** The row the LiteRT half of the local pair is pointed at (§12.7's picker). */
  localModel?: LocalModelChoice;
  sponsored?: { appId: string; deviceId?: string };
  overblast?: { baseUrl: string; model: string };
  byok?: { vendor: ByokVendor; baseUrl?: string; model: string };
  /** §4.6's network policy, as the person's list of hosts a tool may reach. Empty = nothing. */
  network?: { allow: string[] };
}

/**
 * Call a factory a package may or may not export yet, or answer `null`.
 *
 * A CLASS AND A FACTORY ARE BOTH `typeof === "function"`, and which of the two a builder chose is not
 * settled — so `new` is tried first and a plain call second. Either throwing means the export is not
 * what this file assumed, and `null` (a named stub, not a crash) is the right answer to that during a
 * boot: the agent opens without the capability rather than not opening.
 */
function callIfExported<T>(mod: Record<string, unknown>, name: string, args: unknown[]): T | null {
  const factory = mod[name];
  if (typeof factory !== "function") return null;
  try {
    return (factory as (...a: unknown[]) => T)(...args);
  } catch {
    // A CLASS throws when called without `new` ("Class constructor X cannot be invoked…"), and which
    // of the two a builder chose is not something this file gets to insist on. A plain call first,
    // because a factory called with `new` silently returns the wrong thing rather than throwing.
    try {
      return new (factory as new (...a: unknown[]) => T)(...args);
    } catch {
      return null;
    }
  }
}

/**
 * The shell the agent's `bash` runs in.
 *
 * `createBrowserShell(fs)` is the door `src/power/index.ts` documents for exactly this call (it hangs
 * git off the shell's `git` subcommand); the bare class is the fallback for the day that factory is
 * renamed, and `null` — `NoShell`, "wakes on your Mac" — is the answer if both are gone.
 */
function loadPowerShell(fs: AgentFs): Shell | null {
  const mod = powerExports as unknown as Record<string, unknown>;
  return callIfExported<Shell>(mod, "createBrowserShell", [fs]) ?? callIfExported<Shell>(mod, "BuiltinShell", [fs]);
}

/**
 * What an export was asked to include beyond the default travel rules — §4.5's tick, and so far only
 * that. An options OBJECT rather than a boolean argument because the next thing anyone chooses here
 * (a work folder, a session cut-off) has to be addable without touching four call sites.
 */
export interface ExportChoices {
  /** The vault rides along. Only ever true for a password-wrapped vault; see lib/vault-policy.ts. */
  carrySecrets?: boolean;
}

export interface CreateOwnedAgentOptions {
  onStep(id: StepId, state: StepState, detail?: string): void;
  askPermission(req: {
    name: string;
    tier: PermissionTier;
    args: Record<string, unknown>;
  }): Promise<PermissionDecision>;
  /** Name and emoji for a first visit; ignored when an agent already lives on this origin. */
  identity?: { displayName: string; emoji: string };
}

export interface OwnedAgent {
  fs: AgentFs;
  profile: OwnedProfile;
  /** Stable across a brain change — see the façade note in the module header. */
  runtime: AgentRuntime;
  vault: Vault;
  /** Fresh readiness for the four peers of §6.1, rebuilt from the current settings and vault. */
  providers(): Promise<ProviderHandle[]>;
  settings(): ConnectionSettings;
  saveSettings(next: ConnectionSettings): Promise<void>;
  /** Re-reads settings and the vault and hands the loop a new provider list. */
  refreshBrains(): Promise<ProviderHandle[]>;
  /** The sponsoredtokens device registration of §6.2 — MUST be called from a click. */
  registerSponsoredDevice(appId: string): Promise<{ deviceId: string }>;
  /** `passkey` here is the plan's word for the package's `prf`. */
  vaultKind(): Promise<VaultKind | null>;
  createVaultWithPassword(password: string): Promise<void>;
  createVaultWithPasskey(): Promise<void>;
  unlockVault(password?: string): Promise<boolean>;
  passkeyPossible(): boolean;
  /**
   * The `.00agent`, with §4.5's tick as its only option (gap audit A2). `carrySecrets` defaults to
   * FALSE everywhere: an export that was not asked for the vault does not take it.
   */
  exportBundleFile(passphrase: string, opts?: ExportChoices): Promise<Blob>;
  /** `vaultTravelled` is what the far side reports back, read off the files actually written. */
  importBundleFile(file: Blob, passphrase: string): Promise<{ agentId: string; vaultTravelled: boolean }>;
  /** Progress of the local model download, 0..100, or null while nothing is downloading. */
  localProgress(): number | null;

  // ── The local brain picker (§12.7), fed by the mirror ──────────────────────────────────────────
  /** What is chosen now, whether this device gets a picker at all, and where the weights come from. */
  localBrain(): { choice: LocalModelChoice | null; picker: boolean; base: string; available: boolean };
  /** The mirror's rows joined to the package's, cached for five minutes. Never called during boot. */
  localCatalog(force?: boolean): Promise<CatalogResult>;
  /** Is THIS row already on the device? A provider built for it, asked; nothing is downloaded. */
  localRowReadiness(row: LiteRtCatalogRow): Promise<Readiness>;
  /** Point the local brain at a row: a new provider, the old one released, the loop told, the choice saved. */
  chooseLocalModel(row: LiteRtCatalogRow, base?: string): Promise<void>;
  /** Give the GPU back (`unload()` on both local providers). The next turn loads again. */
  unloadLocal(): Promise<void>;
  /**
   * §4.1's retrieval with no model at all (gap audit B14). The SAME index the `search_workspace` tool
   * was built with, kept here so a pane that searches without a brain does not build a second one over
   * the same files. `null` only if the package stops exporting `createWorkspaceIndex`.
   */
  workspaceIndex: WorkspaceIndex | null;
  /** True when this very load created the agent — drives the persist call and the install nag (§3.3). */
  freshlyCreated: boolean;
  /** Empty when nothing is standing in for a real implementation. Printed in Settings regardless. */
  stubs: string[];
}

// ── What this origin remembers, beside the agent itself ───────────────────────────────────────────
// Which agent lives here, the connection settings, the passkey credential id. (The vault itself lives
// in the agent folder, where @00/agent-runtime's `createVault` puts it, so it travels with the agent;
// permissions likewise.) The store is `lib/kv.ts` — shared with the move receipt of §7, which has to
// land in the same database or a cleared browser would forget one and not the other.

const DEFAULT_SETTINGS: ConnectionSettings = { selected: "auto" };

// ── Providers: the four peers of §6.1 ─────────────────────────────────────────────────────────────

/**
 * A catalog the person supplies, not one we ship. The house rule is that clients render what the
 * contract sends and never hardcode a list; for a key someone pasted there IS no contract, so the
 * model id is a field on the card, and this turns it into the one-entry catalog a provider wants.
 */
function catalogFor(modelId: string): ModelInfo[] {
  if (!modelId) return [];
  return [{ id: modelId, label: modelId, class: "strong", local: false, supportsTools: true }];
}

async function readinessOf(provider: ModelProvider | null, whenMissing: Readiness): Promise<Readiness> {
  if (!provider) return whenMissing;
  try {
    return await provider.readiness();
  } catch (err) {
    return { ready: false, reason: "credential", detail: err instanceof Error ? err.message : "unavailable" };
  }
}

// ── The one entry point ───────────────────────────────────────────────────────────────────────────

export async function createOwnedAgent(opts: CreateOwnedAgentOptions): Promise<OwnedAgent> {
  const stubs: string[] = [];

  // 1. Shell. Already painted by the time this runs; the step exists so §4.1's timeline is something
  //    a person can watch rather than an assertion in a document.
  opts.onStep("shell", "done", "offline-capable");

  // 2. Workspace: OPFS, then the agent, scaffolded if this origin has none.
  opts.onStep("workspace", "active", "mounting storage");
  let agentId = (await kvGet<string>(AGENT_ID_KEY)) ?? "";
  let freshlyCreated = false;
  let fs: AgentFs;
  let opfs = true;
  try {
    if (!navigator.storage?.getDirectory) throw new Error("no OPFS on this browser");
    if (!agentId) {
      agentId = newAgentId();
      freshlyCreated = true;
    }
    // The DOM lib's `FileSystemDirectoryHandle` is missing `values()`, which the adapter's structural
    // type requires and every browser that has OPFS actually implements. A cast, not a shim.
    fs = await OpfsFs.atAgentRoot(navigator.storage as unknown as Parameters<typeof OpfsFs.atAgentRoot>[0], agentId);
  } catch {
    // A browser with no OPFS still gets a real agent — it just does not survive the tab, and the
    // shell says so rather than refusing to open.
    opfs = false;
    stubs.push("MemoryFs — this browser has no OPFS, so the agent lives only until the tab closes");
    if (!agentId) {
      agentId = newAgentId();
      freshlyCreated = true;
    }
    fs = new MemoryFs();
  }

  let profile: OwnedProfile;
  if (!(await fs.stat("profile.json"))) {
    freshlyCreated = true;
    opts.onStep("workspace", "active", "creating your agent");
    const scaffolded = await scaffoldAgent(fs, {
      id: agentId,
      displayName: opts.identity?.displayName ?? "Zero",
      emoji: opts.identity?.emoji ?? "\u{1F7E2}",
    });
    profile = {
      id: scaffolded.id,
      displayName: scaffolded.displayName,
      emoji: scaffolded.emoji,
      createdAt: scaffolded.createdAt,
    };
  } else {
    const raw = JSON.parse(await fs.readText("profile.json")) as Partial<OwnedProfile>;
    profile = {
      id: raw.id ?? agentId,
      displayName: raw.displayName ?? "Zero",
      emoji: raw.emoji ?? "\u{1F7E2}",
      createdAt: raw.createdAt ?? new Date().toISOString(),
    };
  }
  await kvSet(AGENT_ID_KEY, profile.id);
  opts.onStep(
    "workspace",
    "done",
    opfs ? `${profile.emoji} ${profile.displayName}` : "in memory only — no OPFS here",
  );

  // 3. The vault (§4.5) and the runtime (§2). The vault is read before the loop is built because its
  //    NAMES go into the system prompt, and because a locked vault is what makes three of the four
  //    brains unreachable.
  const vault = createVault(fs);
  let settings: ConnectionSettings = { ...DEFAULT_SETTINGS, ...((await kvGet<ConnectionSettings>(SETTINGS_KEY)) ?? {}) };

  // The local brain is built FIRST, and not only because its readiness is the boot line: the router
  // refuses to exist without a provider (`a runtime needs at least one ModelProvider`), and the one
  // peer that is always constructible is the one that needs nothing. Its own refusal — no WebGPU, not
  // downloaded — is then what a person sees, in the provider's words, instead of a boot failure.
  //
  // TWO LOCAL BRAINS, IN THE ORDER THE 2026-09-10 RULING NAMES (§6.1): LiteRT leads because it is
  // faster and because web-llm errors outright on some Windows machines, and WebLLM stands behind it
  // so a browser LiteRT cannot serve still answers. `localProviders()` is what puts them in that
  // order — the router then walks past a provider whose readiness is `unsupported` on its own.
  //
  // LiteRT is built ONLY when the owner has named a host for the Gemma weights. The package refuses
  // to invent one (their terms travel with whoever serves them) and so does this app: with no
  // `VITE_LITERT_MODEL_BASE` there is one local brain, WebLLM, and nothing anywhere claims otherwise.
  //
  // WHICH GEMMA — the picker of §12.7, and the phone rule of §12.6. A `LiteRtProvider` is fixed to one
  // asset at construction, so choosing a row means BUILDING A NEW ONE and handing the loop the new
  // pair (`setProviders`, which the runtime now takes without a rebuild). The choice is remembered in
  // the settings KV, so a reload does not start a second two-gigabyte download; nothing here fetches
  // the catalogue, because a boot must not wait on the mirror to show a screen.
  let localPct: number | null = null;
  const onLocalProgress = (report: { progress?: number }): void => {
    localPct = Math.round((report.progress ?? 0) * 100);
  };
  const webllm = new WebLLMProvider({ modelId: WEBLLM_DEFAULT_MODEL_ID, onProgress: onLocalProgress });
  // The weights' home was decided on 2026-09-10 (docs/HANDOFF-infinite-agent.md §12.7): the public
  // mirror on dl.0-0.chat, published by scripts/publish-litert-models.sh. An environment can point
  // elsewhere, or say `off` to run WebLLM only — the app then says so on the Connections screen.
  const litertEnv = (import.meta.env?.VITE_LITERT_MODEL_BASE as string | undefined)?.trim();
  const litertBase = litertEnv === "off" ? "" : litertEnv || DEFAULT_LITERT_MODEL_BASE;
  // The runtime's wasm: same-origin by default (the vite build copies it beside the bundle, the
  // service worker keeps it offline). A hosted deploy whose asset layer cannot carry 27 MB files names
  // the R2 copy instead — CORS is open on that bucket for GET (apps/infinite-site/README.md).
  const litertWasm = (import.meta.env?.VITE_LITERT_WASM_BASE as string | undefined)?.trim() || undefined;

  /** A provider for exactly one row. `null` when this deploy serves no weights at all. */
  const makeLiteRt = (choice: LocalModelChoice | null): LiteRtProvider | null => {
    if (!litertBase) return null;
    return new LiteRtProvider({
      modelBaseUrl: choice?.base || litertBase,
      wasmBaseUrl: litertWasm,
      onProgress: onLocalProgress,
      ...(choice ? { modelId: choice.id, assetFile: choice.assetFile, family: choice.family } : {}),
    });
  };

  // §12.6, decided WITHOUT the network: a phone that has never chosen gets the smallest row the
  // package vouches for under the cap (the 270m), never the desktop default, which is 2 GB. The
  // mirror's list refines the label later; it never changes which brain a first visit downloads.
  const phoneDefault = (): LocalModelChoice | null => {
    const row = phoneRow(mergeMirrorCatalog(null));
    return row ? { id: row.id, assetFile: row.assetFile, base: litertBase, family: row.family, label: row.label } : null;
  };
  const onPhone = isPhone();
  let localChoice: LocalModelChoice | null = settings.localModel ?? (onPhone ? phoneDefault() : null);
  let litert = makeLiteRt(localChoice);
  const chain = (): ModelProvider[] => localProviders({ litert: litert ?? undefined, webllm });

  /** What the ONE "Local AI" card shows: the leader, unless this browser cannot run it at all. */
  const preferredLocal = async (): Promise<{ provider: ModelProvider; readiness: Readiness }> => {
    const localChain = chain();
    const first = localChain[0];
    const readiness = await readinessOf(first, { ready: false, reason: "unsupported" });
    const cannotRunHere = !readiness.ready && readiness.reason === "unsupported";
    if (!cannotRunHere || localChain.length === 1) return { provider: first, readiness };
    const second = localChain[1];
    return { provider: second, readiness: await readinessOf(second, { ready: false, reason: "unsupported" }) };
  };
  if (!litert) stubs.push("Local AI is web-llm only — VITE_LITERT_MODEL_BASE is off");
  const deviceStore = new IndexedDbDeviceKeyStore();

  opts.onStep("runtime", "active", "starting");

  // ── WHAT THE OTHER BUILDERS ARE MAKING, WIRED AS SOON AS IT EXISTS ──────────────────────────────
  //
  // Five capabilities were written in parallel with this file (gap audit A5, B7, B8, B12, B14, B17)
  // and this is the one place they are joined to the agent. All five had landed by the end of the day;
  // the two that come from another package are still asked for with `typeof x === "function"` rather
  // than imported by name, because that is what makes this file survive the next rename: an import of
  // an export that is not there does not fail at runtime, it fails the BUILD, and this file is the
  // boot of the whole app. Anything that goes missing is NAMED in `stubs`, which the Settings pane
  // prints — "this agent has no git tools" is a sentence a person can read, an absent tool is a
  // silence, and `test/bootstrap-wiring.test.ts` holds that the list is empty today.
  const fsExports = agentFsExports as unknown as Record<string, unknown>;
  const runtimeExports = agentRuntimeExports as unknown as Record<string, unknown>;

  /** B8: the git tools, over isomorphic-git on this same filesystem. */
  const git = callIfExported<GitOps>(fsExports, "createGitOps", [fs, DEFAULT_WORKSPACE]);
  if (!git) stubs.push("no git tools — @00/agent-fs does not export createGitOps yet (gap audit B8)");

  /**
   * B14 / §4.1's "retrieval works with no model at all". Built HERE and kept on the agent rather than
   * left to `fullTools` to build its own, so the pane that searches without a brain and the
   * `search_workspace` tool walk one index instead of two. It arrived in @00/agent-runtime's
   * retrieval/; @00/agent-fs is asked as well, because which package owns it was not settled.
   */
  const workspaceIndex =
    callIfExported<WorkspaceIndex>(runtimeExports, "createWorkspaceIndex", [fs]) ??
    callIfExported<WorkspaceIndex>(fsExports, "createWorkspaceIndex", [fs]);
  if (!workspaceIndex) stubs.push("no offline retrieval — no package exports createWorkspaceIndex yet (gap audit B14)");

  // A5 / B7: with a real shell, `bash` stops answering 127 on every call while the prompt claims the
  // agent can run commands.
  const shell = loadPowerShell(fs) ?? undefined;
  if (!shell) stubs.push("bash answers 127 — src/power exports no shell yet (gap audit A5, B7)");

  /**
   * B17: hosts a tool may reach without asking. The list is the person's (settings); the enforcement
   * is the package's. An EMPTY list is still a policy — it is what makes `http_get` exist at all, with
   * every host a `confirm` — and it is the only safe default for an agent in someone's browser.
   */
  const network: NetworkPolicy = { allow: settings.network?.allow ?? [] };
  const secretNames = await vault.list().catch(() => [] as string[]);

  /**
   * B12: the vault, reachable from tools at last — as the two-method view the contract asks for
   * (`SecretsAccess`), not as the vault itself. The adapter is the interesting part: a LOCKED vault
   * answers `null` rather than throwing, because "the key is sealed" is an observation a loop can act
   * on and an exception is a run that ends. Names stay readable either way; that is §4.5's whole rule
   * — the agent sees names, values resolve at use.
   */
  const secrets: SecretsAccess = {
    names: () => vault.list().catch(() => [] as string[]),
    get: async (name) => (vault.unlocked ? await vault.get(name).catch(() => null) : null),
  };

  // One options object, one place. `fullTools` grew every one of these fields the same day this
  // wiring did (`index` → search_workspace, `secrets` → list_secrets, `network` → http_get), so what
  // is passed here is exactly what the agent can do.
  const tools: Tool[] = fullTools({
    fs,
    workspace: DEFAULT_WORKSPACE,
    secrets,
    network,
    ...(git ? { git } : {}),
    ...(shell ? { shell } : {}),
    ...(workspaceIndex ? { index: workspaceIndex } : {}),
  });

  const runtime: AgentRuntime = createAgentRuntime({
    fs,
    providers: chain(),
    tools,
    askPermission: opts.askPermission,
    trust: "full",
    origin: typeof location === "undefined" ? "local" : location.origin,
    context: { secretNames },
    // The loop's half of the same two facts: `${secret:NAME}` is resolved (and redacted back out of
    // every output) by the one place that sees every call, and the policy the network tool enforces
    // is the one the runtime was built with.
    secrets,
    network,
  });
  opts.onStep("runtime", "done", `${tools.length} tools`);

  const buildProviders = async (): Promise<ProviderHandle[]> => {
    const out: ProviderHandle[] = [];

    const chosenLocal = await preferredLocal();
    // The card's id stays `local`: it is the PEER of §6.1, and the two implementations behind it are
    // the router's business, not a second row on a settings screen.
    out.push({ id: "local", peer: "local", provider: chosenLocal.provider, readiness: chosenLocal.readiness });

    const appId = settings.sponsored?.appId;
    const sponsored = appId ? sponsoredProvider({ appId, deviceKeyStore: deviceStore, catalog: [] }) : null;
    out.push({
      id: "sponsored",
      peer: "sponsored",
      provider: sponsored,
      readiness: await readinessOf(sponsored, {
        ready: false,
        reason: "credential",
        detail: "needs a passkey account",
      }),
    });

    const unlocked = vault.unlocked;
    const obToken = unlocked ? await vault.get("overblast.deviceToken").catch(() => "") : "";
    const ob = settings.overblast;
    const overblast =
      ob?.baseUrl && obToken
        ? overblastProvider({ baseUrl: ob.baseUrl, token: obToken, catalog: catalogFor(ob.model) })
        : null;
    out.push({
      id: "overblast",
      peer: "overblast",
      provider: overblast,
      readiness: await readinessOf(overblast, {
        ready: false,
        reason: "credential",
        detail: unlocked ? "needs a device token" : "unlock your vault",
      }),
    });

    const byok = settings.byok;
    const byokKey = byok && unlocked ? await vault.get(byokSecretName(byok.vendor)).catch(() => "") : "";
    const byokInstance =
      byok && byokKey
        ? byokProvider({
            vendor: byok.vendor,
            apiKey: byokKey,
            baseUrl: byok.baseUrl || (byok.vendor === "custom" ? "" : BYOK_BASE_URLS[byok.vendor]),
            catalog: catalogFor(byok.model),
          })
        : null;
    out.push({
      id: byok ? `byok:${byok.vendor}` : "byok",
      peer: "byok",
      provider: byokInstance,
      readiness: await readinessOf(byokInstance, {
        ready: false,
        reason: "credential",
        detail: unlocked ? "needs a key" : "unlock your vault",
      }),
    });

    return out;
  };

  /**
   * The router's input list, in the order it should try them.
   *
   * On `auto` that is every peer that EXISTS, ready ones first — the package's router takes the first
   * ready one and, when none is, hands back the first anyway so the refusal comes from the provider
   * with its own words about what is missing. Passing only the ready ones would turn "your key has
   * expired" into a silent switch to another brain, which §6's "the agent never knows which" is not
   * licence for. On a specific choice it is that peer alone, for the same reason.
   *
   * The list is never empty: `local` is always constructible, and a runtime with no provider throws.
   */
  const refreshBrains = async (): Promise<ProviderHandle[]> => {
    const handles = await buildProviders();
    const usable = handles.filter((h) => h.provider);
    const chosen =
      settings.selected === "auto"
        ? [...usable.filter((h) => h.readiness.ready), ...usable.filter((h) => !h.readiness.ready)]
        : usable.filter((h) => h.id === settings.selected || h.peer === settings.selected);
    // The local peer expands back into its ordered pair here: the CARD shows one brain, the router
    // gets both, so a LiteRT that turns out to be unusable mid-session falls through to WebLLM.
    const localChain = chain();
    const providers = chosen.flatMap((h) => (h.peer === "local" ? localChain : h.provider ? [h.provider] : []));
    // `setProviders` rather than a rebuilt runtime (contract revision 2026-09-10): the listeners the
    // panes took at mount survive, and a run in flight finishes on the brain it started with.
    runtime.setProviders(providers.length ? providers : localChain);
    return handles;
  };

  // 5. Local AI's boot line — the readiness of the local provider, verbatim, never a guess.
  opts.onStep("local-ai", "active");
  const localReadiness = (await preferredLocal()).readiness;
  if (localReadiness.ready) opts.onStep("local-ai", "done", "ready");
  else if (localReadiness.reason === "unsupported") opts.onStep("local-ai", "failed", "unsupported here");
  else if (localReadiness.reason === "download") opts.onStep("local-ai", "done", "not downloaded yet");
  else opts.onStep("local-ai", "done", localReadiness.detail ?? "not loaded");

  await refreshBrains();

  return {
    fs,
    profile,
    runtime,
    vault,
    providers: buildProviders,
    refreshBrains,
    settings: () => settings,
    async saveSettings(next) {
      settings = next;
      await kvSet(SETTINGS_KEY, next);
      await refreshBrains();
    },

    async vaultKind() {
      const kind = await vault.kind();
      return kind === "prf" ? "passkey" : kind;
    },
    passkeyPossible: () => webauthnAvailable(),
    async createVaultWithPassword(password) {
      await vault.createWithPassword(password);
      await refreshBrains();
    },
    async createVaultWithPasskey() {
      // The WebAuthn ceremony belongs to the app — the runtime package has no DOM. It hands the
      // vault the 32 bytes and never sees them again.
      const cred = await createPrfCredential(profile.displayName);
      if (!cred) throw new Error("This device's passkey will not hand back a secret. Use a password.");
      const secret = await getPrfSecret(cred.credentialId);
      if (!secret) throw new Error("The passkey did not return its secret. Use a password.");
      await vault.createWithPrf(secret);
      await kvSet(CREDENTIAL_KEY, cred.credentialId);
      await refreshBrains();
    },
    async unlockVault(password) {
      try {
        const kind = await vault.kind();
        if (kind === "prf") {
          const credentialId = await kvGet<string>(CREDENTIAL_KEY);
          if (!credentialId) throw new Error("This browser has forgotten which passkey holds the vault.");
          const secret = await getPrfSecret(credentialId);
          if (!secret) return false;
          await vault.unlockWithPrf(secret);
        } else {
          await vault.unlockWithPassword(password ?? "");
        }
        await refreshBrains();
        return true;
      } catch {
        // A wrong password and a damaged file are indistinguishable under AES-GCM, and both mean the
        // same thing to the person: still locked.
        return false;
      }
    },

    async registerSponsoredDevice(appId) {
      const device = await registerDevice({ appId, store: deviceStore });
      settings = { ...settings, sponsored: { appId, deviceId: device.deviceId } };
      await kvSet(SETTINGS_KEY, settings);
      await refreshBrains();
      return { deviceId: device.deviceId };
    },

    async exportBundleFile(passphrase, choices) {
      // The default rules first (the four classes plus the person's own `.00ignore`), then the one
      // exception this app adds. Building the matcher here rather than inside the predicate keeps the
      // `.00ignore` read to once per export instead of once per path.
      const base = fullModeInclude(await ignoreMatcherFor(fs));
      const include = includeForExport(base, choices?.carrySecrets === true);
      const bytes = await exportBundle(fs, { secret: passphrase, host: "browser", include });
      return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
    },
    async importBundleFile(file, passphrase) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importBundleInto(fs, bytes, { secret: passphrase });
      await kvSet(AGENT_ID_KEY, result.manifest.agentId);
      // Reported from what was WRITTEN, never from what the sender believed it sent: a bundle made
      // before the tick existed, or by an engine, is answered honestly either way.
      return { agentId: result.manifest.agentId, vaultTravelled: result.written.includes(VAULT_FILE) };
    },

    localProgress: () => localPct,

    localBrain: () => ({ choice: localChoice, picker: !onPhone, base: litertBase, available: Boolean(litert) }),
    localCatalog: (force = false) => loadLiteRtCatalog({ modelBaseUrl: litertBase, force }),
    async localRowReadiness(row) {
      // A provider is a small object until something asks it to load — building one per row is how
      // "is it already downloaded" is answered honestly, from the same Cache Storage key the real
      // download would write. Lazily, at the caller's pace: seven of these on one screen is seven
      // cache lookups, not seven requests.
      if (!litertBase) return { ready: false, reason: "unsupported", detail: "no model host is configured" };
      const probe = makeLiteRt({ id: row.id, assetFile: row.assetFile, base: litertBase, family: row.family });
      return readinessOf(probe, { ready: false, reason: "unsupported" });
    },
    async chooseLocalModel(row, base) {
      const next: LocalModelChoice = {
        id: row.id,
        assetFile: row.assetFile,
        base: base || litertBase,
        family: row.family,
        label: row.label,
      };
      // The GPU first: the old model is compiled and holding memory, and the new one is about to ask
      // for the same memory. `unload` is optional on the contract, so it is called as one.
      await litert?.unload?.();
      localChoice = next;
      litert = makeLiteRt(next);
      settings = { ...settings, localModel: next };
      await kvSet(SETTINGS_KEY, settings);
      await refreshBrains();
    },
    async unloadLocal() {
      await Promise.all(chain().map(async (p) => p.unload?.()));
      localPct = null;
    },

    workspaceIndex,
    freshlyCreated,
    stubs,
  };
}

/** Exported for the Files pane, which wants one walk it can fold into a tree in a single pass. */
export async function walkAll(fs: AgentFs, root = "", maxEntries = 5000): Promise<{ path: string; stat: FsStat }[]> {
  const out: { path: string; stat: FsStat }[] = [];
  for await (const entry of fs.walk(root, { maxEntries })) out.push(entry);
  return out;
}
