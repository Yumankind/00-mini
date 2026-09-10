/**
 * The sessions list — `listSessions()` / `loadSession()` from the contract, and nothing else.
 *
 * The runtime owns the session files (the engine's JSONL shape, so a moved agent keeps its history);
 * this only remembers what the last listing said, so switching panes does not re-read the folder.
 */
import { computed, ref } from "vue";
import { agent } from "./agent.js";
import { openSession } from "./conversation.js";

export interface SessionRow {
  id: string;
  title: string;
  updatedAt: number;
}

const items = ref<SessionRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

export const sessions = computed(() => items.value);
export const sessionsLoading = computed(() => loading.value);
export const sessionsError = computed(() => error.value);

export async function refreshSessions(): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  loading.value = true;
  error.value = null;
  try {
    items.value = await owned.runtime.listSessions();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

export async function open(id: string): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  const history = await owned.runtime.loadSession(id);
  openSession(
    id,
    history.map((m) => ({ role: m.role, content: m.content })),
  );
}

/** Newest first, and a date header the list can group by without a formatting library. */
export function dayLabel(updatedAt: number, now = Date.now()): string {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return "Today";
  if (updatedAt >= startOfToday - day) return "Yesterday";
  return new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function resetSessions(): void {
  items.value = [];
  loading.value = false;
  error.value = null;
}
