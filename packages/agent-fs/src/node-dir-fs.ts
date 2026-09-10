// The same agent folder, backed by a real directory — the adapter the tests run their interop
// against and the one the Mac side uses when it holds a browser-made agent tree.
//
// WHY THE NODE MODULE IS LOADED THE WAY IT IS: every other module in `src/` runs in a browser, and
// a static `import "node:fs/promises"` at the top of a file the barrel re-exports would put a node
// builtin in the PWA's dependency graph — where a bundler either fails the build or ships a shim
// nobody wants. So the specifier is computed, the import is dynamic and cached, and the surface we
// need is declared here structurally rather than pulled from @types/node: this package does not
// depend on node types, and should not start to because of one adapter.

import type { AgentFs, FsEntry, FsStat } from "./types.js";
import { assertRelativePath } from "./types.js";
import { splitPath, walkFs } from "./walk.js";

const decoder = new TextDecoder();

interface NodeStatLike {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Exactly the `node:fs/promises` surface this adapter uses — nothing more is assumed of the host. */
export interface NodeFsPromisesLike {
  stat(path: string): Promise<NodeStatLike>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<string | undefined>;
  readdir(path: string, opts: { withFileTypes: true }): Promise<NodeDirentLike[]>;
  rm(path: string, opts: { recursive: true; force: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

let cached: Promise<NodeFsPromisesLike> | undefined;

/** The dynamic, deliberately unanalysable import — see the module header. */
export function loadNodeFs(): Promise<NodeFsPromisesLike> {
  const specifier = ["node", "fs/promises"].join(":");
  return (cached ??= import(/* @vite-ignore */ specifier) as Promise<NodeFsPromisesLike>);
}

const encoder = new TextEncoder();

export class NodeDirFs implements AgentFs {
  /** `root` is an absolute host path; every method joins onto it with `/`, which node accepts on
   *  Windows too. `impl` is injectable so a test can drive the adapter without a disk. */
  constructor(
    readonly root: string,
    private impl?: NodeFsPromisesLike,
  ) {}

  private async fs(): Promise<NodeFsPromisesLike> {
    return (this.impl ??= await loadNodeFs());
  }

  /** Absolute host path for a contract-relative path. "" is the root itself. */
  abs(rel: string): string {
    const clean = rel === "" ? "" : assertRelativePath(rel);
    const base = this.root.replace(/\/+$/, "");
    return clean === "" ? base || "/" : `${base}/${clean}`;
  }

  async stat(path: string): Promise<FsStat | null> {
    const fs = await this.fs();
    // The path guard runs OUTSIDE the catch: a `..` must be a refusal, not a quiet "no such file".
    const target = this.abs(path);
    try {
      const s = await fs.stat(target);
      return { kind: s.isDirectory() ? "dir" : "file", size: s.isDirectory() ? 0 : s.size, mtime: Math.round(s.mtimeMs) };
    } catch {
      return null;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const fs = await this.fs();
    const buf = await fs.readFile(this.abs(path));
    // A node Buffer is a VIEW into a pooled allocation; handing it out as the contract's Uint8Array
    // would let a later read change bytes a caller already holds. Copy, once, here.
    return Uint8Array.prototype.slice.call(buf) as Uint8Array;
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const fs = await this.fs();
    const rel = assertRelativePath(path);
    const [parent] = splitPath(rel);
    if (parent) await fs.mkdir(this.abs(parent), { recursive: true });
    await fs.writeFile(this.abs(rel), typeof data === "string" ? encoder.encode(data) : data);
  }

  async mkdir(path: string): Promise<void> {
    const fs = await this.fs();
    await fs.mkdir(this.abs(path), { recursive: true });
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const fs = await this.fs();
    const dir = this.abs(path);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const out: FsEntry[] = [];
    for (const d of dirents) {
      // Symlinks are skipped for the reason the bundle skips them: a link resolves to somebody
      // else's file on the other machine.
      if (d.isSymbolicLink()) continue;
      if (!d.isDirectory() && !d.isFile()) continue;
      if (d.isDirectory()) {
        out.push({ name: d.name, kind: "dir", size: 0, mtime: 0 });
        continue;
      }
      let size = 0;
      let mtime = 0;
      try {
        const s = await fs.stat(`${dir}/${d.name}`);
        size = s.size;
        mtime = Math.round(s.mtimeMs);
      } catch {
        /* a file we cannot stat counts as present at zero bytes, never as a failed listing */
      }
      out.push({ name: d.name, kind: "file", size, mtime });
    }
    return out;
  }

  async remove(path: string): Promise<void> {
    const fs = await this.fs();
    await fs.rm(this.abs(path), { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const fs = await this.fs();
    const dst = assertRelativePath(to);
    const [parent] = splitPath(dst);
    if (parent) await fs.mkdir(this.abs(parent), { recursive: true });
    await fs.rename(this.abs(from), this.abs(dst));
  }

  walk(path: string, opts?: { maxEntries?: number }): AsyncIterable<{ path: string; stat: FsStat }> {
    return walkFs(this, path, opts);
  }
}
