// isomorphic-git speaks node's `fs.promises`; the runtime speaks AgentFs. This is the translation,
// and it is the whole of what makes Git work in a browser tab over OPFS.
//
// The only subtle part is ERRORS. isomorphic-git does not ask whether a file exists — it reads and
// branches on `err.code === "ENOENT"`, on `ENOTDIR` from a readdir, on `EEXIST` from a mkdir. An
// adapter that throws a plain Error instead turns "this repository has no HEAD yet" into a crash
// three frames deeper, so every failure below carries the code node would have set. Paths arrive
// absolute-looking (`/workspace/projects/app/.git/config`) because that is what `dir` was set to;
// they are agent-root-relative here, and `..` is refused rather than resolved past the root.

import { fail } from "./errors.js";
import type { AgentFs } from "./types.js";
import { assertRelativePath } from "./types.js";

const decoder = new TextDecoder();

function err(code: string, message: string): Error & { code: string } {
  const e = new Error(`${code}: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

/** `/workspace/a/./b` → `workspace/a/b`. A path climbing past the root is refused, never clamped. */
export function toRel(p: string): string {
  const parts = String(p).replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) fail("path_escapes_root", `git asked for a path outside the agent: ${p}`);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

type Encoding = string | { encoding?: string | null } | null | undefined;

function wantsText(options: Encoding): boolean {
  if (typeof options === "string") return options === "utf8" || options === "utf-8";
  const enc = options?.encoding;
  return enc === "utf8" || enc === "utf-8";
}

/** Stats in the shape isomorphic-git's `normalizeStats` reads: seconds come from the Ms fields. */
function statLike(kind: "file" | "dir", size: number, mtime: number) {
  return {
    type: kind === "dir" ? "dir" : "file",
    mode: kind === "dir" ? 0o40000 : 0o100644,
    size: kind === "dir" ? 0 : size,
    // THE RACY-GIT WINDOW, closed with the only field we have. isomorphic-git decides whether to
    // re-hash a file by comparing the index's saved stat with this one — and it compares mtime in
    // WHOLE SECONDS. Two edits inside the same second that leave the size unchanged ("one" → "two")
    // would therefore be invisible, which is a silent wrong answer from `git status`. `ino` is
    // compared too, so the millisecond precision the adapters do have rides in there.
    ino: mtime % 4294967296,
    dev: 1,
    uid: 1,
    gid: 1,
    ctimeMs: mtime,
    mtimeMs: mtime,
    ctimeSeconds: Math.floor(mtime / 1000),
    mtimeSeconds: Math.floor(mtime / 1000),
    ctimeNanoseconds: 0,
    mtimeNanoseconds: 0,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  };
}

export interface GitFsClient {
  promises: {
    readFile(path: string, options?: Encoding): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string, options?: Encoding): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<ReturnType<typeof statLike>>;
    lstat(path: string): Promise<ReturnType<typeof statLike>>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
  };
}

/** Wrap any AgentFs as the `fs` isomorphic-git takes. One object per repo call is fine — it holds
 *  no state of its own. */
export function gitFs(fs: AgentFs): GitFsClient {
  const stat = async (path: string) => {
    const rel = toRel(path);
    const s = rel === "" ? ({ kind: "dir", size: 0, mtime: 0 } as const) : await fs.stat(rel);
    if (!s) throw err("ENOENT", `no such file or directory, stat '${path}'`);
    return statLike(s.kind, s.size, s.mtime);
  };
  return {
    promises: {
      async readFile(path, options) {
        const rel = toRel(path);
        const s = await fs.stat(rel);
        if (!s) throw err("ENOENT", `no such file or directory, open '${path}'`);
        if (s.kind === "dir") throw err("EISDIR", `illegal operation on a directory, read '${path}'`);
        const data = await fs.readFile(rel);
        return wantsText(options) ? decoder.decode(data) : data;
      },
      async writeFile(path, data) {
        await fs.writeFile(toRel(path), data);
      },
      async unlink(path) {
        await fs.remove(toRel(path));
      },
      async readdir(path) {
        const rel = toRel(path);
        const s = rel === "" ? ({ kind: "dir" } as const) : await fs.stat(rel);
        if (!s) throw err("ENOENT", `no such file or directory, scandir '${path}'`);
        if (s.kind !== "dir") throw err("ENOTDIR", `not a directory, scandir '${path}'`);
        return (await fs.readdir(rel)).map((e) => e.name).sort();
      },
      async mkdir(path) {
        const rel = toRel(path);
        // isomorphic-git creates parents itself and treats EEXIST as success, but only when it is
        // told: a silent success on an existing FILE would let it write a repo into a file's name.
        const s = await fs.stat(rel);
        if (s?.kind === "file") throw err("ENOTDIR", `not a directory, mkdir '${path}'`);
        await fs.mkdir(rel);
      },
      async rmdir(path) {
        await fs.remove(toRel(path));
      },
      stat,
      lstat: stat, // no symlinks in an agent folder — the bundle refuses them at both ends
      async readlink(path) {
        throw err("EINVAL", `invalid argument, readlink '${path}'`);
      },
      async symlink(_target, path) {
        throw err("EPERM", `operation not permitted, symlink '${path}'`);
      },
      async chmod() {
        /* one permission model, and it is not this one */
      },
    },
  };
}

/** The `dir` isomorphic-git should be given for a repo at an agent-root-relative path. */
export function repoDir(rel: string): string {
  return `/${rel === "" ? "" : assertRelativePath(rel)}`;
}
