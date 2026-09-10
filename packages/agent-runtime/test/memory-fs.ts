/**
 * An `AgentFs` in a Map — this package's test filesystem.
 *
 * `@00/agent-fs` ships the real adapters (OPFS, and its own in-memory one) and is written in
 * parallel with this package; the runtime is tested against the INTERFACE, not against a sibling's
 * build state, so it carries its own. Nothing here is exported from `src/` — a runtime that shipped
 * a filesystem would be two packages.
 *
 * The directory model is implicit: a file's parents exist because the file does, plus an explicit set
 * for empty directories `mkdir` made. That is enough for the runtime's questions ("is this a dir",
 * "what is in it") and much less code than a node tree.
 */
import { assertRelativePath, type AgentFs, type FsEntry, type FsStat } from "@00/agent-fs";

export class MemoryFs implements AgentFs {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  private readonly mtimes = new Map<string, number>();
  private clock = 1_700_000_000_000;

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.writeSync(path, content);
  }

  /** Test-only: seed or inspect without going through the async surface. */
  writeSync(path: string, content: string): void {
    const p = assertRelativePath(path);
    this.files.set(p, new TextEncoder().encode(content));
    this.mtimes.set(p, this.clock++);
    for (const parent of parents(p)) this.dirs.add(parent);
  }

  readSync(path: string): string | undefined {
    const raw = this.files.get(assertRelativePath(path));
    return raw ? new TextDecoder().decode(raw) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async stat(path: string): Promise<FsStat | null> {
    const p = assertRelativePath(path);
    const file = this.files.get(p);
    if (file) return { kind: "file", size: file.byteLength, mtime: this.mtimes.get(p) ?? 0 };
    if (this.dirs.has(p) || this.hasChildren(p)) return { kind: "dir", size: 0, mtime: 0 };
    return null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = assertRelativePath(path);
    const file = this.files.get(p);
    if (!file) throw new Error(`ENOENT: ${p}`);
    return file;
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const p = assertRelativePath(path);
    this.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
    this.mtimes.set(p, this.clock++);
    for (const parent of parents(p)) this.dirs.add(parent);
  }

  async mkdir(path: string): Promise<void> {
    const p = assertRelativePath(path);
    this.dirs.add(p);
    for (const parent of parents(p)) this.dirs.add(parent);
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const p = assertRelativePath(path);
    if (!this.dirs.has(p) && !this.hasChildren(p)) throw new Error(`ENOTDIR: ${p}`);
    const prefix = `${p}/`;
    const names = new Map<string, FsEntry>();
    for (const [file, bytes] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut === -1) {
        names.set(rest, { name: rest, kind: "file", size: bytes.byteLength, mtime: this.mtimes.get(file) ?? 0 });
      } else {
        const name = rest.slice(0, cut);
        if (!names.has(name)) names.set(name, { name, kind: "dir", size: 0, mtime: 0 });
      }
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      const name = rest.split("/")[0];
      if (!names.has(name)) names.set(name, { name, kind: "dir", size: 0, mtime: 0 });
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(path: string): Promise<void> {
    const p = assertRelativePath(path);
    this.files.delete(p);
    this.dirs.delete(p);
    for (const file of [...this.files.keys()]) if (file.startsWith(`${p}/`)) this.files.delete(file);
    for (const dir of [...this.dirs]) if (dir.startsWith(`${p}/`)) this.dirs.delete(dir);
  }

  async rename(from: string, to: string): Promise<void> {
    const a = assertRelativePath(from);
    const b = assertRelativePath(to);
    const file = this.files.get(a);
    if (file) {
      await this.writeFile(b, file);
      this.files.delete(a);
      return;
    }
    for (const path of [...this.files.keys()]) {
      if (!path.startsWith(`${a}/`)) continue;
      await this.writeFile(`${b}/${path.slice(a.length + 1)}`, this.files.get(path)!);
      this.files.delete(path);
    }
    this.dirs.delete(a);
    this.dirs.add(b);
  }

  async *walk(path: string, opts: { maxEntries?: number } = {}): AsyncIterable<{ path: string; stat: FsStat }> {
    const p = assertRelativePath(path);
    const prefix = `${p}/`;
    const max = opts.maxEntries ?? Number.MAX_SAFE_INTEGER;
    let n = 0;
    for (const file of [...this.files.keys()].sort()) {
      if (!file.startsWith(prefix)) continue;
      if (n++ >= max) return;
      // Relative to the walked path, as the interface documents.
      yield { path: file.slice(prefix.length), stat: (await this.stat(file))! };
    }
  }

  private hasChildren(p: string): boolean {
    const prefix = `${p}/`;
    for (const file of this.files.keys()) if (file.startsWith(prefix)) return true;
    for (const dir of this.dirs) if (dir.startsWith(prefix)) return true;
    return false;
  }
}

function parents(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
