/**
 * Online/offline, and what it takes away — docs/HANDOFF-infinite-agent.md §4.4.
 *
 * WHY A REDUCER. `navigator.onLine` and its two events are the input, but the UI needs more than a
 * boolean: it needs to know when the state changed (so a banner can say "since"), it must not treat a
 * repeated `online` event as a change, and the remote brain cards each need ONE line of why they are
 * grey. Keeping that as a pure function is what lets it be tested without a browser, and what stops
 * three components from each deciding what "offline" means.
 */

export interface NetState {
  online: boolean;
  /** Epoch ms of the last real transition; the initial reading counts as one. */
  changedAt: number;
}

export type NetEvent = { type: "online" | "offline"; at: number };

export function initialNetState(online: boolean, at: number): NetState {
  return { online, changedAt: at };
}

export function netReducer(state: NetState, event: NetEvent): NetState {
  const online = event.type === "online";
  // A browser fires `online` more than once for one reconnection. Only a real flip moves `changedAt`,
  // or the banner's "since" resets while nothing happened.
  if (online === state.online) return state;
  return { online, changedAt: event.at };
}

/** The header line of §4.4, verbatim. */
export function headerLine(state: NetState): string {
  return state.online ? "Online" : "Offline · local agent available";
}

/** Providers that need the network. `local` is the only one that does not. */
export function isRemoteProvider(providerId: string): boolean {
  return providerId !== "local";
}

/**
 * One line of why a card is grey, or null when nothing is taking it away. Offline is checked first
 * because it is the reason the person can act on, and a missing key is not worth mentioning to
 * someone who could not use the key anyway.
 */
export function remoteBlockedReason(providerId: string, state: NetState): string | null {
  if (state.online) return null;
  if (!isRemoteProvider(providerId)) return null;
  return "Needs a connection — your local agent keeps working.";
}

/** What the whole shell loses offline, said once rather than per feature. */
export function offlineCapabilities(): string {
  return "Files, search, your agent's memory and the local brain all work. Connected brains, backups to the cloud and transfers wait.";
}
