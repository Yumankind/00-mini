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

/** An image travelling with a message: bytes or a base64 string, and its MIME type. Added 2026-09-10
 *  so a vision-capable brain can be shown a picture; providers that cannot take one ignore it and
 *  say so in their readiness/detail rather than failing. */
export interface ImagePart {
  mime: string;
  data: Uint8Array | string;
  /** Where it came from, for the transcript (a workspace path, "screenshot", "camera"). */
  source?: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Optional pictures beside the text (user and tool messages). */
  images?: ImagePart[];
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
  /** Accepts `images` on a message. Absent means text-only. */
  vision?: boolean;
  /** Human name for pickers. */
  label: string;
  /** Rough capability class the router uses: `small` answers fast, `strong` plans and codes. */
  class: "small" | "strong";
  local: boolean;
  supportsTools: boolean;
  contextTokens?: number;
}

/**
 * How far a download has got — TYPED, beside the free-form `detail` (contract revision 2026-09-10).
 *
 * WHY IT IS NOT JUST A NUMBER IN `detail`. The PWA was parsing a percentage out of an English
 * sentence with a regular expression, which means every provider's wording became load-bearing and
 * a rephrasing became a broken progress bar. Bytes are the honest unit for a two-gigabyte model, and
 * `percent` is derived rather than the only field, because a host that sends no `Content-Length`
 * knows how much has arrived and cannot know how much is left. `detail` stays as it was: it is the
 * sentence a person reads, and this is the number a bar draws.
 */
export interface ReadinessProgress {
  loadedBytes: number;
  /** What the host said it would be, when it said. */
  totalBytes?: number;
  /** 0…100, present only when it can be computed honestly. */
  percent?: number;
}

export type Readiness =
  | { ready: true }
  | {
      ready: false;
      reason: "download" | "credential" | "offline" | "unsupported";
      detail?: string;
      /** Set while `reason` is `download` and the provider is actually fetching. */
      progress?: ReadinessProgress;
    };

export interface ModelProvider {
  /** Stable id for settings and the router: `local`, `sponsored`, `overblast`, `byok:<name>`. */
  readonly id: string;
  /** Cheap, no network beyond a cached catalog. */
  models(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  /** What is missing to use it: nothing, a model download, a key, a sign-in, or offline. */
  readiness(): Promise<Readiness>;
  /**
   * Give the machine back what this provider is holding — a compiled WebGPU model, mostly (contract
   * revision 2026-09-10). OPTIONAL, because a provider that holds nothing has nothing to release, and
   * a caller must therefore always call it as `provider.unload?.()`. It is not "close": the provider
   * stays usable and the next request loads again.
   */
  unload?(): Promise<void>;
}
