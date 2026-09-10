/**
 * The runtime's public surface — FROZEN CONTRACT for Phase 0/1 (docs/HANDOFF-infinite-agent.md §2, §4).
 *
 * The PWA (apps/infinite/src) and the embed (apps/infinite/embed) are written against this and
 * nothing deeper. Change this file only with those owners in the loop.
 */
import type { AgentFs } from "@00/agent-fs";
import type { ModelProvider, ToolSchema, ChatMessage, Usage } from "@00/agent-models";

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
  | { type: "model_started"; providerId: string; model?: string }
  | { type: "model_completed"; providerId: string; usage?: Usage; footer?: string }
  | { type: "agent_message"; text: string; final: boolean }
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
  on(listener: (event: AgentEvent) => void): () => void;
  listSessions(): Promise<{ id: string; title: string; updatedAt: number }[]>;
  loadSession(id: string): Promise<ChatMessage[]>;
  abort(): void;
}
