/**
 * The panes' view of the virtual ports.
 *
 * WHY A SECOND MODULE AND NOT VUE IN THE REGISTRY. `src/power/virtual-ports.ts` is framework-free on
 * purpose: the shell calls it, the agent's `bash` calls it through the shell, and a node test drives
 * it with no Vue at all. This file is the thin reactive skin — a `ref` kept in step by the registry's
 * own subscription — plus the two pieces of wiring that need to happen exactly once in a tab: the
 * filesystem `/~/files/…` reads from, and the listener the service worker talks to.
 *
 * WHY THE WIRING IS LAZY. Nothing here matters until somebody opens the power shell, and a message
 * listener installed at boot for a feature nobody used is a boot the person paid for and did not
 * want. `ensurePortRuntime()` is idempotent and is called by the panes that can show a port.
 */
import { computed, ref } from "vue";
import {
  installServiceWorkerBridge,
  listPorts,
  onPortsChanged,
  portUrl,
  setWorkspaceFs,
  unregister,
  type PortEntry,
} from "../power/virtual-ports.js";
import { agent } from "./agent.js";

const portsRef = ref<PortEntry[]>([]);
let detach: (() => void) | null = null;

export const livePorts = computed(() => portsRef.value);
export const hasLivePorts = computed(() => portsRef.value.length > 0);

function refresh(): void {
  portsRef.value = listPorts();
}

/**
 * Point the registry at this tab's agent and start listening. Safe to call on every mount.
 * Returns false when the browser has no service worker (a dev server, a private mode with workers
 * off): the ports still exist, and their URLs will simply not resolve — which is what the pane says.
 */
export function ensurePortRuntime(): boolean {
  const owned = agent.value;
  if (owned) setWorkspaceFs(owned.fs);
  if (!detach) {
    detach = onPortsChanged(refresh);
    refresh();
  }
  return installServiceWorkerBridge();
}

/** `kill 3000` from a button. */
export function stopPort(port: number): boolean {
  const stopped = unregister(port);
  refresh();
  return stopped;
}

export function urlForPort(port: number): string {
  return portUrl(port);
}

/** Test seam, and what a Restore calls. */
export function resetPortsState(): void {
  detach?.();
  detach = null;
  portsRef.value = [];
}
