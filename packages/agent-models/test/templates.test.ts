/**
 * The turn format is the difference between a model that stops and a model that writes both sides
 * of the conversation, and nothing in the installed MediaPipe package can be pinned against it
 * (grep it: no `start_of_turn` anywhere). So what is tested here is the SHAPE this package commits
 * to — markers around every turn, no system role, an open model turn at the end, and a cut at the
 * first marker the model writes back — and the markers themselves stay flagged as unverified in
 * `src/templates.ts` until someone reads a real answer.
 */
import { describe, expect, it } from "vitest";
import { withoutImages } from "../src/image-parts.js";
import {
  FAMILY_MARKERS,
  GEMMA_MARKERS,
  PHI_MARKERS,
  PROMPT_SEGMENT_TEMPLATES,
  PROMPT_TEMPLATES,
  renderPrompt,
  renderPromptSegments,
  stopAtTurnEnd,
  TURN_MARKER_MAX_LENGTH,
  turnMarkerIndex,
  turnMarkerMaxLength,
  turnStops,
} from "../src/templates.js";
import type { PromptFamily } from "../src/templates.js";
import type { ChatMessage, ImagePart } from "../src/types.js";

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
    // Five families since 2026-09-11: Gemma, and the three the ONNX rows' own templates speak, plus
    // the fallback. `chatml`, `phi` and `llama3` exist for the CUT — nothing in this package renders
    // a prompt with them, because `apply_chat_template` renders those models' real templates.
    expect(Object.keys(PROMPT_TEMPLATES).sort()).toEqual(["chatml", "gemma", "llama3", "phi", "plain"]);
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
    // Per family since 2026-09-11: Llama's header token is five characters longer than Gemma's
    // longest, so a hold-back sized for Gemma would stream the first half of one to a reader.
    expect(turnMarkerMaxLength("gemma")).toBe(TURN_MARKER_MAX_LENGTH);
    expect(turnMarkerMaxLength("llama3")).toBe("<|start_header_id|>".length);
    expect(turnMarkerMaxLength("chatml")).toBe("<|im_start|>".length);
    expect(turnMarkerMaxLength("phi")).toBe("<|assistant|>".length);
    expect(turnMarkerMaxLength("plain")).toBe(0);
  });

  /**
   * THE THREE FAMILIES THE ONNX ROWS BROUGHT. Each marker set was read out of that repo's own
   * `chat_template.jinja` on 2026-09-11, and each is here for the CUT: `apply_chat_template` renders
   * those models' prompts, and what this package still has to know is which strings mean "the turn
   * ended" when a model types one as text instead of emitting the token.
   */
  it("cuts a ChatML answer at the Qwen rows' own markers", () => {
    expect(turnStops("chatml")).toEqual(["<|im_end|>", "<|im_start|>"]);
    expect(stopAtTurnEnd("the answer.<|im_end|>\n<|im_start|>user\nnext", "chatml")).toBe("the answer.");
    expect(turnMarkerIndex("all fine", "chatml")).toBe(-1);
    // A family's markers are ITS OWN: Gemma's cut must not fire on a ChatML stream, or a stream that
    // merely quoted the other model's tokens would be truncated.
    expect(stopAtTurnEnd("the answer.<|im_end|>", "gemma")).toBe("the answer.<|im_end|>");
  });

  it("cuts a Phi answer on its headers written out in full, never on the two characters `<|`", () => {
    // `PHI_MARKERS.start` is "<|" because that is how its template builds a header — and scanning a
    // stream for those two characters would cut an answer that merely mentioned them, which is the
    // whole reason `stops` exists beside `start`.
    expect(PHI_MARKERS.start).toBe("<|");
    expect(turnStops("phi")).toContain("<|end|>");
    expect(stopAtTurnEnd("use the <|pipe|> operator", "phi")).toBe("use the <|pipe|> operator");
    expect(stopAtTurnEnd("done<|end|><|user|>again", "phi")).toBe("done");
    expect(stopAtTurnEnd("done<|assistant|>", "phi")).toBe("done");
  });

  it("cuts a Llama 3 answer at `<|eot_id|>` and at the next header", () => {
    expect(turnStops("llama3")).toEqual(["<|eot_id|>", "<|start_header_id|>", "<|end_of_text|>"]);
    expect(stopAtTurnEnd("the answer.<|eot_id|>", "llama3")).toBe("the answer.");
    expect(stopAtTurnEnd("the answer.<|start_header_id|>user<|end_header_id|>\n\nhi", "llama3")).toBe("the answer.");
  });

  it("renders each family's header in ITS OWN shape, not Gemma's with the words swapped", () => {
    const turn = [{ role: "user" as const, content: "hi" }];
    // Nothing in this package renders these today — `apply_chat_template` does — but the renderer is
    // keyed by family and a family with a wrong header shape would be a silent trap for whoever
    // reaches for it next. So each one is pinned to the template it was read from.
    expect(renderPrompt(turn, "chatml")).toBe("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n");
    expect(renderPrompt(turn, "phi")).toBe("<|user|>hi<|end|>\n<|assistant|>");
    expect(renderPrompt(turn, "llama3")).toBe(
      "<|start_header_id|>user<|end_header_id|>\n\nhi<|eot_id|>\n<|start_header_id|>assistant<|end_header_id|>\n\n",
    );
  });

  it("has no markers for `plain`, so an unknown family cuts nothing", () => {
    expect(turnStops("plain")).toEqual([]);
    expect(turnStops("martian" as PromptFamily)).toEqual([]);
    expect(Object.keys(FAMILY_MARKERS).sort()).toEqual(["chatml", "gemma", "llama3", "phi"]);
  });
});

// ── Pictures in a turn (gap B10) ────────────────────────────────────────────────────────────────

describe("the segment form of a prompt", () => {
  const shot: ImagePart = { mime: "image/png", data: new Uint8Array([1, 2, 3]), source: "shot.png" };

  it("puts the picture inside its own turn, after the header and before the words", () => {
    const segments = renderPromptSegments([{ role: "user", content: "what is this?", images: [shot] }], "gemma");
    expect(segments).toEqual([
      { kind: "text", text: "<start_of_turn>user\n" },
      { kind: "image", image: shot },
      { kind: "text", text: "what is this?<end_of_turn>\n<start_of_turn>model\n" },
    ]);
  });

  it("keeps two pictures in the order they were attached, in the turn they came with", () => {
    const second: ImagePart = { mime: "image/png", data: new Uint8Array([9]), source: "b.png" };
    const segments = renderPromptSegments(
      [
        { role: "user", content: "one", images: [shot, second] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
      ],
      "gemma",
    );
    expect(segments.filter((s) => s.kind === "image")).toEqual([
      { kind: "image", image: shot },
      { kind: "image", image: second },
    ]);
    expect(segments[0]).toEqual({ kind: "text", text: "<start_of_turn>user\n" });
    expect(segments[3]?.kind).toBe("text");
  });

  it("is one text segment and nothing else when nothing was attached", () => {
    const segments = renderPromptSegments([{ role: "user", content: "hello" }], "gemma");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: "text", text: renderPrompt([{ role: "user", content: "hello" }], "gemma") });
  });

  it("cuts the plain format the same way, and an unknown family falls back to it", () => {
    const segments = renderPromptSegments([{ role: "user", content: "u", images: [shot] }], "martian" as PromptFamily);
    expect(segments).toEqual([
      { kind: "text", text: "User: " },
      { kind: "image", image: shot },
      { kind: "text", text: "u\n\nAssistant:" },
    ]);
    expect(Object.keys(PROMPT_SEGMENT_TEMPLATES).sort()).toEqual(["chatml", "gemma", "llama3", "phi", "plain"]);
  });
});

describe("the string form, for a task that takes no pictures", () => {
  const shot: ImagePart = { mime: "image/png", data: new Uint8Array([1]), source: "shot.png" };

  it("never drops a picture in silence, even from a caller who forgot to", () => {
    const prompt = renderPrompt([{ role: "user", content: "what is this?", images: [shot] }], "gemma");
    expect(prompt).toContain("A picture was attached (shot.png), but this model cannot see pictures.");
    expect(prompt).toBe("<start_of_turn>user\nwhat is this?\n\n[A picture was attached (shot.png), but this model cannot see pictures.]<end_of_turn>\n<start_of_turn>model\n");
  });

  it("says it once, however many times it is rendered", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi", images: [shot] }];
    const once = renderPrompt(messages, "gemma");
    expect(renderPrompt(withoutImages(messages), "gemma")).toBe(once);
    expect(PROMPT_TEMPLATES.gemma(messages)).toBe(once);
  });
});
