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
 */
import type { Tool } from "./api.js";
import { SeenFiles, editTool, findTool, grepTool, lsTool, readPublicTool, readTool, writeTool } from "./tools-fs.js";
import { gitTools, type GitOps } from "./tools-git.js";
import { rememberTool } from "./tools-memory.js";
import { NoShell, bashTool, type Shell } from "./tools-shell.js";

export interface FullToolsOptions {
  /** Defaults to `NoShell`, whose answer names the Mac. */
  shell?: Shell;
  /** Absent = no git tools at all, rather than five tools that fail. */
  git?: GitOps;
  /** Share it with the runtime so a new session starts with a clean read-before-overwrite guard. */
  seen?: SeenFiles;
  now?: () => Date;
}

export function fullTools(opts: FullToolsOptions = {}): Tool[] {
  const seen = opts.seen ?? new SeenFiles();
  return [
    readTool(seen),
    writeTool(seen),
    editTool(seen),
    lsTool(),
    grepTool(),
    findTool(),
    bashTool(opts.shell ?? NoShell),
    rememberTool({ now: opts.now }),
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
