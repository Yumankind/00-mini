/**
 * `fs` and `fs/promises` — three faces, one `NodeFsBackend`.
 *
 * DOES: `readFile`, `writeFile`, `appendFile`, `mkdir`, `readdir` (with `withFileTypes`), `stat`,
 * `lstat`, `access`, `exists`, `unlink`, `rm`, `rmdir`, `rename`, `copyFile`, `truncate`,
 * `realpath`, `cp` (recursive), and the no-op `chmod`/`utimes`, each in all three Node shapes:
 * `fs.x(…, cb)`, `fs.promises.x(…)`, `fs.xSync(…)`. Encodings behave as Node's do — a string
 * encoding (or `{ encoding }`) returns a string, its absence returns a `Buffer`.
 *
 * DOES NOT: file descriptors (`open`/`read`/`write`/`close`/`fstat` — the store underneath is
 * whole-file and an fd table would be a fiction), `createReadStream`/`createWriteStream` (they exist
 * and read/write the WHOLE file at either end, which is honest for a workspace and wrong for a
 * 4 GB log — the header on each says so), `watch`/`watchFile` (the host emits `file_changed`
 * already), symlinks, `globSync`, `opendir`.
 *
 * THE SYNC FACE IS CONDITIONAL. Every `*Sync` call goes through the shared-memory channel
 * (`src/fs/sync-channel.ts`). Without one — no cross-origin isolation, or the code is on a main
 * thread — it throws `ERR_SYNC_FS_UNAVAILABLE` carrying the isolation sentence, and nothing silently
 * answers from a stale snapshot.
 */

import { Buffer } from "buffer/index.js";
import { Readable, Writable } from "readable-stream";
import type { DirentShape, NodeFsBackend, StatShape } from "../fs/backend.js";
import { bytesOf } from "../fs/backend.js";
import { NodeCompatError } from "../errors.js";

const decoder = new TextDecoder();

/** Node's `Stats`, as much of it as this store can answer truthfully. */
export function makeStats(shape: StatShape, path: string): Record<string, unknown> {
  const mtime = new Date(shape.mtimeMs);
  return {
    path,
    size: shape.size,
    mtimeMs: shape.mtimeMs,
    atimeMs: shape.mtimeMs,
    ctimeMs: shape.mtimeMs,
    birthtimeMs: shape.mtimeMs,
    mtime,
    atime: mtime,
    ctime: mtime,
    birthtime: mtime,
    mode: shape.kind === "dir" ? 0o040755 : 0o100644,
    uid: 0,
    gid: 0,
    dev: 0,
    ino: 0,
    nlink: 1,
    blksize: 4096,
    blocks: Math.ceil(shape.size / 512),
    isFile: () => shape.kind === "file",
    isDirectory: () => shape.kind === "dir",
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function makeDirent(entry: DirentShape, parentPath: string): Record<string, unknown> {
  return {
    name: entry.name,
    parentPath,
    path: parentPath,
    isFile: () => entry.kind === "file",
    isDirectory: () => entry.kind === "dir",
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function encodingOf(options: unknown): string | null {
  if (typeof options === "string") return options;
  if (options && typeof options === "object") {
    const enc = (options as { encoding?: unknown }).encoding;
    return typeof enc === "string" ? enc : null;
  }
  return null;
}

function decodeFile(bytes: Uint8Array, options: unknown): string | Uint8Array {
  const encoding = encodingOf(options);
  if (!encoding || encoding === "buffer") return Buffer.from(bytes);
  if (encoding === "utf8" || encoding === "utf-8") return decoder.decode(bytes);
  return Buffer.from(bytes).toString(encoding);
}

/** The last argument, when it is a function — Node's `(path[, options], cb)` in one place. */
function splitCallback(args: unknown[]): { rest: unknown[]; cb: ((err: unknown, value?: unknown) => void) | null } {
  const copy = [...args];
  const last = copy[copy.length - 1];
  if (typeof last === "function") return { rest: copy.slice(0, -1), cb: last as (err: unknown, value?: unknown) => void };
  return { rest: copy, cb: null };
}

export interface FsModules {
  fs: Record<string, unknown>;
  promises: Record<string, unknown>;
}

export function fsModule(backend: NodeFsBackend): FsModules {
  // ── promises ──────────────────────────────────────────────────────────────────────────────────
  const promises: Record<string, unknown> = {
    readFile: async (path: string, options?: unknown) => decodeFile((await backend.op("readFile", { path }, null)).data as Uint8Array, options),
    writeFile: async (path: string, data: unknown) => void (await backend.op("writeFile", { path }, bytesOf(data))),
    appendFile: async (path: string, data: unknown) => void (await backend.op("appendFile", { path }, bytesOf(data))),
    mkdir: async (path: string, options?: unknown) => {
      const recursive = typeof options === "object" && options ? Boolean((options as { recursive?: boolean }).recursive) : false;
      await backend.op("mkdir", { path, recursive }, null);
      return recursive ? backend.absolute(path) : undefined;
    },
    readdir: async (path: string, options?: unknown) => {
      const entries = (await backend.op("readdir", { path }, null)).value as DirentShape[];
      const wantsDirents = typeof options === "object" && options && (options as { withFileTypes?: boolean }).withFileTypes;
      return wantsDirents ? entries.map((e) => makeDirent(e, backend.absolute(path))) : entries.map((e) => e.name);
    },
    stat: async (path: string) => makeStats((await backend.op("stat", { path }, null)).value as StatShape, backend.absolute(path)),
    lstat: async (path: string) => makeStats((await backend.op("lstat", { path }, null)).value as StatShape, backend.absolute(path)),
    access: async (path: string) => void (await backend.op("access", { path }, null)),
    unlink: async (path: string) => void (await backend.op("unlink", { path }, null)),
    rmdir: async (path: string) => void (await backend.op("rmdir", { path }, null)),
    rm: async (path: string, options?: unknown) => {
      const o = (options ?? {}) as { recursive?: boolean; force?: boolean };
      await backend.op("rm", { path, recursive: o.recursive, force: o.force }, null);
    },
    rename: async (from: string, to: string) => void (await backend.op("rename", { path: from, to }, null)),
    copyFile: async (from: string, to: string) => void (await backend.op("copyFile", { path: from, to }, null)),
    truncate: async (path: string, len = 0) => void (await backend.op("truncate", { path, len }, null)),
    realpath: async (path: string) => (await backend.op("realpath", { path }, null)).value as string,
    chmod: async () => undefined,
    chown: async () => undefined,
    utimes: async () => undefined,
    symlink: async (target: string, path: string) => void (await backend.op("symlink", { path, to: target }, null)),
    readlink: async (path: string) => void (await backend.op("readlink", { path }, null)),
    cp: async (from: string, to: string, options?: unknown) => {
      await copyTree(backend, from, to, Boolean((options as { recursive?: boolean } | undefined)?.recursive));
    },
  };

  // ── callbacks ─────────────────────────────────────────────────────────────────────────────────
  const callbackify =
    (name: string) =>
    (...args: unknown[]): void => {
      const { rest, cb } = splitCallback(args);
      const fn = promises[name] as (...a: unknown[]) => Promise<unknown>;
      fn(...rest).then(
        (value) => cb?.(null, value),
        (err) => {
          if (cb) cb(err);
          else throw err;
        },
      );
    };

  // ── sync ──────────────────────────────────────────────────────────────────────────────────────
  const api: Record<string, unknown> = {
    promises,
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 },
    Stats: function Stats() {
      throw new NodeCompatError("ERR_NOT_CONSTRUCTIBLE", "fs.Stats is not a constructor here; stat() returns a plain object with the same methods");
    },

    readFileSync: (path: string, options?: unknown) => decodeFile(backend.opSync("readFile", { path }).data, options),
    writeFileSync: (path: string, data: unknown) => void backend.opSync("writeFile", { path }, bytesOf(data)),
    appendFileSync: (path: string, data: unknown) => void backend.opSync("appendFile", { path }, bytesOf(data)),
    mkdirSync: (path: string, options?: unknown) =>
      backend.opSync("mkdir", { path, recursive: Boolean((options as { recursive?: boolean } | undefined)?.recursive) }).value,
    readdirSync: (path: string, options?: unknown) => {
      const entries = backend.opSync("readdir", { path }).value as DirentShape[];
      return (options as { withFileTypes?: boolean } | undefined)?.withFileTypes
        ? entries.map((e) => makeDirent(e, backend.absolute(path)))
        : entries.map((e) => e.name);
    },
    statSync: (path: string) => makeStats(backend.opSync("stat", { path }).value as StatShape, backend.absolute(path)),
    lstatSync: (path: string) => makeStats(backend.opSync("lstat", { path }).value as StatShape, backend.absolute(path)),
    existsSync: (path: string) => Boolean(backend.opSync("exists", { path }).value),
    accessSync: (path: string) => void backend.opSync("access", { path }),
    unlinkSync: (path: string) => void backend.opSync("unlink", { path }),
    rmdirSync: (path: string) => void backend.opSync("rmdir", { path }),
    rmSync: (path: string, options?: unknown) => {
      const o = (options ?? {}) as { recursive?: boolean; force?: boolean };
      backend.opSync("rm", { path, recursive: o.recursive, force: o.force });
    },
    renameSync: (from: string, to: string) => void backend.opSync("rename", { path: from, to }),
    copyFileSync: (from: string, to: string) => void backend.opSync("copyFile", { path: from, to }),
    truncateSync: (path: string, len = 0) => void backend.opSync("truncate", { path, len }),
    realpathSync: (path: string) => backend.opSync("realpath", { path }).value as string,
    chmodSync: () => undefined,
    chownSync: () => undefined,
    utimesSync: () => undefined,

    /**
     * `createReadStream` reads the WHOLE file and pushes it as one chunk; `createWriteStream` buffers
     * everything and writes on `end()`. Correct for a workspace, wrong for a 4 GB log — and named so
     * here rather than discovered when the tab runs out of memory.
     */
    createReadStream: (path: string) => {
      const stream = new Readable({ read() {} });
      (promises.readFile as (p: string) => Promise<Uint8Array>)(path).then(
        (bytes) => {
          stream.push(Buffer.from(bytes));
          stream.push(null);
        },
        (err) => stream.destroy(err as Error),
      );
      return stream;
    },
    createWriteStream: (path: string) => {
      const chunks: Uint8Array[] = [];
      return new Writable({
        write(chunk: unknown, _encoding: string, done: (err?: Error) => void) {
          chunks.push(bytesOf(chunk));
          done();
        },
        final(done: (err?: Error) => void) {
          let total = 0;
          for (const c of chunks) total += c.byteLength;
          const body = new Uint8Array(total);
          let at = 0;
          for (const c of chunks) {
            body.set(c, at);
            at += c.byteLength;
          }
          (promises.writeFile as (p: string, d: unknown) => Promise<void>)(path, body).then(
            () => done(),
            (err) => done(err as Error),
          );
        },
      });
    },

    watch: () => {
      throw new NodeCompatError(
        "ERR_FS_NO_WATCH",
        "fs.watch: this filesystem has no change notifications of its own — the host emits file_changed events instead, and a script that needs them should ask the host",
      );
    },
    watchFile: () => {
      throw new NodeCompatError("ERR_FS_NO_WATCH", "fs.watchFile: see fs.watch — the host emits file_changed instead");
    },
    open: () => {
      throw new NodeCompatError(
        "ERR_FS_NO_FD",
        "fs.open: there are no file descriptors here — the store underneath is whole-file, so use readFile/writeFile",
      );
    },
    openSync: () => {
      throw new NodeCompatError("ERR_FS_NO_FD", "fs.openSync: there are no file descriptors here — use readFileSync/writeFileSync");
    },
  };

  for (const name of [
    "readFile",
    "writeFile",
    "appendFile",
    "mkdir",
    "readdir",
    "stat",
    "lstat",
    "access",
    "unlink",
    "rmdir",
    "rm",
    "rename",
    "copyFile",
    "truncate",
    "realpath",
    "chmod",
    "chown",
    "utimes",
    "symlink",
    "readlink",
    "cp",
  ]) {
    api[name] = callbackify(name);
  }
  // `exists` is Node's one callback that takes no error. Deprecated there, still called here.
  api.exists = (path: string, cb: (found: boolean) => void): void => {
    backend.op("exists", { path }, null).then(
      (r) => cb(Boolean(r.value)),
      () => cb(false),
    );
  };
  api.default = api;
  promises.default = promises;
  promises.constants = api.constants;

  return { fs: api, promises };
}

/** `fs.cp` — a file, or a whole tree when `recursive`. Depth-first, directories created as met. */
async function copyTree(backend: NodeFsBackend, from: string, to: string, recursive: boolean): Promise<void> {
  const stat = (await backend.op("stat", { path: from }, null)).value as StatShape;
  if (stat.kind === "file") {
    await backend.op("copyFile", { path: from, to }, null);
    return;
  }
  if (!recursive) {
    throw new NodeCompatError("ERR_FS_EISDIR", `fs.cp: '${from}' is a directory — pass { recursive: true }`);
  }
  await backend.op("mkdir", { path: to, recursive: true }, null);
  const entries = (await backend.op("readdir", { path: from }, null)).value as DirentShape[];
  for (const entry of entries) {
    await copyTree(backend, `${from}/${entry.name}`, `${to}/${entry.name}`, recursive);
  }
}
