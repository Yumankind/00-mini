/**
 * THE PROMPT-BASED TOOL FALLBACK — the mechanism a local model gets when it has no native one.
 *
 * WHY IT IS ITS OWN MODULE. Both local brains need it and neither of them can use its own runtime's
 * function calling: web-llm's native path covers only 7B–8B Hermes builds (finding 1 of the handoff
 * Status), and MediaPipe's LLM Inference API at 0.10.29 exposes no function-calling or
 * constrained-decoding surface at all in the web build — `generateResponse(query, listener)` takes a
 * prompt and returns text, and that is the whole door. So the fallback is not a WebLLM detail, it is
 * the shape of local tool use, and it lives where both providers can reach it rather than being
 * copied into the second one where the two would drift.
 *
 * It is a HEURISTIC and it is marked as one everywhere it appears: `usesFallbackTools` on each
 * provider says which path a turn took, so a planner is never told a guess was a contract.
 */

import { parseToolArguments } from "./openai-compatible.js";
import type { ToolCall, ToolSchema } from "./types.js";

/**
 * The instruction a model with no native tool support is given.
 *
 * Deliberately ONE shape rather than several: the parser below accepts more forms than this asks
 * for (a fenced block, a Hermes `<tool_call>` wrapper) because small models imitate whatever they
 * saw in training, but the prompt teaches exactly one so that the common case is the clean case.
 */
export function fallbackToolPrompt(tools: ToolSchema[]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`);
  return [
    "You can use tools. To use one, reply with ONLY this JSON object and nothing else:",
    '{"tool_call": {"name": "<tool name>", "arguments": {<arguments matching the schema>}}}',
    "Do not explain the call, do not wrap it in prose, and call at most one tool per reply.",
    "If no tool is needed, answer normally in plain text.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

/** Every top-level `{…}` in a string, with where it started and ended. String-aware, so a brace inside a quoted value does not end the object. */
function jsonSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push({ start, end: i + 1 });
        start = -1;
      } else if (depth < 0) depth = 0;
    }
  }
  return spans;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toCall(raw: unknown, index: number): ToolCall | null {
  const root = asRecord(raw);
  if (!root) return null;
  const body = asRecord(root.tool_call) ?? asRecord(root.function) ?? root;
  const name = body.name;
  if (typeof name !== "string" || !name) return null;
  const args = body.arguments ?? body.parameters ?? body.input ?? {};
  return {
    id: `call_${index}`,
    name,
    arguments: typeof args === "string" ? parseToolArguments(args) : (asRecord(args) ?? {}),
  };
}

/**
 * Pull tool calls out of a small model's plain text — THE FALLBACK PATH, and it is a heuristic.
 *
 * What it accepts, in the order small models actually produce them: a Hermes-style
 * `<tool_call>{…}</tool_call>` wrapper, a fenced ```json block, and a bare object anywhere in the
 * answer. What it returns as `text` is the answer with those spans removed, so a model that wrote a
 * sentence and then a call does not have the call read twice — once as prose, once as an action.
 */
export function parseFallbackToolCalls(raw: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  // The wrappers go first: their contents are then plain JSON to the span scan below.
  let text = raw.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_match, inner: string) => `\n${inner}\n`);
  text = text.replace(/```(?:json|tool_call)?\s*([\s\S]*?)```/gi, (_match, inner: string) => `\n${inner}\n`);

  const spans = jsonSpans(text);
  const consumed: { start: number; end: number }[] = [];
  for (const span of spans) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(span.start, span.end));
    } catch {
      continue;
    }
    const call = toCall(parsed, calls.length);
    if (!call) continue;
    calls.push(call);
    consumed.push(span);
  }
  let out = text;
  for (const span of consumed.slice().reverse()) out = out.slice(0, span.start) + out.slice(span.end);
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), calls };
}
