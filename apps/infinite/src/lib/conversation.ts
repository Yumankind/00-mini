/**
 * AgentEvents → the rows the conversation pane draws.
 *
 * WHY A PURE REDUCER OVER THE EVENT BUS. The contract's `AgentEvent` union (packages/agent-runtime/
 * src/api.ts) is the ONLY thing the UI is allowed to know about a turn, and it arrives as a stream of
 * small facts, not as a transcript. Turning that stream into rows is the whole of the view's logic —
 * which deltas belong to which bubble, which tool calls collapse into one line, where a provider's
 * footer goes — so it lives here, testable without a browser, and the component only paints.
 *
 * TOOL ROWS COLLAPSE the way the 00 web UI's do (packages/web-vue/src/components/SessionThread.vue):
 * consecutive calls of the SAME tool become one mono line with a count, because "read ×7" is what the
 * person needs and seven identical lines is what they get otherwise.
 */
import type { AgentEvent, PermissionTier } from "@00/agent-runtime";
import type { BrainStamp } from "./model-chip.js";

export type Row =
  | { kind: "user"; id: string; text: string }
  /** `by` is B20's line under the answer: which brain wrote it, from `model_started`. */
  | { kind: "agent"; id: string; text: string; streaming: boolean; by?: BrainStamp }
  /**
   * A6: what the run is waiting on while nothing else is happening — a model download, mostly.
   *
   * It is NOT an event: readiness is polled, not pushed, so this row is written by `setStatus` from
   * outside the reducer. The reducer's only job is to take it away the moment anything real arrives,
   * which is what makes it "turn into the answer" rather than sit above one.
   */
  | { kind: "status"; id: string; text: string; percent: number | null }
  | {
      kind: "tool";
      id: string;
      name: string;
      calls: number;
      running: number;
      failed: number;
      /** Total wall time of the completed calls in this row. */
      ms: number;
      /** The last output or error, shown when the row is expanded. */
      detail?: string;
    }
  | { kind: "footer"; id: string; text: string }
  /** `openChip` marks the one error a person can act on right here: nothing is ready to answer. */
  | { kind: "error"; id: string; text: string; openChip?: boolean };

export interface ConversationState {
  rows: Row[];
  /** callId → the id of the tool row it was folded into. */
  rowByCall: Record<string, string>;
  /** Monotonic counter behind the row ids: reproducible, and no randomness in a reducer. */
  seq: number;
  /** The last `model_started`, stamped onto the next bubble opened — B20's answered-by line. */
  brain: BrainStamp | null;
}

export function emptyConversation(): ConversationState {
  return { rows: [], rowByCall: {}, seq: 0, brain: null };
}

/**
 * `Omit<Row, "id">` collapses a union into its common keys, which is not what a row builder wants —
 * it has to stay a union of the five shapes minus their id. Distributing over the union is the fix.
 */
type RowInit = Row extends infer R ? (R extends Row ? Omit<R, "id"> : never) : never;

function withRow(state: ConversationState, row: RowInit): ConversationState {
  const seq = state.seq + 1;
  return { ...state, seq, rows: [...state.rows, { ...row, id: `r${seq}` } as Row] };
}

function replaceRow(state: ConversationState, id: string, next: Row): ConversationState {
  return { ...state, rows: state.rows.map((r) => (r.id === id ? next : r)) };
}

export function pushUser(state: ConversationState, text: string): ConversationState {
  return withRow(state, { kind: "user", text });
}

export function pushError(state: ConversationState, text: string, openChip = false): ConversationState {
  return withRow(state, { kind: "error", text, openChip });
}

/**
 * A6's live row, written from OUTSIDE the event stream (readiness is polled, not emitted).
 *
 * One at a time, always last: a second download line under the first would read as two downloads.
 * `null` takes it away, which is what a run's end does when no answer ever arrived.
 */
export function setStatus(
  state: ConversationState,
  status: { text: string; percent: number | null } | null,
): ConversationState {
  const existing = state.rows.find((r) => r.kind === "status");
  if (!status) {
    return existing ? { ...state, rows: state.rows.filter((r) => r.kind !== "status") } : state;
  }
  if (existing) {
    if (existing.kind === "status" && existing.text === status.text && existing.percent === status.percent) return state;
    return replaceRow(state, existing.id, { ...existing, ...status } as Row);
  }
  return withRow(state, { kind: "status", ...status });
}

/** Anything real arriving retires the status row: the download became an answer. */
function clearStatus(state: ConversationState): ConversationState {
  return state.rows.some((r) => r.kind === "status") ? setStatus(state, null) : state;
}

/** The row a delta belongs to: the last agent bubble, but only while it is still streaming. */
function openAgentRow(state: ConversationState): (Row & { kind: "agent" }) | null {
  const last = state.rows[state.rows.length - 1];
  return last && last.kind === "agent" && last.streaming ? last : null;
}

function stamp(state: ConversationState): BrainStamp | undefined {
  return state.brain ?? undefined;
}

function openToolRow(state: ConversationState, name: string): (Row & { kind: "tool" }) | null {
  const last = state.rows[state.rows.length - 1];
  return last && last.kind === "tool" && last.name === name ? last : null;
}

export function reduceEvent(input: ConversationState, event: AgentEvent): ConversationState {
  // Every event below is proof that the run got past whatever the status row was waiting on.
  const state = event.type === "model_started" ? input : clearStatus(input);
  switch (event.type) {
    // THE TWO ANSWER EVENTS (contract revision 2026-09-10). They used to be one event with a boolean,
    // and this reducer had to honour BOTH readings of it — appending unless the text happened to be a
    // repeat of what it had already accumulated, which is a guess with a bug in it for any answer
    // that ends by repeating itself. Now the contract says which is which: a delta ADDS, a message
    // REPLACES and closes.
    case "agent_delta": {
      const open = openAgentRow(state);
      if (!open) return withRow(state, { kind: "agent", text: event.text, streaming: true, by: stamp(state) });
      return replaceRow(state, open.id, { ...open, text: open.text + event.text });
    }
    case "agent_message": {
      const open = openAgentRow(state);
      // The whole message, once: it repeats every delta of the same message, so the accumulation is
      // replaced rather than added to, and the bubble stops streaming.
      if (!open) return withRow(state, { kind: "agent", text: event.text, streaming: false, by: stamp(state) });
      return replaceRow(state, open.id, { ...open, text: event.text, streaming: false });
    }
    /**
     * B20: which brain answered. Remembered rather than drawn, because it arrives BEFORE the bubble
     * it belongs to — and because a run that falls through to a second provider mid-way stamps each
     * bubble with the brain that actually wrote it rather than with the run's last one.
     */
    case "model_started":
      return { ...state, brain: { providerId: event.providerId, model: event.model, brainClass: event.brainClass } };
    case "tool_started": {
      const open = openToolRow(state, event.name);
      if (open) {
        const next = { ...open, calls: open.calls + 1, running: open.running + 1 };
        return {
          ...replaceRow(state, open.id, next),
          rowByCall: { ...state.rowByCall, [event.callId]: open.id },
        };
      }
      const seq = state.seq + 1;
      const id = `r${seq}`;
      return {
        ...state,
        seq,
        rows: [...state.rows, { kind: "tool", id, name: event.name, calls: 1, running: 1, failed: 0, ms: 0 }],
        rowByCall: { ...state.rowByCall, [event.callId]: id },
      };
    }
    case "tool_completed": {
      const id = state.rowByCall[event.callId];
      const row = state.rows.find((r) => r.id === id);
      if (!row || row.kind !== "tool") return state;
      return replaceRow(state, id, {
        ...row,
        running: Math.max(0, row.running - 1),
        ms: row.ms + event.ms,
        detail: event.output,
      });
    }
    case "tool_failed": {
      const id = state.rowByCall[event.callId];
      const row = state.rows.find((r) => r.id === id);
      if (!row || row.kind !== "tool") return state;
      return replaceRow(state, id, {
        ...row,
        running: Math.max(0, row.running - 1),
        failed: row.failed + 1,
        detail: event.error,
      });
    }
    case "model_completed": {
      // The sponsor footer of §6.2: shown under the answer, never fed back into the model.
      return event.footer ? withRow(state, { kind: "footer", text: event.footer }) : state;
    }
    case "error":
      return withRow(state, { kind: "error", text: event.message });
    default:
      // permission_*, file_changed and command_* are consumed by other panes.
      return state;
  }
}

/**
 * Closes any bubble left streaming when a run ends (final, aborted or failed alike), and takes the
 * status row with it: a download the run was waiting on is not still being waited on once the run
 * is over, whatever became of it.
 */
export function settle(state: ConversationState): ConversationState {
  const cleared = clearStatus(state);
  const open = openAgentRow(cleared);
  if (!open) return cleared;
  return replaceRow(cleared, open.id, { ...open, streaming: false });
}

export function toolRowLabel(row: Row & { kind: "tool" }): string {
  const times = row.calls > 1 ? ` ×${row.calls}` : "";
  if (row.running > 0) return `${row.name}${times}`;
  if (row.failed > 0) return `${row.name}${times} · failed`;
  return `${row.name}${times}`;
}

export function toolRowState(row: Row & { kind: "tool" }): "running" | "failed" | "done" {
  if (row.running > 0) return "running";
  return row.failed > 0 ? "failed" : "done";
}

/** The three tiers in the platform's own vocabulary (§4.3), for the approvals modal's headline. */
export const TIER_HEADLINE: Record<PermissionTier, string> = {
  safe: "A safe step",
  confirm: "Your agent wants to make a change",
  "high-risk": "Your agent wants to do something with consequences",
};
