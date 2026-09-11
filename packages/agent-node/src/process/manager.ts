/**
 * A process is a Worker. `ProcessManager` is the table of them.
 *
 * WHY A WORKER AND NOT A FUNCTION CALL. Because a process has to be able to be KILLED, and to run
 * while its parent is doing something else, and to crash without taking anything else down. A
 * Worker is the only thing in a browser with all three properties. So `spawn("node", ["build.js"])`
 * starts a Worker, hands it an entry path and an argv, and the pipes between them are
 * `postMessage`s that this module turns back into the streams a Node script expects.
 *
 * WHAT THE HOST SUPPLIES. `WorkerFactory` — one function, `(spec) => ProcessWorker`. In a browser
 * that is `new Worker(blobUrl)` around the runner (`src/process/runner.ts`); in the node test suite
 * it is `createInlineWorkerFactory`, which runs THE SAME runner in-process on an asynchronous
 * channel. That is deliberate: a fake that only pretended to be a worker would be a test of the
 * fake, and the first bug it would hide is the one where a message arrives inside the call that
 * sent it.
 *
 * DOES: `spawn` with `cwd`/`env`/`stdio`, a `ChildProcess` with `stdout`/`stderr` readable and
 * `stdin` writable, `exit` and `close` events in Node's order, `kill(signal)`, `send()`/`message`
 * for the fork-style channel, pipes between two children, a process table with a cap, and
 * `killAll()` for when a tab is closing.
 *
 * DOES NOT: real signals (`kill("SIGTERM")` terminates the Worker; a Worker cannot be asked to
 * handle a signal, so a child never gets a chance to clean up — said out loud because a build tool
 * that traps SIGINT will not here), `detached`, process groups, `uid`/`gid`, `shell: true` (the
 * host's shell is the thing that would run one, and it is above this layer), or exit codes from
 * anything but the runner's own `process.exit`.
 */

import EventEmitter from "events/events.js";
import { Readable, Writable } from "readable-stream";
import { Buffer } from "buffer/index.js";
import { NodeCompatError } from "../errors.js";
import { resolveAbs } from "../paths.js";

const encoder = new TextEncoder();

export type StdioValue = "pipe" | "ignore" | "inherit";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** `"pipe"` (the default), `"ignore"`, `"inherit"`, or the three-element array Node takes. */
  stdio?: StdioValue | StdioValue[];
  argv0?: string;
  /** `child_process.fork` sets this; the child then has a `process.send`. */
  ipc?: boolean;
  workerData?: unknown;
}

/** Everything the worker side needs to become this process. Serialisable: it crosses postMessage. */
export interface ProcessSpec {
  pid: number;
  command: string;
  args: string[];
  /** The absolute virtual path of the script to run, when the manager could work one out. */
  entry: string | null;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: StdioValue[];
  ipc: boolean;
  workerData: unknown;
}

export interface ProcessWorker {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  terminate(): void;
}

export type WorkerFactory = (spec: ProcessSpec) => ProcessWorker;

/** Worker → host. The whole wire, and there is no other. */
export type FromWorker =
  | { t: "stdout" | "stderr"; text: string }
  | { t: "exit"; code: number }
  | { t: "error"; message: string; stack?: string }
  | { t: "message"; data: unknown };

/** Host → worker. */
export type ToWorker =
  | { t: "start"; spec: ProcessSpec }
  | { t: "stdin"; chunk: Uint8Array }
  | { t: "stdin-end" }
  | { t: "message"; data: unknown }
  | { t: "signal"; signal: string };

export class ChildProcess extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  readonly stdio: (Readable | Writable | null)[];
  readonly spawnfile: string;
  readonly spawnargs: string[];
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected: boolean;

  private settled = false;

  constructor(
    readonly pid: number,
    private readonly worker: ProcessWorker,
    spec: ProcessSpec,
    private readonly onDone: (pid: number) => void,
  ) {
    super();
    this.spawnfile = spec.command;
    this.spawnargs = [spec.command, ...spec.args];
    this.connected = spec.ipc;
    const wantsOut = spec.stdio[1] === "pipe";
    const wantsErr = spec.stdio[2] === "pipe";
    const wantsIn = spec.stdio[0] === "pipe";
    this.stdout = wantsOut ? new Readable({ read() {} }) : null;
    this.stderr = wantsErr ? new Readable({ read() {} }) : null;
    this.stdin = wantsIn
      ? new Writable({
          write: (chunk: unknown, _encoding: string, done: () => void) => {
            worker.post({ t: "stdin", chunk: chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk)) } satisfies ToWorker);
            done();
          },
          final: (done: () => void) => {
            worker.post({ t: "stdin-end" } satisfies ToWorker);
            done();
          },
        })
      : null;
    this.stdio = [this.stdin, this.stdout, this.stderr];

    worker.onMessage((raw) => this.receive(raw as FromWorker));
    // `spawn` fires on the next tick in Node too, so a listener attached on the line after
    // `spawn()` still catches it.
    queueMicrotask(() => this.emit("spawn"));
  }

  private receive(message: FromWorker): void {
    if (!message || typeof message.t !== "string") return;
    // A Worker that has already exited (or been killed) can still have messages in flight: its
    // `terminate()` happens a turn later. Pushing one of those into an ended stream is an
    // uncatchable "push after EOF", so everything after the exit is dropped on purpose.
    if (this.settled && message.t !== "exit") return;
    switch (message.t) {
      case "stdout":
        this.stdout?.push(Buffer.from(encoder.encode(message.text)));
        return;
      case "stderr":
        this.stderr?.push(Buffer.from(encoder.encode(message.text)));
        return;
      case "message":
        this.emit("message", message.data);
        return;
      case "error":
        this.emit("error", new NodeCompatError("ERR_CHILD_PROCESS_FAILED", message.message));
        this.finish(1, null);
        return;
      case "exit":
        this.finish(message.code, null);
        return;
      default:
        return;
    }
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.onDone(this.pid);
    this.emit("exit", code, signal);
    // Node closes stdio AFTER `exit` and emits `close` when it has; the order matters to anything
    // that collects output, because the last chunk must be readable before `close` fires. A
    // MACROTASK, not a microtask: a Readable emits its buffered `data` on the next tick, and a
    // `close` one microtask later would beat the last line of output out of the door.
    this.stdout?.push(null);
    this.stderr?.push(null);
    setTimeout(() => {
      this.worker.terminate();
      this.emit("close", code, signal);
    }, 0);
  }

  /** There are no signals in a Worker: this terminates it. The name is kept so scripts read right. */
  kill(signal: string | number = "SIGTERM"): boolean {
    if (this.settled) return false;
    this.killed = true;
    this.worker.post({ t: "signal", signal: String(signal) } satisfies ToWorker);
    this.finish(null, String(signal));
    return true;
  }

  /** The fork-style channel. Silently a no-op without `ipc`, exactly as a non-forked child is. */
  send(data: unknown): boolean {
    if (!this.connected) return false;
    this.worker.post({ t: "message", data } satisfies ToWorker);
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit("disconnect");
  }

  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
}

export interface ProcessManagerOptions {
  createWorker: WorkerFactory;
  cwd?: string;
  env?: Record<string, string>;
  /** A tab is not a server: a runaway `spawn` loop must hit a wall with a name on it. */
  maxProcesses?: number;
  /** Commands that mean "run this file with the loader". Anything else is the factory's problem. */
  nodeCommands?: string[];
}

export const DEFAULT_MAX_PROCESSES = 16;

export class ProcessManager {
  private readonly children = new Map<number, ChildProcess>();
  private nextPid = 2; // 1 is the runtime's own process
  private readonly createWorker: WorkerFactory;
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly max: number;
  private readonly nodeCommands: Set<string>;

  constructor(opts: ProcessManagerOptions) {
    this.createWorker = opts.createWorker;
    this.cwd = opts.cwd ?? "/";
    this.env = opts.env ?? {};
    this.max = opts.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.nodeCommands = new Set(opts.nodeCommands ?? ["node", "node.exe", "nodejs"]);
  }

  spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess {
    if (this.children.size >= this.max) {
      throw new NodeCompatError(
        "ERR_TOO_MANY_PROCESSES",
        `spawn ${command}: ${this.max} processes are already running in this tab — a browser has one thread pool and a runaway spawn loop would take the page with it. Kill some, or raise maxProcesses deliberately.`,
      );
    }
    const cwd = options.cwd ? resolveAbs(this.cwd, options.cwd) : this.cwd;
    const stdio = normalizeStdio(options.stdio);
    const isNode = this.nodeCommands.has(command);
    // `node --experimental-x file.js a b` — the entry is the first argument that is not a flag.
    const entryArg = isNode ? args.find((a) => !a.startsWith("-")) : null;
    const pid = this.nextPid++;
    const spec: ProcessSpec = {
      pid,
      command,
      args,
      entry: entryArg ? resolveAbs(cwd, entryArg) : null,
      argv: [options.argv0 ?? "node", ...(entryArg ? [resolveAbs(cwd, entryArg)] : []), ...args.slice(entryArg ? args.indexOf(entryArg) + 1 : 0)],
      cwd,
      env: { ...this.env, ...(options.env ?? {}) },
      stdio,
      ipc: Boolean(options.ipc),
      workerData: options.workerData ?? null,
    };
    const worker = this.createWorker(spec);
    const child = new ChildProcess(pid, worker, spec, (done) => this.children.delete(done));
    this.children.set(pid, child);
    worker.post({ t: "start", spec } satisfies ToWorker);
    return child;
  }

  /** `a | b`: one child's stdout into another's stdin, with the EOF that a pipe implies. */
  pipe(from: ChildProcess, to: ChildProcess): void {
    if (!from.stdout || !to.stdin) {
      throw new NodeCompatError(
        "ERR_PIPE_UNAVAILABLE",
        "pipe: both ends must have been spawned with stdio 'pipe' — an 'ignore' end has nothing to connect",
      );
    }
    from.stdout.pipe(to.stdin);
  }

  get(pid: number): ChildProcess | undefined {
    return this.children.get(pid);
  }

  list(): ChildProcess[] {
    return [...this.children.values()];
  }

  killAll(signal = "SIGKILL"): void {
    for (const child of [...this.children.values()]) child.kill(signal);
  }
}

function normalizeStdio(value: SpawnOptions["stdio"]): StdioValue[] {
  if (Array.isArray(value)) {
    return [value[0] ?? "pipe", value[1] ?? "pipe", value[2] ?? "pipe"];
  }
  const one = value ?? "pipe";
  return [one, one, one];
}
