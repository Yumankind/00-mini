/**
 * `NodeFsBackend` — the whole of Node's `fs` expressed as ONE async dispatcher over `AgentFs`.
 *
 * WHY ONE DISPATCHER AND NOT THIRTY METHODS. The `fs` module has three faces (callbacks, promises,
 * sync) over the same twenty operations, and the sync face has to cross a thread boundary as data.
 * If each face were written separately they would drift, and the sync face — the one nobody can
 * debug — would drift first. So there is exactly one place an operation is implemented (`op()`),
 * `call()` is that same map addressed by name for the shared-memory channel, and
 * `src/modules/fs.ts` wraps it three ways without deciding anything.
 *
 * WHAT IT DOES NOT DO, said here rather than discovered later: no file descriptors (`open`/`read`/
 * `write`/`close` — a Worker has no fd table and the underlying store is whole-file), no symlinks
 * (OPFS has none; `symlink`/`readlink` refuse by name), no watching (`fs.watch` is the host's
 * business — the app already emits `file_changed`), no permissions (`chmod`/`chown` succeed and
 * change nothing, because refusing them breaks tarball extraction for no gain), and no `..` above
 * the workspace: every path is collapsed against the virtual root first (`src/paths.ts`).
 */

import type { AgentFs, FsEntry } from "@00/agent-fs";
import { eisdir, enoent, enotdir, failSyncFs, NodeCompatError } from "../errors.js";
import { normalizeAbs, resolveAbs, toAgentPath } from "../paths.js";
import type { SyncFsClient, SyncFsService } from "./sync-channel.js";

export interface StatShape {
  size: number;
  mtimeMs: number;
  kind: "file" | "dir";
}

export interface DirentShape {
  name: string;
  kind: "file" | "dir";
}

export interface NodeFsBackendOptions {
  fs: AgentFs;
  /** The agent-relative folder the virtual `/` maps to. `"workspace"` in the app. */
  root?: string;
  /** Where a relative path resolves from. A function, because `process.chdir` moves it. */
  cwd?: () => string;
  /** The other end of `serveSyncChannel`. Absent means every `*Sync` call refuses by name. */
  sync?: SyncFsClient | null;
}

type Args = Record<string, unknown>;

const encoder = new TextEncoder();

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

export class NodeFsBackend implements SyncFsService {
  readonly fs: AgentFs;
  readonly root: string;
  private readonly cwdOf: () => string;
  /** Set by the host once a channel exists; `null` is the ordinary, un-isolated case. */
  sync: SyncFsClient | null;

  constructor(opts: NodeFsBackendOptions) {
    this.fs = opts.fs;
    this.root = opts.root ?? "";
    this.cwdOf = opts.cwd ?? (() => "/");
    this.sync = opts.sync ?? null;
  }

  /**
   * Node's fs accepts a `file:` URL wherever it accepts a path, and `import.meta.url` handed
   * straight to `readFile` is how half of ESM reads a file beside itself. A `URL` object and a
   * `file://…` string both arrive here as the path they name; anything else is left alone.
   */
  private static asPath(p: unknown): string {
    if (p instanceof URL) return decodeURIComponent(p.pathname);
    const text = String(p);
    if (!text.startsWith("file:")) return text;
    return decodeURIComponent(new URL(text).pathname);
  }

  /** A virtual path, however it was typed, as the `AgentFs` path underneath it. */
  agentPath(p: string): string {
    return toAgentPath(this.root, resolveAbs(this.cwdOf(), NodeFsBackend.asPath(p)));
  }

  /** The absolute virtual path, for anything that reports a path back to the script. */
  absolute(p: string): string {
    return resolveAbs(this.cwdOf(), NodeFsBackend.asPath(p));
  }

  get hasSync(): boolean {
    return this.sync !== null;
  }

  // ── The one implementation ──────────────────────────────────────────────────────────────────────

  async op(name: string, args: Args, data: Uint8Array | null): Promise<{ value?: unknown; data?: Uint8Array }> {
    const p = (key = "path"): string => this.agentPath(String(args[key] ?? ""));
    switch (name) {
      case "readFile": {
        const path = p();
        const stat = await this.fs.stat(path);
        if (!stat) throw enoent("open", String(args.path));
        if (stat.kind === "dir") throw eisdir("read", String(args.path));
        return { data: await this.fs.readFile(path) };
      }
      case "writeFile":
        await this.fs.writeFile(p(), data ?? new Uint8Array(0));
        return {};
      case "appendFile": {
        const path = p();
        const before = (await this.fs.stat(path))?.kind === "file" ? await this.fs.readFile(path) : new Uint8Array(0);
        const extra = data ?? new Uint8Array(0);
        const joined = new Uint8Array(before.byteLength + extra.byteLength);
        joined.set(before, 0);
        joined.set(extra, before.byteLength);
        await this.fs.writeFile(path, joined);
        return {};
      }
      case "mkdir": {
        const path = p();
        const existing = await this.fs.stat(path);
        if (existing) {
          if (args.recursive) return {};
          throw new NodeCompatError("EEXIST", `EEXIST: file already exists, mkdir '${String(args.path)}'`);
        }
        if (!args.recursive) {
          const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
          const parentStat = parent === "" ? { kind: "dir" as const } : await this.fs.stat(parent);
          if (!parentStat) throw enoent("mkdir", String(args.path));
          if (parentStat.kind !== "dir") throw enotdir("mkdir", String(args.path));
        }
        await this.fs.mkdir(path);
        return {};
      }
      case "readdir": {
        const entries: FsEntry[] = await this.fs.readdir(p());
        const value: DirentShape[] = entries
          .map((e) => ({ name: e.name, kind: e.kind }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { value };
      }
      case "stat":
      case "lstat": {
        const stat = await this.fs.stat(p());
        if (!stat) throw enoent("stat", String(args.path));
        return { value: { size: stat.size, mtimeMs: stat.mtime, kind: stat.kind } satisfies StatShape };
      }
      case "exists":
        return { value: (await this.fs.stat(p())) !== null };
      case "unlink": {
        const path = p();
        const stat = await this.fs.stat(path);
        if (!stat) throw enoent("unlink", String(args.path));
        if (stat.kind === "dir") throw eisdir("unlink", String(args.path));
        await this.fs.remove(path);
        return {};
      }
      case "rmdir": {
        const path = p();
        const stat = await this.fs.stat(path);
        if (!stat) throw enoent("rmdir", String(args.path));
        if (stat.kind !== "dir") throw enotdir("rmdir", String(args.path));
        // Node's rmdir refuses a directory with anything in it, and a script that deletes a tree by
        // accident because this one did not is a script that loses work. `rm({ recursive: true })`
        // is the deliberate spelling.
        if ((await this.fs.readdir(path)).length > 0) {
          throw new NodeCompatError("ENOTEMPTY", `ENOTEMPTY: directory not empty, rmdir '${String(args.path)}'`);
        }
        await this.fs.remove(path);
        return {};
      }
      case "rm": {
        const path = p();
        const stat = await this.fs.stat(path);
        if (!stat) {
          if (args.force) return {};
          throw enoent("rm", String(args.path));
        }
        if (stat.kind === "dir" && !args.recursive) {
          throw new NodeCompatError("ERR_FS_EISDIR", `Path is a directory: rm '${String(args.path)}' — pass { recursive: true }`);
        }
        await this.fs.remove(path);
        return {};
      }
      case "rename": {
        const from = p();
        if (!(await this.fs.stat(from))) throw enoent("rename", String(args.path));
        await this.fs.rename(from, p("to"));
        return {};
      }
      case "copyFile": {
        const from = p();
        const stat = await this.fs.stat(from);
        if (!stat) throw enoent("copyfile", String(args.path));
        if (stat.kind === "dir") throw eisdir("copyfile", String(args.path));
        await this.fs.writeFile(p("to"), await this.fs.readFile(from));
        return {};
      }
      case "truncate": {
        const path = p();
        const stat = await this.fs.stat(path);
        if (!stat) throw enoent("truncate", String(args.path));
        const want = Number(args.len ?? 0);
        const current = await this.fs.readFile(path);
        const out = new Uint8Array(want);
        out.set(current.subarray(0, Math.min(want, current.byteLength)));
        await this.fs.writeFile(path, out);
        return {};
      }
      case "realpath":
        return { value: normalizeAbs(this.absolute(String(args.path ?? ""))) };
      case "access": {
        if (!(await this.fs.stat(p()))) throw enoent("access", String(args.path));
        return {};
      }
      // Permissions and timestamps: accepted and ignored. A tarball extraction sets a mode on every
      // file it writes, and a refusal here would fail an install over something the store cannot hold.
      case "chmod":
      case "chown":
      case "utimes":
      case "lutimes":
        return {};
      case "symlink":
      case "readlink":
      case "link":
        throw new NodeCompatError(
          "EINVAL",
          `${name}: this filesystem has no symbolic links (OPFS has none), so '${String(args.path)}' cannot be linked`,
        );
      default:
        throw new NodeCompatError("ERR_FS_OP_UNKNOWN", `fs.${name} is not one of the operations this runtime has`);
    }
  }

  /** The `SyncFsService` face: the same map, addressed by name from the other thread. */
  call(op: string, args: Args, data: Uint8Array | null): Promise<{ value?: unknown; data?: Uint8Array }> {
    return this.op(op, args, data);
  }

  /** The sync face. Throws `ERR_SYNC_FS_UNAVAILABLE` with the isolation sentence when there is no channel. */
  opSync(name: string, args: Args, data: Uint8Array | null = null): { value: unknown; data: Uint8Array } {
    if (!this.sync) failSyncFs(`fs.${name}Sync('${String(args.path ?? "")}')`);
    return this.sync.call(name, args, data);
  }

  // ── Small helpers the layers above want and should not re-derive ────────────────────────────────

  async readFile(path: string): Promise<Uint8Array> {
    return (await this.op("readFile", { path }, null)).data as Uint8Array;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.op("writeFile", { path }, bytesOf(data));
  }

  async mkdirp(path: string): Promise<void> {
    await this.op("mkdir", { path, recursive: true }, null);
  }

  async statOrNull(path: string): Promise<StatShape | null> {
    const found = await this.op("exists", { path }, null);
    if (!found.value) return null;
    return (await this.op("stat", { path }, null)).value as StatShape;
  }
}

export { bytesOf };
