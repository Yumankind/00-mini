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
 * ONE LINE PER TOOL, NOT ONE SCHEMA PER TOOL — and this is a size fix, not a style one.
 *
 * `JSON.stringify(t.parameters)` per tool used to be appended to every local turn. For the runtime's
 * own default set that is 8.6 KB of JSON (~2.5k tokens by the /3.5 heuristic) in front of a model
 * whose whole KV cache is 4096 tokens — the prompt alone overflowed the context and the brain failed
 * on every turn, before the conversation had said a word. A signature carries what the model
 * actually needs to emit a call (the argument NAMES, their types, which are optional) at a twentieth
 * of the size; the prose in each argument's own `description` is what gets dropped, and a small
 * model was not reading it anyway.
 *
 * The raw dump stays reachable behind `schemas: true`, for a caller whose model has the room —
 * argument descriptions genuinely help a big model fill an awkward schema, and deleting the option
 * would trade one wrong default for another.
 */
export interface FallbackToolPromptOptions {
  /** Dump the full JSON schema per tool instead of a signature. For big-context models only. */
  schemas?: boolean;
}

/** A row whose `contextTokens` is at least this can afford the schema dump. */
export const FALLBACK_SCHEMAS_MIN_CONTEXT = 16384;
/** How much of a tool's `description` survives: enough for a clause, never a paragraph. */
export const FALLBACK_DESC_MAX = 56;
/** Arguments named before the line ends in `…`. The rare tool with ten options does not get ten. */
export const FALLBACK_ARGS_SHOWN = 4;

/** A JSON-schema property as a type word: `string`, `number[]`, `object`, `any`. */
function typeWord(prop: unknown): string {
  const p = asRecord(prop);
  if (!p) return "any";
  const type = Array.isArray(p.type) ? p.type.filter((t) => typeof t === "string").join("|") : p.type;
  if (typeof type !== "string" || !type) return Array.isArray(p.enum) ? "enum" : "any";
  if (type !== "array") return type;
  const item = asRecord(p.items);
  return typeof item?.type === "string" ? `${item.type}[]` : "array";
}

/** First sentence, capped — the clause that says what the tool IS, with the manual left behind. */
function shortDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const stop = flat.search(/\.(\s|$)/);
  const first = stop === -1 ? flat : flat.slice(0, stop + 1);
  return first.length > FALLBACK_DESC_MAX ? `${first.slice(0, FALLBACK_DESC_MAX - 1).trimEnd()}…` : first;
}

/** `name(arg: type, arg?: type) — what it is`. The whole of what a fallback model is told. */
export function toolSignature(tool: ToolSchema): string {
  const params = asRecord(tool.parameters);
  const properties = asRecord(params?.properties) ?? {};
  const required = new Set((Array.isArray(params?.required) ? params.required : []).filter((n) => typeof n === "string"));
  const names = Object.keys(properties);
  const shown = names
    .slice(0, FALLBACK_ARGS_SHOWN)
    .map((name) => `${name}${required.has(name) ? "" : "?"}: ${typeWord(properties[name])}`);
  if (names.length > FALLBACK_ARGS_SHOWN) shown.push("…");
  const description = shortDescription(tool.description ?? "");
  return `${tool.name}(${shown.join(", ")})${description ? ` — ${description}` : ""}`;
}

/**
 * The instruction a model with no native tool support is given.
 *
 * Deliberately ONE shape rather than several: the parser below accepts more forms than this asks
 * for (a fenced block, a Hermes `<tool_call>` wrapper) because small models imitate whatever they
 * saw in training, but the prompt teaches exactly one so that the common case is the clean case.
 */
export function fallbackToolPrompt(tools: ToolSchema[], opts: FallbackToolPromptOptions = {}): string {
  if (opts.schemas) {
    return [
      "You can use tools. To use one, reply with ONLY this JSON object and nothing else:",
      '{"tool_call": {"name": "<tool name>", "arguments": {<arguments matching the schema>}}}',
      "Do not explain the call, do not wrap it in prose, and call at most one tool per reply.",
      "If no tool is needed, answer normally in plain text.",
      "",
      "Available tools:",
      ...tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`),
    ].join("\n");
  }
  return [
    "To use a tool, reply with ONLY:",
    '{"tool_call": {"name": "<name>", "arguments": {<args>}}}',
    "One call per reply, no prose; otherwise answer in plain text.",
    "Tools (`?` = optional, `…` = more optional args):",
    ...tools.map(toolSignature),
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
/** JSON with sorted keys, so two spellings of the same arguments compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
    consumed.push(span);
    // A small model that has decided on a call often writes it three, six, twelve times in one
    // message (seen with `remember` on 2026-09-11). Twelve identical writes are one decision: the
    // repeats are consumed out of the text and not run again.
    if (calls.some((c) => c.name === call.name && stableJson(c.arguments) === stableJson(call.arguments))) continue;
    calls.push(call);
  }
  let out = text;
  for (const span of consumed.slice().reverse()) out = out.slice(0, span.start) + out.slice(span.end);
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), calls };
}
