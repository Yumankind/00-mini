/**
 * Forty lines of Map, standing in for `@00/agent-fs`' `MemoryFs` — on the ONE path that needs an
 * `AgentFs` without needing the package.
 *
 * WHERE IT IS USED: the panel runs tools ITSELF on the no-brain path (§5.2.3 — level 0 has no model
 * and the search still answers), and `ToolContext` requires an `fs`. No tool in
 * `embed/src/tools/index.ts` touches it — read the table: every one of them reads the site index,
 * the live page or the owner's knowledge files, and the only one that leaves the device posts a
 * message. But the type is the type, and a cast would be a lie that the next tool to arrive would
 * discover at runtime.
 *
 * WHY NOT `MemoryFs`: importing it pulls `@00/agent-fs` into `e.js`, and with it git-ops, the OPFS
 * adapter, the node-dir adapter and the transfer crypto — 50 KB of source for a Map. The real one
 * lives in `m/brain.js` (`brain-impl.ts`'s `threadFs`) where the runtime that needs a real
 * filesystem already is.
 *
 * It is a SCRATCH filesystem: nothing in it outlives the tab, and nothing in it is written anywhere.
 */

import type { AgentFs, FsEntry, FsStat } from "@00/agent-fs";

const enc = new TextEncoder();
const dec = new TextDecoder();

const clean = (path: string): string => {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\0")) throw new Error(`invalid path: ${path}`);
  const parts = path.split("/").filter((p) => p !== "." && p !== "");
  if (parts.some((p) => p === "..")) throw new Error(`invalid path: ${path}`);
  return parts.join("/");
};

export function scratchFs(now: () => number = Date.now): AgentFs {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const dirs = new Set<string>();
  const under = (dir: string): string[] => [...files.keys()].filter((p) => (dir ? p.startsWith(`${dir}/`) : true));

  return {
    async stat(path) {
      const key = clean(path);
      const file = files.get(key);
      if (file) return { kind: "file", size: file.bytes.length, mtime: file.mtime } satisfies FsStat;
      if (dirs.has(key) || key === "" || under(key).length) return { kind: "dir", size: 0, mtime: 0 };
      return null;
    },
    async readFile(path) {
      const file = files.get(clean(path));
      if (!file) throw new Error(`no such file: ${path}`);
      return file.bytes;
    },
    async readText(path) {
      return dec.decode(await this.readFile(path));
    },
    async writeFile(path, data) {
      const key = clean(path);
      const bytes = typeof data === "string" ? enc.encode(data) : data;
      files.set(key, { bytes, mtime: now() });
      const parent = key.split("/").slice(0, -1).join("/");
      if (parent) dirs.add(parent);
    },
    async mkdir(path) {
      dirs.add(clean(path));
    },
    async readdir(path) {
      const dir = clean(path);
      const names = new Map<string, FsEntry>();
      for (const key of under(dir)) {
        const rest = dir ? key.slice(dir.length + 1) : key;
        const head = rest.split("/")[0]!;
        if (rest.includes("/")) names.set(head, { name: head, kind: "dir", size: 0, mtime: 0 });
        else {
          const file = files.get(key)!;
          names.set(head, { name: head, kind: "file", size: file.bytes.length, mtime: file.mtime });
        }
      }
      return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async remove(path) {
      const key = clean(path);
      files.delete(key);
      dirs.delete(key);
      for (const child of under(key)) files.delete(child);
    },
    async rename(from, to) {
      const src = clean(from);
      const dst = clean(to);
      const file = files.get(src);
      if (!file) throw new Error(`no such file: ${from}`);
      files.delete(src);
      files.set(dst, file);
    },
    async *walk(path, opts) {
      const max = opts?.maxEntries ?? Infinity;
      const dir = clean(path);
      let seen = 0;
      for (const key of under(dir).sort()) {
        if (seen++ >= max) return;
        const file = files.get(key)!;
        yield { path: dir ? key.slice(dir.length + 1) : key, stat: { kind: "file", size: file.bytes.length, mtime: file.mtime } };
      }
    },
  };
}
