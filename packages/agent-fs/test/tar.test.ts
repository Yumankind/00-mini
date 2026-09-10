// The tar is the one format here whose real reader is somebody else's C program, so these tests
// pin the bytes: field offsets, the checksum, the PAX record length, and the refusal of a path that
// escapes. test/bundle.test.ts then runs the same archives through the system `tar` itself.

import { describe, expect, it } from "vitest";
import { BLOCK, normalizeTarPath, paxRecord, readTar, tarPack } from "../src/tar.js";

const utf8 = new TextEncoder();
const text = new TextDecoder();

function field(bytes: Uint8Array, at: number, len: number): string {
  const raw = bytes.subarray(at, at + len);
  const end = raw.indexOf(0);
  return text.decode(end < 0 ? raw : raw.subarray(0, end));
}

describe("tarPack", () => {
  it("writes a ustar header a reader can trust", () => {
    const tar = tarPack([{ path: "burst.json", kind: "file", data: utf8.encode("{}"), mtime: 1_700_000_000 }]);
    expect(field(tar, 0, 100)).toBe("burst.json");
    expect(field(tar, 100, 8)).toBe("0000644");
    expect(field(tar, 124, 12)).toBe("00000000002");
    expect(field(tar, 136, 12)).toBe((1_700_000_000).toString(8).padStart(11, "0"));
    expect(field(tar, 156, 1)).toBe("0");
    expect(field(tar, 257, 6)).toBe("ustar");
    expect(text.decode(tar.subarray(263, 265))).toBe("00");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (tar[i] as number);
    expect(field(tar, 148, 8).trim()).toBe(sum.toString(8).padStart(6, "0"));
  });

  it("pads data to a block and ends with two zero blocks", () => {
    const tar = tarPack([{ path: "a.txt", kind: "file", data: utf8.encode("hi") }]);
    expect(tar.byteLength).toBe(BLOCK * 4);
    expect([...tar.subarray(BLOCK * 2)].every((b) => b === 0)).toBe(true);
  });

  it("marks a directory with typeflag 5 and a trailing slash", () => {
    const tar = tarPack([{ path: "workspace/projects", kind: "dir", data: new Uint8Array(0) }]);
    expect(field(tar, 0, 100)).toBe("workspace/projects/");
    expect(field(tar, 156, 1)).toBe("5");
    expect([...readTar(tar)].map((e) => [e.path, e.kind])).toEqual([["workspace/projects", "dir"]]);
  });

  it("uses a PAX extended header for a name over 100 bytes", () => {
    const long = `agent/workspace/projects/${"deep/".repeat(20)}file.txt`;
    expect(long.length).toBeGreaterThan(100);
    const tar = tarPack([{ path: long, kind: "file", data: utf8.encode("x") }]);
    expect(field(tar, 156, 1)).toBe("x");
    expect(field(tar, 0, 100)).toBe("PaxHeaders.0/file.txt");
    const pax = text.decode(tar.subarray(BLOCK, BLOCK * 2));
    expect(pax).toContain(`path=${long}`);
    // The ustar header that follows still carries a legal short name for a PAX-blind reader.
    expect(field(tar, BLOCK * 2, 100)).toBe("file.txt");
    expect([...readTar(tar)].map((e) => e.path)).toEqual([long]);
  });

  it("computes a PAX record length that counts its own digits", () => {
    expect(paxRecord("path", "a")).toBe("9 path=a\n");
    const record = paxRecord("path", "b".repeat(200));
    expect(record.length).toBe(Number.parseInt(record.slice(0, record.indexOf(" ")), 10));
  });
});

describe("readTar", () => {
  it("round-trips files and directories in order", () => {
    const entries = [
      { path: "burst.json", kind: "file" as const, data: utf8.encode("{}") },
      { path: "agent/workspace", kind: "dir" as const, data: new Uint8Array(0) },
      { path: "agent/workspace/AGENTS.md", kind: "file" as const, data: utf8.encode("rules") },
    ];
    const back = [...readTar(tarPack(entries))];
    expect(back.map((e) => e.path)).toEqual(["burst.json", "agent/workspace", "agent/workspace/AGENTS.md"]);
    expect(text.decode(back[2]?.data as Uint8Array)).toBe("rules");
  });

  it("reads a GNU longname entry", () => {
    const long = `agent/${"x".repeat(120)}.md`;
    const name = utf8.encode(`${long}\0`);
    const tar = tarPack([
      { path: "L", kind: "file", data: name },
      { path: "short.md", kind: "file", data: utf8.encode("body") },
    ]);
    // Re-stamp the first header's typeflag as GNU's 'L' — the writer never emits one, the reader must.
    tar[156] = "L".charCodeAt(0);
    const back = [...readTar(tar)];
    expect(back.map((e) => e.path)).toEqual([long]);
    expect(text.decode(back[0]?.data as Uint8Array)).toBe("body");
  });

  it("joins the ustar prefix field", () => {
    const tar = tarPack([{ path: "file.txt", kind: "file", data: utf8.encode("p") }]);
    const prefix = utf8.encode("deep/dir");
    tar.set(prefix, 345);
    // The checksum is now stale, which readTar does not verify — GNU tar is the one that checks it,
    // and this test is about the prefix join, not about forging a header.
    expect([...readTar(tar)].map((e) => e.path)).toEqual(["deep/dir/file.txt"]);
  });

  it("skips links, devices and a global header", () => {
    const tar = tarPack([
      { path: "link", kind: "file", data: new Uint8Array(0) },
      { path: "real.txt", kind: "file", data: utf8.encode("r") },
    ]);
    tar[156] = "2".charCodeAt(0);
    expect([...readTar(tar)].map((e) => e.path)).toEqual(["real.txt"]);
  });

  it("stops at the end-of-archive blocks and tolerates a stray zero block", () => {
    expect([...readTar(new Uint8Array(BLOCK * 2))]).toEqual([]);
    expect([...readTar(new Uint8Array(10))]).toEqual([]);
  });
});

describe("normalizeTarPath", () => {
  it("drops a leading ./ and trailing slashes", () => {
    expect(normalizeTarPath("./agent/workspace/")).toBe("agent/workspace");
    expect(normalizeTarPath("./")).toBe("");
    expect(normalizeTarPath(".")).toBe("");
  });

  it("refuses an absolute path or one that climbs out", () => {
    for (const bad of ["/etc/passwd", "../../etc/passwd", "agent/../../x", "C:/Windows/system32"]) {
      expect(() => normalizeTarPath(bad)).toThrow(/escapes the payload/);
    }
  });

  it("refuses an escaping entry from inside an archive", () => {
    const tar = tarPack([{ path: "ok.txt", kind: "file", data: utf8.encode("o") }]);
    tar.set(utf8.encode("../../evil.sh"), 0);
    expect(() => [...readTar(tar)]).toThrow(/escapes the payload/);
  });
});
