/**
 * `node <file>` in a browser tab — a Worker with a Node-flavoured prelude.
 *
 * WHY THIS AND NOT A WASM NODE. There is no Node in a browser and there is not going to be one: the
 * things `node` means (a process, a socket, a synchronous filesystem) are things a tab does not have.
 * What people actually run in a project folder is far narrower — a script that reads and writes files
 * beside it, a script that prints, and a tiny server. All three are reachable with a Web Worker, a
 * `require` that resolves the project's OWN files, and a `listen` that registers a virtual port
 * (`src/power/virtual-ports.ts`). Everything past that edge REFUSES BY NAME: `require("express")`
 * says there is no `node_modules` in a browser, `readFileSync` on an unknown file says why the sync
 * form cannot reach the real filesystem, and `npm install` stays refused in the shell. Real Node is
 * on the Mac and in the cloud, and that is where the terminal points.
 *
 * THE WORKER IS THE SANDBOX. A Worker has no DOM, no `window`, no access to this app's OPFS handles
 * and no `importScripts` of anything remote — it is handed its files as bytes and can touch the
 * filesystem only through an RPC the page answers, which means every write goes through the same
 * `AgentFs` the agent and the file tree read. So a script the agent wrote cannot reach the vault, and
 * a `fs.promises.writeFile` shows up in the tree a second later, which is the whole point.
 *
 * THE BOUNDARY IS AN INTERFACE. `RunnerWorker` is three methods, and the browser's implementation
 * (`createBlobWorker`, `type: "classic"`, no network) is one of two: the other runs the SAME prelude
 * source in-process, which is how the node test suite runs a real script through a real `require`
 * without a real Worker. Node 24's `worker_threads` Worker is not the browser's, and a fake that only
 * pretended would be a test of the fake.
 *
 * THE PRELUDE IS A FUNCTION, NOT A STRING. `preludeMain` below is ordinary TypeScript, stringified
 * with `Function.prototype.toString()` and handed to the Worker. That keeps it typechecked, readable
 * and testable — at the price of ONE RULE, which the tests pin: it may not reference a single name
 * from this module's scope, because the closure does not travel. It may use only its own body and
 * the globals a Worker has.
 *
 * AND SINCE THE ORIGIN IS CROSS-ORIGIN ISOLATED, THE SYNC HALF OF `fs` IS REAL. When
 * apps/infinite-site sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` (and the
 * dev server sends the same pair), the page may make a `SharedArrayBuffer`, so each script Worker is
 * handed a channel to the filesystem service Worker (`src/power/fs-service.ts`) and
 * `readFileSync`/`writeFileSync`/`require` become real calls against the workspace instead of reads
 * from a snapshot. Nothing else changes: the async RPC below is untouched and is still what
 * `fs.promises` uses, and on an origin WITHOUT the headers the snapshot and `SyncUnsupportedError`
 * are exactly what they were. One runtime, two answers, and the error names which one it is on.
 *
 * WHAT IT NEEDS FROM THE PAGE THAT IT MIGHT NOT GET: `new Function` (the CommonJS module wrapper is
 * `new Function` everywhere, including in Node), so a Content-Security-Policy without `unsafe-eval`
 * would stop this dead. The app sends no CSP today; the day it does, `script-src` needs to allow it
 * or `node` goes back to being a refusal.
 */
import type { AgentFs } from "@00/agent-fs";
import { PathEscapeError, resolveInSandbox } from "@00/agent-runtime";
import { fsService, type FsService } from "./fs-service.js";
import { syncChannelSource } from "./sync-channel.js";
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
  /** The script's working directory, workspace-rooted. Its files are the ones `require` can see. */
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  signal?: AbortSignal;
  /** Wall clock. A script that registered a port is exempt while the port is registered. */
  timeoutMs?: number;
  /** The seam: the browser passes nothing, a test passes the in-process one. */
  createWorker?: RunnerWorkerFactory;
  /**
   * The synchronous filesystem, when this page is cross-origin isolated. Absent = ask
   * `fs-service.ts` for the tab's one service, which answers `null` on an origin without the
   * headers; `null` = force the snapshot path, which is how a test drives the refusal on purpose.
   */
  syncFs?: FsService | null;
  /** Whose workspace the service opens, when this browser holds more than one agent. */
  agentId?: string;
}

export interface RunScriptResult {
  exitCode: number;
  /** Ports still registered when this returned — a server, left running on purpose. */
  listening: number[];
}

export interface RunnerWorker {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  terminate(): void;
}

export type RunnerWorkerFactory = (source: string) => RunnerWorker;

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

/** Said once, everywhere a package is asked for. */
export const NO_PACKAGES_LINE = "this browser runs scripts and static sites; packages need your Mac";

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
 * The cwd folder, read once, so the Worker can `require` and `readFileSync` without a round trip.
 *
 * WHY A SNAPSHOT AT ALL, NOW THAT THERE IS A SYNC CHANNEL. It is the fast path, not the only path:
 * the files a script is about to `require` travel with it, so the common case costs no round trips.
 * On an isolated origin anything the snapshot missed is fetched over the channel
 * (`src/power/fs-service.ts`) the moment it is asked for, so `truncated` stops being a warning. On an
 * origin without the isolation headers the snapshot IS the whole synchronous filesystem, the caps
 * below are real limits, and a sync read past them refuses by name.
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
    // A `.git` or a stray `node_modules` is neither the person's code nor loadable here, and it is
    // exactly what fills a 5 MB budget with nothing.
    if (/(^|\/)(\.git|node_modules)\//.test(entry.path)) continue;
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

// ── The Worker, both ways of making one ───────────────────────────────────────────────────────────

/**
 * The prelude as source: what a Blob URL Worker is built from, and what the test seam evaluates.
 *
 * The channel client is APPENDED, not prepended, for two reasons: the assertion that this source
 * starts with the prelude stays true, and the prelude reads `self.__00SyncChannel` only when a
 * `start` message arrives — which is always later than the last line of this string.
 */
export function workerSource(): string {
  return `(${preludeMain.toString()})(self);\n${syncChannelSource()}`;
}

/**
 * The browser's Worker: a Blob URL, `type: "classic"`, and NOTHING fetched. The blob inherits this
 * origin, so `fetch` from inside a script is subject to the same CORS the page is — which is the
 * honest answer to "can my script call an API": only if that API allows this origin.
 */
export function createBlobWorker(source: string): RunnerWorker {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "classic", name: "00-js-runner" });
  // Revoked immediately: the Worker has already been handed the bytes, and a URL left alive is a
  // handle to this script that anything on the origin could open.
  URL.revokeObjectURL(url);
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => {
      worker.onmessage = (event: MessageEvent) => handler(event.data);
      worker.onerror = (event: ErrorEvent) => handler({ t: "fatal", message: event.message || "the script's Worker failed" });
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * The same prelude, run in this process — the test seam, and the only way a node suite can execute a
 * real `require` graph. It is NOT a fake protocol: the messages, the prelude and the page half are
 * the shipped ones; only the thread is missing.
 */
export function createEvalWorker(source: string, globals?: Record<string, unknown>): RunnerWorker {
  const listeners: ((message: unknown) => void)[] = [];
  const inbox: ((message: unknown) => void)[] = [];
  let dead = false;
  // DELIVERY IS ASYNCHRONOUS, both ways. A real Worker's message never arrives inside the call that
  // sent it, and a fake that delivered synchronously would hide every ordering bug there is — the
  // first one it hid was `listen()` completing before the main module returned.
  const later = (fn: () => void): void => void queueMicrotask(fn);
  const scope = {
    postMessage: (message: unknown) => {
      if (dead) return;
      later(() => {
        for (const listener of listeners) listener(message);
      });
    },
    addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
      if (type === "message") inbox.push((data) => handler({ data }));
    },
    close: () => {
      dead = true;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", source)(scope);
  // AFTER the source, so a test's fake wins over the real channel client the source just installed.
  // A browser never passes any: there `self` is the Worker's own global and nothing overwrites it.
  if (globals) Object.assign(scope, globals);
  return {
    post: (message) => {
      if (dead) return;
      later(() => {
        for (const handler of [...inbox]) handler(message);
      });
    },
    onMessage: (handler) => listeners.push(handler),
    terminate: () => {
      dead = true;
    },
  };
}

function defaultFactory(): RunnerWorkerFactory {
  if (typeof Worker === "undefined") {
    return () => {
      throw new Error(`this browser has no Web Worker, so it cannot run a script — ${NO_PACKAGES_LINE}`);
    };
  }
  return createBlobWorker;
}

// ── The page half ─────────────────────────────────────────────────────────────────────────────────

interface FromWorker {
  t?: unknown;
  id?: unknown;
  op?: unknown;
  args?: unknown;
  [key: string]: unknown;
}

/**
 * Run one script to its end (or to its first port), streaming its output as it goes.
 *
 * It RESOLVES when the script exits — or when the script's main module has finished and left a
 * server listening, because a terminal that never came back would be the wrong answer to
 * `node server.js`. The Worker stays alive behind the port; `kill 3000` is what ends it.
 */
export async function runScript(fs: AgentFs, opts: RunScriptOptions): Promise<RunScriptResult> {
  const cwd = opts.cwd ?? "/";
  const argv = opts.argv ?? [];
  const stdout = opts.onStdout ?? (() => undefined);
  const stderr = opts.onStderr ?? (() => undefined);

  // `node -e` resolves its requires against the working directory, exactly as Node does.
  let entryPath = `${cwd === "/" ? "" : cwd.replace(/\/$/, "")}/[eval]`;
  let source = opts.code ?? "";
  if (opts.code === undefined) {
    if (!opts.entry) throw new Error("node: nothing to run — give it a file or -e");
    const full = agentPath(opts.entry.startsWith("/") ? opts.entry : `${cwd}/${opts.entry}`);
    const stat = await fs.stat(full);
    if (!stat || stat.kind !== "file") throw new Error(`node: cannot find module '${opts.entry}'`);
    source = await fs.readText(full);
    entryPath = virtualPath(full);
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

  const snapshot = await snapshotFolder(fs, cwd);
  if (snapshot.truncated && !sab) {
    stderr(
      `node: this folder is bigger than a browser snapshot (${SNAPSHOT_MAX_FILES} files / ` +
        `${(SNAPSHOT_MAX_BYTES / 1e6).toFixed(0)} MB), so require and the sync reads may not find everything.\n`,
    );
  }

  const worker = (opts.createWorker ?? defaultFactory())(workerSource());
  const ports = new Set<number>();
  const inflight = new Map<number, (response: VirtualResponse) => void>();
  let requestId = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return await new Promise<RunScriptResult>((resolve) => {
    const stop = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      opts.signal?.removeEventListener("abort", onAbort);
    };
    /** Ports outlive the run; everything else does not. */
    const finish = (exitCode: number, keepPorts: boolean): void => {
      if (settled) return;
      settled = true;
      stop();
      const listening = [...ports];
      if (!keepPorts) {
        for (const port of listening) unregister(port);
        worker.terminate();
        // A Worker that is gone will never read its channel again; leaving the service's loop for it
        // parked on `waitAsync` would be a leak per `node` command.
        if (sab && service) service.release(sab);
      }
      resolve({ exitCode, listening: keepPorts ? listening : [] });
    };
    const kill = (code: number, message?: string): void => {
      if (message) stderr(message);
      for (const port of [...ports]) unregister(port);
      worker.terminate();
      if (sab && service) service.release(sab);
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

    worker.onMessage((raw) => {
      const message = raw as FromWorker;
      if (!message || typeof message.t !== "string") return;
      switch (message.t) {
        case "stdout":
          stdout(String(message.text ?? ""));
          return;
        case "stderr":
          stderr(String(message.text ?? ""));
          return;
        case "fs":
          void answerFs(fs, cwd, message, (reply) => worker.post(reply));
          return;
        case "listen": {
          const port = Number(message.port);
          try {
            registerPort(
              port,
              (request) => askWorker(worker, port, request, inflight, () => (requestId += 1)),
              {
                kind: "script",
                label: entryPath,
                stop: () => {
                  ports.delete(port);
                  worker.terminate();
                },
              },
            );
            ports.add(port);
            arm();
            worker.post({ t: "listen-reply", id: message.id, ok: true });
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
        case "idle":
          // The main module finished and left a server behind: hand the terminal back, keep the port.
          finish(0, true);
          return;
        case "exit":
          finish(Number(message.code) || 0, false);
          return;
        case "fatal":
          kill(EXIT_ERROR, `node: ${String(message.message ?? "the script's Worker failed")}\n`);
          return;
        default:
          return;
      }
    });

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort);
    arm();
    worker.post({
      t: "start",
      entry: entryPath,
      source,
      argv,
      cwd,
      env: opts.env ?? {},
      files: snapshot.files,
      truncated: snapshot.truncated,
      // The one thing in this message that is not a copy: both threads see the same memory, which is
      // the whole point. Absent on an origin that is not cross-origin isolated.
      sab,
    });
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
  worker: RunnerWorker,
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
 * EVERY PATH GOES THROUGH THE SANDBOX GUARD. A script is code the agent wrote or the person pasted,
 * and `/` for it is the workspace — `resolveInSandbox` is what makes `../../vault.json` a refusal
 * here just as it is in the shell and in the agent's own tools.
 */
export async function answerFs(
  fs: AgentFs,
  cwd: string,
  message: { id?: unknown; op?: unknown; args?: unknown },
  reply: (message: unknown) => void,
): Promise<void> {
  const id = message.id;
  const op = String(message.op ?? "");
  const args = (message.args ?? {}) as { path?: string; to?: string; data?: unknown; recursive?: boolean };
  const send = (value: unknown): void => reply({ t: "fs-reply", id, ok: true, value });
  const fail = (error: string): void => reply({ t: "fs-reply", id, ok: false, error });
  let path: string;
  try {
    path = agentPath(args.path?.startsWith("/") ? args.path : `${cwd}/${args.path ?? ""}`);
  } catch (err) {
    fail(err instanceof PathEscapeError ? `${String(args.path)}: outside your workspace` : String(err));
    return;
  }
  try {
    switch (op) {
      case "readFile":
        send({ bytes: await fs.readFile(path) });
        return;
      case "writeFile":
        await fs.writeFile(path, toBytes(args.data));
        send(null);
        return;
      case "appendFile": {
        const before = (await fs.stat(path)) ? await fs.readFile(path) : new Uint8Array(0);
        const extra = toBytes(args.data);
        const joined = new Uint8Array(before.byteLength + extra.byteLength);
        joined.set(before, 0);
        joined.set(extra, before.byteLength);
        await fs.writeFile(path, joined);
        send(null);
        return;
      }
      case "mkdir":
        await fs.mkdir(path);
        send(null);
        return;
      case "readdir":
        send((await fs.readdir(path)).map((e) => e.name));
        return;
      case "stat": {
        const stat = await fs.stat(path);
        if (!stat) {
          fail(`ENOENT: no such file or directory, stat '${String(args.path)}'`);
          return;
        }
        send({ size: stat.size, mtimeMs: stat.mtime, file: stat.kind === "file", directory: stat.kind === "dir" });
        return;
      }
      case "exists":
        send(!!(await fs.stat(path)));
        return;
      case "unlink":
      case "rm":
        await fs.remove(path);
        send(null);
        return;
      case "rename": {
        const to = agentPath(args.to?.startsWith("/") ? args.to : `${cwd}/${args.to ?? ""}`);
        await fs.rename(path, to);
        send(null);
        return;
      }
      default:
        fail(`fs.${op} is not one of the operations this browser runtime has`);
        return;
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ── The prelude ───────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the script sees. Stringified into the Worker, so: NO REFERENCE TO ANYTHING OUTSIDE THIS
 * FUNCTION — not a constant of this module, not an import, not a helper. A test runs the built source
 * in an empty scope, which is what catches a slip.
 *
 * The shape it builds is deliberately Node's and not a new one: a script that runs here should run on
 * the Mac unchanged, and a script that cannot run here should say the Node thing it is missing.
 */
function preludeMain(scope: {
  postMessage: (message: unknown) => void;
  addEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
  close?: () => void;
}): void {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const rawTimeout = setTimeout;
  const NO_PACKAGES = "this browser runs scripts and static sites; packages need your Mac";

  let files: Record<string, Uint8Array> = {};
  let cwd = "/";
  let entry = "/[eval]";
  let started = false;
  let finished = false;
  let mainDone = false;
  let idled = false;
  let alive = 0; // outstanding timers, fetches and filesystem calls — Node's "the loop is not empty"
  /**
   * The blocking filesystem, when the page was cross-origin isolated and handed this Worker a
   * `SharedArrayBuffer` (src/power/sync-channel.ts, src/power/fs-service.ts). `null` on every other
   * origin, and that `null` is what every `*Sync` refusal below is about.
   */
  let syncFs: {
    call: (op: string, args?: Record<string, unknown>, data?: Uint8Array) => {
      ok: boolean;
      value?: unknown;
      error?: string;
      data?: Uint8Array;
    };
  } | null = null;
  let rpcId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  const servers = new Map<number, (req: unknown, res: unknown) => void>();
  const cache: Record<string, { exports: unknown }> = {};
  const post = (message: unknown): void => scope.postMessage(message);

  // ── paths (POSIX, rooted at the workspace) ──
  const split = (p: string): string[] => p.split("/").filter((s) => s.length > 0 && s !== ".");
  const normalize = (p: string): string => {
    const out: string[] = [];
    for (const part of split(p)) {
      if (part === "..") out.pop();
      else out.push(part);
    }
    return `/${out.join("/")}`;
  };
  const join = (...parts: string[]): string => normalize(parts.filter((p) => p !== "").join("/"));
  const dirname = (p: string): string => {
    const at = p.lastIndexOf("/");
    return at <= 0 ? "/" : p.slice(0, at);
  };
  const basename = (p: string, ext?: string): string => {
    const name = p.slice(p.lastIndexOf("/") + 1);
    return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
  };
  const extname = (p: string): string => {
    const name = basename(p);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot) : "";
  };
  const resolvePath = (...parts: string[]): string => {
    let out = cwd;
    for (const part of parts) out = part.startsWith("/") ? part : `${out}/${part}`;
    return normalize(out);
  };

  // ── the page, asked ──
  const rpc = (op: string, args: Record<string, unknown>): Promise<unknown> => {
    alive += 1;
    return new Promise((resolve, reject) => {
      const id = ++rpcId;
      pending.set(id, {
        resolve: (value) => {
          alive -= 1;
          resolve(value);
          settleLater();
        },
        reject: (err) => {
          alive -= 1;
          reject(err);
          settleLater();
        },
      });
      post({ t: "fs", id, op, args });
    });
  };

  /**
   * The same question, asked synchronously. The service answers with the sentences the async RPC
   * answers with (`ENOENT: …`), so a script cannot tell which road its call took — which is the
   * point: the same script must behave the same way here and on the Mac.
   */
  const syncAsk = (op: string, args: Record<string, unknown>, data?: Uint8Array): { value?: unknown; data?: Uint8Array } => {
    const answer = syncFs!.call(op, args, data);
    if (!answer.ok) throw new Error(answer.error ?? `fs.${op} failed`);
    return answer;
  };

  const write = (stream: "stdout" | "stderr", text: string): boolean => {
    post({ t: stream, text: String(text) });
    return true;
  };

  // ── console ──
  const show = (value: unknown, depth = 0): string => {
    if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
    if (value === null || value === undefined || typeof value !== "object") return String(value);
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v), depth ? 0 : 2);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const format = (...args: unknown[]): string => args.map((a) => show(a)).join(" ");
  const consoleShim = {
    log: (...args: unknown[]) => write("stdout", `${format(...args)}\n`),
    info: (...args: unknown[]) => write("stdout", `${format(...args)}\n`),
    debug: (...args: unknown[]) => write("stdout", `${format(...args)}\n`),
    dir: (value: unknown) => write("stdout", `${show(value)}\n`),
    warn: (...args: unknown[]) => write("stderr", `${format(...args)}\n`),
    error: (...args: unknown[]) => write("stderr", `${format(...args)}\n`),
    trace: (...args: unknown[]) => write("stderr", `Trace: ${format(...args)}\n`),
  };

  // ── process ──
  class ExitSignal extends Error {
    code: number;
    constructor(code: number) {
      super(`process.exit(${code})`);
      this.name = "ExitSignal";
      this.code = code;
    }
  }
  const processShim = {
    argv: ["node", entry] as string[],
    env: {} as Record<string, string>,
    platform: "browser",
    version: "browser",
    versions: { node: "browser" },
    exitCode: 0,
    pid: 1,
    cwd: () => cwd,
    chdir: (to: string) => {
      cwd = resolvePath(to);
    },
    exit: (code?: number) => {
      throw new ExitSignal(typeof code === "number" ? code : processShim.exitCode || 0);
    },
    stdout: { write: (text: string) => write("stdout", text), isTTY: false, columns: 80 },
    stderr: { write: (text: string) => write("stderr", text), isTTY: false, columns: 80 },
    // A browser has no signals and no `beforeExit`; accepting the listener and never calling it is
    // the same thing Node does for a signal that never arrives, and it stops a crash on line one.
    on: () => processShim,
    once: () => processShim,
    off: () => processShim,
    removeListener: () => processShim,
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
    hrtime: Object.assign(
      (previous?: [number, number]): [number, number] => {
        const now = Date.now() * 1e6;
        const seconds = Math.floor(now / 1e9);
        const nanos = now % 1e9;
        if (!previous) return [seconds, nanos];
        return [seconds - previous[0], nanos - previous[1]];
      },
      { bigint: () => BigInt(Math.round(Date.now() * 1e6)) },
    ),
    memoryUsage: () => ({ heapUsed: 0, heapTotal: 0, rss: 0 }),
  };

  // ── the event emitter every Node shape leans on ──
  class Emitter {
    private handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    on(name: string, fn: (...args: unknown[]) => void): this {
      (this.handlers[name] ||= []).push(fn);
      return this;
    }
    addListener(name: string, fn: (...args: unknown[]) => void): this {
      return this.on(name, fn);
    }
    once(name: string, fn: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]): void => {
        this.off(name, wrapper);
        fn(...args);
      };
      return this.on(name, wrapper);
    }
    off(name: string, fn: (...args: unknown[]) => void): this {
      this.handlers[name] = (this.handlers[name] ?? []).filter((h) => h !== fn);
      return this;
    }
    removeListener(name: string, fn: (...args: unknown[]) => void): this {
      return this.off(name, fn);
    }
    removeAllListeners(name?: string): this {
      if (name) delete this.handlers[name];
      else this.handlers = {};
      return this;
    }
    listenerCount(name: string): number {
      return (this.handlers[name] ?? []).length;
    }
    emit(name: string, ...args: unknown[]): boolean {
      const list = [...(this.handlers[name] ?? [])];
      for (const fn of list) fn(...args);
      return list.length > 0;
    }
  }

  // ── fs ──
  const bytesOf = (data: unknown): Uint8Array => {
    if (data instanceof Uint8Array) return data;
    if (typeof data === "string") return encoder.encode(data);
    if (data && typeof data === "object" && "byteLength" in (data as ArrayBuffer)) {
      return new Uint8Array(data as ArrayBuffer);
    }
    return encoder.encode(String(data));
  };
  const decode = (bytes: Uint8Array, encoding?: unknown): string | Uint8Array => {
    const wants = typeof encoding === "string" ? encoding : (encoding as { encoding?: string })?.encoding;
    return wants ? decoder.decode(bytes) : bytes;
  };

  class SyncUnsupportedError extends Error {
    constructor(what: string, why: string) {
      super(`${what}: ${why}`);
      this.name = "SyncUnsupportedError";
    }
  }
  const SYNC_WRITE_WHY =
    "a synchronous write needs a synchronous filesystem, which a browser tab only gets behind " +
    "cross-origin isolation (SharedArrayBuffer + Atomics.wait) — use the async form " +
    "(fs.promises.writeFile / fs.writeFile with a callback); it writes into your workspace and the " +
    "file tree sees it";
  const SYNC_READ_WHY =
    "the sync reads answer from the snapshot of your working folder taken when this script started; " +
    "this file was not in it — use fs.promises.readFile, which asks the real filesystem";

  const promisesApi = {
    readFile: async (p: string, encoding?: unknown) =>
      decode(((await rpc("readFile", { path: resolvePath(p) })) as { bytes: Uint8Array }).bytes, encoding),
    writeFile: async (p: string, data: unknown) => {
      await rpc("writeFile", { path: resolvePath(p), data: bytesOf(data) });
    },
    appendFile: async (p: string, data: unknown) => {
      await rpc("appendFile", { path: resolvePath(p), data: bytesOf(data) });
    },
    mkdir: async (p: string) => {
      await rpc("mkdir", { path: resolvePath(p) });
    },
    readdir: async (p: string) => (await rpc("readdir", { path: resolvePath(p) })) as string[],
    stat: async (p: string) => {
      const raw = (await rpc("stat", { path: resolvePath(p) })) as {
        size: number;
        mtimeMs: number;
        file: boolean;
        directory: boolean;
      };
      return { size: raw.size, mtimeMs: raw.mtimeMs, isFile: () => raw.file, isDirectory: () => raw.directory };
    },
    unlink: async (p: string) => {
      await rpc("unlink", { path: resolvePath(p) });
    },
    rm: async (p: string) => {
      await rpc("rm", { path: resolvePath(p) });
    },
    rename: async (from: string, to: string) => {
      await rpc("rename", { path: resolvePath(from), to: resolvePath(to) });
    },
    access: async (p: string) => {
      if (!(await rpc("exists", { path: resolvePath(p) }))) throw new Error(`ENOENT: no such file, access '${p}'`);
    },
  };

  /** The callback forms Node scripts still use: the promise, with `(err, value)` on the end. */
  const callbackify = <T>(fn: (...args: never[]) => Promise<T>) => {
    return (...args: unknown[]): void => {
      const done = typeof args[args.length - 1] === "function" ? (args.pop() as (e: unknown, v?: T) => void) : null;
      (fn as unknown as (...a: unknown[]) => Promise<T>)(...args).then(
        (value) => done?.(null, value),
        (err) => (done ? done(err) : write("stderr", `${String(err)}\n`)),
      );
    };
  };

  const fsApi = {
    promises: promisesApi,
    readFile: callbackify(promisesApi.readFile),
    writeFile: callbackify(promisesApi.writeFile),
    appendFile: callbackify(promisesApi.appendFile),
    mkdir: callbackify(promisesApi.mkdir),
    readdir: callbackify(promisesApi.readdir),
    stat: callbackify(promisesApi.stat),
    unlink: callbackify(promisesApi.unlink),
    rm: callbackify(promisesApi.rm),
    rename: callbackify(promisesApi.rename),
    existsSync: (p: string) => {
      const full = resolvePath(p);
      if (syncFs) return syncAsk("exists", { path: full }).value === true;
      return files[full] !== undefined || Object.keys(files).some((f) => f.startsWith(`${full}/`));
    },
    readFileSync: (p: string, encoding?: unknown) => {
      const full = resolvePath(p);
      // The channel, not the snapshot, when there is one: a file this script wrote a line ago is a
      // file it can read back, which is the difference people notice first.
      if (syncFs) return decode(syncAsk("readFile", { path: full }).data ?? new Uint8Array(0), encoding);
      const found = files[full];
      if (!found) throw new SyncUnsupportedError(`readFileSync('${p}')`, SYNC_READ_WHY);
      return decode(found, encoding);
    },
    readdirSync: (p: string) => {
      const full = resolvePath(p) === "/" ? "" : resolvePath(p);
      if (syncFs) return (syncAsk("readdir", { path: resolvePath(p) }).value as string[]).slice().sort();
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${full}/`)) continue;
        const rest = file.slice(full.length + 1);
        const slash = rest.indexOf("/");
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      if (!names.size && !fsApi.existsSync(p)) throw new SyncUnsupportedError(`readdirSync('${p}')`, SYNC_READ_WHY);
      return [...names].sort();
    },
    statSync: (p: string) => {
      const full = resolvePath(p);
      if (syncFs) {
        const stat = syncAsk("stat", { path: full }).value as {
          size: number;
          mtimeMs: number;
          file: boolean;
          directory: boolean;
        };
        return {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          isFile: () => stat.file,
          isDirectory: () => stat.directory,
        };
      }
      const found = files[full];
      if (found) return { size: found.byteLength, isFile: () => true, isDirectory: () => false };
      if (fsApi.existsSync(p)) return { size: 0, isFile: () => false, isDirectory: () => true };
      throw new SyncUnsupportedError(`statSync('${p}')`, SYNC_READ_WHY);
    },
    writeFileSync: (p: string, data?: unknown) => {
      if (!syncFs) throw new SyncUnsupportedError(`writeFileSync('${p}')`, SYNC_WRITE_WHY);
      const full = resolvePath(p);
      syncAsk("writeFile", { path: full }, bytesOf(data));
      // The snapshot is this Worker's memory of the folder; a write it did not know about would
      // leave `require` and `existsSync` reading yesterday's bytes.
      files[full] = bytesOf(data);
    },
    appendFileSync: (p: string, data?: unknown) => {
      if (!syncFs) throw new SyncUnsupportedError(`appendFileSync('${p}')`, SYNC_WRITE_WHY);
      const full = resolvePath(p);
      syncAsk("appendFile", { path: full }, bytesOf(data));
      delete files[full];
    },
    mkdirSync: (p: string) => {
      if (!syncFs) throw new SyncUnsupportedError(`mkdirSync('${p}')`, SYNC_WRITE_WHY);
      syncAsk("mkdir", { path: resolvePath(p) });
    },
    unlinkSync: (p: string) => {
      if (!syncFs) throw new SyncUnsupportedError(`unlinkSync('${p}')`, SYNC_WRITE_WHY);
      const full = resolvePath(p);
      syncAsk("unlink", { path: full });
      delete files[full];
    },
    rmSync: (p: string) => {
      if (!syncFs) throw new SyncUnsupportedError(`rmSync('${p}')`, SYNC_WRITE_WHY);
      const full = resolvePath(p);
      syncAsk("rm", { path: full });
      delete files[full];
    },
    renameSync: (p: string, to?: string) => {
      if (!syncFs) throw new SyncUnsupportedError(`renameSync('${p}')`, SYNC_WRITE_WHY);
      const from = resolvePath(p);
      syncAsk("rename", { path: from, to: resolvePath(String(to ?? "")) });
      delete files[from];
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2 },
  };

  // ── http ──
  const openRequests = new Map<number, boolean>();
  class ServerResponse {
    statusCode = 200;
    private id: number;
    private headers: Record<string, string> = {};
    private chunks: Uint8Array[] = [];
    private done = false;
    constructor(id: number) {
      this.id = id;
    }
    setHeader(name: string, value: unknown): this {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    }
    getHeader(name: string): string | undefined {
      return this.headers[String(name).toLowerCase()];
    }
    removeHeader(name: string): void {
      delete this.headers[String(name).toLowerCase()];
    }
    writeHead(status: number, a?: unknown, b?: unknown): this {
      this.statusCode = status;
      const headers = (typeof a === "object" && a ? a : typeof b === "object" && b ? b : null) as Record<
        string,
        unknown
      > | null;
      if (headers) for (const key of Object.keys(headers)) this.setHeader(key, headers[key]);
      return this;
    }
    write(chunk: unknown): boolean {
      if (chunk !== undefined && chunk !== null) this.chunks.push(bytesOf(chunk));
      return true;
    }
    end(chunk?: unknown): this {
      if (this.done) return this;
      if (chunk !== undefined && chunk !== null) this.chunks.push(bytesOf(chunk));
      this.done = true;
      let total = 0;
      for (const chunk_ of this.chunks) total += chunk_.byteLength;
      const body = new Uint8Array(total);
      let at = 0;
      for (const chunk_ of this.chunks) {
        body.set(chunk_, at);
        at += chunk_.byteLength;
      }
      // Node sends no content-type either, and a browser with none SNIFFS — which is how a page of
      // text becomes script. So the one guess: markup looks like markup, everything else is text.
      if (!this.headers["content-type"]) {
        const head = decoder.decode(body.subarray(0, 64)).trimStart().toLowerCase();
        this.headers["content-type"] = head.startsWith("<!doctype html") || head.startsWith("<html")
          ? "text/html; charset=utf-8"
          : head.startsWith("{") || head.startsWith("[")
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8";
      }
      openRequests.delete(this.id);
      post({ t: "response", id: this.id, status: this.statusCode, headers: this.headers, body });
      settleLater();
      return this;
    }
  }

  const httpApi = {
    createServer: (handler?: (req: unknown, res: unknown) => void) => {
      let boundPort = 0;
      const server = Object.assign(new Emitter(), {
        listen(...args: unknown[]) {
          const port = args.find((a) => typeof a === "number") as number | undefined;
          const done = args.find((a) => typeof a === "function") as (() => void) | undefined;
          const chosen = port ?? 3000;
          const id = ++rpcId;
          alive += 1;
          pending.set(id, {
            resolve: () => {
              alive -= 1;
              boundPort = chosen;
              servers.set(chosen, handler ?? (() => undefined));
              if (done) done();
              server.emit("listening");
              maybeIdle();
              settleLater();
            },
            reject: (err: Error) => {
              alive -= 1;
              if (server.listenerCount("error")) server.emit("error", err);
              else write("stderr", `${err.message}\n`);
              settleLater();
            },
          });
          post({ t: "listen", id, port: chosen });
          return server;
        },
        close(done?: () => void) {
          if (boundPort) {
            servers.delete(boundPort);
            post({ t: "close", id: ++rpcId, port: boundPort });
            boundPort = 0;
          }
          if (done) done();
          server.emit("close");
          return server;
        },
        address: () => (boundPort ? { address: "127.0.0.1", family: "IPv4", port: boundPort } : null),
      });
      return server;
    },
    STATUS_CODES: { 200: "OK", 404: "Not Found", 500: "Internal Server Error" },
    request: () => {
      throw new Error(`http.request: this browser has no sockets — use fetch(), and ${NO_PACKAGES}`);
    },
    get: () => {
      throw new Error(`http.get: this browser has no sockets — use fetch(), and ${NO_PACKAGES}`);
    },
  };

  // ── require ──
  const builtins: Record<string, unknown> = {
    fs: fsApi,
    "fs/promises": promisesApi,
    path: {
      join,
      resolve: resolvePath,
      dirname,
      basename,
      extname,
      normalize,
      relative: (from: string, to: string) => {
        const a = split(normalize(from));
        const b = split(normalize(to));
        let same = 0;
        while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
        return [...a.slice(same).map(() => ".."), ...b.slice(same)].join("/");
      },
      isAbsolute: (p: string) => p.startsWith("/"),
      parse: (p: string) => ({ root: "/", dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)) }),
      sep: "/",
      posix: null as unknown,
    },
    events: Object.assign(Emitter, { EventEmitter: Emitter, default: Emitter }),
    util: {
      format,
      inspect: (value: unknown) => show(value, 1),
      promisify:
        (fn: (...args: unknown[]) => void) =>
        (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            fn(...args, (err: unknown, value: unknown) => (err ? reject(err) : resolve(value)));
          }),
      callbackify,
      types: { isDate: (v: unknown) => v instanceof Date },
      TextEncoder,
      TextDecoder,
    },
    http: httpApi,
    https: httpApi,
    os: {
      platform: () => "browser",
      EOL: "\n",
      tmpdir: () => "/tmp",
      homedir: () => "/",
      cpus: () => [],
    },
    url: { URL, URLSearchParams, fileURLToPath: (u: string) => String(u).replace(/^file:\/\//, "") },
    querystring: {
      parse: (text: string) => Object.fromEntries(new URLSearchParams(text)),
      stringify: (obj: Record<string, string>) => new URLSearchParams(obj).toString(),
    },
    assert: Object.assign(
      (value: unknown, message?: string) => {
        if (!value) throw new Error(message ?? "assertion failed");
      },
      {
        equal: (a: unknown, b: unknown) => {
          if (a != b) throw new Error(`${show(a)} != ${show(b)}`);
        },
        strictEqual: (a: unknown, b: unknown) => {
          if (a !== b) throw new Error(`${show(a)} !== ${show(b)}`);
        },
        ok: (value: unknown, message?: string) => {
          if (!value) throw new Error(message ?? "assertion failed");
        },
      },
    ),
  };
  (builtins.path as { posix: unknown }).posix = builtins.path;

  /**
   * The bytes behind one candidate path, from the snapshot first and from the workspace second.
   * WITHOUT a channel this is the snapshot and nothing else, which is why `require` used to see only
   * the working folder; with one, any file in the workspace resolves — and is remembered, because
   * Node reads a module once too.
   */
  const moduleBytes = (candidate: string): Uint8Array | undefined => {
    if (files[candidate] !== undefined) return files[candidate];
    if (!syncFs) return undefined;
    const answer = syncFs.call("readFile", { path: candidate });
    if (!answer.ok || !answer.data) return undefined;
    files[candidate] = answer.data;
    return answer.data;
  };

  const candidates = (target: string): string[] => [
    target,
    `${target}.js`,
    `${target}.cjs`,
    `${target}.json`,
    `${target}/index.js`,
    `${target}/index.json`,
  ];

  const makeRequire = (fromDir: string): ((request: string) => unknown) => {
    const require = (request: string): unknown => {
      const name = request.startsWith("node:") ? request.slice(5) : request;
      if (builtins[name]) return builtins[name];
      if (!request.startsWith("./") && !request.startsWith("../") && !request.startsWith("/")) {
        throw new Error(
          `Cannot find module '${request}' — there is no node_modules in a browser tab, so only your ` +
            `own files ('./thing.js') and the built-ins (fs, fs/promises, path, events, util, http) ` +
            `resolve here. ${NO_PACKAGES}`,
        );
      }
      const target = request.startsWith("/") ? normalize(request) : join(fromDir, request);
      for (const candidate of candidates(target)) {
        if (cache[candidate]) return cache[candidate].exports;
        const bytes = moduleBytes(candidate);
        if (bytes === undefined) continue;
        const source = decoder.decode(bytes);
        if (candidate.endsWith(".json")) {
          const parsed = { exports: JSON.parse(source) };
          cache[candidate] = parsed;
          return parsed.exports;
        }
        // The CommonJS wrapper, which is `new Function` in Node too. The module goes in the cache
        // BEFORE it runs, so a cycle sees a half-built exports object instead of looping forever.
        const module = { exports: {} as unknown, id: candidate, filename: candidate, loaded: false };
        cache[candidate] = module;
        const dir = dirname(candidate);
        try {
          const wrapper = new Function("exports", "require", "module", "__filename", "__dirname", source) as (
            exports: unknown,
            require: (request: string) => unknown,
            module: unknown,
            filename: string,
            dir: string,
          ) => void;
          wrapper(module.exports, makeRequire(dir), module, candidate, dir);
        } catch (err) {
          delete cache[candidate];
          throw err;
        }
        module.loaded = true;
        return module.exports;
      }
      throw new Error(
        `Cannot find module '${request}' from '${fromDir}'` +
          (Object.keys(files).length ? "" : " — this folder had no files to snapshot"),
      );
    };
    return Object.assign(require, { resolve: (request: string) => join(fromDir, request), cache });
  };

  // ── keeping the script alive exactly as long as it has something to do ──
  /**
   * A callback that runs after the main module has returned — a timer, an interval, an `.then`.
   * `process.exit()` inside one throws where nothing would catch it, and an ordinary throw there is
   * Node's "uncaught exception, exit 1". Both end the script, and both say so.
   */
  function guarded(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (finished) return;
      finished = true;
      if (err instanceof ExitSignal) {
        post({ t: "exit", code: err.code });
      } else {
        write("stderr", `${(err as Error)?.stack ?? String(err)}\n`);
        post({ t: "exit", code: 1 });
      }
      scope.close?.();
    }
  }

  const timers = new Set<unknown>();
  const timeoutShim = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown => {
    alive += 1;
    const handle = rawTimeout(() => {
      timers.delete(handle);
      alive -= 1;
      guarded(() => fn(...args));
      settleLater();
    }, ms);
    timers.add(handle);
    return handle;
  };
  const clearTimeoutShim = (handle: unknown): void => {
    if (!timers.delete(handle)) return;
    alive -= 1;
    clearTimeout(handle as ReturnType<typeof setTimeout>);
    settleLater();
  };
  const intervals = new Set<unknown>();
  const intervalShim = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown => {
    alive += 1;
    const handle = setInterval(() => guarded(() => fn(...args)), ms);
    intervals.add(handle);
    return handle;
  };
  const clearIntervalShim = (handle: unknown): void => {
    if (!intervals.delete(handle)) return;
    alive -= 1;
    clearInterval(handle as ReturnType<typeof setInterval>);
    settleLater();
  };

  /**
   * "The main module is done and something is listening" — the moment the page may hand the terminal
   * back while this Worker stays alive behind its port. It is NOT necessarily the end of `start()`:
   * `listen()` is a round trip to the page, so a one-line server binds AFTER the last line has run,
   * and a runner that only looked at the end of `start()` would hang until its wall clock ran out.
   */
  function maybeIdle(): void {
    if (idled || finished || !mainDone || servers.size === 0) return;
    idled = true;
    post({ t: "idle", ports: [...servers.keys()] });
  }

  let settling = false;
  function settleLater(): void {
    if (finished || settling) return;
    settling = true;
    rawTimeout(() => {
      settling = false;
      if (finished) return;
      if (servers.size > 0) {
        maybeIdle();
        return; // a server is a reason to stay
      }
      if (alive > 0 || openRequests.size > 0) return;
      finished = true;
      post({ t: "exit", code: processShim.exitCode || 0 });
      scope.close?.();
    }, 0);
  }

  // ── the run ──
  function start(message: {
    entry: string;
    source: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    files: Record<string, Uint8Array>;
    sab?: SharedArrayBuffer | null;
  }): void {
    if (started) return;
    started = true;
    // The channel client is a global the Worker's own source installed (workerSource()), not an
    // import — the closure of this function never travelled. No buffer, no client, no sync fs.
    const makeChannel = (scope as unknown as { __00SyncChannel?: unknown }).__00SyncChannel;
    const layout = (scope as unknown as { __00SyncChannelLayout?: unknown }).__00SyncChannelLayout;
    if (message.sab && typeof makeChannel === "function") {
      try {
        syncFs = (makeChannel as (...args: unknown[]) => typeof syncFs)(message.sab, layout, "client");
      } catch {
        syncFs = null; // a browser that took the buffer and refuses the wait: the snapshot still works
      }
    }
    files = message.files ?? {};
    cwd = message.cwd || "/";
    entry = message.entry || "/[eval]";
    processShim.argv = ["node", entry, ...(message.argv ?? [])];
    processShim.env = { ...(message.env ?? {}) };
    const dir = dirname(entry);
    const module = { exports: {} as unknown, id: entry, filename: entry, loaded: false };
    cache[entry] = module;
    try {
      const wrapper = new Function(
        "exports",
        "require",
        "module",
        "__filename",
        "__dirname",
        "process",
        "console",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "global",
        "globalThis",
        message.source,
      ) as (...args: unknown[]) => void;
      const globals = {
        process: processShim,
        console: consoleShim,
        setTimeout: timeoutShim,
        clearTimeout: clearTimeoutShim,
        setInterval: intervalShim,
        clearInterval: clearIntervalShim,
      };
      wrapper(
        module.exports,
        makeRequire(dir),
        module,
        entry,
        dir,
        processShim,
        consoleShim,
        timeoutShim,
        clearTimeoutShim,
        intervalShim,
        clearIntervalShim,
        (fn: () => void) => timeoutShim(fn, 0),
        globals,
        globals,
      );
    } catch (err) {
      if (err instanceof ExitSignal) {
        finished = true;
        post({ t: "exit", code: err.code });
        scope.close?.();
        return;
      }
      finished = true;
      const error = err as Error;
      write("stderr", `${error?.stack ?? String(err)}\n`);
      post({ t: "exit", code: 1 });
      scope.close?.();
      return;
    }
    // Servers make this an "idle" — the page hands the terminal back and keeps the Worker.
    mainDone = true;
    maybeIdle();
    settleLater();
  }

  scope.addEventListener("message", (event: { data: unknown }) => {
    const message = event.data as {
      t?: string;
      id?: number;
      ok?: boolean;
      value?: unknown;
      error?: string;
      port?: number;
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: Uint8Array | null;
      [key: string]: unknown;
    };
    if (!message || typeof message.t !== "string") return;
    if (message.t === "start") {
      start(message as unknown as Parameters<typeof start>[0]);
      return;
    }
    if (message.t === "fs-reply" || message.t === "listen-reply" || message.t === "close-reply") {
      const waiting = pending.get(Number(message.id));
      if (!waiting) return;
      pending.delete(Number(message.id));
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new Error(message.error ?? "the page refused"));
      return;
    }
    if (message.t === "request") {
      const handler = servers.get(Number(message.port));
      const id = Number(message.id);
      if (!handler) {
        post({ t: "response", id, status: 502, headers: {}, body: encoder.encode("nothing is listening here") });
        return;
      }
      openRequests.set(id, true);
      const body = message.body ?? null;
      const req = Object.assign(new Emitter(), {
        method: String(message.method ?? "GET"),
        url: String(message.url ?? "/"),
        headers: message.headers ?? {},
        httpVersion: "1.1",
        socket: { remoteAddress: "127.0.0.1" },
        /** The whole body, for the many handlers that never bother with the stream. */
        body: body ? decoder.decode(body) : "",
        rawBody: body,
      });
      const res = new ServerResponse(id);
      try {
        handler(req, res);
      } catch (err) {
        if (err instanceof ExitSignal) throw err;
        openRequests.delete(id);
        post({
          t: "response",
          id,
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: encoder.encode(`the handler threw: ${(err as Error)?.message ?? String(err)}`),
        });
        return;
      }
      // Node delivers the body AFTER the handler has had a chance to subscribe, and so do we.
      queueMicrotask(() => {
        if (body && body.byteLength) req.emit("data", body);
        req.emit("end");
      });
      return;
    }
  });

  // An unhandled rejection in a script is a crash in Node 24, and silence here would be worse: the
  // person would see a server that answers nothing and no reason anywhere.
  (scope as unknown as { addEventListener: (t: string, h: (e: unknown) => void) => void }).addEventListener(
    "unhandledrejection",
    (event: unknown) => {
      const reason = (event as { reason?: unknown })?.reason;
      write("stderr", `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
    },
  );
}
