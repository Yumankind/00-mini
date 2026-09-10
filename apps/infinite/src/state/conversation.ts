/**
 * The conversation pane's state — one run at a time, fed by the contract's event bus.
 *
 * The interesting logic is in `lib/conversation.ts`, which is pure and tested. What lives here is the
 * part that cannot be: the subscription to the runtime, the in-flight flag the composer disables
 * itself on, and the rule that a run's end SETTLES any bubble left streaming — because a stream that
 * ends with an error never sends the `final` the reducer is waiting for, and a caret blinking forever
 * is a UI claiming the agent is still thinking.
 */
import { computed, ref, watch } from "vue";
import type { AgentEvent } from "@00/agent-runtime";
import {
  emptyConversation,
  pushError,
  pushUser,
  reduceEvent,
  setStatus,
  settle,
  type ConversationState,
} from "../lib/conversation.js";
import { agent } from "./agent.js";
import {
  brainPreference,
  primeBrains,
  runBlockedReason,
  runStatus,
  startDownloadWatch,
} from "./model-choice.js";

const state = ref<ConversationState>(emptyConversation());
const running = ref(false);
const sessionId = ref<string | null>(null);
const lastError = ref<string | null>(null);
let detach: (() => void) | null = null;
/** True once this run has produced text — see `apply` and the status watch in `send`. */
let answering = false;

export const rows = computed(() => state.value.rows);
export const busy = computed(() => running.value);
export const currentSession = computed(() => sessionId.value);
export const composerError = computed(() => lastError.value);

export function apply(event: AgentEvent): void {
  // The first word of the answer ends the wait: the status row is retired by the reducer, and the
  // poll behind it is told to stop writing a new one over the top of a bubble that is streaming.
  if (event.type === "agent_delta" || event.type === "agent_message") answering = true;
  state.value = reduceEvent(state.value, event);
}

/** Subscribes once. The returned teardown is only for a test; the app lives as long as the tab. */
export function listen(): () => void {
  const owned = agent.value;
  if (!owned || detach) return () => undefined;
  detach = owned.runtime.on(apply);
  return () => {
    detach?.();
    detach = null;
  };
}

export function startNewSession(): void {
  state.value = emptyConversation();
  sessionId.value = null;
  lastError.value = null;
}

export function openSession(id: string, history: { role: string; content: string }[]): void {
  let next = emptyConversation();
  for (const message of history) {
    if (message.role === "user") next = pushUser(next, message.content);
    else if (message.role === "assistant" && message.content.trim()) {
      next = reduceEvent(next, { type: "agent_message", text: message.content, final: true });
    }
  }
  state.value = next;
  sessionId.value = id;
  lastError.value = null;
}

export async function send(prompt: string): Promise<void> {
  const owned = agent.value;
  const text = prompt.trim();
  if (!owned || !text || running.value) return;
  listen();
  state.value = pushUser(state.value, text);

  // A6's second half: a run that CANNOT start says which brain refused and why, with a button to the
  // chip, instead of a bare failure a minute later. Readiness is asked for first, because a composer
  // that has never opened Connections has never asked for it.
  await primeBrains();
  const blocked = runBlockedReason.value;
  if (blocked) {
    lastError.value = null;
    state.value = pushError(state.value, blocked, true);
    return;
  }

  running.value = true;
  lastError.value = null;
  answering = false;
  // A6's first half: while the run waits on a model download, the conversation says so and the line
  // moves. It stops the moment the answer starts — the reducer takes the row away and this stops
  // writing a new one.
  const stopWatch = startDownloadWatch();
  const stopStatus = watch(
    runStatus,
    (d) => {
      if (answering) return;
      state.value = setStatus(state.value, d);
    },
    { immediate: true },
  );
  try {
    const result = await owned.runtime.run({
      prompt: text,
      sessionId: sessionId.value ?? undefined,
      // B20's other half: the segmented control in the chip's picker sets the class of brain the
      // next turns ask for. `auto` is the contract's own default and is passed all the same, so the
      // run says out loud what it wants.
      brain: brainPreference.value,
    });
    sessionId.value = result.sessionId;
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : String(err);
    state.value = reduceEvent(state.value, { type: "error", message: lastError.value });
  } finally {
    stopStatus();
    stopWatch();
    running.value = false;
    state.value = settle(state.value);
  }
}

export function stop(): void {
  agent.value?.runtime.abort();
}

/** Test seam. */
export function resetConversation(): void {
  state.value = emptyConversation();
  running.value = false;
  sessionId.value = null;
  lastError.value = null;
  detach = null;
  answering = false;
}
