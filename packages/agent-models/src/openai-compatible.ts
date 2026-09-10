/**
 * THE OPENAI-COMPATIBLE PEER — one implementation, four deployments.
 *
 * Three of the four brains of §6.1 speak this wire and differ only in base URL and credential:
 * sponsoredtokens (`/api/v1`, no bearer at all — a device signature on the fetch, §6.2), the
 * Overblast credits proxy (`<worker>/ai/v1`, `Bearer sk-obd-…`), and BYOK OpenAI / OpenRouter /
 * any custom compatible host. Writing them as one provider with a `fetch` hook rather than three
 * subclasses is what makes the sponsored transport a *transport*: it wraps `fetch` and this file
 * never learns that requests are being signed.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT, since each was a real bug somewhere before it was a rule here:
 *
 *   · TOOL-CALL DELTAS ARE ASSEMBLED, NOT FORWARDED. A streamed tool call arrives as an id in one
 *     chunk, a name in the next and its arguments a character at a time; the neutral `ToolCall`
 *     promises PARSED arguments, so a call is emitted once, whole, after the stream ends.
 *   · COST IS MONEY AND CENTS ARE THE UNIT. OpenRouter (and the Overblast proxy in front of it)
 *     report `usage.cost` in DOLLARS. ×100 once, here, so no client ever shows a bill 100× wrong.
 *   · THE FOOTER IS LIFTED OUT OF THE ANSWER. The sponsored pipeline appends its credit line to the
 *     assistant's own text (`attribution.ts`), and every harness resends its history each turn — so
 *     a footer left in `message.content` would be re-sent forever and paid for in prompt tokens.
 *     `ChatResponse.footer` is where it goes: shown, never fed back.
 */

import {
  ProviderError,
  providerErrorFromResponse,
  providerErrorFromThrow,
  throwIfAborted,
} from "./errors.js";
import { readSse, SSE_DONE } from "./sse.js";
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, ToolCall, Usage } from "./types.js";

/** The only `fetch` shape this package uses. The global one is assignable to it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Readiness = { ready: true } | { ready: false; reason: "download" | "credential" | "offline" | "unsupported"; detail?: string };

/** What a footer extractor gets besides the parsed JSON, so it can work off text or headers too. */
export interface FooterContext {
  /** The assistant text as it stands — the whole answer when buffered, the accumulation when streamed. */
  content: string;
  /** Response headers, when the answer had any (`Sponsored-By` rides here as well as in the text). */
  headers?: Headers;
}

export interface OpenAICompatibleOptions {
  /** Stable id for settings and the router: `sponsored`, `overblast`, `byok:openai`. */
  id: string;
  /** Base including the version segment; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** The transport. The sponsored device signer is exactly this and nothing more. */
  fetch?: FetchLike;
  catalog: ModelInfo[];
  defaultModel: string;
  /** Merged into every request body — `{ usage: { include: true } }` for OpenRouter's cost meter. */
  extraBody?: Record<string, unknown>;
  /**
   * Lift a footer out of an answer. Returning text that is a TAIL of the content also strips it
   * from `message.content`, which is the whole point: shown once, never fed back as history.
   */
  extractFooter?: (json: unknown, ctx: FooterContext) => string | undefined;
  /** Marker form of the same thing: split the tail of the text at the last occurrence of this. */
  footerLead?: string;
  /** Ask for `usage` on the final streamed chunk. Off for hosts that reject the unknown field. */
  streamUsage?: boolean;
  /** False when the credential is not an api key (the sponsored transport signs instead). */
  requiresApiKey?: boolean;
  /** Overrides the default readiness entirely — a device store answers `credential` from disk. */
  readiness?: () => Promise<Readiness>;
}

// ── The neutral shape → the wire ────────────────────────────────────────────────────────────────

interface WireToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) out.name = m.name;
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }));
    }
    return out;
  });
}

function toWireTools(req: ChatRequest): Record<string, unknown> | undefined {
  if (!req.tools?.length) return undefined;
  return {
    tools: req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  };
}

/**
 * Arguments as an object, always.
 *
 * A model that emitted broken JSON asked for nothing this executor can run, and inventing a key to
 * carry the broken text would be a lie about what it asked for — the tool's own schema check is
 * where an empty argument set is refused, with a sentence the model can act on.
 */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The provider's own finish reason → the four the runtime knows.
 *
 * `content_filter` and `abort` land on `error` deliberately: both mean the answer STOPPED SHORT of
 * what was asked for, and a planner that read them as `stop` would treat a truncated turn as a
 * finished one.
 */
export function mapFinishReason(raw: unknown, hasToolCalls: boolean): ChatResponse["finishReason"] {
  const value = typeof raw === "string" ? raw : "";
  switch (value) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return hasToolCalls ? "tool_calls" : "stop";
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return "tool_calls";
    case "length":
    case "max_tokens":
    case "model_length":
      return "length";
    case "content_filter":
    case "abort":
    case "error":
      return "error";
    default:
      return hasToolCalls ? "tool_calls" : "stop";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Usage, with `cost` converted from DOLLARS to cents.
 *
 * OpenRouter reports `usage.cost` in USD and the Overblast proxy passes it through; the neutral
 * `Usage.costCents` is cents. The rounding is to six decimals rather than to a whole cent because a
 * small turn genuinely costs a fraction of one, and a floor to zero would make a session look free.
 */
export function mapUsage(raw: unknown): Usage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cost = usage.cost;
  const out: Usage = {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
  };
  if (typeof cost === "number" && Number.isFinite(cost)) out.costCents = Math.round(cost * 100 * 1e6) / 1e6;
  return out;
}

/** Split a footer off the tail of an answer. Returns the text without it, and the footer. */
export function splitFooter(content: string, lead: string | undefined): { content: string; footer?: string } {
  if (!lead) return { content };
  const at = content.lastIndexOf(lead);
  if (at === -1) return { content };
  // The blank line the pipeline writes before the lead belongs to the footer, not to the answer.
  const body = content.slice(0, at).replace(/\n+$/, "");
  return { content: body, footer: content.slice(at).trim() };
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly doFetch: FetchLike;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async models(): Promise<ModelInfo[]> {
    return this.opts.catalog.slice();
  }

  async readiness(): Promise<Readiness> {
    if (this.opts.readiness) return this.opts.readiness();
    // `navigator.onLine` is only ever trusted in the negative direction: false means there is
    // demonstrably no network, true means nothing at all.
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    if (nav && nav.onLine === false) return { ready: false, reason: "offline" };
    if (this.opts.requiresApiKey !== false && !this.opts.apiKey) {
      return { ready: false, reason: "credential", detail: `${this.id} needs a key.` };
    }
    return { ready: true };
  }

  private url(): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private origin(): string | undefined {
    try {
      return new URL(this.opts.baseUrl).origin;
    } catch {
      return undefined;
    }
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.defaultModel,
      messages: toWireMessages(req.messages),
      stream,
      ...toWireTools(req),
      ...(this.opts.extraBody ?? {}),
    };
    if (typeof req.temperature === "number") body.temperature = req.temperature;
    if (typeof req.maxTokens === "number") body.max_tokens = req.maxTokens;
    // `stream_options` is how an OpenAI-compatible host is asked to put `usage` on the last chunk;
    // without it a streamed turn reports no tokens and no cost at all.
    if (stream && this.opts.streamUsage !== false) body.stream_options = { include_usage: true };
    return body;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    return headers;
  }

  private async send(req: ChatRequest, stream: boolean): Promise<Response> {
    throwIfAborted(this.id, req);
    const body = JSON.stringify(this.buildBody(req, stream));
    let res: Response;
    try {
      res = await this.doFetch(this.url(), { method: "POST", headers: this.headers(), body, signal: req.signal });
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw providerErrorFromResponse({ providerId: this.id, status: res.status, text, headers: res.headers, origin: this.origin() });
    }
    return res;
  }

  private footerOf(json: unknown, content: string, headers?: Headers): { content: string; footer?: string } {
    const hook = this.opts.extractFooter?.(json, { content, headers });
    if (hook) {
      // A hook that returned the tail of the answer means "this part is the footer" — cut it out.
      return content.endsWith(hook) ? { content: content.slice(0, content.length - hook.length).replace(/\n+$/, ""), footer: hook } : { content, footer: hook };
    }
    return splitFooter(content, this.opts.footerLead);
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
    const choice = asRecord((root?.choices as unknown[] | undefined)?.[0]);
    const message = asRecord(choice?.message);
    const rawCalls = Array.isArray(message?.tool_calls) ? (message?.tool_calls as WireToolCall[]) : [];
    const toolCalls: ToolCall[] = rawCalls.map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? "",
      arguments: parseToolArguments(c.function?.arguments),
    }));
    const rawContent = typeof message?.content === "string" ? message.content : "";
    const split = this.footerOf(json, rawContent, res.headers);
    const out: ChatMessage = { role: "assistant", content: split.content };
    if (toolCalls.length) out.toolCalls = toolCalls;
    const response: ChatResponse = {
      message: out,
      usage: mapUsage(root?.usage),
      finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
    };
    if (split.footer) response.footer = split.footer;
    return response;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await this.send(req, true);
    const pending = new Map<number, { id?: string; name: string; args: string }>();
    let content = "";
    let finish: unknown;
    let usage: Usage | undefined;
    let hookFooter: string | undefined;

    try {
      for await (const event of readSse(res, req.signal)) {
        if (req.signal?.aborted) throw providerErrorFromThrow(this.id, new Error("aborted"), req.signal);
        if (!event.data || event.data === SSE_DONE) continue;
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          // A frame that is not JSON is a keep-alive or a proxy's comment. Skipping it is right;
          // failing the turn on it would break every host that writes one.
          continue;
        }
        const root = asRecord(json);
        // The refusal object rides inside a normal chunk on a streaming call (cloud-agents
        // contract, §3a): there is no extra SSE event to trip on, so it is read here.
        const errored = asRecord(root?.error);
        if (errored) {
          throw providerErrorFromResponse({
            providerId: this.id,
            status: Number(errored.status ?? 402) || 402,
            text: JSON.stringify({ error: errored }),
            origin: this.origin(),
          });
        }
        const chunkUsage = mapUsage(root?.usage);
        if (chunkUsage) usage = chunkUsage;
        hookFooter ??= this.opts.extractFooter?.(json, { content, headers: res.headers });
        const choice = asRecord((root?.choices as unknown[] | undefined)?.[0]);
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = asRecord(choice.delta);
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          yield { type: "text", delta: delta.content };
        }
        for (const [i, call] of (Array.isArray(delta.tool_calls) ? (delta.tool_calls as WireToolCall[]) : []).entries()) {
          const index = typeof call.index === "number" ? call.index : i;
          const slot = pending.get(index) ?? { name: "", args: "" };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (typeof call.function?.arguments === "string") slot.args += call.function.arguments;
          pending.set(index, slot);
        }
      }
      // `readSse` returns cleanly when the signal fires — a stream that ended because the person
      // pressed stop is not a finished turn, and must not be filed as one.
      if (req.signal?.aborted) throw providerErrorFromThrow(this.id, new Error("aborted"), req.signal);
    } catch (err) {
      throw providerErrorFromThrow(this.id, err, req.signal);
    }

    const toolCalls: ToolCall[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot]) => ({ id: slot.id ?? `call_${index}`, name: slot.name, arguments: parseToolArguments(slot.args) }));
    for (const call of toolCalls) yield { type: "tool_call", call };

    // The deltas above went out with the footer still in them, ON PURPOSE: the credit line is meant
    // to be read as it arrives. What must not carry it is the message the runtime files as history,
    // which is this one.
    const split = hookFooter
      ? { content: content.endsWith(hookFooter) ? content.slice(0, content.length - hookFooter.length).replace(/\n+$/, "") : content, footer: hookFooter }
      : splitFooter(content, this.opts.footerLead);
    const message: ChatMessage = { role: "assistant", content: split.content };
    if (toolCalls.length) message.toolCalls = toolCalls;
    const response: ChatResponse = { message, usage, finishReason: mapFinishReason(finish, toolCalls.length > 0) };
    if (split.footer) response.footer = split.footer;
    yield { type: "done", response };
  }
}
