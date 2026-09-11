/**
 * "THIS COMPUTER" — the companion's state, polled like a brain's readiness (§14.4).
 *
 * The card in Connections, the Git pane's remote buttons and the network policy's second road all
 * ask the same question ("is the engine on this machine there, and does it know this browser?"), and
 * they must never answer it differently. So it is asked HERE, on one timer, and everything else
 * reads the refs.
 *
 * THE FIVE STATES ARE NOT A GRADIENT, they are five different sentences:
 *   · `not-a-desktop` — a phone. There is no `00d` to find and the card is not shown at all.
 *   · `idle` — nothing has been asked yet (the boot, before the first probe).
 *   · `unreachable` — asked, and nothing useful answered. `error` carries WHY, and the why decides
 *     what the card offers: install it, run it, or (Safari) a road that does not go through
 *     localhost at all.
 *   · `found` — an engine with the companion routes is there, and it does not know this browser.
 *     The card asks for the six words.
 *   · `paired` — it knows this browser, and `scopes` says what that is worth.
 *
 * WHY IT POLLS, AND ONLY WHILE THE TAB IS VISIBLE. The companion is a process someone starts and
 * stops in a terminal; nothing tells a page that it died. Twenty seconds is the same bargain the
 * brain cards make — cheap enough to be invisible, fast enough that "it is gone" appears before the
 * person has tried to use it twice. A hidden tab polls nothing: a background tab pinging localhost
 * forever is exactly the behaviour that makes someone uninstall a thing.
 *
 * WHAT IS REMEMBERED between reloads is three strings (`base`, `engineFp`, `fingerprint`) and never
 * a secret — the key itself lives in IndexedDB as a non-extractable `CryptoKey` and cannot be read
 * by this module or any other.
 */
import { computed, ref } from "vue";
import { COMPANION_KEY, kvDelete, kvGet, kvSet } from "../lib/kv.js";
import {
  DEFAULT_COMPANION_BASE,
  probeCompanion,
  type CompanionProbe,
  type ProbeEnv,
} from "../companion/probe.js";
import {
  CompanionError,
  fetchUrl,
  gitHttp,
  gitProxyBase,
  me,
  pair,
  revoke,
  type CompanionEnv,
} from "../companion/client.js";
import { forgetCompanionKey } from "../companion/key.js";

export type CompanionStatus = "idle" | "probing" | "found" | "paired" | "unreachable" | "not-a-desktop";

/** What survives a reload. Three strings, no secret. */
export interface CompanionRecord {
  base: string;
  engineFp: string;
  /** THIS browser's fingerprint, as the engine filed it. Shown so two browsers can be told apart. */
  fingerprint: string;
}

const status = ref<CompanionStatus>("idle");
const engineName = ref("");
const engineFp = ref("");
const scopes = ref<string[]>([]);
const problem = ref<string | null>(null);
const base = ref(DEFAULT_COMPANION_BASE);
const deviceFp = ref("");
const busy = ref(false);

export const companionStatus = computed(() => status.value);
export const companionName = computed(() => engineName.value || "This computer");
export const companionScopes = computed(() => scopes.value);
export const companionProblem = computed(() => problem.value);
export const companionBase = computed(() => base.value);
export const companionDeviceFp = computed(() => deviceFp.value);
export const companionBusy = computed(() => busy.value);
export const companionPaired = computed(() => status.value === "paired");
/** The card is not drawn at all on a surface that cannot have an engine. */
export const companionHidden = computed(() => status.value === "not-a-desktop");

/**
 * Everything this store touches that a node test cannot have: the network, the key store, the clock
 * and the media query. One object, replaced wholesale by a test and never read from a component.
 */
export interface CompanionDeps extends CompanionEnv, ProbeEnv {
  /** Is the tab in front? A hidden tab polls nothing. */
  visible?: () => boolean;
}

let deps: CompanionDeps = {};

/**
 * What this session knows about the grant, beside what IndexedDB remembers.
 *
 * The kv store is best-effort by design (`lib/kv.ts`: every failure means "not remembered"), and a
 * browser that refuses to write must not lose a pairing it just made twenty seconds later on the
 * next poll. So the record lives here for the session and in kv for the next one.
 */
let live: CompanionRecord | null = null;

export function configureCompanion(next: CompanionDeps): void {
  deps = next;
}

function visible(): boolean {
  if (deps.visible) return deps.visible();
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/** For tests, and for the "forget everything" path a cleared browser takes. */
export function resetCompanion(): void {
  live = null;
  status.value = "idle";
  engineName.value = "";
  engineFp.value = "";
  scopes.value = [];
  problem.value = null;
  base.value = DEFAULT_COMPANION_BASE;
  deviceFp.value = "";
  busy.value = false;
}

function applyProbe(result: CompanionProbe): void {
  if (result.state === "not-a-desktop") {
    status.value = "not-a-desktop";
    problem.value = null;
    return;
  }
  if (result.state === "unreachable") {
    status.value = "unreachable";
    problem.value = result.reason;
    scopes.value = [];
    return;
  }
  engineName.value = result.name;
  engineFp.value = result.engineFp;
  problem.value = null;
  status.value = "found";
}

/**
 * One round of §14.4's readiness: is it there, and does it still know us?
 *
 * The `me` call is what makes a REVOKED grant visible — the key is still in this browser, the probe
 * still finds the engine, and only the signed call can say that the grant behind it is gone. When it
 * says so the record is dropped, because a card offering "Disconnect" for a grant that does not
 * exist is a lie a person cannot act on.
 */
export async function probeCompanionNow(): Promise<CompanionStatus> {
  const wasPaired = status.value === "paired";
  if (!wasPaired) status.value = "probing";
  const record = live ?? (await kvGet<CompanionRecord>(COMPANION_KEY));
  if (record?.base) base.value = record.base;
  applyProbe(await probeCompanion(base.value, deps));
  if (status.value !== "found") return status.value;
  if (!record || record.engineFp !== engineFp.value) return status.value;
  try {
    const identity = await me(base.value, engineFp.value, deps);
    engineName.value = identity.engineName || engineName.value;
    scopes.value = identity.scopes;
    deviceFp.value = identity.fingerprint;
    status.value = "paired";
  } catch (err) {
    // The engine is there and says this browser is not paired (or not paired any more). Keep the
    // card in `found` so the person can enter a new code, and drop what we remembered.
    if (err instanceof CompanionError) {
      live = null;
      await kvDelete(COMPANION_KEY);
    }
    scopes.value = [];
    deviceFp.value = "";
  }
  return status.value;
}

/** §14.4's poll. Returns the stopper, as every watcher in this app does. */
export function startCompanionWatch(everyMs = 20_000): () => void {
  void probeCompanionNow();
  const timer = setInterval(() => {
    if (!visible()) return;
    void probeCompanionNow();
  }, everyMs);
  return () => clearInterval(timer);
}

/** The six words from the terminal. On success the grant is remembered and the card flips. */
export async function connect(code: string, opts: { name?: string; agentId?: string } = {}): Promise<boolean> {
  if (!engineFp.value) {
    problem.value = "There is no companion to pair with yet.";
    return false;
  }
  busy.value = true;
  problem.value = null;
  try {
    const identity = await pair(
      {
        base: base.value,
        engineFp: engineFp.value,
        code,
        name: opts.name ?? "00 Mini in this browser",
        agentId: opts.agentId ?? "",
      },
      deps,
    );
    scopes.value = identity.scopes;
    deviceFp.value = identity.fingerprint;
    engineName.value = identity.engineName || engineName.value;
    status.value = "paired";
    live = { base: base.value, engineFp: engineFp.value, fingerprint: identity.fingerprint };
    await kvSet(COMPANION_KEY, live);
    return true;
  } catch (err) {
    problem.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    busy.value = false;
  }
}

/**
 * Hand the grant back and forget the key.
 *
 * The local half happens whatever the engine says (see `revoke`): a person who pressed Disconnect
 * has disconnected, and a key this browser has thrown away cannot sign anything even if the engine
 * still lists it.
 */
export async function disconnect(): Promise<void> {
  busy.value = true;
  try {
    const fp = engineFp.value;
    if (fp) {
      await revoke(base.value, fp, deps);
      await forgetCompanionKey(fp, deps);
    }
    live = null;
    await kvDelete(COMPANION_KEY);
    scopes.value = [];
    deviceFp.value = "";
    status.value = fp ? "found" : "idle";
  } finally {
    busy.value = false;
  }
}

// ── What the runtime and the panes read ──────────────────────────────────────────────────────────

/** True when the companion is paired AND that grant carries this scope. */
export function companionHasScope(scope: string): boolean {
  return status.value === "paired" && scopes.value.includes(scope);
}

/**
 * The git road, or `null`. Read at CALL time by the delegating ops in `src/companion/git.ts`, so a
 * companion that appears or goes away mid-session needs nothing rebuilt.
 */
export function companionGitRemote(): { http: ReturnType<typeof gitHttp>; corsProxy: string } | null {
  if (!companionHasScope("git")) return null;
  return { http: gitHttp(base.value, engineFp.value, deps), corsProxy: gitProxyBase(base.value) };
}

/** `NetworkPolicy.proxy`'s answer when the companion can fetch for us, else `null`. */
export async function companionProxyTarget(url: URL): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (!companionHasScope("fetch")) return null;
  return fetchUrl(base.value, engineFp.value, url.href, deps);
}

/** Why a remote git action is not available, or `null` when it is. One sentence, said everywhere. */
export function companionGitBlocked(): string | null {
  if (status.value === "paired") return companionHasScope("git") ? null : "this computer did not grant git.";
  if (status.value === "not-a-desktop") return "Clone, push and pull need a computer running 00.";
  if (status.value === "found") return "Connect this computer in Connections → This computer.";
  return "Connect this computer (Connections → This computer) — nothing leaves this browser until you do.";
}
