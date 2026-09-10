/**
 * The one place the app knows whether it is online — docs/HANDOFF-infinite-agent.md §4.4.
 *
 * Nothing touches `window` at module scope: `startOffline()` is called once from the app's mount, so
 * this module imports cleanly in a node test and the reducer it wraps stays the thing under test.
 */
import { computed, ref } from "vue";
import { headerLine, initialNetState, netReducer, remoteBlockedReason, type NetEvent, type NetState } from "../lib/offline.js";

const state = ref<NetState>(initialNetState(true, 0));

export const net = computed<NetState>(() => state.value);
export const online = computed(() => state.value.online);
export const netHeadline = computed(() => headerLine(state.value));

export function applyNetEvent(event: NetEvent): void {
  state.value = netReducer(state.value, event);
}

export function blockedReason(providerId: string): string | null {
  return remoteBlockedReason(providerId, state.value);
}

/** Returns the teardown, so a test or a second mount does not stack listeners. */
export function startOffline(now: () => number = Date.now): () => void {
  state.value = initialNetState(navigator.onLine !== false, now());
  const up = () => applyNetEvent({ type: "online", at: now() });
  const down = () => applyNetEvent({ type: "offline", at: now() });
  window.addEventListener("online", up);
  window.addEventListener("offline", down);
  return () => {
    window.removeEventListener("online", up);
    window.removeEventListener("offline", down);
  };
}

/** For tests, and for the boot sequence, which sets the first reading before any listener exists. */
export function setOnline(value: boolean, at = 0): void {
  state.value = initialNetState(value, at);
}
