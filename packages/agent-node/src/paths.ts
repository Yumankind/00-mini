/**
 * Two path worlds, and the one function that crosses between them.
 *
 * WHY. `AgentFs` speaks paths relative to the agent root, with no leading `/` and no `..`
 * (`packages/agent-fs/src/types.ts`, a frozen contract). Node speaks absolute POSIX paths. A script
 * that says `/app.js` means "the workspace root", not the machine's root, and a script that says
 * `../../vault.json` means an escape attempt. So this module owns:
 *
 *   - `normalizeAbs` / `resolveAbs` — POSIX semantics over the VIRTUAL root, `..` collapsed against
 *     `/` so it can never climb past it;
 *   - `toAgentPath(root, abs)` — the virtual path as the `AgentFs` path underneath it, where `root`
 *     is the agent-relative folder the workspace lives in (`"workspace"` in the app today);
 *   - `toVirtualPath(root, agent)` — the way back, for anything that reports a path to the script.
 *
 * The guard is HERE and not in each caller: there must be no path through this package that reaches
 * `AgentFs` without having collapsed `..` first. Collapsing (rather than refusing) is what Node
 * itself does — `path.resolve("/", "../../etc")` is `/etc` — and since our `/` is the workspace, the
 * worst a climb can reach is the workspace root.
 */

import { assertRelativePath } from "@00/agent-fs";

/** `/a/./b/../c` → `/a/c`. Always absolute, never a trailing slash except for the root itself. */
export function normalizeAbs(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Node's `path.resolve`, with `base` standing in for the process cwd. */
export function resolveAbs(base: string, ...parts: string[]): string {
  let out = base.startsWith("/") ? base : `/${base}`;
  for (const part of parts) {
    if (part === undefined || part === null || part === "") continue;
    out = part.startsWith("/") ? part : `${out}/${part}`;
  }
  return normalizeAbs(out);
}

export function dirnameAbs(p: string): string {
  const at = normalizeAbs(p).lastIndexOf("/");
  return at <= 0 ? "/" : p.slice(0, at);
}

export function basenameAbs(p: string): string {
  const norm = normalizeAbs(p);
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/**
 * A virtual absolute path as the `AgentFs` path under `root`.
 *
 * `root` is agent-relative and may be `""` (the agent root itself is the workspace). The virtual
 * root maps to `root`, which `AgentFs` accepts as a directory path everywhere but `readFile`.
 */
export function toAgentPath(root: string, abs: string): string {
  const rel = normalizeAbs(abs).slice(1);
  const joined = root === "" ? rel : rel === "" ? root : `${root}/${rel}`;
  return joined === "" ? "" : assertRelativePath(joined);
}

/** `workspace/projects/site/app.js` → `/projects/site/app.js`. */
export function toVirtualPath(root: string, agentPath: string): string {
  if (root === "") return `/${agentPath}`;
  if (agentPath === root) return "/";
  return agentPath.startsWith(`${root}/`) ? `/${agentPath.slice(root.length + 1)}` : `/${agentPath}`;
}
