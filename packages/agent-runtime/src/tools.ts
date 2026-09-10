/**
 * THE TWO TOOL SETS, and the boundary between them.
 *
 * `fullTools()` is the agent you own: your workspace, your shell, your memory, your repos.
 * `lightTools()` is the agent on someone else's website: read-only, inside ONE conversation's
 * folder, plus `read_public` — which is the only thing it can see of the operator's workspace
 * (docs/agent-layout.md, "Trust & isolation"; docs/HANDOFF-infinite-agent.md §5.2.2).
 *
 * The light list is a SECURITY-CRITICAL ALLOWLIST, in the engine's words (light-tools.ts): never add
 * shell, write, memory, git, secrets or anything that reaches another conversation. It is short on
 * purpose, and short is the feature. The site tools of §5.2.2 (`site_search`, `page_highlight`, …)
 * are the embed's, not the runtime's — they need a DOM and this package has none, so the embed
 * registers them alongside these.
 *
 * ┌─ `bash` IS NO LONGER ALWAYS REGISTERED (A5, 2026-09-10) — and this reverses a decision ───────┐
 * │ tools-shell.ts argues, at length and correctly, that a command this host cannot run should be │
 * │ SHOWN as "wakes on your Mac" rather than hidden. The audit then watched a real agent say, out │
 * │ loud, that it was "executing bash commands" — because a registered tool IS a claim of ability, │
 * │ and no description talks a model out of using a tool it can see. The plan's rule ("never      │
 * │ hidden, never deleted") is about the operator's own TOOLS FOLDER, where a `tools/<name>.json` │
 * │ this host cannot run must still be listed; it was over-applied to a capability that simply is │
 * │ not here.                                                                                     │
 * │ So: a real `Shell` (`available: true`) gets `bash` registered exactly as before; `NoShell`, or │
 * │ no shell at all, gets NO TOOL and a prompt paragraph that says so by name and points at the    │
 * │ file tools instead (prompt-text.ts). `NoShell` and `bashTool` are still exported, so a host    │
 * │ that wants the explaining stub — a preview of what the Mac would do — registers it itself.     │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 */
import type { AgentFs } from "@00/agent-fs";
import type { NetworkPolicy, SecretsAccess, Tool } from "./api.js";
import { createWorkspaceIndex, type WorkspaceIndex } from "./retrieval/workspace-index.js";
import {
  SeenFiles,
  copyTool,
  deleteTool,
  editTool,
  findTool,
  grepTool,
  lsTool,
  moveTool,
  readPublicTool,
  readTool,
  statTool,
  writeTool,
} from "./tools-fs.js";
import { gitTools, type GitOps } from "./tools-git.js";
import { rememberTool } from "./tools-memory.js";
import { httpGetTool } from "./tools-net.js";
import { finishOnboardingTool } from "./tools-onboarding.js";
import { searchWorkspaceTool } from "./tools-search.js";
import { listSecretsTool } from "./tools-secrets.js";
import { bashTool, type Shell } from "./tools-shell.js";

export interface FullToolsOptions {
  /**
   * The shell, when this host HAS one. Absent (or a `Shell` whose `available` is false) means no
   * `bash` tool at all — see the box above.
   */
  shell?: Shell;
  /** Absent = no git tools at all, rather than five tools that fail. */
  git?: GitOps;
  /** Share it with the runtime so a new session starts with a clean read-before-overwrite guard. */
  seen?: SeenFiles;
  /**
   * Retrieval. Pass the index the host also feeds `file_changed` to; pass `false` for no
   * `search_workspace` at all. Absent builds one over `workspace`, because an agent that cannot
   * search its own memory is the gap this closed (B14) and a default of "off" would leave it open.
   */
  index?: WorkspaceIndex | false;
  /** The filesystem the default index walks. Ignored when `index` is given. */
  fs?: AgentFs;
  /** Where `search_workspace` looks; the agent's sandbox by default. */
  workspace?: string;
  /** Wire the vault and `list_secrets` appears. Values are still resolved by the loop, not here. */
  secrets?: SecretsAccess;
  /** Wire a policy (even an empty one) and `http_get` appears. Absent = no network tool. */
  network?: NetworkPolicy;
  /** For a test, or a host whose fetch is not the global one. Only used with `network`. */
  fetch?: typeof globalThis.fetch;
  /** `false` leaves `finish_onboarding` out; it is on by default, and harmless once setup is done. */
  onboarding?: boolean;
  now?: () => Date;
}

export function fullTools(opts: FullToolsOptions = {}): Tool[] {
  const seen = opts.seen ?? new SeenFiles();
  const shell = opts.shell;
  const index =
    opts.index === false
      ? null
      : (opts.index ?? (opts.fs ? createWorkspaceIndex(opts.fs, { root: opts.workspace ?? "workspace" }) : null));
  return [
    readTool(seen),
    writeTool(seen),
    editTool(seen),
    lsTool(),
    grepTool(),
    findTool(),
    statTool(),
    deleteTool(),
    moveTool(),
    copyTool(),
    ...(shell?.available ? [bashTool(shell)] : []),
    rememberTool({ now: opts.now }),
    ...(index ? [searchWorkspaceTool(index)] : []),
    ...(opts.secrets ? [listSecretsTool()] : []),
    ...(opts.network ? [httpGetTool({ policy: opts.network, ...(opts.fetch ? { fetch: opts.fetch } : {}) })] : []),
    ...(opts.onboarding === false ? [] : [finishOnboardingTool()]),
    ...(opts.git ? gitTools(opts.git) : []),
  ];
}

export interface LightToolsOptions {
  /** Where `workspace/public/` lives; only a test moves it. */
  publicDir?: string;
}

export function lightTools(opts: LightToolsOptions = {}): Tool[] {
  return [readTool(), lsTool(), grepTool(), findTool(), readPublicTool(opts.publicDir)];
}

/** The light allowlist as NAMES, so a caller can assert on it without building the tools. */
export const LIGHT_TOOL_NAMES = ["read", "ls", "grep", "find", "read_public"] as const;
