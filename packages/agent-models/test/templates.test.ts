/**
 * The turn format is the difference between a model that stops and a model that writes both sides
 * of the conversation, and nothing in the installed MediaPipe package can be pinned against it
 * (grep it: no `start_of_turn` anywhere). So what is tested here is the SHAPE this package commits
 * to — markers around every turn, no system role, an open model turn at the end, and a cut at the
 * first marker the model writes back — and the markers themselves stay flagged as unverified in
 * `src/templates.ts` until someone reads a real answer.
 */
import { describe, expect, it } from "vitest";
import { GEMMA_MARKERS, PROMPT_TEMPLATES, renderPrompt, stopAtTurnEnd, TURN_MARKER_MAX_LENGTH, turnMarkerIndex } from "../src/templates.js";
import type { PromptFamily } from "../src/templates.js";
import type { ChatMessage } from "../src/types.js";

describe("the gemma turn format", () => {
  it("wraps every turn and leaves the model's own turn open at the end", () => {
    const prompt = renderPrompt(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
      "gemma",
    );
    expect(prompt).toBe(
      "<start_of_turn>user\nhello<end_of_turn>\n" +
        "<start_of_turn>model\nhi<end_of_turn>\n" +
        "<start_of_turn>user\nagain<end_of_turn>\n" +
        "<start_of_turn>model\n",
    );
  });

  it("folds the system turn into the first user turn, because Gemma has no system role", () => {
    const prompt = renderPrompt(
      [
        { role: "system", content: "you are 00" },
        { role: "user", content: "hello" },
      ],
      "gemma",
    );
    expect(prompt).toBe("<start_of_turn>user\nyou are 00\n\nhello<end_of_turn>\n<start_of_turn>model\n");
    expect(prompt).not.toContain("system");
  });

  it("still delivers a conversation that is nothing but a system prompt", () => {
    expect(renderPrompt([{ role: "system", content: "be brief" }], "gemma")).toBe(
      "<start_of_turn>user\nbe brief<end_of_turn>\n<start_of_turn>model\n",
    );
  });

  it("replays an assistant tool call as the JSON it wrote, and a tool result as a user turn", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ls", arguments: { path: "." } }] },
      { role: "tool", content: "a.md", toolCallId: "c1", name: "ls" },
    ];
    const prompt = renderPrompt(messages, "gemma");
    expect(prompt).toContain('<start_of_turn>model\n{"tool_call":{"name":"ls","arguments":{"path":"."}}}<end_of_turn>');
    expect(prompt).toContain("<start_of_turn>user\nResult of ls:\na.md<end_of_turn>");
  });

  it("keeps prose that came with a tool call", () => {
    const prompt = renderPrompt([{ role: "assistant", content: "one moment", toolCalls: [{ id: "c", name: "ls", arguments: {} }] }], "gemma");
    expect(prompt).toContain('one moment\n{"tool_call":{"name":"ls","arguments":{}}}');
  });

  it("names a tool result by its call id when it has no name", () => {
    expect(renderPrompt([{ role: "tool", content: "x", toolCallId: "c9" }], "gemma")).toContain("Result of c9:");
    expect(renderPrompt([{ role: "tool", content: "x" }], "gemma")).toContain("Result of tool:");
  });
});

describe("the plain fallback format", () => {
  it("labels the turns and asks for the answer, with no markers a strange model never saw", () => {
    const prompt = renderPrompt(
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        { role: "tool", content: "t", name: "ls" },
      ],
      "plain",
    );
    expect(prompt).toBe("System: s\n\nUser: u\n\nAssistant: a\n\nTool: Result of ls:\nt\n\nAssistant:");
    expect(prompt).not.toContain(GEMMA_MARKERS.start);
  });

  it("is what an unnamed family gets, rather than Gemma's markers by accident", () => {
    expect(renderPrompt([{ role: "user", content: "hi" }])).toContain("User: hi");
    expect(Object.keys(PROMPT_TEMPLATES).sort()).toEqual(["gemma", "plain"]);
    // A family this package has never heard of — a caller's typo, or a model added ahead of its
    // template — must not silently borrow Gemma's markers.
    expect(renderPrompt([{ role: "user", content: "hi" }], "martian" as PromptFamily)).toContain("User: hi");
  });
});

describe("cutting the answer at the first marker", () => {
  it("finds whichever marker comes first, and only for gemma", () => {
    expect(turnMarkerIndex("done<end_of_turn>", "gemma")).toBe(4);
    expect(turnMarkerIndex("done<start_of_turn>user", "gemma")).toBe(4);
    expect(turnMarkerIndex("done", "gemma")).toBe(-1);
    expect(turnMarkerIndex("done<end_of_turn>", "plain")).toBe(-1);
  });

  it("keeps the answer and drops the conversation the model invented after it", () => {
    expect(stopAtTurnEnd("the answer.\n<end_of_turn>\n<start_of_turn>user\nnext", "gemma")).toBe("the answer.");
    expect(stopAtTurnEnd("the answer.", "gemma")).toBe("the answer.");
    expect(stopAtTurnEnd("the answer.<end_of_turn>", "plain")).toBe("the answer.<end_of_turn>");
  });

  it("says how much of a stream's tail could still be half a marker", () => {
    expect(TURN_MARKER_MAX_LENGTH).toBe(GEMMA_MARKERS.start.length);
  });
});
