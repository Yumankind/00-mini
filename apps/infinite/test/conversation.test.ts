import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@00/agent-runtime";
import {
  emptyConversation,
  pushUser,
  reduceEvent,
  settle,
  toolRowLabel,
  toolRowState,
  type ConversationState,
} from "../src/lib/conversation.js";

function run(events: AgentEvent[], from: ConversationState = emptyConversation()): ConversationState {
  return events.reduce(reduceEvent, from);
}

describe("the conversation reducer", () => {
  it("opens one bubble and appends the deltas into it", () => {
    const state = run([
      { type: "agent_message", text: "Hel", final: false },
      { type: "agent_message", text: "lo.", final: false },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "agent", text: "Hello.", streaming: true });
  });

  it("closes the bubble on `final`", () => {
    const state = run([
      { type: "agent_message", text: "Hi", final: false },
      { type: "agent_message", text: "", final: true },
    ]);
    expect(state.rows[0]).toMatchObject({ kind: "agent", text: "Hi", streaming: false });
  });

  it("does not double the text when `final` repeats the whole stream", () => {
    // The contract does not say whether `text` on a final event repeats or adds. Both readings work.
    const state = run([
      { type: "agent_message", text: "Hello.", final: false },
      { type: "agent_message", text: "Hello.", final: true },
    ]);
    expect(state.rows[0]).toMatchObject({ text: "Hello.", streaming: false });
  });

  it("takes a `final` with no preceding delta as a whole message", () => {
    const state = run([{ type: "agent_message", text: "Done.", final: true }]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "agent", text: "Done.", streaming: false });
  });

  it("starts a new bubble after the last one closed", () => {
    const state = run([
      { type: "agent_message", text: "One", final: true },
      { type: "agent_message", text: "Two", final: true },
    ]);
    expect(state.rows.map((r) => (r.kind === "agent" ? r.text : ""))).toEqual(["One", "Two"]);
  });

  it("collapses consecutive calls of the same tool into one row", () => {
    const state = run([
      { type: "tool_started", callId: "a", name: "read", args: { path: "one" } },
      { type: "tool_completed", callId: "a", name: "read", output: "1", ms: 4 },
      { type: "tool_started", callId: "b", name: "read", args: { path: "two" } },
      { type: "tool_completed", callId: "b", name: "read", output: "2", ms: 6 },
    ]);
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0];
    expect(row).toMatchObject({ kind: "tool", name: "read", calls: 2, running: 0, ms: 10, detail: "2" });
    if (row.kind === "tool") {
      expect(toolRowLabel(row)).toBe("read ×2");
      expect(toolRowState(row)).toBe("done");
    }
  });

  it("does not collapse a different tool, or one separated by an answer", () => {
    const state = run([
      { type: "tool_started", callId: "a", name: "read", args: {} },
      { type: "tool_started", callId: "b", name: "grep", args: {} },
      { type: "agent_message", text: "…", final: true },
      { type: "tool_started", callId: "c", name: "grep", args: {} },
    ]);
    expect(state.rows.map((r) => r.kind)).toEqual(["tool", "tool", "agent", "tool"]);
  });

  it("marks a row failed and keeps the error as its detail", () => {
    const state = run([
      { type: "tool_started", callId: "a", name: "write", args: {} },
      { type: "tool_failed", callId: "a", name: "write", error: "refused" },
    ]);
    const row = state.rows[0];
    expect(row).toMatchObject({ kind: "tool", failed: 1, running: 0, detail: "refused" });
    if (row.kind === "tool") {
      expect(toolRowState(row)).toBe("failed");
      expect(toolRowLabel(row)).toBe("write · failed");
    }
  });

  it("keeps a row running while one of its calls has not answered", () => {
    const state = run([
      { type: "tool_started", callId: "a", name: "read", args: {} },
      { type: "tool_started", callId: "b", name: "read", args: {} },
      { type: "tool_completed", callId: "a", name: "read", output: "", ms: 1 },
    ]);
    const row = state.rows[0];
    expect(row).toMatchObject({ running: 1, calls: 2 });
    if (row.kind === "tool") expect(toolRowState(row)).toBe("running");
  });

  it("ignores a completion for a call it never saw start", () => {
    const state = run([{ type: "tool_completed", callId: "ghost", name: "read", output: "", ms: 1 }]);
    expect(state.rows).toHaveLength(0);
  });

  it("shows a provider footer as its own row, and only when there is one", () => {
    const withFooter = run([{ type: "model_completed", providerId: "sponsored", footer: "— sponsored by X" }]);
    expect(withFooter.rows[0]).toMatchObject({ kind: "footer", text: "— sponsored by X" });
    const without = run([{ type: "model_completed", providerId: "local" }]);
    expect(without.rows).toHaveLength(0);
  });

  it("keeps errors as rows of their own", () => {
    const state = run([{ type: "error", message: "the model refused" }]);
    expect(state.rows[0]).toMatchObject({ kind: "error", text: "the model refused" });
  });

  it("ignores the events other panes consume", () => {
    const state = run([
      { type: "model_started", providerId: "local" },
      { type: "permission_requested", callId: "a", name: "write", tier: "confirm", args: {} },
      { type: "permission_answered", callId: "a", allowed: true },
      { type: "file_changed", path: "workspace/a.md", op: "write" },
      { type: "command_started", command: "ls" },
      { type: "command_completed", command: "ls", exitCode: 0 },
    ]);
    expect(state.rows).toHaveLength(0);
  });

  it("puts the person's own message in as a row", () => {
    const state = pushUser(emptyConversation(), "hello");
    expect(state.rows[0]).toMatchObject({ kind: "user", text: "hello" });
  });

  it("gives every row a distinct key", () => {
    const state = run(
      [
        { type: "agent_message", text: "a", final: true },
        { type: "error", message: "b" },
        { type: "agent_message", text: "c", final: true },
      ],
      pushUser(emptyConversation(), "start"),
    );
    const ids = state.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("settles a bubble a failed run left streaming", () => {
    const streaming = run([{ type: "agent_message", text: "half…", final: false }]);
    expect(settle(streaming).rows[0]).toMatchObject({ streaming: false });
    // Settling twice, or with nothing open, changes nothing.
    expect(settle(settle(streaming))).toEqual(settle(streaming));
    expect(settle(emptyConversation()).rows).toHaveLength(0);
  });
});
