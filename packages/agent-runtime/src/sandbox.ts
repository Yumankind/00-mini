/**
 * The path guard — the one place that turns a path a MODEL wrote into a path the filesystem may see.
 *
 * Every tool argument is attacker-adjacent: for the light agent the words come from a stranger, and
 * for the full agent they come from a model that has read a stranger's page. So there is exactly one
 * function that maps `args.path` onto an `AgentFs` path, it is used by every tool, and it throws
 * rather than clamping — a silently rewritten path is how `../../vault.json` becomes a read.
 *
 * The mapping, stated once:
 *   - `AgentFs` paths are POSIX and relative to the AGENT ROOT (`workspace/AGENTS.md`).
 *   - A tool's `path` argument is relative to the SANDBOX (`AGENTS.md` → `workspace/AGENTS.md`),
 *     because the engine's tools are cwd-scoped to `workspace/` and a moved agent's skills say
 *     `read MEMORY.md`, not `read workspace/MEMORY.md`.
 *   - A LEADING SLASH means agent-root-absolute, which is the closest thing a browser agent has to
 *     `/`. `/workspace/AGENTS.md` resolves; `/vault.json` throws. Pi's tools accept absolute paths
 *     and the engine contains them the same way (guardReadable in apps/00d/src/tools.ts), so a model
 *     that emits one gets the engine's answer rather than a parse error.
 *   - `.` and `..` are resolved BEFORE the containment check, so no traversal survives it.
 */
import { assertRelativePath } from "@00/agent-fs";

export class PathEscapeError extends Error {
  readonly code = "path_escapes_sandbox";
  constructor(readonly attempted: string, readonly sandbox: string) {
    super(`path is outside this agent's sandbox (${sandbox}/): ${JSON.stringify(attempted)}`);
    this.name = "PathEscapeError";
  }
}

/** Split a POSIX path into segments, resolving `.` and `..`; returns null when it climbs above the root. */
function resolveSegments(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** The sandbox root itself, normalised (`workspace`, `threads-fs/telegram/42`). */
export function normalizeSandbox(sandbox: string): string {
  const parts = resolveSegments(sandbox.split("/"));
  if (!parts || parts.length === 0) throw new Error(`invalid sandbox root: ${JSON.stringify(sandbox)}`);
  return assertRelativePath(parts.join("/"));
}

/**
 * Map a tool's `path` argument onto an agent-root-relative `AgentFs` path inside `sandbox`.
 * An empty/absent path is the sandbox root itself, which is what `ls` with no argument means.
 */
export function resolveInSandbox(sandbox: string, p?: string | null): string {
  const root = normalizeSandbox(sandbox);
  const raw = typeof p === "string" ? p : "";
  if (raw.includes("\0")) throw new PathEscapeError(raw, root);
  const absolute = raw.startsWith("/");
  const segments = resolveSegments(raw.split("/"));
  if (!segments) throw new PathEscapeError(raw, root);
  if (absolute) {
    // Agent-root-absolute: it must already begin with the sandbox to be inside it.
    const rootParts = root.split("/");
    const inside = rootParts.every((seg, i) => segments[i] === seg);
    if (!inside) throw new PathEscapeError(raw, root);
    return segments.join("/");
  }
  return [root, ...segments].join("/");
}

/** The inverse, for output the model reads: `workspace/memory/x.md` → `memory/x.md`. */
export function relativeToSandbox(sandbox: string, full: string): string {
  const root = normalizeSandbox(sandbox);
  if (full === root) return ".";
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
}

/**
 * Glob → RegExp, for `find`'s `pattern` and `grep`'s `glob`.
 *
 * Deliberately small and gitignore-free: `*` (no `/`), `**` (any depth), `?`, and character classes
 * are what the engine's callers actually write (`*.ts`, `src/**\/*.spec.ts`). A pattern with no `/`
 * matches the BASENAME, which is what makes `find '*.md'` find nested files — the behaviour `fd`
 * gives pi's find tool.
 */
export function globToRegExp(glob: string, opts: { matchBasename?: boolean } = {}): RegExp {
  const matchBasename = opts.matchBasename ?? !glob.includes("/");
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` swallows the slash so `**/*.ts` also matches a top-level `a.ts`.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${matchBasename ? "(?:.*/)?" : ""}${out}$`);
}
