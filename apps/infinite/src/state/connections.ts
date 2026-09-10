/**
 * The Connections pane's state — the four peers of §6.1 behind one door.
 *
 * WHY READINESS IS POLLED AND NOT CACHED. `readiness()` is the contract's only honest answer to "can
 * this brain answer right now", and it changes without telling anyone: a download finishes, a token
 * expires, the network drops. Re-asking on an interval while the pane is open is cheap (the contract
 * says it is, and for the local provider it is a WebGPU probe), and it is what makes the boot line and
 * the card agree.
 */
import { computed, ref, shallowRef } from "vue";
import type { ByokVendor } from "@00/agent-models";
import { BRAIN_PEERS, byokProviderId, byokSecretName, type BrainId } from "../lib/brains.js";
import { statusLine, statusTone, type Readiness } from "../lib/readiness.js";
import type { ConnectionSettings, ProviderHandle } from "../runtime/bootstrap.js";
import { agent } from "./agent.js";
import { blockedReason } from "./offline.js";

const handles = shallowRef<ProviderHandle[]>([]);
const busy = ref(false);
const lastError = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

export const brains = computed(() => handles.value);
export const connectionsBusy = computed(() => busy.value);
export const connectionsError = computed(() => lastError.value);

export const selectedBrain = computed<string>(() => agent.value?.settings().selected ?? "auto");
export const settings = computed<ConnectionSettings>(() => agent.value?.settings() ?? { selected: "auto" });

export interface BrainCard {
  peer: (typeof BRAIN_PEERS)[number];
  handle: ProviderHandle | null;
  status: string;
  tone: ReturnType<typeof statusTone>;
  /** Non-null when offline has taken this card away; §4.4's one line of why. */
  unreachable: string | null;
  selected: boolean;
}

const UNKNOWN: Readiness = { ready: false, reason: "credential", detail: "not set up" };

export const cards = computed<BrainCard[]>(() =>
  BRAIN_PEERS.map((peer) => {
    const handle = handles.value.find((h) => h.peer === peer.id) ?? null;
    const readiness = handle?.readiness ?? UNKNOWN;
    const chosen = selectedBrain.value;
    return {
      peer,
      handle,
      status: statusLine(handle?.id ?? peer.id, readiness),
      tone: statusTone(readiness),
      unreachable: peer.remote ? blockedReason(handle?.id ?? peer.id) : null,
      selected: chosen === peer.id || chosen === handle?.id,
    };
  }),
);

export async function refreshBrains(): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  busy.value = true;
  try {
    handles.value = await owned.providers();
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

export function startBrainPolling(everyMs = 5000): () => void {
  void refreshBrains();
  timer = setInterval(() => void refreshBrains(), everyMs);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export async function chooseBrain(id: string): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  await owned.saveSettings({ ...owned.settings(), selected: id });
  handles.value = await owned.refreshBrains();
}

// ── The three cards that ask for something ────────────────────────────────────────────────────────

export async function saveOverblast(baseUrl: string, model: string, token: string): Promise<void> {
  const owned = agent.value;
  if (!owned) throw new Error("No agent yet.");
  if (!owned.vault.unlocked) throw new Error("Unlock your vault first — the token is only stored sealed.");
  await owned.vault.set("overblast.deviceToken", token.trim());
  await owned.saveSettings({ ...owned.settings(), overblast: { baseUrl: baseUrl.trim(), model: model.trim() } });
  handles.value = await owned.refreshBrains();
}

export async function saveByok(vendor: ByokVendor, key: string, baseUrl: string, model: string): Promise<void> {
  const owned = agent.value;
  if (!owned) throw new Error("No agent yet.");
  // §4.5, and §13's boundary: a key reaches the vault or it does not get stored at all.
  if (!owned.vault.unlocked) throw new Error("Unlock your vault first — a key is only stored sealed.");
  await owned.vault.set(byokSecretName(vendor), key.trim());
  await owned.saveSettings({
    ...owned.settings(),
    byok: { vendor, baseUrl: baseUrl.trim() || undefined, model: model.trim() },
  });
  await chooseBrain(byokProviderId(vendor));
}

export async function registerSponsored(appId: string): Promise<string> {
  const owned = agent.value;
  if (!owned) throw new Error("No agent yet.");
  const { deviceId } = await owned.registerSponsoredDevice(appId.trim());
  handles.value = await owned.refreshBrains();
  return deviceId;
}

export function resetConnections(): void {
  handles.value = [];
  busy.value = false;
  lastError.value = null;
}

export type { BrainId };
