import { describe, expect, it } from "vitest";
import { ALPHABET, nanoid, newAgentId, newCallId, newSessionId } from "../src/lib/id.js";

/** A deterministic byte source, so "unbiased" is something a test can actually assert. */
function counting(start = 0): (n: number) => Uint8Array {
  let next = start;
  return (n) => Uint8Array.from({ length: n }, () => next++ & 0xff);
}

describe("id generation", () => {
  it("uses nanoid's 64-character alphabet, so the 6-bit mask is unbiased", () => {
    expect(ALPHABET).toHaveLength(64);
    expect(new Set(ALPHABET).size).toBe(64);
  });

  it("maps each byte through the low six bits", () => {
    const bytes = Uint8Array.from([0, 1, 63, 64, 65, 255]);
    const id = nanoid(6, () => bytes);
    expect(id).toBe(
      [ALPHABET[0], ALPHABET[1], ALPHABET[63], ALPHABET[0], ALPHABET[1], ALPHABET[63]].join(""),
    );
  });

  it("returns the requested length", () => {
    expect(nanoid(1, counting())).toHaveLength(1);
    expect(nanoid(21, counting())).toHaveLength(21);
    expect(nanoid(64, counting())).toHaveLength(64);
  });

  it("refuses a size that is not a positive integer", () => {
    expect(() => nanoid(0, counting())).toThrow(/bad size/);
    expect(() => nanoid(-3, counting())).toThrow(/bad size/);
    expect(() => nanoid(2.5, counting())).toThrow(/bad size/);
  });

  it("mints an agent id of 12 characters, all legal in a folder name", () => {
    // The engine's paths.safeSegment() decides this on the far side of a transfer, so the guarantee
    // has to hold here rather than be discovered there.
    for (let seed = 0; seed < 32; seed++) {
      const id = newAgentId(counting(seed * 7));
      expect(id).toHaveLength(12);
      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    }
  });

  it("gives sessions and calls their own lengths", () => {
    expect(newSessionId(counting())).toHaveLength(16);
    expect(newCallId(counting())).toHaveLength(10);
  });

  it("does not repeat itself with real randomness", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newAgentId()));
    expect(seen.size).toBe(500);
  });
});
