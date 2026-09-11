/**
 * ModelProvider — FROZEN CONTRACT for Phase 0 (docs/HANDOFF-infinite-agent.md §6).
 *
 * One neutral chat shape with tool calls; every provider (WebLLM, OpenAI-compatible over any base
 * URL, the sponsoredtokens device-signed transport) maps to and from it. The runtime never sees a
 * provider's own wire format and never knows which provider answered. Change this file only with
 * the other packages' owners in the loop.
 */

import type { Host } from "@00/shared";

/**
 * WHICH HARNESSES A ROW MAY BE OFFERED ON — one definition, shared with the Mac side.
 *
 * `Host` lives in `@00/shared` (packages/shared/src/models.ts) rather than here, because the Mac
 * engine's model catalogue carries the same field and two definitions of the same four words is how
 * two pickers start disagreeing about what a phone is. Re-exported so a browser package that already
 * imports from here does not need a second import for one word.
 */
export type { Host } from "@00/shared";
export { HOSTS, isHost } from "@00/shared";

/**
 * A row nobody has classified is desktop-only.
 *
 * THE CONSERVATIVE READING, and it is deliberate: a mirror may serve a row this package has never
 * heard of (`mergeMirrorCatalog` offers it anyway, with its numbers derived), and the one thing that
 * must never happen is a three-gigabyte model appearing on a phone because a field was missing. So
 * absence means `browser-desktop` and nothing else, everywhere a browser reads it.
 */
export const DEFAULT_HOSTS: readonly Host[] = ["browser-desktop"];

/** The harnesses this row may be offered on, with the default above when it names none. */
export function hostsOf(row: { hosts?: readonly Host[] }): readonly Host[] {
  return row.hosts?.length ? row.hosts : DEFAULT_HOSTS;
}

/** Can this row be offered on that harness? The ONE gate a picker asks (§12.6 is `browser-phone`). */
export function offeredOn(row: { hosts?: readonly Host[] }, host: Host): boolean {
  return hostsOf(row).includes(host);
}

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
  /**
   * The harnesses this row may be OFFERED on (additive, 2026-09-11). Readiness stays the runtime
   * truth: a row listed for `browser-desktop` may still need a download, and a row listed for a
   * harness whose browser has no WebGPU is still refused by `readiness()`. Absent means
   * `DEFAULT_HOSTS` — desktop only — wherever a browser reads it; see the constant.
   */
  hosts?: Host[];
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
  /**
   * Which wait this is (additive, 2026-09-11). `download` is bytes arriving; `load` is the bytes in
   * hand and the runtime compiling them for the GPU — a wait with no byte count, which used to show
   * as a download stuck at 100 %. `paused` is a download that was stopped or cut off, with the bytes
   * so far kept on disk; it resumes with the next load. Absent means `download`, as every older
   * provider meant.
   */
  phase?: "download" | "load" | "paused";
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
  /**
   * Stop a download or a compile that is in flight (additive, 2026-09-11 — Bruno: "Stop in the
   * composer should stop any generation and any download / install of a model"). A pending `load()`
   * rejects with an abort error, the bytes already fetched stay in the cache (a later load resumes
   * from there), a task that arrives after the abort is closed rather than kept. A no-op when
   * nothing is loading. Optional: a remote provider has nothing to abort.
   */
  abortLoad?(): void;
}
