/**
 * The workspace, owned by one Worker, answered synchronously.
 *
 * WHY A SEPARATE WORKER AND NOT THE PAGE. A script's Worker asks for a file and BLOCKS on
 * `Atomics.wait` (src/power/sync-channel.ts). Whoever answers must be free to do asynchronous work
 * while it is blocked — every OPFS call is a promise — so the answering thread can never be the one
 * that is waiting, and it should not be the page's main thread either: a page that answered would
 * be doing filesystem I/O on the thread that paints. So there is one dedicated Worker, it opens the
 * agent's `workspace/` folder itself through `navigator.storage.getDirectory()`, and it is the only
 * thread that holds sync access handles.
 *
 * WHY IT TOUCHES OPFS DIRECTLY AND NOT THROUGH `AgentFs`. `AgentFs` lives on the page and cannot
 * cross a thread; a handle can. What is here is the same translation `packages/agent-fs/src/opfs-fs.ts`
 * makes — a path becomes a chain of `getDirectoryHandle` calls — and it obeys that file's rule:
 * HOLD NO LOGIC WORTH TESTING. The operations are named and shaped exactly like `NodeFsBackend`'s
 * (`packages/agent-node/src/fs/backend.ts`, the far end of the async road in js-runner.ts) — dirents
 * from `readdir`, `{ size, mtimeMs, kind }` from `stat` — so a script cannot tell which road its call
 * took, and the error strings are the same sentences.
 *
 * THE PATHS ARRIVE ABSOLUTE. `NodeFsBackend.opSync` passes a script's own spelling straight through,
 * so the runtime Worker resolves it against the process cwd before it reaches this thread
 * (`ResolvingSyncClient` in src/power/node-runtime-worker.ts). Everything here is workspace-absolute.
 *
 * THE SANDBOX IS THE HANDLE. This Worker is opened at `agents/<id>/workspace` and every path is
 * resolved by popping `..` with a floor at that folder, so there is no path a script can name that
 * reaches the vault, the profile or another agent — not because a guard refused it but because the
 * traversal starts at the workspace and cannot walk upwards. `agents/` is where the app puts them
 * (bootstrap.ts, `OpfsFs.atAgentRoot`).
 *
 * IT EXISTS ONLY WHEN THE PAGE IS CROSS-ORIGIN ISOLATED. No isolation, no `SharedArrayBuffer`, no
 * channel, and `startFsService()` answers `null` — the runner then keeps its snapshot path and its
 * `SyncUnsupportedError`, which is exactly what happens on any origin that does not send the two
 * headers of apps/infinite-site/src/headers.ts.
 */

import { FILES_ROOT } from "./virtual-ports.js";
import {
  SYNC_CHANNEL_LAYOUT,
  createChannelBuffer,
  syncChannelSource,
  type SyncChannelLayout,
} from "./sync-channel.js";

/** The Worker seam, the same three methods as the runner's — a test may hand over its own. */
export interface ServiceWorkerLike {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  terminate(): void;
}

export type ServiceWorkerFactory = (source: string) => ServiceWorkerLike;

export interface FsService {
  /** The agent whose workspace this service opened. */
  readonly agentId: string;
  /** A fresh channel for one script Worker. Hand the buffer over in that Worker's start message. */
  open(): SharedArrayBuffer;
  /** That script has finished: close its channel so the service's loop for it returns. */
  release(sab: SharedArrayBuffer): void;
  /** End the service entirely. The next caller starts a new one. */
  stop(): void;
}

export interface FsServiceOptions {
  /** Which agent's workspace to open. Absent: the one folder under `agents/`, if there is one. */
  agentId?: string;
  createWorker?: ServiceWorkerFactory;
}

/**
 * Is this page allowed to share memory at all? Both halves are checked because a browser can have
 * `SharedArrayBuffer` as a name and refuse to let it cross a `postMessage` without isolation, which
 * fails later and much less clearly.
 */
export function isCrossOriginIsolated(): boolean {
  const scope = globalThis as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown };
  return scope.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === "function";
}

/** The service Worker's whole program: the channel, then the body below. */
export function fsServiceSource(): string {
  return `${syncChannelSource()}(${fsServiceMain.toString()})(self);`;
}

/** A classic Blob Worker with nothing fetched — the same sandbox argument as the runner's. */
function createBlobServiceWorker(source: string): ServiceWorkerLike {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "classic", name: "00-fs-service" });
  URL.revokeObjectURL(url);
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => {
      worker.onmessage = (event: MessageEvent) => handler(event.data);
      worker.onerror = (event: ErrorEvent) => handler({ t: "open-reply", ok: false, error: event.message });
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Start the service, or say why there is none. Never throws: every caller's fallback is the same
 * snapshot path it had before, and a runner that crashed because a browser lacked a header would be
 * a worse answer than a script that reads a snapshot.
 */
export async function startFsService(opts: FsServiceOptions = {}): Promise<FsService | null> {
  if (!isCrossOriginIsolated()) return null;
  const factory = opts.createWorker ?? (typeof Worker === "undefined" ? null : createBlobServiceWorker);
  if (!factory) return null;

  let worker: ServiceWorkerLike;
  try {
    worker = factory(fsServiceSource());
  } catch {
    return null;
  }

  const opened = await new Promise<{ ok: boolean; agentId?: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), 5_000);
    worker.onMessage((raw) => {
      const message = raw as { t?: unknown; ok?: unknown; agentId?: unknown };
      if (message?.t !== "open-reply") return;
      clearTimeout(timer);
      resolve({ ok: message.ok === true, agentId: typeof message.agentId === "string" ? message.agentId : undefined });
    });
    worker.post({ t: "open", agentId: opts.agentId ?? "", filesRoot: FILES_ROOT });
  });
  if (!opened.ok) {
    worker.terminate();
    return null;
  }

  const live = new Set<SharedArrayBuffer>();
  return {
    agentId: opened.agentId ?? "",
    open: () => {
      const sab = createChannelBuffer();
      live.add(sab);
      worker.post({ t: "serve", sab });
      return sab;
    },
    release: (sab) => {
      live.delete(sab);
      closeChannel(sab, SYNC_CHANNEL_LAYOUT);
    },
    stop: () => {
      for (const sab of live) closeChannel(sab, SYNC_CHANNEL_LAYOUT);
      live.clear();
      worker.terminate();
    },
  };
}

/** The page's half of `close()`: it holds the buffer, so it can end a loop without a message. */
function closeChannel(sab: SharedArrayBuffer, layout: SyncChannelLayout): void {
  const slots = new Int32Array(sab, 0, layout.slots);
  Atomics.store(slots, layout.state, layout.closed);
  Atomics.notify(slots, layout.state);
}

/**
 * ONE service per tab, not one per script. Opening a second Worker per `node` would mean a second
 * set of OPFS handles on the same folder, and a sync access handle is exclusive — the second would
 * lose races with the first for no gain.
 */
let shared: Promise<FsService | null> | undefined;

export function fsService(opts: FsServiceOptions = {}): Promise<FsService | null> {
  shared ??= startFsService(opts);
  return shared;
}

/** Tests and a torn-down tab: forget the singleton without touching a live one. */
export function resetFsService(): void {
  shared = undefined;
}

// ── The Worker's body ────────────────────────────────────────────────────────────────────────────

/**
 * Stringified, so the rule of the prelude in js-runner.ts applies here too: NO REFERENCE TO ANYTHING
 * OUTSIDE THIS FUNCTION. Its only dependency is `self.__00SyncChannel`, which `fsServiceSource()`
 * defines above it, and the OPFS API the browser gives every Worker.
 *
 * EXPORTED FOR THE SAME REASON `createEvalWorker` exists: a node suite can hand it a scope whose
 * `navigator.storage` is a pair of in-memory fakes (the trick packages/agent-fs/test/opfs-fs.test.ts
 * plays on `OpfsFs`) and drive every operation for real. Nothing but a test calls it directly.
 */
export function fsServiceMain(scope: {
  addEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
  [key: string]: unknown;
}): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let workspace: any = null;
  const reply = (message: unknown): void => scope.postMessage(message);

  /** A virtual path (`/lib/util.js`) as segments, with `..` popped and floored at the workspace. */
  const parts = (path: string): string[] => {
    const out: string[] = [];
    for (const segment of String(path ?? "").split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        out.pop();
        continue;
      }
      out.push(segment);
    }
    return out;
  };

  const dirAt = async (segments: string[], create: boolean): Promise<any> => {
    let cursor = workspace;
    for (const segment of segments) {
      try {
        cursor = await cursor.getDirectoryHandle(segment, { create });
      } catch {
        return null;
      }
    }
    return cursor;
  };

  const fileAt = async (segments: string[], create: boolean): Promise<any> => {
    if (!segments.length) return null;
    const dir = await dirAt(segments.slice(0, -1), create);
    if (!dir) return null;
    try {
      return await dir.getFileHandle(segments[segments.length - 1], { create });
    } catch {
      return null;
    }
  };

  /** The sync fast path, and the same fallback rule as packages/agent-fs/src/opfs-fs.ts. */
  const readBytes = async (handle: any): Promise<Uint8Array> => {
    if (handle.createSyncAccessHandle) {
      try {
        const access = await handle.createSyncAccessHandle();
        try {
          const buffer = new Uint8Array(access.getSize());
          access.read(buffer, { at: 0 });
          return buffer;
        } finally {
          access.close();
        }
      } catch {
        /* another handle is open on this file, or this engine has none — the async read is correct */
      }
    }
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  };

  const writeBytes = async (handle: any, bytes: Uint8Array, append: boolean): Promise<void> => {
    if (handle.createSyncAccessHandle) {
      try {
        const access = await handle.createSyncAccessHandle();
        try {
          const at = append ? access.getSize() : 0;
          if (!append) access.truncate(0);
          access.write(bytes, { at });
          access.flush();
          return;
        } finally {
          access.close();
        }
      } catch {
        /* fall through to createWritable */
      }
    }
    let payload = bytes;
    if (append) {
      const before = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      payload = new Uint8Array(before.byteLength + bytes.byteLength);
      payload.set(before, 0);
      payload.set(bytes, before.byteLength);
    }
    const writable = await handle.createWritable();
    await writable.write(payload);
    await writable.close();
  };

  const copyDir = async (from: any, toSegments: string[]): Promise<void> => {
    const target = await dirAt(toSegments, true);
    if (!target) return;
    for await (const child of from.values()) {
      if (child.kind === "directory") {
        await copyDir(child, toSegments.concat(child.name));
        continue;
      }
      await writeBytes(await target.getFileHandle(child.name, { create: true }), await readBytes(child), false);
    }
  };

  const enoent = (syscall: string, path: string): { ok: boolean; error: string } => ({
    ok: false,
    error: `ENOENT: no such file or directory, ${syscall} '${path}'`,
  });

  const answer = async (request: {
    op: string;
    args: Record<string, unknown>;
    data?: Uint8Array;
  }): Promise<{ ok: boolean; value?: unknown; error?: string; data?: Uint8Array }> => {
    if (!workspace) return { ok: false, error: "the filesystem service has no workspace open" };
    const segments = parts(String(request.args.path ?? ""));
    const shown = `/${segments.join("/")}`;
    const last = segments[segments.length - 1];
    switch (request.op) {
      case "readFile": {
        const handle = await fileAt(segments, false);
        if (!handle) return enoent("open", shown);
        return { ok: true, data: await readBytes(handle) };
      }
      case "writeFile":
      case "appendFile": {
        const handle = await fileAt(segments, true);
        if (!handle) return { ok: false, error: `EACCES: cannot write '${shown}'` };
        await writeBytes(handle, request.data ?? new Uint8Array(0), request.op === "appendFile");
        return { ok: true, value: null };
      }
      case "mkdir": {
        const dir = await dirAt(segments, true);
        return dir ? { ok: true, value: null } : { ok: false, error: `EACCES: cannot create '${shown}'` };
      }
      // The DIRENT shape, not a list of names: `@00/agent-node`'s `fs.readdir` answers
      // `{ name, kind }` in all three of its faces (packages/agent-node/src/modules/fs.ts), and this
      // service is the far end of the synchronous one — two spellings of a directory entry in one
      // product is one spelling and one bug.
      case "readdir": {
        const dir = await dirAt(segments, false);
        if (!dir) return enoent("scandir", shown);
        const entries: { name: string; kind: "file" | "dir" }[] = [];
        for await (const child of dir.values()) {
          entries.push({ name: child.name, kind: child.kind === "directory" ? "dir" : "file" });
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { ok: true, value: entries };
      }
      case "stat":
      case "lstat":
      case "exists": {
        const handle = await fileAt(segments, false);
        if (handle) {
          const file = await handle.getFile();
          if (request.op === "exists") return { ok: true, value: true };
          return { ok: true, value: { size: file.size, mtimeMs: file.lastModified, kind: "file" } };
        }
        const dir = await dirAt(segments, false);
        if (request.op === "exists") return { ok: true, value: Boolean(dir) };
        if (!dir) return enoent("stat", shown);
        return { ok: true, value: { size: 0, mtimeMs: 0, kind: "dir" } };
      }
      case "access": {
        const handle = (await fileAt(segments, false)) ?? (await dirAt(segments, false));
        return handle ? { ok: true, value: null } : enoent("access", shown);
      }
      case "realpath":
        return { ok: true, value: shown };
      // Permissions and timestamps: accepted and ignored, exactly as `NodeFsBackend` accepts them —
      // a tarball extraction sets a mode on every file it writes and a refusal here would fail an
      // install over something this store cannot hold.
      case "chmod":
      case "chown":
      case "utimes":
      case "lutimes":
        return { ok: true, value: null };
      case "copyFile": {
        const source = await fileAt(segments, false);
        if (!source) return enoent("copyfile", shown);
        const target = await fileAt(parts(String(request.args.to ?? "")), true);
        if (!target) return { ok: false, error: `EACCES: cannot write '${String(request.args.to ?? "")}'` };
        await writeBytes(target, await readBytes(source), false);
        return { ok: true, value: null };
      }
      case "truncate": {
        const handle = await fileAt(segments, false);
        if (!handle) return enoent("truncate", shown);
        const want = Number(request.args.len ?? 0);
        const current = await readBytes(handle);
        const out = new Uint8Array(want);
        out.set(current.subarray(0, Math.min(want, current.byteLength)));
        await writeBytes(handle, out, false);
        return { ok: true, value: null };
      }
      case "unlink":
      case "rmdir":
      case "rm": {
        if (!last) return { ok: false, error: `EPERM: the workspace itself cannot be removed` };
        const parent = await dirAt(segments.slice(0, -1), false);
        if (parent) {
          try {
            await parent.removeEntry(last, { recursive: true });
          } catch {
            /* already gone — a missing path is not an error (packages/agent-fs/src/types.ts) */
          }
        }
        return { ok: true, value: null };
      }
      case "rename": {
        const to = parts(String(request.args.to ?? ""));
        if (!last || !to.length) return { ok: false, error: `EPERM: '${shown}' cannot be renamed` };
        const parent = await dirAt(segments.slice(0, -1), false);
        const source = await fileAt(segments, false);
        if (source) {
          const target = await fileAt(to, true);
          if (!target) return { ok: false, error: `EACCES: cannot write '/${to.join("/")}'` };
          await writeBytes(target, await readBytes(source), false);
        } else {
          const dir = await dirAt(segments, false);
          if (!dir) return enoent("rename", shown);
          await copyDir(dir, to);
        }
        try {
          await parent?.removeEntry(last, { recursive: true });
        } catch {
          /* the copy is what mattered */
        }
        return { ok: true, value: null };
      }
      default:
        return { ok: false, error: `fs.${request.op} is not one of the operations this browser runtime has` };
    }
  };

  const open = async (message: { agentId?: string; filesRoot?: string }): Promise<void> => {
    try {
      const storage = (scope as any).navigator?.storage;
      if (!storage?.getDirectory) throw new Error("this browser has no OPFS");
      const root = await storage.getDirectory();
      const agents = await root.getDirectoryHandle("agents", { create: false });
      let id = message.agentId ?? "";
      if (!id) {
        const found: string[] = [];
        for await (const child of agents.values()) if (child.kind === "directory") found.push(child.name);
        if (found.length !== 1) {
          throw new Error(
            found.length
              ? "this browser holds more than one agent and the service was not told which"
              : "this browser has no agent folder yet",
          );
        }
        id = found[0]!;
      }
      const agent = await agents.getDirectoryHandle(id, { create: false });
      workspace = await agent.getDirectoryHandle(message.filesRoot || "workspace", { create: true });
      reply({ t: "open-reply", ok: true, agentId: id });
    } catch (err) {
      reply({ t: "open-reply", ok: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  scope.addEventListener("message", (event: { data: unknown }) => {
    const message = event.data as { t?: string; sab?: SharedArrayBuffer; agentId?: string; filesRoot?: string };
    if (!message || typeof message.t !== "string") return;
    if (message.t === "open") {
      void open(message);
      return;
    }
    if (message.t === "serve" && message.sab) {
      const endpoint = (scope as any).__00SyncChannel(
        message.sab,
        (scope as any).__00SyncChannelLayout,
        "server",
        answer,
      );
      void endpoint.serve();
    }
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
