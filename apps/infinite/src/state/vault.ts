/**
 * The vault's UI state — §4.5's promises, kept where the screen can see them.
 *
 * The crypto is `createVault` in @00/agent-runtime and the WebAuthn ceremony is `lib/webauthn-prf.ts`.
 * What is here is the part the person experiences: locked on every entry, `Lock now` always one click
 * away, and the idle lock SURFACED rather than sprung — the package locks on access after 30 minutes
 * whether or not anyone is watching, so the shell watches the same clock and says so first.
 */
import { computed, ref } from "vue";
import {
  IDLE_LOCK_MS,
  emptyVaultState,
  idleLine,
  kindLabel,
  shouldLock,
  travelNote,
  unlockPrompt,
  type VaultKind,
  type VaultState,
} from "../lib/vault-policy.js";
import { agent } from "./agent.js";

const state = ref<VaultState>(emptyVaultState());
const names = ref<string[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
const now = ref(0);
let ticker: ReturnType<typeof setInterval> | null = null;

export const vaultState = computed(() => state.value);
export const secretNames = computed(() => names.value);
export const vaultError = computed(() => error.value);
export const vaultBusy = computed(() => busy.value);
export const vaultKindLabel = computed(() => kindLabel(state.value.kind));
export const vaultUnlockPrompt = computed(() => unlockPrompt(state.value.kind));
export const vaultTravelNote = computed(() => travelNote(state.value.kind));
export const vaultIdleLine = computed(() => idleLine(state.value, now.value));
/** The shell blocks on this: a vault that exists is asked for on every entry (§4.5). */
export const needsUnlock = computed(() => state.value.exists && !state.value.unlocked);

export async function refreshVault(): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  const kind = await owned.vaultKind();
  const list = await owned.vault.list().catch(() => [] as string[]);
  names.value = list;
  state.value = {
    exists: kind !== null,
    unlocked: owned.vault.unlocked,
    kind,
    lastActivity: state.value.lastActivity,
  };
}

export function touchVault(at = Date.now()): void {
  if (!state.value.unlocked) return;
  state.value = { ...state.value, lastActivity: at };
}

export async function createVaultWith(kind: VaultKind, password?: string): Promise<boolean> {
  const owned = agent.value;
  if (!owned) return false;
  busy.value = true;
  error.value = null;
  try {
    if (kind === "passkey") await owned.createVaultWithPasskey();
    else await owned.createVaultWithPassword(password ?? "");
    // The refresh has to land BEFORE the touch: `touchVault` only counts activity on an unlocked
    // vault, and until the refresh runs this store still believes it is locked — so touching first
    // left `lastActivity` at zero and the idle line said "Locked — idle." the instant it opened.
    await refreshVault();
    touchVault();
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    busy.value = false;
  }
}

export async function unlock(password?: string): Promise<boolean> {
  const owned = agent.value;
  if (!owned) return false;
  busy.value = true;
  error.value = null;
  try {
    const ok = await owned.unlockVault(password);
    if (!ok) error.value = "That did not open it.";
    await refreshVault();
    touchVault();
    return ok;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    busy.value = false;
  }
}

export async function lockNow(): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  owned.vault.lock();
  await owned.refreshBrains();
  await refreshVault();
}

export async function removeSecret(name: string): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  await owned.vault.remove(name);
  await refreshVault();
  await owned.refreshBrains();
}

/**
 * One timer for the countdown line AND the lock itself. The package locks on access; a browser tab
 * that is throttled in the background will not tick, which is exactly why the package does not rely
 * on a timer either. Two independent checks, same 30 minutes.
 */
export function startVaultClock(everyMs = 15_000): () => void {
  now.value = Date.now();
  ticker = setInterval(() => {
    now.value = Date.now();
    if (shouldLock(state.value, now.value, IDLE_LOCK_MS)) void lockNow();
  }, everyMs);
  return () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };
}

export function resetVaultState(): void {
  state.value = emptyVaultState();
  names.value = [];
  error.value = null;
  busy.value = false;
}
