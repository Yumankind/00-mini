/**
 * The filesystem the runtime sees — FROZEN CONTRACT for Phase 0 (docs/HANDOFF-infinite-agent.md §2, §3).
 *
 * Paths are POSIX, relative to the agent's root (`agents/<id>/`), never absolute, never containing
 * `..`. Every adapter (OPFS, in-memory, a Node directory for tests) implements exactly this, and
 * everything above it — tools, bundle writer, git backend, scaffold — is written against it once.
 * Change this file only with the other packages' owners in the loop.
 */

export interface FsStat {
  kind: "file" | "dir";
  size: number;
  /** Milliseconds since epoch; 0 when the adapter cannot know. */
  mtime: number;
}

export interface FsEntry extends FsStat {
  name: string;
}

export interface AgentFs {
  stat(path: string): Promise<FsStat | null>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Parents are created; an existing directory is not an error. */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<FsEntry[]>;
  /** Files and directories alike; a missing path is not an error. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Depth-first walk of every FILE under `path`, relative paths, sorted, dotfiles included. */
  walk(path: string, opts?: { maxEntries?: number }): AsyncIterable<{ path: string; stat: FsStat }>;
}

/** `path` guards every adapter must apply before touching storage. */
export function assertRelativePath(p: string): string {
  if (typeof p !== "string" || p.length === 0 || p.startsWith("/") || p.includes("\0")) {
    throw new Error(`invalid path: ${JSON.stringify(p)}`);
  }
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "")) throw new Error(`invalid path: ${JSON.stringify(p)}`);
  return parts.filter((s) => s !== ".").join("/");
}
