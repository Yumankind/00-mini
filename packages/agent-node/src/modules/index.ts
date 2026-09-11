/**
 * `builtinModule(name, ctx)` — the whole core-module table, and the only place a name maps to an
 * implementation.
 *
 * WHY A TABLE AND NOT A BUNDLE OF FILES THE LOADER IMPORTS. Because half of these modules need
 * something from the host that only exists at runtime: `fs` needs a backend, `http` needs a bridge,
 * `child_process` needs a process manager, `os.homedir()` needs to know where the workspace is. A
 * static import graph cannot carry that, so a builtin is a FUNCTION OF A CONTEXT, built once per
 * loader and cached there.
 *
 * WHAT IS AND IS NOT HERE. Present: buffer, events, path, util, stream (+ `stream/promises`,
 * `stream/consumers`), string_decoder, url, querystring, assert (+ `assert/strict`), os, crypto,
 * zlib, timers (+ `timers/promises`), process, fs, fs/promises, child_process, worker_threads,
 * http, https, module, console, punycode (a stub that names itself), constants, net, tls, dgram,
 * dns, cluster, v8/vm/perf_hooks/async_hooks/inspector/repl/readline/tty/diagnostics_channel as
 * refusals or minimal stubs. Absent entirely — `require` returns undefined and the loader says
 * "Cannot find module" — nothing: every name Node has resolves to SOMETHING that explains itself,
 * because a missing builtin is a mystery and a refusing builtin is an answer.
 */

import type { NodeFsBackend } from "../fs/backend.js";
import type { ProcessManager } from "../process/manager.js";
import { NodeCompatError } from "../errors.js";
import { bufferModule, eventsModule, pathModule, streamModule, stringDecoderModule, utilModule } from "./core.js";
import { assertModule, osModule, querystringModule, timersModule, urlModule } from "./small.js";
import { cryptoModule } from "./crypto.js";
import { zlibModule, type SyncCompressor } from "./zlib.js";
import { fsModule } from "./fs.js";
import { httpModule, type HttpBridge, type NetworkBridge } from "./http.js";
import { clusterModule, dgramModule, dnsModule, netModule, tlsModule } from "./refusals.js";
import { childProcessModule, workerThreadsModule } from "./child.js";
import type { NodeProcess } from "./process.js";

export interface BuiltinContext {
  process: NodeProcess;
  fs?: NodeFsBackend | null;
  httpBridge?: HttpBridge | null;
  network?: NetworkBridge | null;
  processes?: ProcessManager | null;
  syncCompressor?: SyncCompressor | null;
  /** `os.homedir()`. The workspace root, because that is what "home" means to an agent's script. */
  homedir?: string;
  /** So `module.builtinModules` and a bare `require("module")` can answer. */
  loaderRequire?: (request: string) => unknown;
}

/** Every name this runtime answers. `module.builtinModules` returns exactly this. */
export const BUILTIN_NAMES = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "stream/promises",
  "stream/consumers",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
] as const;

function refusingModule(name: string, why: string): Record<string, unknown> {
  const api = new Proxy(
    { name },
    {
      get(target, key) {
        if (key === "name" || typeof key === "symbol") return (target as Record<string, unknown>)[key as string];
        return () => {
          throw new NodeCompatError("ERR_MODULE_UNSUPPORTED", `${name}.${String(key)}: ${why}`);
        };
      },
    },
  );
  return api as unknown as Record<string, unknown>;
}

/**
 * Build the module named `name`, or `undefined` when it is not a builtin at all (the loader then
 * goes looking in `node_modules`). Results are NOT cached here: the loader caches, because the
 * cache belongs to a loader instance and this function is pure over its context.
 */
export function builtinModule(name: string, ctx: BuiltinContext): unknown {
  const bare = name.startsWith("node:") ? name.slice(5) : name;
  const cwd = (): string => ctx.process.cwd();
  const homedir = ctx.homedir ?? "/";

  switch (bare) {
    case "buffer":
      return bufferModule();
    case "events":
      return eventsModule();
    case "path":
    case "path/posix":
      return pathModule(cwd);
    case "util":
      return utilModule();
    case "util/types":
      return (utilModule() as { types: unknown }).types;
    case "stream":
      return streamModule();
    case "stream/promises":
      return (streamModule() as { promises: unknown }).promises;
    case "stream/consumers":
      return streamConsumers();
    case "string_decoder":
      return stringDecoderModule();
    case "url":
      return urlModule();
    case "querystring":
      return querystringModule();
    case "assert":
    case "assert/strict":
      return assertModule();
    case "os":
      return osModule(homedir);
    case "crypto":
      return cryptoModule();
    case "zlib":
      return zlibModule(ctx.syncCompressor ?? null);
    case "timers":
      return timersModule();
    case "timers/promises":
      return (timersModule() as { promises: unknown }).promises;
    case "process":
      return ctx.process;
    case "console":
      return makeConsole(ctx.process);
    case "fs":
      return fsOrRefuse(ctx).fs;
    case "fs/promises":
      return fsOrRefuse(ctx).promises;
    case "http":
      return httpModule({ bridge: ctx.httpBridge ?? null, network: ctx.network ?? null }, "http:");
    case "https":
      return httpModule({ bridge: ctx.httpBridge ?? null, network: ctx.network ?? null }, "https:");
    case "http2":
      return refusingModule("http2", "HTTP/2 needs a socket and a TLS handshake, neither of which exists in a tab — http.createServer over the host's virtual ports is the road here");
    case "net":
      return netModule();
    case "tls":
      return tlsModule();
    case "dgram":
      return dgramModule();
    case "dns":
    case "dns/promises":
      return bare === "dns" ? dnsModule() : (dnsModule() as { promises: unknown }).promises;
    case "cluster":
      return clusterModule();
    case "child_process":
      return childProcessModule(ctx.processes ?? null);
    case "worker_threads":
      return workerThreadsModule(ctx.processes ?? null, ctx.process);
    case "module":
      return moduleModule(ctx);
    case "constants":
      return { ...(osModule(homedir).constants as object), F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
    case "punycode":
      return refusingModule("punycode", "punycode is deprecated in Node and absent here; the WHATWG URL parser already handles international domain names");
    case "v8":
      return refusingModule("v8", "there is no V8 API surface in a browser — heap snapshots and serialisation hooks belong to the engine's embedder, and the embedder here is the browser");
    case "vm":
      return refusingModule("vm", "a browser has no separate contexts to run code in; `new Function` is what this runtime uses, and a script that wants isolation should be spawned as its own process");
    case "perf_hooks":
      return { performance, PerformanceObserver: (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver, monitorEventLoopDelay: () => ({ enable() {}, disable() {} }) };
    case "async_hooks":
      return asyncHooksModule();
    case "diagnostics_channel":
      return diagnosticsChannelModule();
    case "inspector":
      return refusingModule("inspector", "the inspector protocol is Node's debugger; the browser's own devtools are already attached to this Worker");
    case "repl":
      return refusingModule("repl", "there is no REPL here — the host's terminal is the interactive surface");
    case "readline":
      return readlineModule(ctx.process);
    case "tty":
      return { isatty: () => false, ReadStream: class {}, WriteStream: class {} };
    default:
      return undefined;
  }
}

function fsOrRefuse(ctx: BuiltinContext): { fs: unknown; promises: unknown } {
  if (!ctx.fs) {
    const why = "this runtime was created without a filesystem backend, so there is nothing for fs to read or write — the host passes one to createLoader";
    return { fs: refusingModule("fs", why), promises: refusingModule("fs/promises", why) };
  }
  return fsModule(ctx.fs);
}

/** `console`, written onto the process's own two sinks so a child's output reaches its parent. */
export function makeConsole(process: NodeProcess): Record<string, unknown> {
  const show = (value: unknown, depth = 0): string => {
    if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
    if (value === null || value === undefined || typeof value !== "object") return String(value);
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    try {
      const seen = new WeakSet<object>();
      const text = JSON.stringify(
        value,
        (_key, v: unknown) => {
          if (typeof v === "bigint") return `${v}n`;
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[Circular]";
            seen.add(v);
          }
          return v;
        },
        depth ? 0 : 2,
      );
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const format = (...args: unknown[]): string => args.map((a) => show(a)).join(" ");
  const out = (...args: unknown[]): void => void process.stdout.write(`${format(...args)}\n`);
  const err = (...args: unknown[]): void => void process.stderr.write(`${format(...args)}\n`);
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  return {
    log: out,
    info: out,
    debug: out,
    dir: (value: unknown) => void process.stdout.write(`${show(value)}\n`),
    table: out,
    warn: err,
    error: err,
    trace: (...args: unknown[]) => err(`Trace: ${format(...args)}`),
    group: out,
    groupEnd: () => undefined,
    assert: (value: unknown, ...args: unknown[]) => {
      if (!value) err(`Assertion failed:`, ...args);
    },
    count: (label = "default") => {
      const next = (counts.get(label) ?? 0) + 1;
      counts.set(label, next);
      out(`${label}: ${next}`);
    },
    countReset: (label = "default") => void counts.delete(label),
    time: (label = "default") => void timers.set(label, Date.now()),
    timeEnd: (label = "default") => {
      const started = timers.get(label);
      if (started !== undefined) out(`${label}: ${Date.now() - started}ms`);
      timers.delete(label);
    },
    timeLog: (label = "default") => {
      const started = timers.get(label);
      if (started !== undefined) out(`${label}: ${Date.now() - started}ms`);
    },
    Console: class Console {},
  };
}

function streamConsumers(): Record<string, unknown> {
  const collect = async (stream: AsyncIterable<unknown>): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  };
  return {
    buffer: collect,
    arrayBuffer: async (s: AsyncIterable<unknown>) => (await collect(s)).buffer,
    text: async (s: AsyncIterable<unknown>) => new TextDecoder().decode(await collect(s)),
    json: async (s: AsyncIterable<unknown>) => JSON.parse(new TextDecoder().decode(await collect(s))) as unknown,
  };
}

/**
 * `async_hooks` is a Node internal a few libraries reach for (`AsyncLocalStorage`, mostly). The
 * storage IS implementable without hooks as long as nobody awaits across a `run()` — which is the
 * limit, stated: this one keeps a stack, so a value set inside `run` is visible to everything that
 * runs synchronously and to microtasks chained from it, and NOT to a callback scheduled later.
 */
function asyncHooksModule(): Record<string, unknown> {
  class AsyncLocalStorage<T> {
    private stack: T[] = [];
    run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
      this.stack.push(store);
      try {
        return fn(...args);
      } finally {
        this.stack.pop();
      }
    }
    getStore(): T | undefined {
      return this.stack[this.stack.length - 1];
    }
    enterWith(store: T): void {
      this.stack.push(store);
    }
    exit<R>(fn: () => R): R {
      const saved = this.stack;
      this.stack = [];
      try {
        return fn();
      } finally {
        this.stack = saved;
      }
    }
    disable(): void {
      this.stack = [];
    }
  }
  return {
    AsyncLocalStorage,
    AsyncResource: class AsyncResource {
      constructor(readonly type: string) {}
      runInAsyncScope<R>(fn: (...args: unknown[]) => R, self?: unknown, ...args: unknown[]): R {
        return fn.apply(self, args);
      }
      emitDestroy(): this {
        return this;
      }
    },
    createHook: () => ({ enable: () => undefined, disable: () => undefined }),
    executionAsyncId: () => 0,
    triggerAsyncId: () => 0,
  };
}

function diagnosticsChannelModule(): Record<string, unknown> {
  const channels = new Map<string, { subscribers: ((message: unknown) => void)[] }>();
  const channel = (name: string): Record<string, unknown> => {
    const entry = channels.get(name) ?? { subscribers: [] };
    channels.set(name, entry);
    return {
      name,
      get hasSubscribers() {
        return entry.subscribers.length > 0;
      },
      publish: (message: unknown) => {
        for (const fn of [...entry.subscribers]) fn(message);
      },
      subscribe: (fn: (message: unknown) => void) => void entry.subscribers.push(fn),
      unsubscribe: (fn: (message: unknown) => void) => {
        entry.subscribers = entry.subscribers.filter((f) => f !== fn);
        return true;
      },
    };
  };
  return {
    channel,
    hasSubscribers: (name: string) => (channels.get(name)?.subscribers.length ?? 0) > 0,
    subscribe: (name: string, fn: (message: unknown) => void) => void (channel(name).subscribe as (f: unknown) => void)(fn),
  };
}

/** `readline` with no TTY: `createInterface` answers `line`-less and `question` calls back empty. */
function readlineModule(process: NodeProcess): Record<string, unknown> {
  return {
    createInterface: () => ({
      question: (_query: string, cb?: (answer: string) => void) => {
        process.stderr.write("readline: this runtime has no interactive input; the question was not asked\n");
        cb?.("");
      },
      close: () => undefined,
      on: () => undefined,
      prompt: () => undefined,
      write: (text: string) => void process.stdout.write(text),
      [Symbol.asyncIterator]: async function* () {
        /* no input, so no lines */
      },
    }),
    clearLine: () => true,
    cursorTo: () => true,
  };
}

function moduleModule(ctx: BuiltinContext): Record<string, unknown> {
  return {
    builtinModules: [...BUILTIN_NAMES],
    isBuiltin: (name: string) => BUILTIN_NAMES.includes((name.startsWith("node:") ? name.slice(5) : name) as (typeof BUILTIN_NAMES)[number]),
    createRequire: () => ctx.loaderRequire,
    _resolveFilename: (request: string) => request,
    syncBuiltinESMExports: () => undefined,
  };
}
