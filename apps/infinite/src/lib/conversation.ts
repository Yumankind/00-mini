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

export type Row =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string; streaming: boolean }
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
  | { kind: "error"; id: string; text: string };

export interface ConversationState {
  rows: Row[];
  /** callId → the id of the tool row it was folded into. */
  rowByCall: Record<string, string>;
  /** Monotonic counter behind the row ids: reproducible, and no randomness in a reducer. */
  seq: number;
}

export function emptyConversation(): ConversationState {
  return { rows: [], rowByCall: {}, seq: 0 };
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

/** The row a delta belongs to: the last agent bubble, but only while it is still streaming. */
function openAgentRow(state: ConversationState): (Row & { kind: "agent" }) | null {
  const last = state.rows[state.rows.length - 1];
  return last && last.kind === "agent" && last.streaming ? last : null;
}

function openToolRow(state: ConversationState, name: string): (Row & { kind: "tool" }) | null {
  const last = state.rows[state.rows.length - 1];
  return last && last.kind === "tool" && last.name === name ? last : null;
}

export function reduceEvent(state: ConversationState, event: AgentEvent): ConversationState {
  switch (event.type) {
    case "agent_message": {
      const open = openAgentRow(state);
      if (!open) {
        // A `final` with no preceding delta is a whole message; a first delta opens the bubble.
        return withRow(state, { kind: "agent", text: event.text, streaming: !event.final });
      }
      // The contract does not say whether `text` on a final event repeats the accumulated stream or
      // adds to it, so both readings are honoured: a repeat is dropped, anything else appends. See
      // the contract gaps note in the handoff for this module.
      const repeat = event.final && event.text.length > 0 && open.text.endsWith(event.text);
      const text = repeat ? open.text : open.text + event.text;
      return replaceRow(state, open.id, { ...open, text, streaming: !event.final });
    }
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
      // model_started, permission_*, file_changed, command_* are consumed by other panes.
      return state;
  }
}

/** Closes any bubble left streaming when a run ends (final, aborted or failed alike). */
export function settle(state: ConversationState): ConversationState {
  const open = openAgentRow(state);
  if (!open) return state;
  return replaceRow(state, open.id, { ...open, streaming: false });
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
