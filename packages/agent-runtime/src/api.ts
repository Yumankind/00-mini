/**
 * The runtime's public surface — FROZEN CONTRACT for Phase 0/1 (docs/HANDOFF-infinite-agent.md §2, §4).
 *
 * The PWA (apps/infinite/src) and the embed (apps/infinite/embed) are written against this and
 * nothing deeper. Change this file only with those owners in the loop.
 */
import type { AgentFs } from "@00/agent-fs";
import type { ModelClass, ModelProvider, ToolSchema, ChatMessage, Usage } from "@00/agent-models";

/**
 * THE VAULT IS PART OF THE SURFACE (contract revision 2026-09-10, finding 4).
 *
 * It was reachable only from this package's own `index.ts`, which made the frozen file a contract
 * with a hole in it: the PWA's boot builds a vault, holds it for the life of the session and shows
 * its state on three screens, and could not name its type without reaching past the contract. Types
 * only — `createVault` stays where it is.
 */
export type { Vault, VaultErrorCode, VaultFile, VaultOptions, VaultStore } from "./vault.js";

export type PermissionTier = "safe" | "confirm" | "high-risk";

export interface ToolContext {
  fs: AgentFs;
  /** Workspace-relative sandbox root the tool may touch (`workspace` for the full agent, a thread folder for the light one). */
  sandbox: string;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
}

export interface Tool {
  schema: ToolSchema;
  tier: PermissionTier;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; isError?: boolean }>;
}

export type AgentEvent =
  /**
   * `brainClass` (added additively, class-aware routing 2026-09-10) is the class this call was
   * ACTUALLY answered in, not the one that was asked for: a run that wanted `strong` on a machine
   * where only the small local brain is ready says `small` here. Optional, so a consumer written
   * against the previous union still compiles and a consumer that wants to draw the chip can.
   */
  | { type: "model_started"; providerId: string; model?: string; brainClass?: ModelClass }
  | { type: "model_completed"; providerId: string; usage?: Usage; footer?: string }
  /**
   * A streamed increment of the answer being written. Never the whole thing, never repeated.
   * (Contract revision 2026-09-10: `agent_message` used to carry both readings behind a boolean, and
   * every consumer had to guess whether a `final` event repeated the stream or added to it.)
   */
  | { type: "agent_delta"; text: string }
  /**
   * ONE assistant message, WHOLE, once. It arrives after any deltas of the same message and repeats
   * them — a consumer that accumulated deltas replaces its accumulation with this text rather than
   * appending it. `final` is `true` on every one of them: it is what makes the two events tell apart
   * at a glance, and what keeps a reducer written against the old union compiling.
   */
  | { type: "agent_message"; text: string; final: true }
  | { type: "tool_started"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool_completed"; callId: string; name: string; output: string; ms: number }
  | { type: "tool_failed"; callId: string; name: string; error: string }
  | { type: "permission_requested"; callId: string; name: string; tier: PermissionTier; args: Record<string, unknown> }
  | { type: "permission_answered"; callId: string; allowed: boolean; remember?: "session" | "always" }
  | { type: "file_changed"; path: string; op: "write" | "delete" | "rename" }
  | { type: "command_started"; command: string }
  | { type: "command_completed"; command: string; exitCode: number }
  | { type: "error"; message: string };

export interface PermissionDecision {
  allowed: boolean;
  remember?: "session" | "always";
}

export interface RunOptions {
  prompt: string;
  /** Workspace-relative folder the run works in; `workspace` by default. */
  workspace?: string;
  /** Provider id or `auto` (the router picks). */
  model?: string;
  /**
   * WHICH CLASS OF BRAIN THIS RUN WANTS — `auto` by default (class-aware routing 2026-09-10, §6).
   *
   * `auto` does NOT mean one class for the run: the runtime derives a class PER MODEL CALL from the
   * shape of that call (`classifyCall` in brain-class.ts — a tool-less short question is `small`,
   * planning over a tool result is `strong`), and the picker takes the first ready provider that
   * offers it. `small` and `strong` force it for every call of the run instead.
   *
   * It is a preference and never a cap. When no ready provider offers the class asked for, the run
   * still happens on what IS ready, and `model_started.brainClass` says which class answered.
   */
  brain?: "auto" | "small" | "strong";
  /** Tool names; all registered tools by default. */
  tools?: string[];
  maxSteps?: number;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  sessionId: string;
  text: string;
  steps: number;
  usage: Usage;
  stopped: "final" | "max_steps" | "aborted" | "error";
  /**
   * Which brain actually answered, and on which model (contract revision 2026-09-10). The LAST one
   * of the run, because a run that switched brains mid-way ended on this one — and because the
   * agent still never learns any of it: this is the caller's receipt, not the model's context.
   * Absent when no provider was reached at all (an abort before the first step).
   */
  providerId?: string;
  model?: string;
}

export interface AgentRuntimeOptions {
  fs: AgentFs;
  providers: ModelProvider[];
  tools: Tool[];
  /** Asked for every `confirm` and `high-risk` call the standing permissions do not already answer. */
  askPermission(req: { name: string; tier: PermissionTier; args: Record<string, unknown> }): Promise<PermissionDecision>;
  /** `full` reads the identity files and the operator's memory; `light` reads only `public/` and its thread folder. */
  trust: "full" | "light";
}

export interface AgentRuntime {
  run(opts: RunOptions): Promise<RunResult>;
  /**
   * Change the brains behind this runtime without rebuilding it (contract revision 2026-09-10).
   *
   * WHEN IT TAKES EFFECT, AND WHY THAT AND NOT SOONER: at the NEXT `run()`. A run in flight keeps
   * the list it started with, because a turn whose first half was planned by one model and whose
   * second half is answered by another is not a fallback, it is a corrupted turn — the same rule the
   * models router applies to a stream it has already emitted from. A caller who wants the change to
   * bite now calls `abort()` first, and that is a decision they make out loud.
   *
   * Listeners survive: `on()` is subscribed once, at mount, and never learns that the brain changed.
   * An empty list throws, exactly as the constructor does — a runtime with no provider cannot run.
   */
  setProviders(providers: ModelProvider[]): void;
  on(listener: (event: AgentEvent) => void): () => void;
  listSessions(): Promise<{ id: string; title: string; updatedAt: number }[]>;
  loadSession(id: string): Promise<ChatMessage[]>;
  abort(): void;
}
