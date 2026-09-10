/**
 * The approvals door — docs/HANDOFF-infinite-agent.md §4.3.
 *
 * WHY A QUEUE AND NOT A CALLBACK. `AgentRuntimeOptions.askPermission` returns a promise, and the loop
 * WAITS on it: whatever this resolves with is what happens next, so the modal is not a notification,
 * it is the decision. A queue is what makes that safe when a turn asks twice before the person has
 * answered once — the second request waits behind the first instead of replacing the dialog under
 * their finger. Cancelling the whole queue (the tab closing, `abort()`) must resolve every waiter,
 * or the loop hangs forever holding a lock nobody can see.
 */
import { computed, ref } from "vue";
import type { PermissionDecision, PermissionTier } from "@00/agent-runtime";

export interface PendingApproval {
  id: number;
  name: string;
  tier: PermissionTier;
  args: Record<string, unknown>;
  resolve(decision: PermissionDecision): void;
}

const queue = ref<PendingApproval[]>([]);
let nextId = 1;

export const pending = computed(() => queue.value);
export const current = computed<PendingApproval | null>(() => queue.value[0] ?? null);
export const waiting = computed(() => queue.value.length);

/** Handed straight to `createOwnedAgent`; the returned promise is what the loop blocks on. */
export function askPermission(req: {
  name: string;
  tier: PermissionTier;
  args: Record<string, unknown>;
}): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    queue.value = [...queue.value, { id: nextId++, ...req, resolve }];
  });
}

/** The modal's three buttons: Cancel, Allow once, Always allow. */
export function answer(id: number, decision: PermissionDecision): void {
  const item = queue.value.find((a) => a.id === id);
  if (!item) return;
  queue.value = queue.value.filter((a) => a.id !== id);
  item.resolve(decision);
}

export function allowOnce(id: number): void {
  answer(id, { allowed: true });
}

export function allowAlways(id: number): void {
  answer(id, { allowed: true, remember: "always" });
}

export function refuse(id: number): void {
  answer(id, { allowed: false });
}

/** Every waiter gets an answer, or the loop never returns. */
export function refuseAll(): void {
  const items = queue.value;
  queue.value = [];
  for (const item of items) item.resolve({ allowed: false });
}

/** Test seam: the queue is module state, and a suite must be able to start from empty. */
export function resetApprovals(): void {
  queue.value = [];
  nextId = 1;
}
