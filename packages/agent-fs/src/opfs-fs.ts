// The agent folder in the browser's Origin Private File System — the ONLY adapter that cannot be
// unit-tested in node, so the rule for this file is: hold no logic worth testing.
//
// Everything that could be got wrong once and stay wrong (path validation, walk order and its
// bound, the tar, the scaffold, the ignore matcher) lives in modules the suite covers; what is left
// here is the translation from one relative path to a chain of `getDirectoryHandle` calls. The
// handle types are declared structurally rather than taken from lib.dom, for two reasons: this
// package compiles with a lib set that does not carry the async-iterable half of the OPFS types,
// and a structural interface is a thing a test can implement — which is how the translation gets
// exercised at all (test/opfs-fs.test.ts drives it against an in-memory pair of fakes).
//
// The sync fast path is real but conditional: `createSyncAccessHandle` exists only inside a Worker
// and only one may be open on a file at a time, so it is tried, and any failure falls straight back
// to the async API rather than failing a read the person is waiting for.

import type { AgentFs, FsEntry, FsStat } from "./types.js";
import { assertRelativePath } from "./types.js";
import { splitPath, walkFs } from "./walk.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ── The slice of the File System Access API this adapter uses ────────────────────────────────────

export interface OpfsFileLike {
  readonly size: number;
  readonly lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsSyncAccessHandle {
  read(buf: Uint8Array, opts?: { at?: number }): number;
  write(buf: Uint8Array, opts?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OpfsFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<OpfsFileLike>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>;
}

export interface OpfsDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<OpfsFileHandle | OpfsDirectoryHandle>;
}

export interface OpfsFsOptions {
  /** Try `createSyncAccessHandle` for reads and writes (worker only). Default: try it. */
  sync?: boolean;
}

function enoent(path: string): Error & { code: string } {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

export class OpfsFs implements AgentFs {
  constructor(
    private readonly root: OpfsDirectoryHandle,
    private readonly opts: OpfsFsOptions = {},
  ) {}

  /** `navigator.storage.getDirectory()`, then one subdirectory per agent: `agents/<id>/`. */
  static async atAgentRoot(
    storage: { getDirectory(): Promise<OpfsDirectoryHandle> },
    agentId: string,
    opts: OpfsFsOptions = {},
  ): Promise<OpfsFs> {
    const rootDir = await storage.getDirectory();
    const agents = await rootDir.getDirectoryHandle("agents", { create: true });
    const dir = await agents.getDirectoryHandle(assertRelativePath(agentId), { create: true });
    return new OpfsFs(dir, opts);
  }

  private async dirAt(rel: string, create: boolean): Promise<OpfsDirectoryHandle | null> {
    if (rel === "") return this.root;
    let cur = this.root;
    for (const seg of rel.split("/")) {
      try {
        cur = await cur.getDirectoryHandle(seg, { create });
      } catch {
        return null;
      }
    }
    return cur;
  }

  private async fileAt(rel: string, create: boolean): Promise<OpfsFileHandle | null> {
    const [parent, name] = splitPath(assertRelativePath(rel));
    const dir = await this.dirAt(parent, create);
    if (!dir) return null;
    try {
      return await dir.getFileHandle(name, { create });
    } catch {
      return null;
    }
  }

  async stat(path: string): Promise<FsStat | null> {
    const rel = path === "" ? "" : assertRelativePath(path);
    if (rel === "") return { kind: "dir", size: 0, mtime: 0 };
    const fh = await this.fileAt(rel, false);
    if (fh) {
      const f = await fh.getFile();
      return { kind: "file", size: f.size, mtime: f.lastModified };
    }
    return (await this.dirAt(rel, false)) ? { kind: "dir", size: 0, mtime: 0 } : null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const rel = assertRelativePath(path);
    const fh = await this.fileAt(rel, false);
    if (!fh) throw enoent(rel);
    if (this.opts.sync !== false && fh.createSyncAccessHandle) {
      try {
        const h = await fh.createSyncAccessHandle();
        try {
          const buf = new Uint8Array(h.getSize());
          h.read(buf, { at: 0 });
          return buf;
        } finally {
          h.close();
        }
      } catch {
        /* not in a worker, or another handle is open — the async path below is always correct */
      }
    }
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const rel = assertRelativePath(path);
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const fh = await this.fileAt(rel, true);
    if (!fh) throw enoent(rel);
    if (this.opts.sync !== false && fh.createSyncAccessHandle) {
      try {
        const h = await fh.createSyncAccessHandle();
        try {
          h.truncate(0);
          h.write(bytes, { at: 0 });
          h.flush();
          return;
        } finally {
          h.close();
        }
      } catch {
        /* fall through to createWritable */
      }
    }
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async mkdir(path: string): Promise<void> {
    const rel = path === "" ? "" : assertRelativePath(path);
    if (!(await this.dirAt(rel, true))) throw enoent(rel);
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const rel = path === "" ? "" : assertRelativePath(path);
    const dir = await this.dirAt(rel, false);
    if (!dir) throw enoent(rel);
    const out: FsEntry[] = [];
    for await (const h of dir.values()) {
      if (h.kind === "directory") {
        out.push({ name: h.name, kind: "dir", size: 0, mtime: 0 });
        continue;
      }
      const f = await h.getFile();
      out.push({ name: h.name, kind: "file", size: f.size, mtime: f.lastModified });
    }
    return out;
  }

  async remove(path: string): Promise<void> {
    const [parent, name] = splitPath(assertRelativePath(path));
    const dir = await this.dirAt(parent, false);
    if (!dir) return; // a missing path is not an error (types.ts)
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch {
      /* already gone */
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = assertRelativePath(from);
    const dst = assertRelativePath(to);
    if (src === dst) return;
    const st = await this.stat(src);
    if (!st) throw enoent(src);
    if (st.kind === "file") {
      await this.writeFile(dst, await this.readFile(src));
      await this.remove(src);
      return;
    }
    // OPFS has no directory move in the async API, so a directory rename is a copy of every file
    // under it followed by one removeEntry — bounded by the same walk everything else uses.
    await this.mkdir(dst);
    for await (const entry of this.walk(src)) {
      const tail = entry.path.slice(src.length + 1);
      await this.writeFile(`${dst}/${tail}`, await this.readFile(entry.path));
    }
    await this.remove(src);
  }

  walk(path: string, opts?: { maxEntries?: number }): AsyncIterable<{ path: string; stat: FsStat }> {
    return walkFs(this, path, opts);
  }
}
