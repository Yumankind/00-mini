/**
 * `zlib` over the platform's own Compression/DecompressionStream.
 *
 * DOES: `gzip`/`gunzip`, `deflate`/`inflate` (zlib-wrapped, `"deflate"` in the web API),
 * `deflateRaw`/`inflateRaw`, `unzip` (sniffs gzip vs zlib from the first two bytes), all in the
 * callback form Node has and in a `*Async` promise form, plus `createGzip`/`createGunzip` as
 * transform streams over the same primitives, and the `constants` scripts compare against.
 *
 * DOES NOT: any of it synchronously without a shared-memory channel. `CompressionStream` is a
 * STREAM — the bytes come back on a later microtask, and nothing in JavaScript can unwind that into
 * a synchronous return. So `gzipSync` and its siblings throw `ERR_SYNC_ZLIB_UNAVAILABLE` naming the
 * async twin, unless the runtime was given a `SyncCompressor` (the same isolation story as the sync
 * filesystem: a Worker, a SharedArrayBuffer, and a service on the other side). Also absent: brotli
 * (no browser exposes a Brotli *compressor* to script, only the decoder inside `fetch`), the
 * `level`/`strategy`/`windowBits` options (the web API takes none, so accepting them and ignoring
 * them would be the lie), and `zlib.crc32`.
 *
 * WHY NOT A WASM ZLIB. Because a browser already ships one, in the network stack, exposed as
 * `CompressionStream` since 2023 in every target. Bundling pako to duplicate it would cost 45 KB on
 * a runtime whose whole argument is that it needs no bundle.
 */

import { NodeCompatError } from "../errors.js";

type Format = "gzip" | "deflate" | "deflate-raw";

/** Optional: a host that IS isolated can supply real synchronous compression. None does today. */
export interface SyncCompressor {
  compress(format: Format, data: Uint8Array): Uint8Array;
  decompress(format: Format, data: Uint8Array): Uint8Array;
}

function plain(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * The write is deliberately NOT awaited before the read starts: awaiting it deadlocks on the
 * transform's backpressure the moment the payload exceeds one internal chunk, which is every real
 * tarball. Same shape, same reason, as `packages/agent-fs/src/gzip.ts`.
 */
async function through(data: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // The write's own rejection is silenced and the READ's is the one that reaches the caller: when a
  // DecompressionStream refuses its input both sides reject, and an unattended second rejection is
  // an unhandled-rejection crash in a Worker for an error that was already reported once.
  const pump = writer
    .write(plain(data))
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await pump;
  return concat(chunks);
}

function available(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

export async function compress(format: Format, data: Uint8Array): Promise<Uint8Array> {
  if (!available()) {
    throw new NodeCompatError("ERR_NO_COMPRESSION_STREAM", "this runtime compresses with CompressionStream, which this environment does not have");
  }
  return await through(data, new CompressionStream(format as CompressionFormat));
}

export async function decompress(format: Format, data: Uint8Array): Promise<Uint8Array> {
  if (!available()) {
    throw new NodeCompatError("ERR_NO_COMPRESSION_STREAM", "this runtime decompresses with DecompressionStream, which this environment does not have");
  }
  return await through(data, new DecompressionStream(format as CompressionFormat));
}

/** gzip starts `1f 8b`; a zlib stream's first byte is `78` in every level anyone uses. */
export function sniffFormat(data: Uint8Array): Format {
  if (data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  if (data[0] === 0x78) return "deflate";
  return "deflate-raw";
}

const SYNC_WHY =
  "CompressionStream is a stream — its bytes arrive on a later microtask and nothing can unwind that " +
  "into a synchronous return. Use the async twin (or await the promise form); a synchronous zlib " +
  "would need the same cross-origin isolation the synchronous filesystem needs";

export function zlibModule(sync: SyncCompressor | null = null): Record<string, unknown> {
  const callbackForm =
    (run: (data: Uint8Array) => Promise<Uint8Array>) =>
    (data: unknown, optionsOrCb?: unknown, maybeCb?: unknown): void => {
      const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as
        | ((err: Error | null, result?: Uint8Array) => void)
        | undefined;
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      run(bytes).then(
        (out) => cb?.(null, out),
        (err) => cb?.(err as Error),
      );
    };

  const syncForm =
    (name: string, kind: "compress" | "decompress", format: Format) =>
    (data: Uint8Array): Uint8Array => {
      if (sync) return kind === "compress" ? sync.compress(format, data) : sync.decompress(format, data);
      throw new NodeCompatError("ERR_SYNC_ZLIB_UNAVAILABLE", `zlib.${name}: ${SYNC_WHY} — zlib.${name.replace(/Sync$/, "")}()`);
    };

  const api: Record<string, unknown> = {
    gzip: callbackForm((d) => compress("gzip", d)),
    gunzip: callbackForm((d) => decompress("gzip", d)),
    deflate: callbackForm((d) => compress("deflate", d)),
    inflate: callbackForm((d) => decompress("deflate", d)),
    deflateRaw: callbackForm((d) => compress("deflate-raw", d)),
    inflateRaw: callbackForm((d) => decompress("deflate-raw", d)),
    unzip: callbackForm((d) => decompress(sniffFormat(d), d)),

    gzipAsync: (d: Uint8Array) => compress("gzip", d),
    gunzipAsync: (d: Uint8Array) => decompress("gzip", d),
    deflateAsync: (d: Uint8Array) => compress("deflate", d),
    inflateAsync: (d: Uint8Array) => decompress("deflate", d),

    gzipSync: syncForm("gzipSync", "compress", "gzip"),
    gunzipSync: syncForm("gunzipSync", "decompress", "gzip"),
    deflateSync: syncForm("deflateSync", "compress", "deflate"),
    inflateSync: syncForm("inflateSync", "decompress", "deflate"),
    deflateRawSync: syncForm("deflateRawSync", "compress", "deflate-raw"),
    inflateRawSync: syncForm("inflateRawSync", "decompress", "deflate-raw"),
    unzipSync: syncForm("unzipSync", "decompress", "gzip"),

    createGzip: () => new CompressionStream("gzip"),
    createGunzip: () => new DecompressionStream("gzip"),
    createDeflate: () => new CompressionStream("deflate"),
    createInflate: () => new DecompressionStream("deflate"),

    brotliCompress: () => {
      throw new NodeCompatError("ERR_NO_BROTLI", "zlib.brotliCompress: no browser exposes a Brotli compressor to script (only the decoder inside fetch) — gzip is the one this runtime can do");
    },
    brotliDecompress: () => {
      throw new NodeCompatError("ERR_NO_BROTLI", "zlib.brotliDecompress: not exposed to script in a browser — ask the server for gzip");
    },
    constants: {
      Z_NO_COMPRESSION: 0,
      Z_BEST_SPEED: 1,
      Z_BEST_COMPRESSION: 9,
      Z_DEFAULT_COMPRESSION: -1,
      Z_NO_FLUSH: 0,
      Z_FINISH: 4,
      Z_OK: 0,
      Z_STREAM_END: 1,
    },
  };
  api.promises = {
    gzip: api.gzipAsync,
    gunzip: api.gunzipAsync,
    deflate: api.deflateAsync,
    inflate: api.inflateAsync,
  };
  api.default = api;
  return api;
}
