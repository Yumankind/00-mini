/**
 * Ids, minted here and never asked of a server.
 *
 * WHY NANOID BY HAND. `nanoid` is a dependency this app does not carry and does not need: the whole
 * algorithm is an alphabet and a mask over `crypto.getRandomValues`. What matters is that the ALPHABET
 * and the LENGTH match apps/00d/src/scaffold.ts::newAgentId — an agent minted in a browser is exported
 * as a `.00agent` and imported on the Mac, where `paths.safeSegment()` decides whether its id is a
 * legal folder name. A different alphabet here would be a bug that only shows up on the far side of a
 * transfer, which is the worst place to find one.
 */

/** nanoid's default alphabet: 64 URL-safe characters, so a 6-bit mask is unbiased with no rejection. */
export const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function nanoid(size = 21, random: RandomBytes = cryptoRandom): string {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`nanoid: bad size ${size}`);
  const bytes = random(size);
  let out = "";
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] & 63];
  return out;
}

/** Matches scaffold.ts: nanoid(12), then the same belt-and-braces sanitiser it applies. */
export function newAgentId(random: RandomBytes = cryptoRandom): string {
  return nanoid(12, random).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Session file names are `<epoch-ms>_<id>` on the Mac; the id half is all we mint. */
export function newSessionId(random: RandomBytes = cryptoRandom): string {
  return nanoid(16, random);
}

/** Correlates a `permission_requested` with the `tool_started` that follows it. */
export function newCallId(random: RandomBytes = cryptoRandom): string {
  return nanoid(10, random);
}

/** Row keys for the conversation view — never persisted, never sent anywhere. */
export function newRowId(random: RandomBytes = cryptoRandom): string {
  return nanoid(8, random);
}
