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
 */

import type { ChatMessage } from "./types.js";

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

/**
 * The transcript as one string in the family's turn format, ending with the OPEN model turn — the
 * model is meant to continue the string, so the last thing in it is the header of its own answer.
 */
function renderMarked(messages: ChatMessage[], markers: TurnMarkers): string {
  // Every system turn is collected first and prefixed to the first user turn: Gemma has no system
  // role, and a system instruction placed after the first user turn is one the model reads late.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean)
    .join("\n\n");

  const out: string[] = [];
  let systemPending = system;
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? markers.assistantRole : markers.userRole;
    let text = message.role === "assistant" ? assistantTurnText(message) : message.role === "tool" ? toolTurnText(message) : message.content;
    if (role === markers.userRole && systemPending) {
      text = `${systemPending}\n\n${text}`;
      systemPending = "";
    }
    out.push(`${markers.start}${role}\n${text}${markers.end}\n`);
  }
  // A conversation that is nothing but a system prompt still has to reach the model somehow.
  if (systemPending) out.push(`${markers.start}${markers.userRole}\n${systemPending}${markers.end}\n`);
  out.push(`${markers.start}${markers.assistantRole}\n`);
  return out.join("");
}

/** No markers at all: a labelled transcript. Wrong for Gemma, right for a model whose format we do not know. */
function renderPlain(messages: ChatMessage[]): string {
  const label: Record<ChatMessage["role"], string> = { system: "System", user: "User", assistant: "Assistant", tool: "Tool" };
  const lines = messages.map((m) => {
    const text = m.role === "assistant" ? assistantTurnText(m) : m.role === "tool" ? toolTurnText(m) : m.content;
    return `${label[m.role]}: ${text}`;
  });
  return `${lines.join("\n\n")}\n\nAssistant:`;
}

export const PROMPT_TEMPLATES: Record<PromptFamily, (messages: ChatMessage[]) => string> = {
  gemma: (messages) => renderMarked(messages, GEMMA_MARKERS),
  plain: renderPlain,
};

/** The transcript, in the family's format. Unknown families get `plain` rather than Gemma's markers. */
export function renderPrompt(messages: ChatMessage[], family: PromptFamily = "plain"): string {
  return (PROMPT_TEMPLATES[family] ?? renderPlain)(messages);
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
