/**
 * A QR encoder, written out rather than installed — docs/HANDOFF-infinite-agent.md §7, "bring it
 * with you by scanning a QR code" (apps/infinite/DESIGN.md, the landing's `#qr` section).
 *
 * WHY NOT A DEPENDENCY. Every QR library on npm is 15–60 KB of code that draws to a `<canvas>` or a
 * DOM node, and this app ships a 60 KB embed and a PWA that must work with the network gone. What is
 * actually needed is one function from a string to a grid of booleans; the rest of a library is
 * rendering this app already knows how to do (an `<svg>` with one `<path>`, which is theme-aware and
 * scales, where a canvas is neither). The house rule is no new dependencies for the browser agent, so
 * the encoder is here, in ~350 lines, with the tables that make it work written down beside it.
 *
 * WHAT IT DOES AND DELIBERATELY DOES NOT DO:
 *
 * - **Byte mode only.** The thing being encoded is a URL with a percent-encoded fragment, which is
 *   not alphanumeric mode's 45-character alphabet; numeric and kanji modes would save nothing here
 *   and cost a third of this file.
 * - **Error correction M** (~15% recoverable). L makes the code smaller but a phone reading a screen
 *   at an angle needs the redundancy; Q and H make it denser than a small panel can show.
 * - **Versions 1–10**, which is up to 213 bytes in byte mode at M — four times what the receive link
 *   needs (`https://0-0.chat/?receive#code=` plus six words is ~70). Beyond version 10 the modules
 *   get too fine to scan off a 200 px panel anyway, so the honest answer past that is to throw.
 * - **No decoder ships here.** Nothing in the app reads a QR code. `test/qr.test.ts` does: it writes
 *   the inverse of this file (its own eight mask functions, its own zigzag walk, its own
 *   de-interleaving) and reads the message back out of the finished grid, which is the strongest
 *   check available without a camera. What it CANNOT prove is that a phone agrees — a mistake shared
 *   by the encoder and its inverse would pass. The last word is a person with a camera.
 *
 * The reference is ISO/IEC 18004. The tables below are its, transcribed; the algorithms (the
 * Reed-Solomon remainder, the BCH format/version bits, the zigzag placement, the eight masks and
 * their penalty scores) are written out rather than table-driven wherever the code is shorter than
 * the table would be.
 */

/** The smallest and largest symbol this encoder makes. */
export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 10;

/**
 * Error correction M, per version: the EC codewords per block, and the two block groups (the second
 * group's blocks each hold one data codeword more than the first's). Index 0 is unused so the array
 * is read by version number.
 */
const EC_M: readonly (readonly [ec: number, blocks1: number, data1: number, blocks2: number, data2: number])[] = [
  [0, 0, 0, 0, 0],
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

/** Alignment pattern centres per version; the pattern is skipped where it would sit on a finder. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// ── GF(256), the field Reed-Solomon lives in ─────────────────────────────────────────────────────
//
// x^8 + x^4 + x^3 + x^2 + 1 (0x11d) is QR's primitive polynomial, and 2 is its generator. Two tables
// turn multiplication into addition of logarithms; `EXP` is doubled in length so a sum of two logs
// (at most 508) needs no modulo.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = x << 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** g(x) = ∏(x − α^i) for i < degree. Index 0 is the highest-degree coefficient, always 1. */
function rsGenerator(degree: number): Uint8Array {
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The EC codewords for one block: the remainder of the data polynomial over the generator. */
function rsRemainder(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = rsGenerator(ecLength);
  const rest = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ rest[0];
    rest.copyWithin(0, 1);
    rest[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i++) rest[i] ^= mul(gen[i + 1], factor);
  }
  return rest;
}

// ── BCH, which protects the two things a reader must read before it can read anything ────────────

/** 15 bits: 5 of format (EC level + mask), 10 of BCH, then the mask pattern 0x5412 the spec fixes. */
export function formatBits(maskId: number): number {
  const value = (0b00 << 3) | maskId; // 0b00 is error correction level M
  let rest = value << 10;
  for (let bit = 14; bit >= 10; bit--) if ((rest >> bit) & 1) rest ^= 0x537 << (bit - 10);
  return ((value << 10) | rest) ^ 0x5412;
}

/** 18 bits: 6 of version, 12 of BCH. Only versions 7 and up carry it. */
export function versionBits(version: number): number {
  let rest = version << 12;
  for (let bit = 17; bit >= 12; bit--) if ((rest >> bit) & 1) rest ^= 0x1f25 << (bit - 12);
  return (version << 12) | rest;
}

// ── The data half: text → codewords ──────────────────────────────────────────────────────────────

/** Data codewords (before EC) a version holds at level M. */
function dataCodewords(version: number): number {
  const [, blocks1, data1, blocks2, data2] = EC_M[version];
  return blocks1 * data1 + blocks2 * data2;
}

/** Byte-mode character count: 8 bits up to version 9, 16 from version 10. */
function countBits(version: number): number {
  return version >= 10 ? 16 : 8;
}

/** How many UTF-8 bytes fit, which is what a caller wants to know before it asks. */
export function qrCapacity(version: number): number {
  return dataCodewords(version) - Math.ceil((4 + countBits(version)) / 8);
}

/** The smallest version that holds this many bytes, or `null` when nothing here does. */
export function qrVersionFor(byteLength: number): number | null {
  for (let version = QR_MIN_VERSION; version <= QR_MAX_VERSION; version++) {
    if (byteLength <= qrCapacity(version)) return version;
  }
  return null;
}

/**
 * Mode indicator, length, the bytes, a terminator, and then the two pad codewords the spec names,
 * alternating until the version is full. `0xec 0x11` are not arbitrary: they are the bytes a reader
 * expects to see and are chosen so padding never looks like data.
 */
function codewordsFor(bytes: Uint8Array, version: number): Uint8Array {
  const total = dataCodewords(version);
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    out[i / 8] = byte;
  }
  const PAD = [0xec, 0x11];
  for (let at = bits.length / 8, i = 0; at < total; at++, i++) out[at] = PAD[i % 2];
  return out;
}

/**
 * Blocks, their EC, and the interleaving. A symbol is not "data then parity": it is the first
 * codeword of every block, then the second of every block, and so on — which is what makes a smudge
 * across the middle of a code survivable, because it lands one or two codewords deep in each block
 * rather than wiping one block out entirely.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecLength, blocks1, size1, blocks2, size2] = EC_M[version];
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let at = 0;
  for (const [count, size] of [[blocks1, size1], [blocks2, size2]]) {
    for (let i = 0; i < count; i++) {
      const chunk = data.subarray(at, at + size);
      at += size;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLength) });
    }
  }
  const out: number[] = [];
  const widest = Math.max(size1, size2);
  for (let i = 0; i < widest; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecLength; i++) for (const block of blocks) out.push(block.ec[i]);
  return Uint8Array.from(out);
}

// ── The grid half: function patterns, data placement, masking ────────────────────────────────────

type Grid = boolean[][];

function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

/**
 * The patterns a reader finds BEFORE it knows anything: finders, separators, timing, alignment, the
 * version block and the reserved format area. Exported because it is also the map a READER needs —
 * `test/qr.test.ts` decodes what this module encodes, and a decoder that guessed where the data
 * modules are would be testing its own guess.
 */
export function qrFunctionPatterns(version: number): { modules: Grid; reserved: Grid } {
  const size = 17 + 4 * version;
  const modules = blank(size);
  const reserved = blank(size);

  const finder = (top: number, left: number): void => {
    // −1..7 rather than 0..6: the ring of light modules around each finder (the separator) is part
    // of the pattern, and it is what tells a reader where the finder ENDS.
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r;
        const x = left + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        modules[y][x] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (onRing || inCore);
        reserved[y][x] = true;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // The two timing lines: alternating modules along row 6 and column 6, which give a reader the
  // module pitch of a symbol it is seeing at an angle.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    modules[6][i] = dark;
    modules[i][6] = dark;
    reserved[6][i] = true;
    reserved[i][6] = true;
  }

  const centres = ALIGNMENT[version];
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      // The three corners already carry a finder, which is bigger and does the same job.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          modules[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          reserved[r + dr][c + dc] = true;
        }
      }
    }
  }

  // The format area, reserved now and written once a mask has been chosen, plus the one module that
  // is dark in every symbol ever made.
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      modules[a][b] = dark;
      reserved[a][b] = true;
      modules[b][a] = dark;
      reserved[b][a] = true;
    }
  }
  return { modules, reserved };
}

/** The zigzag: two columns at a time, right to left, up then down, skipping the timing column. */
function placeData(modules: Grid, reserved: Grid, codewords: Uint8Array): void {
  const size = modules.length;
  const totalBits = codewords.length * 8;
  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // column 6 is the timing line and is never a data column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[row][x]) continue;
        // Past the last codeword the remaining modules are the version's remainder bits, which are
        // zero — they carry nothing and a reader ignores them.
        modules[row][x] = index < totalBits && ((codewords[index >> 3] >> (7 - (index & 7))) & 1) === 1;
        index++;
      }
    }
    upward = !upward;
  }
}

/** The eight masks, by id. Each answers "is this module flipped?" for a position. */
const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Mask the data modules and write the format bits for that mask. Mutates the grid it is given. */
function applyMask(modules: Grid, reserved: Grid, maskId: number): void {
  const size = modules.length;
  const mask = MASKS[maskId];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && mask(r, c)) modules[r][c] = !modules[r][c];
    }
  }
  const bits = formatBits(maskId);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // The copy down the left column and across the top row, in the spec's own order — the two jumps
    // are where the timing line and the dark module sit.
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;

    if (i < 8) modules[8][size - 1 - i] = dark;
    else if (i < 9) modules[8][15 - i] = dark;
    else modules[8][14 - i] = dark;
  }
}

/**
 * The four penalties of the spec, in the spec's own order. They exist to pick the mask whose result
 * is easiest for a camera: long runs of one colour confuse the pitch, 2×2 blocks look like a
 * pattern, `1011101` looks like a FINDER, and a symbol that is 90% dark loses its contrast.
 */
export function maskPenalty(modules: Grid): number {
  const size = modules.length;
  let score = 0;

  const runs = (get: (i: number) => boolean): number => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) total += run - 2;
        run = 1;
      }
    }
    return run >= 5 ? total + run - 2 : total;
  };
  for (let i = 0; i < size; i++) {
    score += runs((j) => modules[i][j]);
    score += runs((j) => modules[j][i]);
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const first = modules[r][c];
      if (modules[r][c + 1] === first && modules[r + 1][c] === first && modules[r + 1][c + 1] === first) score += 3;
    }
  }

  const FINDER_LIKE = ["10111010000", "00001011101"];
  const count = (line: string): number => {
    let found = 0;
    for (const pattern of FINDER_LIKE) {
      for (let at = line.indexOf(pattern); at !== -1; at = line.indexOf(pattern, at + 1)) found++;
    }
    return found * 40;
  };
  for (let i = 0; i < size; i++) {
    let row = "";
    let col = "";
    for (let j = 0; j < size; j++) {
      row += modules[i][j] ? "1" : "0";
      col += modules[j][i] ? "1" : "0";
    }
    score += count(row) + count(col);
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// ── The two things this module is for ────────────────────────────────────────────────────────────

/**
 * `text` as a grid of modules, `true` being dark. Throws for text that no version up to 10 holds —
 * a QR code that cannot be made is not a QR code that is silently wrong.
 */
export function qrMatrix(text: string): Grid {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (version === null) {
    throw new Error(`${bytes.length} bytes is more than a version ${QR_MAX_VERSION} QR code holds (${qrCapacity(QR_MAX_VERSION)}).`);
  }
  const codewords = interleave(codewordsFor(bytes, version), version);

  let best: Grid | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let maskId = 0; maskId < 8; maskId++) {
    const { modules, reserved } = qrFunctionPatterns(version);
    placeData(modules, reserved, codewords);
    applyMask(modules, reserved, maskId);
    const score = maskPenalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = modules;
    }
  }
  return best as Grid;
}

export interface QrSvgOptions {
  /** Width and height of the `<svg>` in CSS pixels. */
  size?: number;
  /** The dark modules. `currentColor` by default, which is what makes the code theme-aware. */
  fg?: string;
  /** The light ones. Transparent by default; a scanner needs contrast, not a white box. */
  bg?: string;
  /** The margin, in modules. The spec asks for 4; 2 scans fine on a screen and wastes less panel. */
  quiet?: number;
}

/**
 * One `<svg>` string, one `<path>`, no dependency and no canvas. The whole code is a single path of
 * 1×1 squares in a `viewBox` measured in MODULES, so the browser scales it to any size with no
 * rounding of its own; `shape-rendering: crispEdges` stops a half-pixel of antialiasing from
 * blurring the edge between two modules, which is what a camera is reading.
 */
export function qrSvg(text: string, options: QrSvgOptions = {}): string {
  const { size = 160, fg = "currentColor", bg = "transparent", quiet = 2 } = options;
  const modules = qrMatrix(text);
  const span = modules.length + quiet * 2;
  let path = "";
  for (let r = 0; r < modules.length; r++) {
    for (let c = 0; c < modules.length; c++) {
      if (modules[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const background = bg === "transparent" || bg === "none" ? "" : `<rect width="${span}" height="${span}" fill="${bg}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `${background}<path fill="${fg}" d="${path}"/></svg>`
  );
}
