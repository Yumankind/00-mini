// Byte plumbing shared by the container modules. It exists for one dull reason worth stating once:
// TypeScript's typed arrays became generic over their backing store, so a `Uint8Array` that MIGHT
// sit on a SharedArrayBuffer is no longer a `BufferSource` — and every WebCrypto and stream call in
// this package takes one. `detach()` returns a copy on a plain ArrayBuffer and the argument fights
// stop. The copies are small, once per call, and never in a loop over file contents.

/** A copy of `u` whose backing store is a plain ArrayBuffer. */
export function detach(u: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy.buffer;
}

/** One buffer from many, in order. */
export function concat(parts: Uint8Array[]): Uint8Array {
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

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder();

/** Byte length of a string as UTF-8 — PAX record lengths count bytes, not code points. */
export function utf8Length(s: string): number {
  return utf8.encode(s).byteLength;
}
