/**
 * The runtime's public surface — FROZEN CONTRACT for Phase 0/1 (docs/HANDOFF-infinite-agent.md §2, §4).
 *
 * The PWA (apps/infinite/src) and the embed (apps/infinite/embed) are written against this and
 * nothing deeper. Change this file only with those owners in the loop.
 */
import type { AgentFs } from "@00/agent-fs";
import type { ImagePart, ModelClass, ModelProvider, ToolSchema, ChatMessage, Usage } from "@00/agent-models";

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

/**
 * THE VAULT, AS A TOOL SEES IT (additive, gap B12 — 2026-09-10).
 *
 * Names are readable whether or not the vault is unlocked, because a name is not a secret and an
 * agent that cannot even say "you have an OPENAI_API_KEY, and your vault is locked" is an agent that
 * looks broken. `get` answers `null` rather than throwing for both "no such name" and "locked": a
 * tool asking for a value it cannot have is an ordinary refusal to report, not an exception to crash
 * on, and the two cases are deliberately indistinguishable to a MODEL (see `resolveSecretArgs`).
 */
export interface SecretsAccess {
  names(): Promise<string[]>;
  get(name: string): Promise<string | null>;
}

export interface ToolContext {
  fs: AgentFs;
  /** Workspace-relative sandbox root the tool may touch (`workspace` for the full agent, a thread folder for the light one). */
  sandbox: string;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  /** The operator's vault, when the host wired one (additive). Absent = no secrets on this host. */
  secrets?: SecretsAccess;
}

/**
 * What a tool hands back. `images` is additive (gap B10, 2026-09-10): a tool that read a PICTURE
 * puts the bytes here and the loop carries them to the provider on the tool result message, instead
 * of a tool inventing a description of an image nobody looked at.
 */
export interface ToolResult {
  output: string;
  isError?: boolean;
  images?: ImagePart[];
}

export interface Tool {
  schema: ToolSchema;
  tier: PermissionTier;
  /**
   * THE TIER FOR THESE ARGUMENTS, when it is not the same for all of them (additive, gap B17).
   *
   * `tier` is what the tool MEANS and stays the answer for most calls. A few tools mean different
   * things depending on what they are pointed at — deleting a file is `confirm`, deleting a folder
   * is `high-risk`; a checkout is `confirm`, a FORCED checkout throws away work that was never
   * committed. Returning a tier per call is how those get the tier they deserve without splitting
   * one tool into two names the models would then have to choose between.
   *
   * It may never LOWER the tier below `tier`: the loop takes the stricter of the two, so a tool
   * cannot talk its way out of a confirmation.
   */
  tierFor?(args: Record<string, unknown>, ctx: ToolContext): PermissionTier | Promise<PermissionTier>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
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

/**
 * WHERE A TOOL MAY GO ON THE NETWORK — the first network policy this runtime has (gap B17).
 *
 * One field, and it is an ALLOW list rather than a block list, because the only safe default for an
 * agent in a browser is "nowhere without being asked". A host on it is a `safe` fetch; a host off it
 * is not refused (an agent that cannot read a page it was given the link to is a poor agent) — it is
 * a `confirm`, so the person sees the URL before it is dialled. Entries are HOSTS (`example.com`),
 * matching that host and its subdomains; `*` means every host, which is a thing an owner may
 * legitimately choose for their own browser and must never be the default.
 */
export interface NetworkPolicy {
  allow: string[];
}

export interface AgentRuntimeOptions {
  fs: AgentFs;
  providers: ModelProvider[];
  tools: Tool[];
  /** Asked for every `confirm` and `high-risk` call the standing permissions do not already answer. */
  askPermission(req: { name: string; tier: PermissionTier; args: Record<string, unknown> }): Promise<PermissionDecision>;
  /** `full` reads the identity files and the operator's memory; `light` reads only `public/` and its thread folder. */
  trust: "full" | "light";
  /**
   * The operator's vault, handed to every tool through `ToolContext.secrets` (additive, gap B12).
   *
   * It is a runtime option rather than a tool option because the VALUE RESOLUTION is the loop's job,
   * not a tool's: `${secret:NAME}` in any string argument is replaced immediately before `run`, and
   * any secret value that comes back in the output is put back to `${secret:NAME}` before the model
   * or the session file ever sees it. A tool cannot be trusted to do that; the one place that
   * touches every call can.
   */
  secrets?: SecretsAccess;
  /** Passed to the network tools this runtime registers. Absent = the empty allow list. */
  network?: NetworkPolicy;
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
