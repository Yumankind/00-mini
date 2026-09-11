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

/** The `events` module. Node exports the class itself AND as `.EventEmitter`; so does the package. */
export function eventsModule(): Record<string, unknown> {
  const api = EventEmitter as unknown as Record<string, unknown>;
  return Object.assign(EventEmitter, {
    EventEmitter,
    default: EventEmitter,
    once: api.once,
    on: api.on,
    captureRejectionSymbol: Symbol.for("nodejs.rejection"),
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

/** `stream`, plus the submodule names Node answers separately. */
export function streamModule(): Record<string, unknown> {
  const api = streams as unknown as Record<string, unknown>;
  return Object.assign({}, api, { default: api, promises: (api.promises as unknown) ?? { pipeline: api.pipeline, finished: api.finished } });
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
  return Object.assign({}, api, {
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
