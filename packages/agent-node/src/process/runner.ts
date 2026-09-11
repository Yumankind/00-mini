/**
 * The worker side of a process: `serveProcess`, and the in-process factory the tests use.
 *
 * WHY THIS IS A FUNCTION AND NOT A WORKER FILE. A browser host builds its Worker from a blob or a
 * bundle; a Node test has neither. Both need the SAME code to be what runs, or the tests test a
 * fake. So the worker side is a plain function over a `WorkerChannel` (two methods), and the two
 * hosts differ only in how they make that channel: `self` in a real Worker,
 * `createInlineWorkerFactory` in this process. The inline one delivers every message on a later
 * microtask, exactly as a real Worker does — a synchronous fake would hide every ordering bug there
 * is, starting with the one where `listen()` resolves before the main module returns.
 *
 * WHEN A PROCESS ENDS. `process.exit()` (an `ExitSignal` thrown through the stack), an uncaught
 * throw (exit 1, stack on stderr), or the event loop going quiet. "Quiet" is counted, not guessed:
 * timers are wrapped, the filesystem backend's in-flight calls are counted, and anything else that
 * should keep the process alive takes a `hold()` from `ProcessIo` and releases it later — an HTTP
 * server is exactly that, and the host wires it when it wires its bridge.
 *
 * DOES: argv, cwd, env, stdin as an async byte stream, stdout/stderr, the `worker_threads` parent
 * port, `workerData`, a `SIGTERM`-shaped kill that ends the process at once.
 * DOES NOT: `process.on("exit")` handlers running on a kill (a terminated Worker gets no chance —
 * the same as `SIGKILL`), or a graceful drain of pending work on exit.
 */

import { createLoader, type CreateLoaderOptions, type Loader } from "../loader/index.js";
import { createProcess, ExitSignal, type NodeProcess } from "../modules/process.js";
import EventEmitter from "events/events.js";
import type { FromWorker, ProcessSpec, ProcessWorker, ToWorker } from "./manager.js";

export interface WorkerChannel {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

export interface ProcessIo {
  /** Keep the process alive until the returned function is called. An open server is one of these. */
  hold(): () => void;
  /** The `worker_threads` parent port, and `process.send`'s other end. */
  parentPort: EventEmitter & { postMessage(data: unknown): void };
  /** Bytes written to this process's stdin, in order, then `null` at EOF. */
  onStdin(handler: (chunk: Uint8Array | null) => void): void;
}

export interface ProcessRuntimeOptions {
  /**
   * Everything the loader needs for THIS process. `process`, `stdout`, `stderr`, `argv` and the
   * timer globals are supplied by the runner and override whatever this returns.
   */
  configure(spec: ProcessSpec, io: ProcessIo): CreateLoaderOptions;
  /** Called after the loader exists and before the entry runs — a host's last hook. */
  onReady?(loader: Loader, spec: ProcessSpec): void;
}

const decoder = new TextDecoder();

export function serveProcess(channel: WorkerChannel, opts: ProcessRuntimeOptions): void {
  let started = false;
  let finished = false;
  let mainDone = false;
  let alive = 0;
  let settling = false;
  let process: NodeProcess | null = null;
  const stdinHandlers: ((chunk: Uint8Array | null) => void)[] = [];
  const parentPort = Object.assign(new EventEmitter(), {
    postMessage: (data: unknown) => channel.post({ t: "message", data } satisfies FromWorker),
    close: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });

  const post = (message: FromWorker): void => channel.post(message);
  const rawTimeout = setTimeout;

  const settleLater = (): void => {
    if (finished || settling) return;
    settling = true;
    rawTimeout(() => {
      settling = false;
      if (finished || !mainDone || alive > 0) return;
      finished = true;
      post({ t: "exit", code: process?.exitCode ?? 0 });
    }, 0);
  };

  const end = (code: number): void => {
    if (finished) return;
    finished = true;
    post({ t: "exit", code });
  };

  /** A callback that runs AFTER the main module returned: a throw there is Node's exit 1. */
  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ExitSignal) end(err.code);
      else {
        post({ t: "stderr", text: `${(err as Error)?.stack ?? String(err)}\n` });
        end(1);
      }
    }
  };

  const io: ProcessIo = {
    hold: () => {
      alive += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        alive -= 1;
        settleLater();
      };
    },
    parentPort,
    onStdin: (handler) => void stdinHandlers.push(handler),
  };

  const timerGlobals = (): Record<string, unknown> => {
    const timers = new Set<unknown>();
    const intervals = new Set<unknown>();
    return {
      setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown => {
        alive += 1;
        const handle = rawTimeout(() => {
          timers.delete(handle);
          alive -= 1;
          guarded(() => fn(...args));
          settleLater();
        }, ms);
        timers.add(handle);
        return handle;
      },
      clearTimeout: (handle: unknown): void => {
        if (!timers.delete(handle)) return;
        alive -= 1;
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        settleLater();
      },
      setInterval: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown => {
        alive += 1;
        const handle = setInterval(() => guarded(() => fn(...args)), ms);
        intervals.add(handle);
        return handle;
      },
      clearInterval: (handle: unknown): void => {
        if (!intervals.delete(handle)) return;
        alive -= 1;
        clearInterval(handle as ReturnType<typeof setInterval>);
        settleLater();
      },
    };
  };

  /** In-flight filesystem calls keep the process alive; without this a script that only awaits exits. */
  const countingBackend = <T extends object>(backend: T): T =>
    new Proxy(backend, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key !== "op" || typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          alive += 1;
          const result = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          return result.finally(() => {
            alive -= 1;
            settleLater();
          });
        };
      },
    });

  const start = (spec: ProcessSpec): void => {
    if (started) return;
    started = true;
    const config = opts.configure(spec, io);
    process = createProcess({
      argv: spec.argv,
      env: spec.env,
      cwd: spec.cwd,
      pid: spec.pid,
      stdout: (text) => post({ t: "stdout", text }),
      stderr: (text) => post({ t: "stderr", text }),
    });
    // `worker_threads` reads these two off the process object; `process.send` is the same channel.
    Object.assign(process, {
      __parentPort: spec.ipc ? parentPort : null,
      __workerData: spec.workerData,
      send: spec.ipc ? (data: unknown) => (parentPort.postMessage(data), true) : undefined,
      connected: spec.ipc,
    });

    const loader = createLoader({
      ...config,
      backend: config.backend ? (countingBackend(config.backend) as typeof config.backend) : config.backend,
      cwd: spec.cwd,
      env: spec.env,
      process,
      globals: { ...(config.globals ?? {}), ...timerGlobals() },
    });
    opts.onReady?.(loader, spec);

    if (!spec.entry) {
      post({ t: "stderr", text: `${spec.command}: this runtime runs JavaScript files — there was no file in "${[spec.command, ...spec.args].join(" ")}"\n` });
      end(127);
      return;
    }
    // TypeScript needs the warm-up first (the browser's esbuild has no synchronous transform — see
    // loader/index.ts), and a warm-up is an await, so the entry runs from an async tail. A plain
    // JavaScript entry with no transformer takes the same road with nothing to await.
    const run = async (): Promise<void> => {
      try {
        if (config.transformer) await loader.warmup(spec.entry!);
        loader.runMain(spec.entry!, spec.argv.slice(2));
      } catch (err) {
        if (err instanceof ExitSignal) {
          end(err.code);
          return;
        }
        post({ t: "stderr", text: `${(err as Error)?.stack ?? String(err)}\n` });
        end(1);
        return;
      }
      mainDone = true;
      settleLater();
    };
    void run();
  };

  channel.onMessage((raw) => {
    const message = raw as ToWorker;
    if (!message || typeof message.t !== "string") return;
    switch (message.t) {
      case "start":
        start(message.spec);
        return;
      case "stdin":
        for (const handler of [...stdinHandlers]) handler(message.chunk);
        return;
      case "stdin-end":
        for (const handler of [...stdinHandlers]) handler(null);
        return;
      case "message":
        parentPort.emit("message", message.data);
        return;
      case "signal":
        // A Worker cannot be asked to handle a signal; the host has already decided this ends here.
        finished = true;
        return;
      default:
        return;
    }
  });
}

/**
 * A `WorkerFactory` that runs `serveProcess` in THIS thread on an asynchronous channel. The node
 * suite's only way to exercise a real loader through the real process wire; a browser host uses a
 * real Worker instead and the code on the other side is identical.
 */
export function createInlineWorkerFactory(opts: ProcessRuntimeOptions): (spec: ProcessSpec) => ProcessWorker {
  return (_spec: ProcessSpec): ProcessWorker => {
    const toHost: ((message: unknown) => void)[] = [];
    const toWorker: ((message: unknown) => void)[] = [];
    let dead = false;
    const later = (fn: () => void): void => void queueMicrotask(fn);
    serveProcess(
      {
        post: (message) => {
          if (dead) return;
          later(() => {
            for (const handler of [...toHost]) handler(message);
          });
        },
        onMessage: (handler) => void toWorker.push(handler),
      },
      opts,
    );
    return {
      post: (message) => {
        if (dead) return;
        later(() => {
          for (const handler of [...toWorker]) handler(message);
        });
      },
      onMessage: (handler) => void toHost.push(handler),
      terminate: () => {
        dead = true;
      },
    };
  };
}

/** Decode a stdin chunk the way a script expects to see it. Exported because hosts need it too. */
export function decodeChunk(chunk: Uint8Array): string {
  return decoder.decode(chunk);
}
