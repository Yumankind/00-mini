/**
 * ModelProvider — FROZEN CONTRACT for Phase 0 (docs/HANDOFF-infinite-agent.md §6).
 *
 * One neutral chat shape with tool calls; every provider (WebLLM, OpenAI-compatible over any base
 * URL, the sponsoredtokens device-signed transport) maps to and from it. The runtime never sees a
 * provider's own wire format and never knows which provider answered. Change this file only with
 * the other packages' owners in the loop.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments; a provider that streams text arguments parses before emitting. */
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant only */
  toolCalls?: ToolCall[];
  /** tool only: which call this answers */
  toolCallId?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** Provider-specific model id; the router fills it when absent. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Money, in cents, when the provider reports it (credits, sponsored); undefined otherwise. */
  costCents?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: Usage;
  finishReason: "stop" | "tool_calls" | "length" | "error";
  /** Free-form text the provider attaches under an answer (the sponsor footer). Shown, never fed back. */
  footer?: string;
}

export type ChatChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; response: ChatResponse };

export interface ModelInfo {
  id: string;
  /** Human name for pickers. */
  label: string;
  /** Rough capability class the router uses: `small` answers fast, `strong` plans and codes. */
  class: "small" | "strong";
  local: boolean;
  supportsTools: boolean;
  contextTokens?: number;
}

export interface ModelProvider {
  /** Stable id for settings and the router: `local`, `sponsored`, `overblast`, `byok:<name>`. */
  readonly id: string;
  /** Cheap, no network beyond a cached catalog. */
  models(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  /** What is missing to use it: nothing, a model download, a key, a sign-in, or offline. */
  readiness(): Promise<{ ready: true } | { ready: false; reason: "download" | "credential" | "offline" | "unsupported"; detail?: string }>;
}
