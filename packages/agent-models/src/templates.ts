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

/** The families this package knows how to prompt. `plain` is the honest fallback for anything else. */
export type PromptFamily = "gemma" | "plain";

export interface TurnMarkers {
  /** Opens a turn; the role name and a newline follow it. */
  start: string;
  /** Closes a turn. */
  end: string;
  /** What the model's own turns are called (`model` for Gemma, `assistant` for most others). */
  assistantRole: string;
  userRole: string;
}

/** Gemma 3 / 3n / 4 instruction-tuned format, from the model card. See the warning above. */
export const GEMMA_MARKERS: TurnMarkers = {
  start: "<start_of_turn>",
  end: "<end_of_turn>",
  assistantRole: "model",
  userRole: "user",
};

/** How a tool result is written back to a model that has no `tool` role — which is all of them here. */
function toolTurnText(message: ChatMessage): string {
  const which = message.name ?? message.toolCallId ?? "tool";
  return `Result of ${which}:\n${message.content}`;
}

/** An assistant turn that asked for a tool is replayed as the JSON it wrote, so the transcript matches what the model produced. */
function assistantTurnText(message: ChatMessage): string {
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
    out.push({ kind: "text", text: `${markers.start}${role}\n` });
    for (const image of message.images ?? []) out.push({ kind: "image", image });
    out.push({ kind: "text", text: `${text}${markers.end}\n` });
  }
  // A conversation that is nothing but a system prompt still has to reach the model somehow.
  if (systemPending) out.push({ kind: "text", text: `${markers.start}${markers.userRole}\n${systemPending}${markers.end}\n` });
  out.push({ kind: "text", text: `${markers.start}${markers.assistantRole}\n` });
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
  plain: renderPlain,
};

export const PROMPT_TEMPLATES: Record<PromptFamily, (messages: ChatMessage[]) => string> = {
  gemma: (messages) => renderPrompt(messages, "gemma"),
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
  if (family !== "gemma") return -1;
  const hits = [text.indexOf(GEMMA_MARKERS.end), text.indexOf(GEMMA_MARKERS.start)].filter((i) => i !== -1);
  return hits.length ? Math.min(...hits) : -1;
}

/** The longest marker, so a streamer knows how much of its tail could still be half of one. */
export const TURN_MARKER_MAX_LENGTH = Math.max(GEMMA_MARKERS.start.length, GEMMA_MARKERS.end.length);

export function stopAtTurnEnd(text: string, family: PromptFamily): string {
  const at = turnMarkerIndex(text, family);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}
