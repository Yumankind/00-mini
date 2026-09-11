/**
 * TURN FORMATS — because LiteRT takes a PROMPT, not a conversation.
 *
 * MediaPipe's LLM Inference API has one input: `generateResponse(query)`, where `query` is a string
 * (or image/audio parts). There is no `messages` array and no chat template applied for us — the
 * `.task` / `.litertlm` bundle carries the weights and the tokenizer, and the turn markers are the
 * caller's job. Handing a Gemma model a bare "user: …\nassistant:" transcript gets a model that
 * rambles past the end of its answer, because the token it was trained to stop on never appears.
 *
 * ⚠️ THE MARKERS BELOW ARE UNVERIFIED AGAINST LIVE OUTPUT. They are the Gemma instruction-tuned
 * chat format as published on the model card, NOT something read out of the installed package:
 * `@mediapipe/tasks-genai@0.10.29` ships no template, no tokenizer config and no string containing
 * `start_of_turn` anywhere in its bundle or its `.d.ts` (grepped, zero hits). So the first time a
 * real model answers, someone must check three things and fix this file if they differ: that the
 * answer stops on its own, that the markers do not appear in the returned text, and that a second
 * turn is continued rather than restarted. Until then, treat this as the best available guess,
 * which is why it is one small module keyed by family rather than a string buried in the provider.
 *
 * Gemma has NO system role. A system turn is folded into the first user turn — the same compromise
 * every Gemma chat template makes — rather than invented as a fourth role the model never saw.
 *
 * PICTURES (2026-09-10, gap B10). `Prompt` in MediaPipe's own typings is `PromptPart | PromptPart[]`
 * and a `PromptPart` is `string | Image | Audio`, so a multi-modal prompt is this same transcript cut
 * into pieces with the images sitting where they were attached. That is why the renderer's real
 * output is a SEGMENT LIST (`renderPromptSegments`) and the string form is that list with its text
 * joined: one implementation of the turn format, two shapes of it, instead of a second renderer that
 * drifts. A picture goes AFTER its turn's header and BEFORE that turn's text, which is the order
 * Gemma's own multi-modal examples use and the only order in which the words can refer to it.
 */

import { withoutImages } from "./image-parts.js";
import type { ChatMessage, ImagePart } from "./types.js";

/**
 * The families this package knows how to prompt, and — which is the part that matters for the ONNX
 * rows — the families whose END-OF-TURN it knows how to cut at. `plain` is the honest fallback.
 *
 * FOUR FAMILIES, TWO DIFFERENT JOBS (2026-09-11, with the Qwen3.5 / Phi-4 / Llama 3.2 ONNX rows).
 * `LiteRtProvider` uses a family to BUILD a prompt, because MediaPipe takes a string and applies no
 * template. `TransformersProvider` does not: the library's own `apply_chat_template` renders the
 * repo's Jinja template, which is the model's real one rather than our reading of a model card. What
 * that provider still needs a family for is the OTHER half — knowing which markers a model might
 * type as text, so an answer that runs past its own turn is cut instead of shown. So the new families
 * below carry markers that are used for the cut and are correct for the render as well; nothing
 * renders a Qwen or Llama prompt in this package today, and `apply_chat_template` is why.
 */
export type PromptFamily = "gemma" | "chatml" | "phi" | "llama3" | "plain";

export interface TurnMarkers {
  /** Opens a turn; the role name follows it, then `roleSuffix`. */
  start: string;
  /**
   * What comes between the role name and the turn's text. A newline for Gemma and ChatML; Llama 3
   * closes its header with a token of its own (`<|end_header_id|>\n\n`) and Phi closes it with
   * `|>` — the formats differ in the shape of the header, not only in the words.
   */
  roleSuffix?: string;
  /** Closes a turn. */
  end: string;
  /** What the model's own turns are called (`model` for Gemma, `assistant` for most others). */
  assistantRole: string;
  userRole: string;
  /**
   * EVERY STRING THAT MEANS "the turn is over, and what follows is not the answer".
   *
   * Separate from `start`/`end` because the cut and the render are different questions: Phi's header
   * is `<|` + role + `|>`, and scanning a stream for the two characters `<|` would cut an answer that
   * merely mentioned them. Absent ⇒ `[end, start]`, which is exactly what the Gemma cut has always
   * been.
   */
  stops?: string[];
}

/** Gemma 3 / 3n / 4 instruction-tuned format, from the model card. See the warning above. */
export const GEMMA_MARKERS: TurnMarkers = {
  start: "<start_of_turn>",
  end: "<end_of_turn>",
  assistantRole: "model",
  userRole: "user",
};

/**
 * ChatML, which is what the Qwen3.5 ONNX rows speak — read out of their own
 * `chat_template.jinja` on 2026-09-11 (`<|im_start|>role\n … <|im_end|>`), not from memory.
 */
export const CHATML_MARKERS: TurnMarkers = {
  start: "<|im_start|>",
  roleSuffix: "\n",
  end: "<|im_end|>",
  assistantRole: "assistant",
  userRole: "user",
};

/**
 * Phi-4-mini's, read out of `onnx-community/Phi-4-mini-instruct-ONNX`'s `chat_template.jinja`:
 * `{{ '<|' + role + '|>' + content + '<|end|>' }}`, and `<|assistant|>` as the generation prompt.
 * The stop list names the headers in full for the reason `stops` exists.
 */
export const PHI_MARKERS: TurnMarkers = {
  start: "<|",
  roleSuffix: "|>",
  end: "<|end|>",
  assistantRole: "assistant",
  userRole: "user",
  stops: ["<|end|>", "<|user|>", "<|assistant|>", "<|system|>", "<|endoftext|>"],
};

/**
 * Llama 3.x's, read out of `onnx-community/Llama-3.2-3B-Instruct-ONNX`'s `chat_template.jinja`:
 * `<|start_header_id|>role<|end_header_id|>\n\n … <|eot_id|>`. The template writes the BOS token
 * itself, which is why every caller of it passes `add_special_tokens: false`.
 */
export const LLAMA3_MARKERS: TurnMarkers = {
  start: "<|start_header_id|>",
  roleSuffix: "<|end_header_id|>\n\n",
  end: "<|eot_id|>",
  assistantRole: "assistant",
  userRole: "user",
  stops: ["<|eot_id|>", "<|start_header_id|>", "<|end_of_text|>"],
};

/** Every family that has markers at all. `plain` is deliberately absent: it has none, and a lookup
 *  that misses is how an unknown family gets the honest answer rather than Gemma's tokens. */
export const FAMILY_MARKERS: Partial<Record<PromptFamily, TurnMarkers>> = {
  gemma: GEMMA_MARKERS,
  chatml: CHATML_MARKERS,
  phi: PHI_MARKERS,
  llama3: LLAMA3_MARKERS,
};

/** What a stream must watch for in this family. `[end, start]` when the family named nothing else. */
export function turnStops(family: PromptFamily): string[] {
  const markers = FAMILY_MARKERS[family];
  if (!markers) return [];
  return markers.stops ?? [markers.end, markers.start];
}

/**
 * How a tool result is written back to a model that has no `tool` role — which is all of them here.
 *
 * EXPORTED since 2026-09-11, for `transformers.ts`: that provider does not build a marked prompt at
 * all (the library's own `apply_chat_template` does that), but it faces the same two questions — what
 * a tool result reads as, and how an assistant turn that asked for a tool is replayed — and two
 * answers to those would be two wordings of the same transcript.
 */
export function toolTurnText(message: ChatMessage): string {
  const which = message.name ?? message.toolCallId ?? "tool";
  return `Result of ${which}:\n${message.content}`;
}

/** An assistant turn that asked for a tool is replayed as the JSON it wrote, so the transcript matches what the model produced. */
export function assistantTurnText(message: ChatMessage): string {
  if (!message.toolCalls?.length) return message.content;
  const calls = message.toolCalls.map((c) => JSON.stringify({ tool_call: { name: c.name, arguments: c.arguments ?? {} } })).join("\n");
  return message.content ? `${message.content}\n${calls}` : calls;
}

/** A piece of a prompt: text, or a picture that sits at this point in the transcript. */
export type PromptSegment = { kind: "text"; text: string } | { kind: "image"; image: ImagePart };

/** Adjacent text is one segment, so a prompt with no pictures is a list of exactly one. */
function mergeSegments(parts: PromptSegment[]): PromptSegment[] {
  const out: PromptSegment[] = [];
  for (const part of parts) {
    if (part.kind === "text" && !part.text) continue;
    const last = out[out.length - 1];
    if (part.kind === "text" && last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + part.text };
    else out.push(part);
  }
  return out;
}

/**
 * The transcript in the family's turn format, ending with the OPEN model turn — the model is meant
 * to continue the string, so the last thing in it is the header of its own answer.
 */
function renderMarked(messages: ChatMessage[], markers: TurnMarkers): PromptSegment[] {
  // Every system turn is collected first and prefixed to the first user turn: Gemma has no system
  // role, and a system instruction placed after the first user turn is one the model reads late.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean)
    .join("\n\n");

  const out: PromptSegment[] = [];
  let systemPending = system;
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? markers.assistantRole : markers.userRole;
    let text = message.role === "assistant" ? assistantTurnText(message) : message.role === "tool" ? toolTurnText(message) : message.content;
    if (role === markers.userRole && systemPending) {
      text = `${systemPending}\n\n${text}`;
      systemPending = "";
    }
    out.push({ kind: "text", text: `${markers.start}${role}${markers.roleSuffix ?? "\n"}` });
    for (const image of message.images ?? []) out.push({ kind: "image", image });
    out.push({ kind: "text", text: `${text}${markers.end}\n` });
  }
  // A conversation that is nothing but a system prompt still has to reach the model somehow.
  const header = (role: string): string => `${markers.start}${role}${markers.roleSuffix ?? "\n"}`;
  if (systemPending) out.push({ kind: "text", text: `${header(markers.userRole)}${systemPending}${markers.end}\n` });
  out.push({ kind: "text", text: header(markers.assistantRole) });
  return mergeSegments(out);
}

/** No markers at all: a labelled transcript. Wrong for Gemma, right for a model whose format we do not know. */
function renderPlain(messages: ChatMessage[]): PromptSegment[] {
  const label: Record<ChatMessage["role"], string> = { system: "System", user: "User", assistant: "Assistant", tool: "Tool" };
  const out: PromptSegment[] = [];
  for (const [i, m] of messages.entries()) {
    const text = m.role === "assistant" ? assistantTurnText(m) : m.role === "tool" ? toolTurnText(m) : m.content;
    if (i) out.push({ kind: "text", text: "\n\n" });
    out.push({ kind: "text", text: `${label[m.role]}: ` });
    for (const image of m.images ?? []) out.push({ kind: "image", image });
    out.push({ kind: "text", text });
  }
  out.push({ kind: "text", text: "\n\nAssistant:" });
  return mergeSegments(out);
}

export const PROMPT_SEGMENT_TEMPLATES: Record<PromptFamily, (messages: ChatMessage[]) => PromptSegment[]> = {
  gemma: (messages) => renderMarked(messages, GEMMA_MARKERS),
  chatml: (messages) => renderMarked(messages, CHATML_MARKERS),
  phi: (messages) => renderMarked(messages, PHI_MARKERS),
  llama3: (messages) => renderMarked(messages, LLAMA3_MARKERS),
  plain: renderPlain,
};

export const PROMPT_TEMPLATES: Record<PromptFamily, (messages: ChatMessage[]) => string> = {
  gemma: (messages) => renderPrompt(messages, "gemma"),
  chatml: (messages) => renderPrompt(messages, "chatml"),
  phi: (messages) => renderPrompt(messages, "phi"),
  llama3: (messages) => renderPrompt(messages, "llama3"),
  plain: (messages) => renderPrompt(messages, "plain"),
};

/**
 * The transcript in the family's format, cut at its pictures. Unknown families get `plain` rather
 * than Gemma's markers by accident.
 */
export function renderPromptSegments(messages: ChatMessage[], family: PromptFamily = "plain"): PromptSegment[] {
  return (PROMPT_SEGMENT_TEMPLATES[family] ?? renderPlain)(messages);
}

/**
 * The transcript as ONE STRING — for a task that takes no pictures.
 *
 * It drops the images through `withoutImages` first, which is what makes the drop audible: a
 * text-only caller that forgot to do it still gets the note in the prompt rather than a silently
 * picture-less turn (rule 3 of image-parts.ts). Calling it twice is harmless — the second call finds
 * nothing left to drop.
 */
export function renderPrompt(messages: ChatMessage[], family: PromptFamily = "plain"): string {
  const segments = renderPromptSegments(withoutImages(messages), family);
  return segments.map((s) => (s.kind === "text" ? s.text : "")).join("");
}

/**
 * What the model must not be allowed to say back to the runtime.
 *
 * A model that keeps generating past its own `<end_of_turn>` writes the next turn's header into the
 * answer; the provider cuts the text at the first marker rather than showing a person a transcript
 * of a conversation they did not have. The index is exported because a STREAM has to make the same
 * cut on a growing buffer, and a second implementation of it would be the one that disagrees.
 */
export function turnMarkerIndex(text: string, family: PromptFamily): number {
  const hits = turnStops(family)
    .map((stop) => text.indexOf(stop))
    .filter((i) => i !== -1);
  return hits.length ? Math.min(...hits) : -1;
}

/**
 * The longest stop string in this family, so a streamer knows how much of its tail could still be
 * half of one. Per family since 2026-09-11: `<|start_header_id|>` is five characters longer than
 * Gemma's longest, and a hold-back sized for Gemma would stream the first half of it to a reader.
 */
export function turnMarkerMaxLength(family: PromptFamily): number {
  return turnStops(family).reduce((n, stop) => Math.max(n, stop.length), 0);
}

/** Gemma's, kept as a constant because two providers already read it by that name. */
export const TURN_MARKER_MAX_LENGTH = turnMarkerMaxLength("gemma");

export function stopAtTurnEnd(text: string, family: PromptFamily): string {
  const at = turnMarkerIndex(text, family);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}
