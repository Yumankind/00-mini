/**
 * The ref's grammar, and the fact that a browser mints exactly one.
 *
 * A ref is minted OFFLINE and pasted into a website by hand; by the time anyone finds out the worker
 * will not take it, it is in somebody's page source. So the grammar is checked against the worker's
 * own regular expression rather than against a copy of it — that import is the whole point of these
 * two files — and `ownRef` is pinned to never mint twice, because a second ref orphans every snippet
 * already pasted.
 */
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE32_ALPHABET, base32Number, embedSnippet, isRef, newRef, ownRef, refMintedAtSeconds, unbase32Number } from "../src/registry/ref.js";
import { installFakeIndexedDb } from "./mac-helpers.js";

const WORKER_REFS = "/Users/brunosilva/Documents/GitHub/moltworker/worker/src/infinite/refs.ts";

describe("the grammar", () => {
  it("mints something the shape of ia_<base32 seconds>_<12>", () => {
    const ref = newRef(1_757_000_000_000);
    expect(ref).toMatch(/^ia_[a-z2-7]{6,9}_[a-z2-7]{12}$/);
    expect(isRef(ref)).toBe(true);
    expect(refMintedAtSeconds(ref)).toBe(1_757_000_000);
  });

  it("uses the worker's alphabet and nothing else", () => {
    const ref = newRef(Date.now(), (n) => new Uint8Array(n).fill(255));
    // 255 % 32 === 31, the last character of the alphabet: the mint is a plain modulo and 256/32 is
    // exact, so no byte is favoured.
    expect(ref.split("_")[2]).toBe(BASE32_ALPHABET[31].repeat(12));
  });

  it("round-trips a number through base 32", () => {
    for (const n of [0, 1, 31, 32, 1023, 1_757_000_000]) {
      expect(unbase32Number(base32Number(n))).toBe(n);
    }
    expect(unbase32Number("!!")).toBeNull();
    expect(() => base32Number(-1)).toThrow();
  });

  it.each([
    ["", false],
    ["ia_abc_abcdefghijkl", false], // seconds field too short
    ["ia_abcdef_abcdefghijk", false], // eleven, not twelve
    ["IA_ABCDEF_ABCDEFGHIJKL", false], // upper case is not the alphabet
    ["ia_abcdef_abcdefghijk1", false], // 0, 1, 8 and 9 are not in base32
    ["ia_abcdef_abcdefghijkl", true],
  ])("refuses or accepts %s", (value, expected) => {
    expect(isRef(value)).toBe(expected);
  });

  it("agrees with the worker's own regular expression", async () => {
    if (!existsSync(WORKER_REFS)) {
      // The sibling checkout is how these vectors are generated (CLAUDE.md, "The sibling repo").
      console.warn("moltworker is not checked out beside 00Local — the cross-repo ref check is skipped.");
      return;
    }
    const worker = (await import(/* @vite-ignore */ WORKER_REFS)) as typeof import("../src/registry/ref.js");
    for (let i = 0; i < 50; i++) {
      const ours = newRef(Date.now() - i * 86_400_000);
      expect(worker.isRef(ours)).toBe(true);
      expect(isRef(worker.newRef(Date.now()))).toBe(true);
    }
    expect(worker.REF_RE.source).toBe(/^ia_[a-z2-7]{6,9}_[a-z2-7]{12}$/.source);
    expect(worker.BASE32_ALPHABET).toBe(BASE32_ALPHABET);
  });
});

describe("the snippet", () => {
  it("points at the product origin's loader and carries nothing else", () => {
    const snippet = embedSnippet("ia_abcdef_abcdefghijkl", "https://infinite.example/");
    expect(snippet).toBe('<script async src="https://infinite.example/e/ia_abcdef_abcdefghijkl.js"></script>');
    // The private half is not in it, cannot be in it, and this is the assertion that says so.
    expect(snippet).not.toContain("linkPub");
    expect(snippet).not.toContain("key");
  });
});

describe("one ref per browser", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installFakeIndexedDb();
    return () => restore();
  });

  it("mints once and reads the same one back", async () => {
    const first = await ownRef();
    const second = await ownRef(() => {
      throw new Error("ownRef minted a second ref — every snippet already pasted is now orphaned");
    });
    expect(second).toBe(first);
    expect(isRef(first)).toBe(true);
  });

  it("mints again when what was stored is not a ref", async () => {
    const stored = await ownRef(() => "not-a-ref" as string);
    expect(stored).toBe("not-a-ref");
    const next = await ownRef(() => "ia_abcdef_abcdefghijkl");
    expect(next).toBe("ia_abcdef_abcdefghijkl");
  });
});
