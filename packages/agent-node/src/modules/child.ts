/**
 * `child_process` and `worker_threads` — two Node vocabularies over the ONE process model.
 *
 * WHY BOTH MAP ONTO ONE THING. In Node they are genuinely different (an OS process versus a thread
 * in the same process); here they cannot be, because a browser has exactly one primitive — a Worker
 * — and it is already isolated, already message-passing, already killable. So `spawn`, `fork` and
 * `new Worker` all become `ProcessManager.spawn`, and the difference is only which channel is wired
 * up: `fork` and `worker_threads` get the message port, `spawn` gets pipes.
 *
 * DOES: `spawn`, `exec`, `execFile`, `fork`, and the `*Sync` twins REFUSING by name; `ChildProcess`
 * with pipes and `kill`; `worker_threads.Worker` with `postMessage`, `on("message")`,
 * `terminate()`, `workerData`, `isMainThread`, `threadId`, and `parentPort` when the current process
 * IS a worker.
 *
 * DOES NOT: `execSync`/`spawnSync`/`execFileSync` — a synchronous child would have to block this
 * thread while another thread runs a whole program, which needs the same shared-memory isolation the
 * synchronous filesystem needs and, unlike a file read, cannot be bounded. `shell: true` (there is a
 * shell above this layer and it is the host's). `MessageChannel`/`MessagePort` beyond the parent
 * port. `SharedArrayBuffer` transfer between workers (the host decides whether the page is isolated;
 * this layer will not assume it). `Atomics.wait` inside a worker on a port.
 */

import EventEmitter from "events/events.js";
import { NodeCompatError } from "../errors.js";
import type { ChildProcess, ProcessManager, SpawnOptions } from "../process/manager.js";
import type { NodeProcess } from "./process.js";

const decoder = new TextDecoder();

function noManager(what: string): never {
  throw new NodeCompatError(
    "ERR_NO_PROCESS_MANAGER",
    `${what}: this runtime was created without a process model, so it cannot start another process — the host passes a ProcessManager to createLoader`,
  );
}

function refuseSync(name: string): never {
  throw new NodeCompatError(
    "ERR_SYNC_CHILD_UNAVAILABLE",
    `child_process.${name}: a synchronous child would have to block this thread while another one runs a whole program. That needs cross-origin isolation and a bounded wait, and a program's runtime is not bounded — use the async form (${name.replace(/Sync$/, "")}) and await it.`,
  );
}

/** Collect a child's output the way `exec` does: whole strings, one callback, an error on non-zero. */
function collect(child: ChildProcess, cb?: (err: Error | null, stdout: string, stderr: string) => void): void {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  child.stdout?.on("data", (chunk: Uint8Array) => out.push(chunk));
  child.stderr?.on("data", (chunk: Uint8Array) => err.push(chunk));
  child.on("close", (code: number | null) => {
    const text = (parts: Uint8Array[]): string => parts.map((p) => decoder.decode(p)).join("");
    const stdout = text(out);
    const stderr = text(err);
    if (code === 0 || code === null) cb?.(null, stdout, stderr);
    else {
      const error = new NodeCompatError("ERR_CHILD_EXIT", `Command failed with exit code ${code}`) as NodeCompatError & { code: string };
      cb?.(error, stdout, stderr);
    }
  });
}

/** `exec("node a.js b")` — a command LINE, split the way a shell would on unquoted whitespace. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let any = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || any) out.push(current);
      current = "";
      any = false;
      continue;
    }
    current += ch;
  }
  if (current || any) out.push(current);
  return out;
}

export function childProcessModule(manager: ProcessManager | null): Record<string, unknown> {
  const spawn = (command: string, args?: unknown, options?: unknown): ChildProcess => {
    if (!manager) noManager(`child_process.spawn('${command}')`);
    const list = Array.isArray(args) ? (args as string[]) : [];
    const opts = (Array.isArray(args) ? options : args) as SpawnOptions | undefined;
    return manager.spawn(command, list, opts ?? {});
  };
  const api: Record<string, unknown> = {
    spawn,
    execFile: (file: string, args?: unknown, options?: unknown, maybeCb?: unknown): ChildProcess => {
      const cb = [args, options, maybeCb].find((a) => typeof a === "function") as
        | ((err: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      const child = spawn(file, Array.isArray(args) ? args : [], (typeof options === "object" ? options : {}) as SpawnOptions);
      collect(child, cb);
      return child;
    },
    exec: (line: string, options?: unknown, maybeCb?: unknown): ChildProcess => {
      const cb = [options, maybeCb].find((a) => typeof a === "function") as
        | ((err: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      const [command, ...args] = splitCommandLine(line);
      if (!command) {
        throw new NodeCompatError("ERR_INVALID_ARG_VALUE", "child_process.exec: the command line was empty");
      }
      const child = spawn(command, args, (typeof options === "object" ? options : {}) as SpawnOptions);
      collect(child, cb);
      return child;
    },
    fork: (modulePath: string, args?: unknown, options?: unknown): ChildProcess => {
      const opts = ((Array.isArray(args) ? options : args) ?? {}) as SpawnOptions;
      return spawn("node", [modulePath, ...(Array.isArray(args) ? (args as string[]) : [])], { ...opts, ipc: true });
    },
    execSync: () => refuseSync("execSync"),
    spawnSync: () => refuseSync("spawnSync"),
    execFileSync: () => refuseSync("execFileSync"),
    ChildProcess: class {},
  };
  api.default = api;
  return api;
}

/**
 * `worker_threads`. The `Worker` class here is a `ChildProcess` wearing a different name: same
 * manager, same Worker underneath, with the message port wired instead of the pipes.
 */
export function workerThreadsModule(manager: ProcessManager | null, current: NodeProcess): Record<string, unknown> {
  const parentPort = (current as unknown as { __parentPort?: unknown }).__parentPort ?? null;

  class Worker extends EventEmitter {
    private readonly child: ChildProcess;
    readonly threadId: number;
    constructor(filename: string, options: { workerData?: unknown; env?: Record<string, string>; argv?: string[] } = {}) {
      super();
      if (!manager) noManager(`new worker_threads.Worker('${filename}')`);
      this.child = manager.spawn("node", [filename, ...(options.argv ?? [])], {
        ipc: true,
        workerData: options.workerData,
        env: options.env,
      });
      this.threadId = this.child.pid;
      this.child.on("message", (data: unknown) => this.emit("message", data));
      this.child.on("error", (err: unknown) => this.emit("error", err));
      this.child.on("exit", (code: number | null) => this.emit("exit", code ?? 0));
      this.child.stdout?.on("data", (chunk: Uint8Array) => this.emit("stdout", chunk));
      this.child.stderr?.on("data", (chunk: Uint8Array) => this.emit("stderr", chunk));
    }
    postMessage(data: unknown): void {
      this.child.send(data);
    }
    terminate(): Promise<number> {
      this.child.kill("SIGKILL");
      return Promise.resolve(0);
    }
    ref(): void {
      /* a browser Worker has no reference count */
    }
    unref(): void {
      /* see ref() */
    }
    get stdout(): unknown {
      return this.child.stdout;
    }
    get stderr(): unknown {
      return this.child.stderr;
    }
  }

  const api: Record<string, unknown> = {
    Worker,
    isMainThread: parentPort === null,
    parentPort,
    threadId: current.pid,
    workerData: (current as unknown as { __workerData?: unknown }).__workerData ?? null,
    SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
    resourceLimits: {},
    MessageChannel: class MessageChannel {
      constructor() {
        throw new NodeCompatError(
          "ERR_NO_MESSAGE_CHANNEL",
          "worker_threads.MessageChannel: this runtime wires exactly one port per process (parentPort); a second channel would need the host to route it",
        );
      }
    },
    markAsUntransferable: () => undefined,
    moveMessagePortToContext: () => {
      throw new NodeCompatError("ERR_MODULE_UNSUPPORTED", "worker_threads.moveMessagePortToContext: there are no vm contexts here");
    },
    receiveMessageOnPort: () => undefined,
  };
  api.default = api;
  return api;
}
