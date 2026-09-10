// gzip through the platform's own streams — Node 24 and every target browser ship
// CompressionStream/DecompressionStream, so a bundle needs no compression library and the PWA pays
// nothing for one. The un-awaited write is deliberate and load-bearing: awaiting it before reading
// deadlocks on the transform's backpressure the moment the payload exceeds one internal chunk,
// which is every real bundle.

import { concat, detach } from "./bytes.js";

async function through(
  data: Uint8Array,
  stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const pump = writer.write(detach(data)).then(() => writer.close());
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

export function gzip(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new CompressionStream("gzip"));
}

export function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new DecompressionStream("gzip"));
}
