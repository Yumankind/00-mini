/**
 * Types for the five npm packages this layer stands on.
 *
 * WHY BY HAND. `@types/node` is deliberately not installed (`tsconfig.json` has `"types": []`):
 * this package must compile as BROWSER code, and the moment Node's globals are in scope a `Buffer`
 * or a `process` typo compiles here and explodes in a Worker. The packages themselves ship no
 * declarations, and they are imported by their FILE paths (`events/events.js`, not `events`) so that
 * a bundler and Node both take the npm implementation rather than Node's builtin — which is the
 * whole reason they are dependencies.
 *
 * These declarations cover what this package actually calls, not the packages' full surface. The
 * runtime objects are re-exported to scripts unchanged; a script sees the real thing.
 */

declare module "events/events.js" {
  class EventEmitter {
    static EventEmitter: typeof EventEmitter;
    static defaultMaxListeners: number;
    static once(emitter: unknown, name: string): Promise<unknown[]>;
    on(name: string, fn: (...args: any[]) => void): this;
    once(name: string, fn: (...args: any[]) => void): this;
    off(name: string, fn: (...args: any[]) => void): this;
    addListener(name: string, fn: (...args: any[]) => void): this;
    removeListener(name: string, fn: (...args: any[]) => void): this;
    removeAllListeners(name?: string): this;
    setMaxListeners(n: number): this;
    listenerCount(name: string): number;
    listeners(name: string): ((...args: any[]) => void)[];
    eventNames(): (string | symbol)[];
    emit(name: string, ...args: any[]): boolean;
  }
  export default EventEmitter;
}

declare module "buffer/index.js" {
  interface BufferLike extends Uint8Array {
    toString(encoding?: string, start?: number, end?: number): string;
    write(text: string, offset?: number, length?: number, encoding?: string): number;
    equals(other: Uint8Array): boolean;
    readUInt32BE(offset?: number): number;
  }
  interface BufferConstructor {
    new (size: number): BufferLike;
    from(value: string, encoding?: string): BufferLike;
    from(value: ArrayBufferLike | ArrayLike<number>, byteOffset?: number, length?: number): BufferLike;
    alloc(size: number, fill?: number | string): BufferLike;
    allocUnsafe(size: number): BufferLike;
    concat(list: Uint8Array[], total?: number): BufferLike;
    isBuffer(value: unknown): boolean;
    byteLength(value: string | Uint8Array, encoding?: string): number;
    poolSize: number;
  }
  export const Buffer: BufferConstructor;
  export const SlowBuffer: BufferConstructor;
  export const INSPECT_MAX_BYTES: number;
  export const kMaxLength: number;
}

declare module "util/util.js" {
  const util: {
    format(...args: unknown[]): string;
    inspect(value: unknown, opts?: unknown): string;
    promisify<T = unknown>(fn: (...args: any[]) => void): (...args: any[]) => Promise<T>;
    inherits(ctor: unknown, superCtor: unknown): void;
    deprecate<T>(fn: T, message: string): T;
    isArray(value: unknown): boolean;
    types?: Record<string, (value: unknown) => boolean>;
    [key: string]: unknown;
  };
  export default util;
}

declare module "string_decoder/lib/string_decoder.js" {
  export class StringDecoder {
    constructor(encoding?: string);
    write(buffer: Uint8Array): string;
    end(buffer?: Uint8Array): string;
  }
}

declare module "readable-stream" {
  export class Readable {
    constructor(opts?: Record<string, unknown>);
    static from(iterable: unknown, opts?: Record<string, unknown>): Readable;
    push(chunk: unknown, encoding?: string): boolean;
    read(size?: number): unknown;
    pipe<T>(destination: T, opts?: Record<string, unknown>): T;
    unpipe(destination?: unknown): this;
    setEncoding(encoding: string): this;
    destroy(error?: Error): this;
    on(name: string, fn: (...args: any[]) => void): this;
    once(name: string, fn: (...args: any[]) => void): this;
    off(name: string, fn: (...args: any[]) => void): this;
    emit(name: string, ...args: any[]): boolean;
    readonly readable: boolean;
    readonly destroyed: boolean;
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
  }
  export class Writable {
    constructor(opts?: Record<string, unknown>);
    write(chunk: unknown, encoding?: string, cb?: (err?: Error | null) => void): boolean;
    end(chunk?: unknown, encoding?: string, cb?: () => void): this;
    destroy(error?: Error): this;
    on(name: string, fn: (...args: any[]) => void): this;
    once(name: string, fn: (...args: any[]) => void): this;
    emit(name: string, ...args: any[]): boolean;
    readonly writable: boolean;
    readonly destroyed: boolean;
  }
  export class Duplex extends Readable {}
  export class Transform extends Duplex {}
  export class PassThrough extends Transform {}
  export function pipeline(...args: unknown[]): unknown;
  export function finished(...args: unknown[]): unknown;
  const streams: {
    Readable: typeof Readable;
    Writable: typeof Writable;
    Duplex: typeof Duplex;
    Transform: typeof Transform;
    PassThrough: typeof PassThrough;
    pipeline: typeof pipeline;
    finished: typeof finished;
    [key: string]: unknown;
  };
  export default streams;
}

declare module "path-browserify" {
  interface PathApi {
    sep: string;
    delimiter: string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    normalize(p: string): string;
    isAbsolute(p: string): boolean;
    relative(from: string, to: string): string;
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    extname(p: string): string;
    format(parts: Record<string, string | undefined>): string;
    parse(p: string): { root: string; dir: string; base: string; ext: string; name: string };
    posix?: PathApi;
    win32?: PathApi;
  }
  const path: PathApi;
  export default path;
}
