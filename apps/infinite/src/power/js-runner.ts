/**
 * `node <file>` in a browser tab — one `@00/agent-node` process, hosted by this page.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. This module used to BE the runtime: a hand-written prelude,
 * stringified into a Blob Worker, with a `require` that saw the working folder and nothing else and a
 * `fs` that refused half of Node's surface. `@00/agent-node` is that runtime written properly — Node's
 * resolution algorithm, `node_modules`, `exports` maps, the whole `fs` in all three shapes, `http`
 * over a host bridge, and an npm client that talks to the registry from the tab. So this module is
 * now the HOST half and only the host half: it owns the process's lifetime (a timeout, an abort, a
 * kill), the filesystem the Worker may reach, the ports it may take, and the terminal its output
 * goes to. The Worker's side is `src/power/node-runtime-worker.ts`, an ordinary module built by vite.
 *
 * THE FOUR THINGS ONLY THE PAGE CAN DO, and they are the whole of this file:
 *
 *   1. **The filesystem.** A Worker has no `AgentFs` and no OPFS handle of ours. `answerFs` is the
 *      page doing the operation against the real filesystem, through a `NodeFsBackend` rooted at the
 *      workspace — so `/` for a script is `workspace/`, and `../../vault.json` collapses at the root
 *      rather than reaching the agent's own record.
 *   2. **The synchronous filesystem.** Under cross-origin isolation the page opens a channel to the
 *      filesystem service Worker (`src/power/fs-service.ts`) and hands the buffer over, which is what
 *      turns `require("is-number")` after an `npm install` into a real read. Without the headers the
 *      folder is snapshotted once and the loader reads that instead.
 *   3. **The ports.** `server.listen(3000)` is a message to this page, which registers a handler in
 *      `src/power/virtual-ports.ts`; the service worker turns `/~/3000/…` into a call back into the
 *      Worker. `kill 3000` ends the process behind it.
 *   4. **The terminal.** stdout and stderr are Node streams here, so chunks reach `onStdout` AS THEY
 *      ARE WRITTEN — the old runner could only hand back two strings when the script had ended, which
 *      is why a long build looked frozen.
 *
 * IT RESOLVES when the process exits — or when the main module has left a server listening, because a
 * terminal that never came back would be the wrong answer to `node server.js`. The Worker lives on
 * behind the port until `kill` or the tab.
 */
import type { AgentFs } from "@00/agent-fs";
import { PathEscapeError, resolveInSandbox, type NetworkPolicy } from "@00/agent-runtime";
import {
  ChildProcess,
  NodeFsBackend,
  ProcessManager,
  decodeChunk,
  type ProcessSpec,
  type ProcessWorker,
  type WorkerFactory,
} from "@00/agent-node";
import { fsService, type FsService } from "./fs-service.js";
import { createBrowserNodeWorker, type BootMessage, type SyncCallable } from "./node-runtime-worker.js";
import {
  FILES_ROOT,
  PortInUseError,
  registerPort,
  unregister,
  type VirtualRequest,
  type VirtualResponse,
} from "./virtual-ports.js";

// ── What a caller asks for ────────────────────────────────────────────────────────────────────────

export interface RunScriptOptions {
  /** A workspace path (`projects/site/app.js`, or `/projects/site/app.js` — `/` is the workspace). */
  entry?: string;
  /** `node -e`: the source itself, run as if it were `/[eval]` in `cwd`. */
  code?: string;
  /** What lands in `process.argv` after the script name. */
  argv?: string[];
  /** The script's working directory, workspace-rooted. */
  cwd?: string;
  env?: Record<string, string>;
  /** Called with every chunk as it is written, not once at the end. */
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  signal?: AbortSignal;
  /** Wall clock. A script that registered a port is exempt while the port is registered. */
  timeoutMs?: number;
  /** The seam: the browser passes nothing, a test passes the in-process factory. */
  createWorker?: WorkerFactory;
  /**
   * The synchronous filesystem, when this page is cross-origin isolated. Absent = ask
   * `fs-service.ts` for the tab's one service, which answers `null` on an origin without the
   * headers; `null` = force the snapshot path, which is how a test drives the refusal on purpose.
   */
  syncFs?: FsService | null;
  /**
   * A blocking client handed straight to the Worker. The node suite's road only: `Atomics.wait` is
   * illegal on a main thread, so the tests cannot drive a real channel from one.
   */
  syncClient?: SyncCallable | null;
  /** The hosts a script may reach. Absent = the empty list, and every outbound call refuses by name. */
  network?: NetworkPolicy | null;
  /** Whose workspace the service opens, when this browser holds more than one agent. */
  agentId?: string;
}

export interface RunScriptResult {
  exitCode: number;
  /** Ports still registered when this returned — a server, left running on purpose. */
  listening: number[];
}

/** A script gets a minute unless it is serving; then it lives until its port is killed or the tab is. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** How long the page waits for a handler to answer one request before it says 504 itself. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The preloaded snapshot: enough for a project folder, nowhere near enough to copy a whole disk. */
export const SNAPSHOT_MAX_BYTES = 5_000_000;
export const SNAPSHOT_MAX_FILES = 500;
/** Exit codes with a meaning: the shell prints them and the tests read them. */
export const EXIT_TIMEOUT = 124;
export const EXIT_ABORTED = 130;
export const EXIT_ERROR = 1;

/** Said once, wherever a package cannot be had. npm IS here now; this is about the machine's own. */
export const NO_PACKAGES_LINE =
  "this browser installs pure-JS packages from npm and runs scripts and static sites; anything that " +
  "needs a real toolchain needs your Mac";

// ── The snapshot ──────────────────────────────────────────────────────────────────────────────────

export interface Snapshot {
  /** Virtual absolute path (`/app.js`, `/lib/util.js`) → bytes. */
  files: Record<string, Uint8Array>;
  /** True when the folder was bigger than a snapshot may be; `require` then misses files. */
  truncated: boolean;
}

/** A workspace path, however it was typed, as the `AgentFs` path underneath it. */
export function agentPath(p: string): string {
  return resolveInSandbox(FILES_ROOT, (p ?? "").replace(/^\/+/, "") || ".");
}

/** …and back: `workspace/projects/site/app.js` → `/projects/site/app.js`. */
export function virtualPath(full: string): string {
  if (full === FILES_ROOT) return "/";
  return full.startsWith(`${FILES_ROOT}/`) ? `/${full.slice(FILES_ROOT.length + 1)}` : `/${full}`;
}

/**
 * The cwd folder, read once, for the runs that have no channel.
 *
 * WHY IT SURVIVED. On an isolated origin it is not taken at all: the loader reads the real filesystem
 * through the shared-memory channel and a snapshot would only be a stale copy. On an origin WITHOUT
 * the isolation headers it is the whole synchronous filesystem a script gets — the caps below are
 * real limits, and a `require` past them fails with the sentence that says which road it was on.
 */
export async function snapshotFolder(
  fs: AgentFs,
  root: string,
  limits: { maxBytes?: number; maxFiles?: number } = {},
): Promise<Snapshot> {
  const maxBytes = limits.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? SNAPSHOT_MAX_FILES;
  const files: Record<string, Uint8Array> = {};
  let bytes = 0;
  let count = 0;
  let truncated = false;
  const full = agentPath(root);
  // `walk` yields AGENT-ROOT-RELATIVE paths (packages/agent-fs/src/walk.ts), not paths relative to
  // the folder walked — so `entry.path` is already the thing to read and to name.
  for await (const entry of fs.walk(full, { maxEntries: maxFiles + 1 })) {
    // A `.git` is not loadable here and is exactly what fills a 5 MB budget with nothing. A
    // `node_modules` IS loadable now, so it is snapshotted like anything else — and on this road it
    // is also the first thing to blow the cap, which is what the warning is for.
    if (/(^|\/)\.git\//.test(entry.path)) continue;
    if (count >= maxFiles || bytes + entry.stat.size > maxBytes) {
      truncated = true;
      continue;
    }
    try {
      const data = await fs.readFile(entry.path);
      files[virtualPath(entry.path)] = data;
      bytes += data.byteLength;
      count += 1;
    } catch {
      truncated = true;
    }
  }
  return { files, truncated };
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────────

function defaultFactory(): WorkerFactory {
  if (typeof Worker === "undefined") {
    return () => {
      throw new Error(`this browser has no Web Worker, so it cannot run a script — ${NO_PACKAGES_LINE}`);
    };
  }
  return () => createBrowserNodeWorker();
}

/**
 * Run one script to its end (or to its first port), streaming its output as it goes.
 */
export async function runScript(fs: AgentFs, opts: RunScriptOptions): Promise<RunScriptResult> {
  const cwd = opts.cwd ?? "/";
  const argv = opts.argv ?? [];
  const stdout = opts.onStdout ?? ((): void => undefined);
  const stderr = opts.onStderr ?? ((): void => undefined);
  const base = cwd === "/" ? "" : cwd.replace(/\/$/, "");

  // `node -e` resolves its requires against the working directory, exactly as Node does — and gets a
  // filename, because a loader loads files and a synthetic one is cheaper than a second code path.
  let entryPath = `${base}/[eval]`;
  let evalSource: BootMessage["eval"] = null;
  if (opts.code === undefined) {
    if (!opts.entry) throw new Error("node: nothing to run — give it a file or -e");
    const full = agentPath(opts.entry.startsWith("/") ? opts.entry : `${cwd}/${opts.entry}`);
    const stat = await fs.stat(full);
    if (!stat || stat.kind !== "file") throw new Error(`node: cannot find module '${opts.entry}'`);
    entryPath = virtualPath(full);
  } else {
    evalSource = { path: entryPath, source: opts.code };
  }

  // The synchronous filesystem, if this origin is isolated. Never fatal: `null` is an ordinary
  // browser without the headers, and the script then gets the snapshot it always got.
  const service = opts.syncFs === undefined ? await fsService({ agentId: opts.agentId }) : opts.syncFs;
  let sab: SharedArrayBuffer | null = null;
  try {
    sab = service ? service.open() : null;
  } catch {
    sab = null;
  }
  const hasSync = Boolean(sab) || Boolean(opts.syncClient);

  const snapshot = hasSync ? { files: {}, truncated: false } : await snapshotFolder(fs, cwd);
  if (snapshot.truncated) {
    stderr(
      `node: this folder is bigger than a browser snapshot (${SNAPSHOT_MAX_FILES} files / ` +
        `${(SNAPSHOT_MAX_BYTES / 1e6).toFixed(0)} MB), so require and the sync reads may not find everything.\n`,
    );
  }

  const ports = new Set<number>();
  const inflight = new Map<number, (response: VirtualResponse) => void>();
  let requestId = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let child: ChildProcess | null = null;

  return await new Promise<RunScriptResult>((resolve) => {
    /** Everything that outlives the promise, released in one place: the channel and the ports. */
    const release = (): void => {
      if (sab && service) service.release(sab);
      sab = null;
    };
    const finish = (exitCode: number, keepPorts: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      opts.signal?.removeEventListener("abort", onAbort);
      const listening = [...ports];
      if (!keepPorts) {
        for (const port of listening) unregister(port);
        child?.kill();
        release();
      }
      resolve({ exitCode, listening: keepPorts ? listening : [] });
    };
    const kill = (code: number, message?: string): void => {
      if (message) stderr(message);
      finish(code, false);
    };
    function onAbort(): void {
      kill(EXIT_ABORTED, "\nnode: stopped.\n");
    }

    const arm = (): void => {
      if (timer) clearTimeout(timer);
      // A registered port means the script is a server, and a server is supposed to sit there.
      if (ports.size > 0) return;
      timer = setTimeout(() => {
        kill(
          EXIT_TIMEOUT,
          `\nnode: stopped after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s — a browser tab ` +
            `will not run a script forever. Long work belongs on your Mac.\n`,
        );
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    };

    /** The page half of the Worker's four extra messages; agent-node's own go to the manager. */
    const answer = (worker: ProcessWorker, raw: unknown): void => {
      const message = raw as Record<string, unknown> & { t?: string };
      if (!message || typeof message.t !== "string") return;
      switch (message.t) {
        case "fs":
          void answerFs(fs, cwd, message as Parameters<typeof answerFs>[2], (reply) => worker.post(reply));
          return;
        case "listen": {
          const port = Number(message.port);
          try {
            registerPort(port, (request) => askWorker(worker, port, request, inflight, () => (requestId += 1)), {
              kind: "script",
              label: entryPath,
              stop: () => {
                ports.delete(port);
                child?.kill();
                release();
              },
            });
            ports.add(port);
            arm();
            worker.post({ t: "listen-reply", id: message.id, ok: true });
            // The main module has left a server behind: hand the terminal back and keep the Worker.
            // A macrotask later, so the last line the script printed is already out of the pipe.
            setTimeout(() => finish(0, true), 0);
          } catch (err) {
            worker.post({
              t: "listen-reply",
              id: message.id,
              ok: false,
              error: err instanceof PortInUseError ? err.message : String(err),
            });
          }
          return;
        }
        case "close": {
          const port = Number(message.port);
          if (ports.delete(port)) unregister(port);
          arm();
          worker.post({ t: "close-reply", id: message.id, ok: true });
          return;
        }
        case "response": {
          const settle = inflight.get(Number(message.id));
          if (!settle) return;
          inflight.delete(Number(message.id));
          settle({
            status: Number(message.status) || 200,
            headers: (message.headers as Record<string, string>) ?? {},
            body: toBytes(message.body),
          });
          return;
        }
        case "error":
          kill(EXIT_ERROR, `node: ${String(message.message ?? "the script's Worker failed")}\n`);
          return;
        default:
          return;
      }
    };

    const factory = opts.createWorker ?? defaultFactory();
    const manager = new ProcessManager({
      createWorker: (spec: ProcessSpec): ProcessWorker => {
        const worker = factory(spec);
        worker.onMessage((raw) => answer(worker, raw));
        // Before agent-node's own `start`, which the manager posts the moment this returns.
        const boot: BootMessage = {
          t: "boot",
          sab,
          files: snapshot.files,
          eval: evalSource,
          network: opts.network ?? null,
          syncClient: opts.syncClient ?? null,
        };
        worker.post(boot);
        return worker;
      },
      cwd,
      env: opts.env ?? {},
    });

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort);
    arm();

    try {
      child = manager.spawn("node", [entryPath, ...argv], { cwd, env: opts.env ?? {} });
    } catch (err) {
      kill(EXIT_ERROR, `node: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
    child.stdout?.on("data", (chunk: Uint8Array) => stdout(decodeChunk(chunk)));
    child.stderr?.on("data", (chunk: Uint8Array) => stderr(decodeChunk(chunk)));
    child.on("close", (code: number | null) => finish(code ?? EXIT_ERROR, false));
  });
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}

/** One request into a script's handler, with the page's own timeout so nothing hangs forever. */
function askWorker(
  worker: ProcessWorker,
  port: number,
  request: VirtualRequest,
  inflight: Map<number, (response: VirtualResponse) => void>,
  nextId: () => number,
): Promise<VirtualResponse> {
  const id = nextId();
  return new Promise<VirtualResponse>((resolve) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      resolve({
        status: 504,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        body: new TextEncoder().encode(`the handler on ${port} did not answer in ${REQUEST_TIMEOUT_MS / 1000}s.`),
      });
    }, REQUEST_TIMEOUT_MS);
    inflight.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    worker.post({
      t: "request",
      id,
      port,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });
  });
}

// ── The filesystem RPC, answered ──────────────────────────────────────────────────────────────────

/**
 * The Worker asked for a filesystem operation; this is the page doing it, against the real `AgentFs`.
 *
 * IT IS ONE CALL, and that is the point: `NodeFsBackend` is where an `fs` operation is implemented
 * exactly once in this product (`packages/agent-node/src/fs/backend.ts`), for the callbacks, the
 * promises and the synchronous forms alike. A second hand-written map here — the twenty-verb switch
 * this function used to be — was a second dialect to drift, and it drifted: it had no `copyFile`, no
 * `truncate`, no `lstat`, and its `readdir` answered names where every other road answers dirents.
 *
 * THE SANDBOX IS THE ROOT. The backend is rooted at `workspace` and resolves against the script's
 * cwd, and `toAgentPath` collapses `..` before anything is opened — so `/` is the workspace and there
 * is no path a script can type that climbs above it.
 */
export async function answerFs(
  fs: AgentFs,
  cwd: string,
  message: { id?: unknown; op?: unknown; args?: unknown; data?: unknown },
  reply: (message: unknown) => void,
): Promise<void> {
  const id = message.id;
  const op = String(message.op ?? "");
  const args = (message.args ?? {}) as Record<string, unknown>;
  const data = message.data instanceof Uint8Array ? message.data : null;
  const backend = new NodeFsBackend({ fs, root: FILES_ROOT, cwd: () => cwd });
  try {
    const answer = await backend.call(op, args, data);
    reply({ t: "fs-reply", id, ok: true, value: answer.value, data: answer.data });
  } catch (err) {
    const failure = err as Error & { code?: string };
    reply({
      t: "fs-reply",
      id,
      ok: false,
      error: err instanceof PathEscapeError ? `${String(args.path)}: outside your workspace` : failure.message,
      code: failure.code,
    });
  }
}
