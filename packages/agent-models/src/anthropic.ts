/**
 * ANTHROPIC — the one BYOK vendor that is not OpenAI-shaped, so it gets its own provider.
 *
 * `/v1/messages` differs from `/chat/completions` in four ways that cannot be papered over with a
 * base URL, which is why this is a second implementation rather than a third set of options:
 *
 *   · SYSTEM IS NOT A MESSAGE. It is a top-level `system` string; a `{role:"system"}` entry in the
 *     array is a 400.
 *   · CONTENT IS BLOCKS. An assistant turn that called a tool is `[{type:"text"},{type:"tool_use"}]`
 *     and a tool RESULT is a `user` turn holding `[{type:"tool_result", tool_use_id}]` — there is no
 *     `tool` role at all.
 *   · ARGUMENTS ARE AN OBJECT ON THE WIRE. `tool_use.input` is already JSON, not a string that
 *     needs parsing — except while streaming, where it arrives as `input_json_delta` text.
 *   · `max_tokens` IS REQUIRED. A request without one is refused, so this file has a default rather
 *     than letting a caller who omitted it discover that on the wire.
 *
 * `anthropic-dangerous-direct-browser-access: true` is what makes the call answerable from a page at
 * all: without it the API sends no CORS headers and the browser refuses the response before we see
 * it. The header's name is the vendor saying what it is — the person's own key, in the person's own
 * browser, sealed in the vault of §4.5 and never an embed's (§6.1 level 3 vs §6.2). Nothing in this
 * package ever puts a key on a page it does not own.
 */

import { ProviderError, providerErrorFromResponse, providerErrorFromThrow, throwIfAborted } from "./errors.js";
import { mapFinishReason, parseToolArguments } from "./openai-compatible.js";
import type { FetchLike, Readiness } from "./openai-compatible.js";
import { readSse } from "./sse.js";
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall, Usage } from "./types.js";

/** The version header every `/v1/messages` call carries. Pinned, not negotiated. */
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

/** Anthropic refuses a request with no `max_tokens`, so one is always sent. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  catalog: ModelInfo[];
  defaultModel: string;
  maxTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

type Block = Record<string, unknown>;

/**
 * The neutral history → Anthropic's `{ system, messages }`.
 *
 * Consecutive tool results are merged into ONE user turn: the API refuses two user turns in a row,
 * and a planner that ran three tools in a turn produces exactly that shape.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: Record<string, unknown>[] } {
  const systems: string[] = [];
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systems.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) (last.content as Block[]).push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system: systems.length ? systems.join("\n\n") : undefined, messages: out };
}

/** Read the answer's content blocks into neutral text plus tool calls. */
export function readAnthropicContent(content: unknown): { text: string; toolCalls: ToolCall[] } {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
        name: typeof block.name === "string" ? block.name : "",
        arguments: asRecord(block.input) ?? {},
      });
    }
  }
  return { text, toolCalls };
}

function anthropicUsage(raw: unknown, carry?: Usage): Usage | undefined {
  const usage = asRecord(raw);
  if (!usage) return carry;
  const input = Number(usage.input_tokens ?? carry?.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? carry?.outputTokens ?? 0);
  return { inputTokens: Number.isFinite(input) ? input : 0, outputTokens: Number.isFinite(output) ? output : 0 };
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly opts: AnthropicProviderOptions;
  private readonly doFetch: FetchLike;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = opts;
    this.id = opts.id ?? "byok:anthropic";
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async models(): Promise<ModelInfo[]> {
    return this.opts.catalog.slice();
  }

  async readiness(): Promise<Readiness> {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    if (nav && nav.onLine === false) return { ready: false, reason: "offline" };
    if (!this.opts.apiKey) return { ready: false, reason: "credential", detail: "Anthropic needs your own API key." };
    return { ready: true };
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      // The vendor's own name for "yes, this is a browser and I meant it": without it the API sends
      // no CORS headers and a page never sees the answer.
      "anthropic-dangerous-direct-browser-access": "true",
      ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
      ...(this.opts.headers ?? {}),
    };
  }

  private async send(req: ChatRequest, stream: boolean): Promise<Response> {
    throwIfAborted(this.id, req);
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.defaultModel,
      messages,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream,
    };
    if (system) body.system = system;
    if (typeof req.temperature === "number") body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const url = `${(this.opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/messages`;
    let res: Response;
    try {
      res = await this.doFetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw providerErrorFromResponse({ providerId: this.id, status: res.status, text, headers: res.headers });
    }
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.send(req, false);
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new ProviderError({ status: res.status, code: "server_error", message: `${this.id} answered with something that is not JSON.`, providerId: this.id, cause: err });
    }
    const root = asRecord(json);
    const { text, toolCalls } = readAnthropicContent(root?.content);
    const message: ChatMessage = { role: "assistant", content: text };
    if (toolCalls.length) message.toolCalls = toolCalls;
    return {
      message,
      usage: anthropicUsage(root?.usage),
      finishReason: mapFinishReason(root?.stop_reason, toolCalls.length > 0),
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await this.send(req, true);
    // One slot per content block index. A `tool_use` block's arguments arrive as `input_json_delta`
    // text, so they are assembled and parsed once, at the end — the same rule the OpenAI path keeps.
    const blocks = new Map<number, { kind: "text" | "tool_use"; id: string; name: string; args: string }>();
    let text = "";
    let stopReason: unknown;
    let usage: Usage | undefined;

    try {
      for await (const event of readSse(res, req.signal)) {
        if (req.signal?.aborted) throw providerErrorFromThrow(this.id, new Error("aborted"), req.signal);
        if (!event.data) continue;
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          continue;
        }
        const root = asRecord(json);
        if (!root) continue;
        const type = typeof root.type === "string" ? root.type : event.event;
        if (type === "error") {
          const err = asRecord(root.error);
          throw providerErrorFromResponse({ providerId: this.id, status: 500, text: JSON.stringify({ error: err ?? root }) });
        }
        if (type === "message_start") {
          usage = anthropicUsage(asRecord(root.message)?.usage, usage);
          continue;
        }
        if (type === "content_block_start") {
          const index = Number(root.index ?? 0);
          const block = asRecord(root.content_block);
          if (block?.type === "tool_use") {
            blocks.set(index, {
              kind: "tool_use",
              id: typeof block.id === "string" ? block.id : `call_${index}`,
              name: typeof block.name === "string" ? block.name : "",
              args: "",
            });
          } else {
            blocks.set(index, { kind: "text", id: "", name: "", args: "" });
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = Number(root.index ?? 0);
          const delta = asRecord(root.delta);
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            text += delta.text;
            yield { type: "text", delta: delta.text };
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const slot = blocks.get(index) ?? { kind: "tool_use" as const, id: `call_${index}`, name: "", args: "" };
            slot.args += delta.partial_json;
            blocks.set(index, slot);
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = asRecord(root.delta);
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          usage = anthropicUsage(root.usage, usage);
        }
      }
      // See the same line in `openai-compatible.ts`: `readSse` ends quietly on an abort.
      if (req.signal?.aborted) throw providerErrorFromThrow(this.id, new Error("aborted"), req.signal);
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }

    const toolCalls: ToolCall[] = [...blocks.entries()]
      .filter(([, slot]) => slot.kind === "tool_use")
      .sort((a, b) => a[0] - b[0])
      .map(([, slot]) => ({ id: slot.id, name: slot.name, arguments: parseToolArguments(slot.args) }));
    for (const call of toolCalls) yield { type: "tool_call", call };

    const message: ChatMessage = { role: "assistant", content: text };
    if (toolCalls.length) message.toolCalls = toolCalls;
    yield { type: "done", response: { message, usage, finishReason: mapFinishReason(stopReason, toolCalls.length > 0) } };
  }
}
