/**
 * `process` — the object the loader hands every module, and the `node:process` builtin.
 *
 * DOES: `argv`, `argv0`, `execPath`, `env` (a live object, so `process.env.X = "1"` is seen by the
 * next child), `cwd()`/`chdir()`, `exit()`/`exitCode`, `stdout`/`stderr` as writable sinks with
 * `isTTY`, `stdin` as an empty readable, `nextTick`, `hrtime` (+`.bigint`), `uptime`, `platform`
 * `"browser"`, `arch`, `versions`, `pid`/`ppid`, `on`/`once`/`off` as a real EventEmitter so
 * `beforeExit`/`exit` listeners actually fire (`exit()` emits `exit` before it throws), `emitWarning`,
 * `memoryUsage`/`cpuUsage` (zeros, openly), `execArgv` (empty).
 *
 * DOES NOT: signals (`SIGINT` has no sender here — a listener is accepted and never called, which is
 * what Node does for a signal that never arrives), `process.binding`, `setuid`/`getuid`, `dlopen`,
 * `report`, `resourceUsage`. `process.exit()` THROWS an `ExitSignal` rather than returning: a
 * Worker cannot stop its own stack, and the loader turns that throw into an exit code.
 */

import EventEmitter from "events/events.js";

/** What `process.exit()` throws. The loader catches it; nothing else should. */
export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitSignal";
  }
}

/** `process.stdout`/`stderr`: a writable that is also an EventEmitter, because Node's is a stream. */
export interface WritableSink extends EventEmitter {
  write(chunk: string | Uint8Array): boolean;
  isTTY: boolean;
  columns: number;
  rows: number;
  writable: boolean;
  end(): void;
}

/** `process.stdin`: an EventEmitter that never emits, because there is no interactive input here. */
export interface ReadableStdin extends EventEmitter {
  read(): null;
  setEncoding(): unknown;
  resume(): unknown;
  pause(): unknown;
  setRawMode(): unknown;
  isTTY: boolean;
  readable: boolean;
}

export interface NodeProcessOptions {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  pid?: number;
}

export interface NodeProcess extends EventEmitter {
  argv: string[];
  argv0: string;
  execPath: string;
  env: Record<string, string>;
  platform: string;
  arch: string;
  version: string;
  versions: Record<string, string>;
  pid: number;
  ppid: number;
  exitCode: number;
  stdout: WritableSink;
  stderr: WritableSink;
  stdin: ReadableStdin;
  cwd(): string;
  chdir(to: string): void;
  exit(code?: number): never;
  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void;
  hrtime: ((previous?: [number, number]) => [number, number]) & { bigint(): bigint };
  uptime(): number;
  execArgv: string[];
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  cpuUsage(): { user: number; system: number };
  emitWarning(warning: string | Error): void;
}

const decoder = new TextDecoder();

/**
 * `process.stdout` is a STREAM in Node, and packages attach handlers to it (`on("error")`,
 * `once("drain")`) before they write a byte. So the sink is a real EventEmitter that simply never
 * emits: there is no error to report when the other end is a terminal callback, and a missing `.on`
 * is a TypeError in somebody else's library. `setRawMode` on stdin is the same deal — `isTTY` is
 * false, so turning raw mode on or off is honestly nothing.
 */
function sink(write: (text: string) => void): WritableSink {
  return Object.assign(new EventEmitter(), {
    write(chunk: string | Uint8Array): boolean {
      write(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      return true;
    },
    isTTY: false,
    columns: 80,
    rows: 24,
    writable: true,
    end(): void {
      /* a sink that is the terminal is never closed */
    },
  }) as unknown as WritableSink;
}

export function createProcess(opts: NodeProcessOptions = {}): NodeProcess {
  const started = Date.now();
  let cwd = opts.cwd ?? "/";
  const emitter = new EventEmitter() as unknown as NodeProcess;
  const out = opts.stdout ?? (() => undefined);
  const err = opts.stderr ?? (() => undefined);

  const hrtime = ((previous?: [number, number]): [number, number] => {
    const nanos = Math.round(performance.now() * 1e6);
    const value: [number, number] = [Math.floor(nanos / 1e9), nanos % 1e9];
    if (!previous) return value;
    let seconds = value[0] - previous[0];
    let rest = value[1] - previous[1];
    if (rest < 0) {
      seconds -= 1;
      rest += 1e9;
    }
    return [seconds, rest];
  }) as NodeProcess["hrtime"];
  hrtime.bigint = () => BigInt(Math.round(performance.now() * 1e6));

  return Object.assign(emitter, {
    argv: opts.argv ?? ["node"],
    argv0: "node",
    execArgv: [],
    execPath: "/usr/local/bin/node",
    env: { ...(opts.env ?? {}) },
    // "browser" and not "linux": a script that branches on the platform should take the branch that
    // matches what it can actually do here, and lying would send it down the fork/exec road.
    platform: "browser",
    arch: "wasm32",
    version: "v24.0.0-browser",
    versions: { node: "24.0.0", v8: "browser", agentNode: "0.0.1" },
    pid: opts.pid ?? 1,
    ppid: 0,
    exitCode: 0,
    stdout: sink(out),
    stderr: sink(err),
    stdin: Object.assign(new EventEmitter(), {
      read: () => null,
      setEncoding: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      setRawMode: function (this: unknown) {
        return this;
      },
      isTTY: false,
      readable: true,
    }),
    cwd: () => cwd,
    chdir: (to: string) => {
      cwd = to.startsWith("/") ? to : `${cwd === "/" ? "" : cwd}/${to}`;
    },
    exit: (code?: number): never => {
      const exitCode = typeof code === "number" ? code : (emitter.exitCode ?? 0);
      emitter.exitCode = exitCode;
      // Node fires `exit` listeners before the process goes, and a script's cleanup hangs off that.
      emitter.emit("exit", exitCode);
      throw new ExitSignal(exitCode);
    },
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void queueMicrotask(() => fn(...args)),
    hrtime,
    uptime: () => (Date.now() - started) / 1000,
    // Zeros, and zeros on purpose: a tab cannot see its own resident set, and a made-up number is
    // worse than an obvious one. The shape is complete so destructuring never fails.
    memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), {
      rss: () => 0,
    }),
    cpuUsage: () => ({ user: 0, system: 0 }),
    emitWarning: (warning: string | Error) => {
      err(`Warning: ${warning instanceof Error ? warning.message : warning}\n`);
    },
  }) as NodeProcess;
}
