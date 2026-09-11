/**
 * The QR encoder (src/lib/qr.ts), checked two ways.
 *
 * STRUCTURE, against the spec's own constants: the size of each version, the three finder patterns,
 * the timing lines, the module that is dark in every code ever made, and the format bits taken back
 * out of the grid and run through their own BCH check.
 *
 * AND A ROUND TRIP, which is the part that matters. The decoder below is written as the INVERSE of
 * the encoder and shares no code with it — its own transcription of the eight mask functions, its own
 * zigzag walk, its own de-interleaving table — so a message that comes back out has survived the
 * placement, the masking, the block split and the padding. It only borrows `qrFunctionPatterns`,
 * because a decoder that guessed where the data modules are would be testing its own guess.
 *
 * WHAT THIS STILL CANNOT PROVE: that a PHONE agrees. A misreading of the spec shared by the encoder
 * and its inverse would pass every line of this file. The last word is a person with a camera.
 */
import { describe, expect, it } from "vitest";
import {
  QR_MAX_VERSION,
  formatBits,
  qrCapacity,
  qrFunctionPatterns,
  qrMatrix,
  qrSvg,
  qrVersionFor,
  versionBits,
} from "../src/lib/qr.js";

// ── The inverse, written independently ───────────────────────────────────────────────────────────

/** The spec's eight masks, transcribed a second time. A typo in either copy fails the round trip. */
const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Level M block layout per version: [ec, blocks1, data1, blocks2, data2]. The spec's table again. */
const LAYOUT: number[][] = [
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

/** The 15 format bits as the grid carries them, read off the copy down the left column. */
function readFormat(matrix: boolean[][]): number {
  const size = matrix.length;
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const dark = i < 6 ? matrix[i][8] : i < 8 ? matrix[i + 1][8] : matrix[size - 15 + i][8];
    if (dark) bits |= 1 << i;
  }
  return bits;
}

/** The other copy, across the top row — the two must agree or no reader could trust either. */
function readFormatMirror(matrix: boolean[][]): number {
  const size = matrix.length;
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const dark = i < 8 ? matrix[8][size - 1 - i] : i < 9 ? matrix[8][15 - i] : matrix[8][14 - i];
    if (dark) bits |= 1 << i;
  }
  return bits;
}

/** BCH(15,5) with generator 0x537: a format value a reader would accept has remainder zero. */
function formatIsWellFormed(bits: number): boolean {
  let rest = bits ^ 0x5412;
  for (let bit = 14; bit >= 10; bit--) if ((rest >> bit) & 1) rest ^= 0x537 << (bit - 10);
  return (rest & 0x3ff) === 0;
}

/** The whole message, read back out of a finished grid. */
function decode(matrix: boolean[][]): string {
  const size = matrix.length;
  const version = (size - 17) / 4;
  const format = readFormat(matrix);
  // The 15 bits are 5 of data over 10 of BCH: the data half is the top five.
  const maskId = ((format ^ 0x5412) >> 10) & 0b111;
  const mask = MASKS[maskId];
  const { reserved } = qrFunctionPatterns(version);

  // The zigzag, unmasking as it goes.
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[row][x]) continue;
        bits.push(matrix[row][x] !== mask(row, x) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const [, blocks1, data1, blocks2, data2] = LAYOUT[version];
  const sizes = [...Array<number>(blocks1).fill(data1), ...Array<number>(blocks2).fill(data2)];
  const dataTotal = sizes.reduce((a, b) => a + b, 0);
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length && codewords.length < dataTotal; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    codewords.push(byte);
  }

  // De-interleave: the symbol holds the first codeword of every block, then the second, and so on.
  const blocks: number[][] = sizes.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < blocks.length; b++) if (i < sizes[b]) blocks[b].push(codewords[at++]);
  }
  const data = blocks.flat();

  // Mode, length, bytes. The data stream is bit-addressed, so the header is read bit by bit.
  const dataBits: number[] = [];
  for (const byte of data) for (let b = 7; b >= 0; b--) dataBits.push((byte >> b) & 1);
  const take = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | (dataBits.shift() ?? 0);
    return value;
  };
  expect(take(4)).toBe(0b0100); // byte mode
  const length = take(version >= 10 ? 16 : 8);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8);
  return new TextDecoder().decode(bytes);
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────────

const LINK = "https://0-0.chat/?receive#code=amber-canyon-pixel-forest-cider-lantern";

describe("the BCH-protected bits", () => {
  it("makes the format strings the spec publishes for level M", () => {
    expect(formatBits(0)).toBe(0x5412);
    expect(formatBits(1)).toBe(0x5125);
    for (let mask = 0; mask < 8; mask++) expect(formatIsWellFormed(formatBits(mask))).toBe(true);
  });

  it("makes the version strings the spec publishes for 7 to 10", () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });
});

describe("capacity", () => {
  it("holds the byte counts the spec's table gives for level M", () => {
    const expected = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    expect(Array.from({ length: 10 }, (_x, i) => qrCapacity(i + 1))).toEqual(expected);
  });

  it("picks the smallest version that fits, and admits when nothing does", () => {
    expect(qrVersionFor(1)).toBe(1);
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(213)).toBe(10);
    expect(qrVersionFor(214)).toBeNull();
  });
});

describe("the grid", () => {
  it("is 17 + 4·version modules on a side", () => {
    expect(qrMatrix("x").length).toBe(21); // version 1
    expect(qrMatrix("x".repeat(15)).length).toBe(25); // version 2
    expect(qrMatrix("x".repeat(200)).length).toBe(57); // version 10
  });

  it("carries a finder in three corners and light separators around them", () => {
    const m = qrMatrix(LINK);
    const size = m.length;
    const finderAt = (top: number, left: number): void => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(m[top + r][left + c]).toBe(ring || core);
        }
      }
    };
    finderAt(0, 0);
    finderAt(0, size - 7);
    finderAt(size - 7, 0);
    // The fourth corner is NOT a finder — that asymmetry is how a reader finds the rotation. At
    // version 7 and up it holds an alignment pattern's edge, never the 7x7 ring.
    const corner = [0, 1, 2, 3, 4, 5, 6].map((r) => [0, 1, 2, 3, 4, 5, 6].map((c) => m[size - 7 + r][size - 7 + c]));
    expect(corner[0].every(Boolean)).toBe(false);
    // The separators: a light row and column between each finder and the rest of the code.
    for (let i = 0; i < 8; i++) {
      expect(m[7][i]).toBe(false);
      expect(m[i][7]).toBe(false);
    }
  });

  it("carries both timing lines and the module that is dark in every QR code", () => {
    const m = qrMatrix(LINK);
    for (let i = 8; i < m.length - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[m.length - 8][8]).toBe(true);
  });

  it("writes format bits that pass their own BCH check, twice, and name the mask that was used", () => {
    for (const text of ["x", LINK, "y".repeat(120)]) {
      const m = qrMatrix(text);
      const bits = readFormat(m);
      expect(bits).toBe(readFormatMirror(m));
      expect(formatIsWellFormed(bits)).toBe(true);
      const value = (bits ^ 0x5412) >> 10; // the five data bits, over ten of BCH
      expect(value >> 3).toBe(0b00); // level M
      expect(formatBits(value & 0b111)).toBe(bits); // and the mask id it names
    }
  });

  it("does not always choose the same mask — the penalty score is doing something", () => {
    const chosen = new Set<number>();
    for (let i = 0; i < 40; i++) chosen.add(((readFormat(qrMatrix(`payload number ${i}`)) ^ 0x5412) >> 10) & 0b111);
    expect(chosen.size).toBeGreaterThan(1);
  });
});

describe("the round trip", () => {
  it("gives the message back, at every version from 1 to 10", () => {
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
      const text = `v${version}:` + "a".repeat(qrCapacity(version) - `v${version}:`.length);
      const matrix = qrMatrix(text);
      expect(matrix.length).toBe(17 + 4 * version);
      expect(decode(matrix)).toBe(text);
    }
  });

  it("gives back the receive link, punctuation and all", () => {
    expect(decode(qrMatrix(LINK))).toBe(LINK);
  });

  it("gives back text that is not ASCII, because the bytes are UTF-8", () => {
    const text = "café — naïve ✓";
    expect(decode(qrMatrix(text))).toBe(text);
  });

  it("gives back a one-character message, where the padding is nearly the whole symbol", () => {
    expect(decode(qrMatrix("x"))).toBe("x");
  });
});

describe("refusals", () => {
  it("never throws for anything up to the version 10 capacity, and throws by name past it", () => {
    for (let length = 1; length <= qrCapacity(QR_MAX_VERSION); length += 7) {
      expect(() => qrMatrix("z".repeat(length))).not.toThrow();
    }
    expect(() => qrMatrix("z".repeat(qrCapacity(QR_MAX_VERSION) + 1))).toThrow(/more than a version 10/);
    // UTF-8, so the limit is in BYTES — three-byte characters run out three times sooner.
    expect(() => qrMatrix("✓".repeat(72))).toThrow(/more than a version 10/);
  });
});

describe("the SVG", () => {
  it("is one path in a viewBox measured in modules, with the quiet zone around it", () => {
    const svg = qrSvg("x", { size: 120, quiet: 2 });
    const modules = qrMatrix("x").length;
    expect(svg).toContain(`width="120" height="120"`);
    expect(svg).toContain(`viewBox="0 0 ${modules + 4} ${modules + 4}"`);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain(`fill="currentColor"`); // theme-aware by default
    expect(svg).not.toContain("<rect"); // no background box unless one is asked for
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("takes its own colours and its own quiet zone when a caller has an opinion", () => {
    const svg = qrSvg("x", { size: 64, fg: "#111", bg: "#fff", quiet: 4 });
    expect(svg).toContain(`fill="#111"`);
    expect(svg).toContain(`<rect width="${qrMatrix("x").length + 8}"`);
    expect(svg).toContain(`fill="#fff"`);
  });

  it("draws one square per dark module and nothing for the light ones", () => {
    const matrix = qrMatrix("hello");
    const dark = matrix.flat().filter(Boolean).length;
    const svg = qrSvg("hello");
    expect(svg.match(/M\d+ \d+h1v1h-1z/g)).toHaveLength(dark);
  });
});
