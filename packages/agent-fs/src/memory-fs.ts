// The agent folder with no storage under it — the adapter every test and every dry run uses.
//
// It exists so that the layers above (scaffold, the bundle writer, the git backend, the runtime's
// tools) can be tested without OPFS, without a disk and without a temp directory to clean up, and
// so that an import can be validated in memory before a single byte reaches the person's real
// agent. Directories are tracked EXPLICITLY rather than inferred from file paths, because an empty
// `projects/` is part of a scaffolded agent and a bundle that silently dropped it would arrive on
// the far side missing folders the prompt tells the agent it has.

import type { AgentFs, FsEntry, FsStat } from "./types.js";
import { assertRelativePath } from "./types.js";
import { ancestors, splitPath, walkFs } from "./walk.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function enoent(path: string): Error & { code: string } {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

function enotdir(path: string): Error & { code: string } {
  const err = new Error(`ENOTDIR: not a directory, '${path}'`) as Error & { code: string };
  err.code = "ENOTDIR";
  return err;
}

interface MemFile {
  data: Uint8Array;
  mtime: number;
}

export class MemoryFs implements AgentFs {
  private files = new Map<string, MemFile>();
  private dirs = new Set<string>([""]);
  private lastStamp = 0;
  /**
   * Injectable so a test can make mtimes deterministic. The default is the wall clock forced to
   * STRICTLY INCREASE: two writes inside one millisecond are ordinary in memory, and a consumer that
   * decides "unchanged" from an equal timestamp (git's index does exactly that) would then miss the
   * second one.
   */
  now: () => number = () => (this.lastStamp = Math.max(Date.now(), this.lastStamp + 1));

  private norm(path: string): string {
    return assertRelativePath(path);
  }

  private ensureDirs(rel: string): void {
    for (const a of ancestors(rel)) {
      if (this.files.has(a)) throw enotdir(a);
      this.dirs.add(a);
    }
  }

  async stat(path: string): Promise<FsStat | null> {
    const rel = path === "" ? "" : this.norm(path);
    const f = this.files.get(rel);
    if (f) return { kind: "file", size: f.data.byteLength, mtime: f.mtime };
    if (this.dirs.has(rel)) return { kind: "dir", size: 0, mtime: 0 };
    return null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const rel = this.norm(path);
    const f = this.files.get(rel);
    if (!f) throw enoent(rel);
    return f.data.slice();
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const rel = this.norm(path);
    if (this.dirs.has(rel)) throw new Error(`EISDIR: is a directory, '${rel}'`);
    this.ensureDirs(rel);
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    this.files.set(rel, { data: bytes, mtime: this.now() });
  }

  async mkdir(path: string): Promise<void> {
    const rel = path === "" ? "" : this.norm(path);
    if (this.files.has(rel)) throw enotdir(rel);
    this.ensureDirs(rel);
    this.dirs.add(rel);
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const rel = path === "" ? "" : this.norm(path);
    if (this.files.has(rel)) throw enotdir(rel);
    if (!this.dirs.has(rel)) throw enoent(rel);
    const prefix = rel === "" ? "" : `${rel}/`;
    const out: FsEntry[] = [];
    for (const d of this.dirs) {
      if (d === rel || !d.startsWith(prefix)) continue;
      const tail = d.slice(prefix.length);
      if (tail.includes("/")) continue;
      out.push({ name: tail, kind: "dir", size: 0, mtime: 0 });
    }
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const tail = p.slice(prefix.length);
      if (tail === "" || tail.includes("/")) continue;
      out.push({ name: tail, kind: "file", size: f.data.byteLength, mtime: f.mtime });
    }
    return out;
  }

  async remove(path: string): Promise<void> {
    const rel = this.norm(path);
    this.files.delete(rel);
    if (this.dirs.has(rel)) {
      const prefix = `${rel}/`;
      for (const d of [...this.dirs]) if (d === rel || d.startsWith(prefix)) this.dirs.delete(d);
      for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.files.delete(p);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.norm(from);
    const dst = this.norm(to);
    if (src === dst) return;
    const f = this.files.get(src);
    if (f) {
      this.ensureDirs(dst);
      this.files.set(dst, f);
      this.files.delete(src);
      return;
    }
    if (!this.dirs.has(src)) throw enoent(src);
    const prefix = `${src}/`;
    this.ensureDirs(dst);
    this.dirs.add(dst);
    for (const d of [...this.dirs]) {
      if (d.startsWith(prefix)) {
        this.dirs.delete(d);
        this.dirs.add(dst + "/" + d.slice(prefix.length));
      }
    }
    for (const [p, v] of [...this.files]) {
      if (p.startsWith(prefix)) {
        this.files.delete(p);
        this.files.set(dst + "/" + p.slice(prefix.length), v);
      }
    }
    this.dirs.delete(src);
  }

  walk(path: string, opts?: { maxEntries?: number }): AsyncIterable<{ path: string; stat: FsStat }> {
    return walkFs(this, path, opts);
  }

  // ── Beyond the contract: what only an in-memory fs can offer ────────────────────────────────────

  /** Every file, sorted — a test's one-line assertion about a whole tree. */
  snapshot(): { path: string; size: number }[] {
    return [...this.files.entries()]
      .map(([path, f]) => ({ path, size: f.data.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** Directories that exist in their own right, sorted, root excluded. */
  dirList(): string[] {
    return [...this.dirs].filter(Boolean).sort();
  }
}
