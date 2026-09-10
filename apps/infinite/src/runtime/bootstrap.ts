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
 * same source that would have said otherwise.
 *
 * ONE PIECE OF WIRING THAT IS NOT OBVIOUS: `createAgentRuntime` takes its providers at construction,
 * and the person changes brains mid-session (§4.1's "brain switching mid-session" proof). So the app
 * holds a FAÇADE — `runtime` below — whose listeners survive while the inner runtime is rebuilt under
 * it. Components subscribe once, at mount, and never learn that the brain changed.
 */
import type { AgentFs, FsStat } from "@00/agent-fs";
import { MemoryFs, OpfsFs, exportBundle, importBundleInto, scaffoldAgent } from "@00/agent-fs";
import type {
  AgentEvent,
  AgentRuntime,
  ChatMessage as RuntimeChatMessage,
  PermissionDecision,
  PermissionTier,
  RunOptions,
  RunResult,
  Tool,
  Vault,
} from "@00/agent-runtime";
import { createAgentRuntime, createVault, fullTools } from "@00/agent-runtime";
import type { ModelInfo, ModelProvider } from "@00/agent-models";
import {
  BYOK_BASE_URLS,
  IndexedDbDeviceKeyStore,
  LiteRtProvider,
  WEBLLM_DEFAULT_MODEL_ID,
  WebLLMProvider,
  byokProvider,
  localProviders,
  overblastProvider,
  registerDevice,
  sponsoredProvider,
  type ByokVendor,
} from "@00/agent-models";
import type { StepId, StepState } from "../lib/boot-steps.js";
import { AGENT_ID_KEY, CREDENTIAL_KEY, SETTINGS_KEY, kvGet, kvSet } from "../lib/kv.js";
import type { BrainId } from "../lib/brains.js";
import { byokSecretName } from "../lib/brains.js";
import { newAgentId } from "../lib/id.js";
import type { Readiness } from "../lib/readiness.js";
import type { VaultKind } from "../lib/vault-policy.js";
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

export interface ConnectionSettings {
  /** A provider id, or `auto` to let the first ready peer answer. */
  selected: string;
  sponsored?: { appId: string; deviceId?: string };
  overblast?: { baseUrl: string; model: string };
  byok?: { vendor: ByokVendor; baseUrl?: string; model: string };
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
  exportBundleFile(passphrase: string): Promise<Blob>;
  importBundleFile(file: Blob, passphrase: string): Promise<{ agentId: string }>;
  /** Progress of the local model download, 0..100, or null while nothing is downloading. */
  localProgress(): number | null;
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

// ── The façade that lets the brain change mid-session ─────────────────────────────────────────────

interface RuntimeHost extends AgentRuntime {
  /** Swap the inner loop for one built on `providers`, keeping every listener. */
  rebuild(providers: ModelProvider[]): void;
}

function runtimeHost(build: (providers: ModelProvider[]) => AgentRuntime, initial: ModelProvider[]): RuntimeHost {
  const listeners = new Set<(event: AgentEvent) => void>();
  let inner = build(initial);
  let detach = inner.on((event) => {
    for (const l of listeners) l(event);
  });
  return {
    rebuild(providers) {
      detach();
      // A run in flight belongs to the old provider list; letting it finish under a new one would
      // mean a turn half-answered by two brains.
      inner.abort();
      inner = build(providers);
      detach = inner.on((event) => {
        for (const l of listeners) l(event);
      });
    },
    run: (opts: RunOptions): Promise<RunResult> => inner.run(opts),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listSessions: () => inner.listSessions(),
    loadSession: (id: string): Promise<RuntimeChatMessage[]> => inner.loadSession(id),
    abort: () => inner.abort(),
  };
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
  const litert = litertBase
    ? new LiteRtProvider({ modelBaseUrl: litertBase, wasmBaseUrl: litertWasm, onProgress: onLocalProgress })
    : null;
  const localChain = localProviders({ litert: litert ?? undefined, webllm });
  /** What the ONE "Local AI" card shows: the leader, unless this browser cannot run it at all. */
  const preferredLocal = async (): Promise<{ provider: ModelProvider; readiness: Readiness }> => {
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
  const tools: Tool[] = fullTools();
  const secretNames = await vault.list().catch(() => [] as string[]);
  const runtime = runtimeHost(
    (providers) =>
      createAgentRuntime({
        fs,
        providers,
        tools,
        askPermission: opts.askPermission,
        trust: "full",
        origin: typeof location === "undefined" ? "local" : location.origin,
        context: { secretNames },
      }),
    localChain,
  );
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
    const providers = chosen.flatMap((h) => (h.peer === "local" ? localChain : h.provider ? [h.provider] : []));
    runtime.rebuild(providers.length ? providers : localChain);
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

    async exportBundleFile(passphrase) {
      const bytes = await exportBundle(fs, { secret: passphrase, host: "browser" });
      return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
    },
    async importBundleFile(file, passphrase) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importBundleInto(fs, bytes, { secret: passphrase });
      await kvSet(AGENT_ID_KEY, result.manifest.agentId);
      return { agentId: result.manifest.agentId };
    },

    localProgress: () => localPct,
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
