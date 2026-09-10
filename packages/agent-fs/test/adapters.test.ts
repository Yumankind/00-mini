// One contract, two adapters: everything in here runs against MemoryFs AND a real directory, because
// the whole point of AgentFs is that the layers above cannot tell which one they are standing on.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFs } from "../src/memory-fs.js";
import { NodeDirFs } from "../src/node-dir-fs.js";
import { assertRelativePath, type AgentFs } from "../src/types.js";
import { ancestors, splitPath, walkFs } from "../src/walk.js";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-fs-"));
  roots.push(dir);
  return dir;
}

const makers: [string, () => Promise<AgentFs>][] = [
  ["MemoryFs", async () => new MemoryFs()],
  ["NodeDirFs", async () => new NodeDirFs(await tempRoot())],
];

describe.each(makers)("%s", (_name, make) => {
  it("writes, reads and stats a file, creating parents on the way", async () => {
    const fs = await make();
    await fs.writeFile("workspace/memory/2026-09-10.md", "hello");
    expect(await fs.readText("workspace/memory/2026-09-10.md")).toBe("hello");
    const st = await fs.stat("workspace/memory/2026-09-10.md");
    expect(st?.kind).toBe("file");
    expect(st?.size).toBe(5);
    expect((await fs.stat("workspace/memory"))?.kind).toBe("dir");
  });

  it("returns null from stat for what is not there", async () => {
    const fs = await make();
    expect(await fs.stat("nope.txt")).toBeNull();
  });

  it("round-trips bytes without sharing the buffer", async () => {
    const fs = await make();
    const data = new Uint8Array([0, 1, 2, 250]);
    await fs.writeFile("files/blob.bin", data);
    const back = await fs.readFile("files/blob.bin");
    expect([...back]).toEqual([0, 1, 2, 250]);
    back[0] = 99;
    expect([...(await fs.readFile("files/blob.bin"))]).toEqual([0, 1, 2, 250]);
  });

  it("keeps an empty directory", async () => {
    const fs = await make();
    await fs.mkdir("workspace/projects");
    const entries = await fs.readdir("workspace");
    expect(entries.map((e) => e.name)).toEqual(["projects"]);
    expect(entries[0]?.kind).toBe("dir");
  });

  it("mkdir on an existing directory is not an error", async () => {
    const fs = await make();
    await fs.mkdir("a/b");
    await fs.mkdir("a/b");
    expect((await fs.stat("a/b"))?.kind).toBe("dir");
  });

  it("removes files and whole trees, and a missing path is not an error", async () => {
    const fs = await make();
    await fs.writeFile("a/b/c.txt", "x");
    await fs.writeFile("a/b/d.txt", "y");
    await fs.remove("a/b/c.txt");
    expect(await fs.stat("a/b/c.txt")).toBeNull();
    await fs.remove("a");
    expect(await fs.stat("a")).toBeNull();
    await expect(fs.remove("a")).resolves.toBeUndefined();
  });

  it("renames a file and a directory", async () => {
    const fs = await make();
    await fs.writeFile("a/one.txt", "1");
    await fs.rename("a/one.txt", "b/two.txt");
    expect(await fs.readText("b/two.txt")).toBe("1");
    expect(await fs.stat("a/one.txt")).toBeNull();
    await fs.writeFile("src/deep/x.txt", "d");
    await fs.rename("src", "dst");
    expect(await fs.readText("dst/deep/x.txt")).toBe("d");
    expect(await fs.stat("src")).toBeNull();
  });

  it("walks every file, sorted, dotfiles included", async () => {
    const fs = await make();
    await fs.writeFile("workspace/AGENTS.md", "a");
    await fs.writeFile("workspace/.00ignore", "*.log");
    await fs.writeFile("workspace/memory/b.md", "b");
    await fs.writeFile("profile.json", "{}");
    const seen: string[] = [];
    for await (const e of fs.walk("")) seen.push(e.path);
    expect(seen).toEqual(["profile.json", "workspace/.00ignore", "workspace/AGENTS.md", "workspace/memory/b.md"]);
  });

  it("walks a subtree and honours maxEntries", async () => {
    const fs = await make();
    for (const n of ["a", "b", "c", "d"]) await fs.writeFile(`workspace/files/${n}.txt`, n);
    const all: string[] = [];
    for await (const e of fs.walk("workspace/files")) all.push(e.path);
    expect(all).toHaveLength(4);
    const capped: string[] = [];
    for await (const e of fs.walk("workspace/files", { maxEntries: 2 })) capped.push(e.path);
    expect(capped).toEqual(["workspace/files/a.txt", "workspace/files/b.txt"]);
  });

  it("refuses absolute paths and .. in every method that takes one", async () => {
    const fs = await make();
    await expect(fs.writeFile("/etc/passwd", "x")).rejects.toThrow(/invalid path/);
    await expect(fs.readFile("../outside.txt")).rejects.toThrow(/invalid path/);
    await expect(fs.stat("a/../../b")).rejects.toThrow(/invalid path/);
    await expect(fs.remove("..")).rejects.toThrow(/invalid path/);
    await expect(fs.rename("ok.txt", "../out.txt")).rejects.toThrow(/invalid path/);
  });

  it("throws ENOENT reading what is not there", async () => {
    const fs = await make();
    await expect(fs.readFile("gone.txt")).rejects.toThrow();
  });
});

describe("assertRelativePath", () => {
  it("normalises away single dots", () => {
    expect(assertRelativePath("a/./b")).toBe("a/b");
  });
  it("refuses the empty string, NULs, leading slashes and ..", () => {
    for (const bad of ["", "/a", "a\0b", "../a", "a//b"]) expect(() => assertRelativePath(bad)).toThrow();
  });
});

describe("walk helpers", () => {
  it("splits a path and lists its ancestors", () => {
    expect(splitPath("a/b/c.txt")).toEqual(["a/b", "c.txt"]);
    expect(splitPath("c.txt")).toEqual(["", "c.txt"]);
    expect(ancestors("a/b/c.txt")).toEqual(["a", "a/b"]);
    expect(ancestors("c.txt")).toEqual([]);
  });

  it("yields nothing for a non-positive cap or a missing directory", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("a.txt", "a");
    const none: string[] = [];
    for await (const e of walkFs(fs, "", { maxEntries: 0 })) none.push(e.path);
    expect(none).toEqual([]);
    const missing: string[] = [];
    for await (const e of walkFs(fs, "nowhere")) missing.push(e.path);
    expect(missing).toEqual([]);
  });
});

describe("MemoryFs extras", () => {
  it("reports a snapshot and its directories", async () => {
    const fs = new MemoryFs();
    fs.now = () => 1_700_000_000_000;
    await fs.writeFile("b.txt", "bb");
    await fs.writeFile("a/c.txt", "c");
    expect(fs.snapshot()).toEqual([
      { path: "a/c.txt", size: 1 },
      { path: "b.txt", size: 2 },
    ]);
    expect(fs.dirList()).toEqual(["a"]);
    expect((await fs.stat("b.txt"))?.mtime).toBe(1_700_000_000_000);
  });

  it("refuses to treat a file as a directory", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("a.txt", "a");
    await expect(fs.writeFile("a.txt/b", "b")).rejects.toThrow(/ENOTDIR/);
    await expect(fs.readdir("a.txt")).rejects.toThrow(/ENOTDIR/);
    await expect(fs.mkdir("a.txt")).rejects.toThrow(/ENOTDIR/);
    await expect(fs.readdir("nope")).rejects.toThrow(/ENOENT/);
    await expect(fs.rename("nope", "other")).rejects.toThrow(/ENOENT/);
  });

  it("renaming onto itself is a no-op", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("a.txt", "a");
    await fs.rename("a.txt", "a.txt");
    expect(await fs.readText("a.txt")).toBe("a");
  });
});

describe("NodeDirFs", () => {
  it("skips symlinks when listing, the way the bundle does", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(join(root, "workspace", "real.txt"), "r");
    await symlink(join(root, "workspace", "real.txt"), join(root, "workspace", "link.txt"));
    const fs = new NodeDirFs(root);
    expect((await fs.readdir("workspace")).map((e) => e.name)).toEqual(["real.txt"]);
  });

  it("maps a relative path onto its root, and the root onto itself", async () => {
    const fs = new NodeDirFs("/tmp/agent/");
    expect(fs.abs("workspace/a.md")).toBe("/tmp/agent/workspace/a.md");
    expect(fs.abs("")).toBe("/tmp/agent");
  });
});
