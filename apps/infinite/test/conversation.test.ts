import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@00/agent-runtime";
import {
  emptyConversation,
  pushError,
  pushUser,
  reduceEvent,
  setStatus,
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
      { type: "agent_delta", text: "Hel" },
      { type: "agent_delta", text: "lo." },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "agent", text: "Hello.", streaming: true });
  });

  it("closes the bubble on the whole message, and never doubles the text", () => {
    // The contract revision of 2026-09-10: `agent_message` repeats the deltas, so it REPLACES them.
    const state = run([
      { type: "agent_delta", text: "Hel" },
      { type: "agent_delta", text: "lo." },
      { type: "agent_message", text: "Hello.", final: true },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "agent", text: "Hello.", streaming: false });
  });

  it("takes the whole message even when it says more than the deltas did", () => {
    // A provider whose stream was cut short still ends with the message it actually produced, and
    // the person reads that rather than the half that arrived.
    const state = run([
      { type: "agent_delta", text: "Hello" },
      { type: "agent_message", text: "Hello. And one more thing.", final: true },
    ]);
    expect(state.rows[0]).toMatchObject({ text: "Hello. And one more thing.", streaming: false });
  });

  it("takes a message with no preceding delta as a whole message", () => {
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
    const streaming = run([{ type: "agent_delta", text: "half…" }]);
    expect(settle(streaming).rows[0]).toMatchObject({ streaming: false });
    // Settling twice, or with nothing open, changes nothing.
    expect(settle(settle(streaming))).toEqual(settle(streaming));
    expect(settle(emptyConversation()).rows).toHaveLength(0);
  });
});

describe("A6: the row that says what the run is waiting on", () => {
  it("appears once, updates in place, and never doubles", () => {
    let state = setStatus(emptyConversation(), { text: "Downloading Gemma 3 270m · 4%", percent: 4 });
    state = setStatus(state, { text: "Downloading Gemma 3 270m · 41%", percent: 41 });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "status", text: "Downloading Gemma 3 270m · 41%", percent: 41 });
  });

  it("is the same object when nothing changed, so a poll costs no repaint", () => {
    const state = setStatus(emptyConversation(), { text: "Downloading", percent: 1 });
    expect(setStatus(state, { text: "Downloading", percent: 1 })).toBe(state);
    expect(setStatus(emptyConversation(), null)).toEqual(emptyConversation());
  });

  it("turns into the answer: the first delta takes it away", () => {
    const waiting = setStatus(emptyConversation(), { text: "Downloading Gemma 3 270m · 41%", percent: 41 });
    const answered = run([{ type: "agent_delta", text: "Hel" }], waiting);
    expect(answered.rows.map((r) => r.kind)).toEqual(["agent"]);
  });

  it("survives the `model_started` that comes BEFORE the download starts", () => {
    // The runtime names the brain, then the provider fetches two gigabytes, then it answers. Only
    // the answer ends the wait.
    const waiting = setStatus(emptyConversation(), { text: "Downloading Gemma 4 E2B", percent: null });
    const started = run([{ type: "model_started", providerId: "local", model: "gemma-4-E2B-it-web" }], waiting);
    expect(started.rows.map((r) => r.kind)).toEqual(["status"]);
  });

  it("is taken away by a tool row and by an error, which are also proof the wait is over", () => {
    const waiting = setStatus(emptyConversation(), { text: "Downloading", percent: 2 });
    expect(run([{ type: "tool_started", callId: "a", name: "read", args: {} }], waiting).rows.map((r) => r.kind)).toEqual(["tool"]);
    expect(run([{ type: "error", message: "no" }], waiting).rows.map((r) => r.kind)).toEqual(["error"]);
  });

  it("does not outlive the run that was waiting", () => {
    const waiting = setStatus(emptyConversation(), { text: "Downloading", percent: 2 });
    expect(settle(waiting).rows).toHaveLength(0);
  });

  it("carries the button that opens the chip, and only on the error that has one", () => {
    const blocked = pushError(emptyConversation(), "No brain can answer yet — Local AI cannot run in this browser.", true);
    expect(blocked.rows[0]).toMatchObject({ kind: "error", openChip: true });
    expect(pushError(emptyConversation(), "boom").rows[0]).toMatchObject({ openChip: false });
  });
});

describe("B20: which brain answered", () => {
  it("stamps the bubble with the model_started that opened it", () => {
    const state = run([
      { type: "model_started", providerId: "local", model: "gemma3-270m-it-q4_0-web", brainClass: "small" },
      { type: "agent_delta", text: "Hi" },
      { type: "agent_message", text: "Hi.", final: true },
    ]);
    expect(state.rows[0]).toMatchObject({
      kind: "agent",
      streaming: false,
      by: { providerId: "local", model: "gemma3-270m-it-q4_0-web", brainClass: "small" },
    });
  });

  it("keeps the streaming caret while the deltas arrive, stamped from the first event", () => {
    const state = run([
      { type: "model_started", providerId: "byok:openai", model: "gpt-4o-mini" },
      { type: "agent_delta", text: "Hal" },
    ]);
    expect(state.rows[0]).toMatchObject({ kind: "agent", text: "Hal", streaming: true, by: { providerId: "byok:openai" } });
  });

  it("stamps each bubble with the brain that actually wrote it, not the run's last one", () => {
    const state = run([
      { type: "model_started", providerId: "local" },
      { type: "agent_message", text: "One", final: true },
      { type: "model_started", providerId: "sponsored" },
      { type: "agent_message", text: "Two", final: true },
    ]);
    expect(state.rows.map((r) => (r.kind === "agent" ? r.by?.providerId : null))).toEqual(["local", "sponsored"]);
  });

  it("leaves the line off a bubble no model was announced for", () => {
    const state = run([{ type: "agent_message", text: "restored from a session", final: true }]);
    expect(state.rows[0]).toMatchObject({ kind: "agent" });
    expect((state.rows[0] as { by?: unknown }).by).toBeUndefined();
  });
});
