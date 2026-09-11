/**
 * The five modules that are already written, and the one wrapper each of them needs.
 *
 * DOES: hand a script the REAL `buffer`, `events`, `path-browserify`, `util`, `readable-stream` and
 * `string_decoder` packages — the same code npm ships, not a re-implementation. `Buffer` is also
 * installed as a global, because half of npm assumes it. `path` is `path-browserify` with `resolve`
 * rebound to this process's cwd (the package reads a global `process`, which a Worker has none of)
 * and `path.win32` removed. `util` gains `promisify`'s missing friends only where the package lacks
 * them.
 *
 * DOES NOT: pretend to be Node's own C++-backed versions. `util.inspect` is the JS one (no colours,
 * shallower defaults); `stream` is readable-stream v4, which is Node 18's streams, so
 * `Readable.fromWeb`/`toWeb` exist but `stream/consumers` and `stream/web` do not; `path.win32` is
 * absent because there is no Windows under this filesystem and a script that reaches for it wants
 * behaviour we would have to invent.
 *
 * WHY THE PACKAGES AND NOT OUR OWN. `apps/infinite/src/power/js-runner.ts` hand-wrote small
 * versions of four of these into its prelude, and each one was subtly wrong in the way hand-written
 * ones always are (`path.relative` without a common-root check, an `EventEmitter` with no
 * `error`-event rule). These are the versions the ecosystem is tested against.
 */

import { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength } from "buffer/index.js";
import EventEmitter from "events/events.js";
import pathBrowserify from "path-browserify";
import { StringDecoder } from "string_decoder/lib/string_decoder.js";
import streams from "readable-stream";
import util from "util/util.js";

export { Buffer, EventEmitter, StringDecoder };

/** The `buffer` module, plus the constants scripts read off it. */
export function bufferModule(): Record<string, unknown> {
  return {
    Buffer,
    SlowBuffer,
    INSPECT_MAX_BYTES,
    kMaxLength,
    constants: { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 536870888 },
    atob: (text: string) => (globalThis as { atob?: (s: string) => string }).atob?.(text),
    btoa: (text: string) => (globalThis as { btoa?: (s: string) => string }).btoa?.(text),
    Blob: (globalThis as { Blob?: unknown }).Blob,
    isUtf8: (bytes: Uint8Array) => {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    },
  };
}

type AnyEmitter = {
  on(name: string, fn: (...args: unknown[]) => void): unknown;
  off(name: string, fn: (...args: unknown[]) => void): unknown;
  listeners(name: string): unknown[];
};

/**
 * `events.on(emitter, name)` — the async iterator Node added in 12 and the `events` package (3.3.0)
 * does not have. Written out because modern code uses it in place of a `data` handler, and the
 * alternative was for it to be `undefined` and fail as "events.on is not a function".
 *
 * The limits it shares with Node's: events that arrive with nobody awaiting are QUEUED without
 * bound, an `error` event rejects the iterator, and `return()`/`break` unsubscribes.
 */
function eventsOn(emitter: AnyEmitter, name: string): AsyncIterableIterator<unknown[]> {
  const queue: unknown[][] = [];
  const waiting: { resolve: (r: IteratorResult<unknown[]>) => void; reject: (err: unknown) => void }[] = [];
  let finished: { error: unknown } | null = null;

  const push = (...args: unknown[]): void => {
    const next = waiting.shift();
    if (next) next.resolve({ value: args, done: false });
    else queue.push(args);
  };
  const fail = (err: unknown): void => {
    finished = { error: err };
    stop();
    for (const w of waiting.splice(0)) w.reject(err);
  };
  const stop = (): void => {
    emitter.off(name, push);
    emitter.off("error", fail);
  };
  emitter.on(name, push);
  emitter.on("error", fail);

  const iterator: AsyncIterableIterator<unknown[]> = {
    next(): Promise<IteratorResult<unknown[]>> {
      const ready = queue.shift();
      if (ready) return Promise.resolve({ value: ready, done: false });
      if (finished) return Promise.reject(finished.error);
      return new Promise((resolve, reject) => void waiting.push({ resolve, reject }));
    },
    return(): Promise<IteratorResult<unknown[]>> {
      stop();
      for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: unknown): Promise<IteratorResult<unknown[]>> {
      stop();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/** The `events` module. Node exports the class itself AND as `.EventEmitter`; so does the package. */
export function eventsModule(): Record<string, unknown> {
  const api = EventEmitter as unknown as Record<string, unknown>;
  return Object.assign(EventEmitter, {
    EventEmitter,
    default: EventEmitter,
    once: api.once,
    on: (api.on as unknown) ?? eventsOn,
    getEventListeners: (emitter: AnyEmitter, name: string) => emitter.listeners(name),
    setMaxListeners: (api.setMaxListeners as unknown) ?? (() => undefined),
    captureRejectionSymbol: Symbol.for("nodejs.rejection"),
    errorMonitor: (api.errorMonitor as unknown) ?? Symbol.for("events.errorMonitor"),
  }) as unknown as Record<string, unknown>;
}

/** `path`, with `resolve` anchored to this process rather than to a global that does not exist. */
export function pathModule(cwd: () => string): Record<string, unknown> {
  const api: Record<string, unknown> = {
    ...(pathBrowserify as unknown as Record<string, unknown>),
    resolve: (...parts: string[]): string => {
      const anchored = parts.some((p) => typeof p === "string" && p.startsWith("/")) ? parts : [cwd(), ...parts];
      return pathBrowserify.resolve(...anchored.filter((p) => typeof p === "string"));
    },
    sep: "/",
    delimiter: ":",
  };
  api.posix = api;
  // Deliberately absent rather than wrong: there is no drive letter under this filesystem.
  delete api.win32;
  return api;
}

/**
 * `stream`. Node's `stream` module IS the legacy `Stream` constructor with everything else hung off
 * it — `require("stream")` is callable and has a `.prototype.pipe`, and packages do subclass it — so
 * this returns that function rather than a plain object holding the same names.
 */
export function streamModule(): Record<string, unknown> {
  const api = streams as unknown as Record<string, unknown>;
  const Stream = (api.Stream ?? api.default) as unknown as Record<string, unknown>;
  // Only what is MISSING is added: readable-stream defines `promises` on its Stream as a getter with
  // no setter, and an `Object.assign` over it throws rather than being ignored.
  const add = (key: string, value: unknown): void => {
    if (key in Stream) return;
    Object.defineProperty(Stream, key, { value, enumerable: true, configurable: true, writable: true });
  };
  for (const [key, value] of Object.entries(api)) add(key, value);
  add("Stream", Stream);
  add("default", Stream);
  add("promises", { pipeline: api.pipeline, finished: api.finished });
  return Stream;
}

/** `util`. `promisify`, `inherits`, `format` and `inspect` come from the package; the rest is Node's shape. */
export function utilModule(): Record<string, unknown> {
  const api = util as unknown as Record<string, unknown>;
  const callbackify = (fn: (...args: unknown[]) => Promise<unknown>) =>
    function (...args: unknown[]): void {
      const done = args.pop() as (err: unknown, value?: unknown) => void;
      fn(...args).then(
        (value) => done(null, value),
        (err) => done(err ?? new Error("rejected with a falsy value")),
      );
    };
  // The `util` package's `format` predates `%i` and `%f`, and leaves them in the output as literal
  // text — which reads as a bug in the caller's own log line. Handled here before delegating.
  const packageFormat = api.format as (...args: unknown[]) => string;
  const format = (...args: unknown[]): string => {
    if (typeof args[0] !== "string" || !/%[if]/.test(args[0])) return packageFormat(...args);
    const rest = args.slice(1);
    let at = 0;
    const first = args[0].replace(/%[%if]/g, (token) => {
      if (token === "%%") return "%%";
      if (at >= rest.length) return token;
      const value = Number(rest[at++]);
      return token === "%i" ? String(Number.isNaN(value) ? NaN : Math.trunc(value)) : String(value);
    });
    return packageFormat(first, ...rest.slice(at));
  };

  // `inspect` from the package is pre-BigInt and renders a bigint, a symbol, a Map and a Set all as
  // `{}`. These four are handled at the top level — nested ones still go through the package — so a
  // `console.log(util.inspect(new Map(…)))` says what it holds instead of nothing.
  const packageInspect = api.inspect as (value: unknown, ...rest: unknown[]) => string;
  const inspect = (value: unknown, ...rest: unknown[]): string => {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol") return value.toString();
    if (value instanceof Map) {
      const body = [...value].map(([k, v]) => `${packageInspect(k)} => ${packageInspect(v)}`).join(", ");
      return value.size === 0 ? "Map(0) {}" : `Map(${value.size}) { ${body} }`;
    }
    if (value instanceof Set) {
      const body = [...value].map((v) => packageInspect(v)).join(", ");
      return value.size === 0 ? "Set(0) {}" : `Set(${value.size}) { ${body} }`;
    }
    return packageInspect(value, ...rest);
  };

  return Object.assign({}, api, {
    format,
    inspect: Object.assign(inspect, packageInspect),
    callbackify: (api.callbackify as unknown) ?? callbackify,
    TextEncoder,
    TextDecoder,
    types: Object.assign(
      {
        isDate: (v: unknown) => v instanceof Date,
        isRegExp: (v: unknown) => v instanceof RegExp,
        isPromise: (v: unknown) => v instanceof Promise,
        isMap: (v: unknown) => v instanceof Map,
        isSet: (v: unknown) => v instanceof Set,
        isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
        isUint8Array: (v: unknown) => v instanceof Uint8Array,
        isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
      },
      (api.types as Record<string, unknown>) ?? {},
    ),
    isDeepStrictEqual: deepStrictEqual,
    default: api,
  });
}

export function stringDecoderModule(): Record<string, unknown> {
  return { StringDecoder, default: { StringDecoder } };
}

/**
 * Structural equality, shared by `util.isDeepStrictEqual` and `assert.deepStrictEqual`.
 * Strict means strict: `1` is not `"1"`, `NaN` IS `NaN`, and the prototypes must match.
 */
export function deepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b);
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return x.byteLength === y.byteLength && x.every((v, i) => v === y[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepStrictEqual(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  const ka = Reflect.ownKeys(a as object).filter((k) => typeof k === "string");
  const kb = Reflect.ownKeys(b as object).filter((k) => typeof k === "string");
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepStrictEqual((a as Record<string, unknown>)[key as string], (b as Record<string, unknown>)[key as string])) return false;
  }
  return true;
}
