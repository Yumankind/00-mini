// Git in a browser tab, over an in-memory agent folder. isomorphic-git is doing the real work; what
// is under test is the fs shim it stands on (its error codes above all) and the six helpers that
// turn its status matrix into the vocabulary the tools use.

import { describe, expect, it } from "vitest";
import { MemoryFs } from "../src/memory-fs.js";
import { gitFs, repoDir, toRel } from "../src/git-fs.js";
import {
  DEFAULT_AUTHOR,
  GitRemoteUnavailableError,
  gitAdd,
  gitClone,
  gitCommit,
  gitDiffNames,
  gitInit,
  gitLog,
  gitPull,
  gitPush,
  gitStatus,
} from "../src/git.js";

const REPO = "workspace/projects/app";

async function repo(): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await gitInit(fs, REPO);
  return fs;
}

describe("git over an AgentFs", () => {
  it("inits, adds, commits, logs and reports status", async () => {
    const fs = await repo();
    expect((await fs.stat(`${REPO}/.git/HEAD`))?.kind).toBe("file");
    expect(await fs.readText(`${REPO}/.git/HEAD`)).toContain("refs/heads/main");
    expect(await gitLog(fs, REPO)).toEqual([]);

    await fs.writeFile(`${REPO}/README.md`, "# app\n");
    expect(await gitStatus(fs, REPO)).toEqual([{ path: "README.md", status: "untracked", staged: false }]);

    await gitAdd(fs, REPO, "README.md");
    expect(await gitStatus(fs, REPO)).toEqual([{ path: "README.md", status: "added", staged: true }]);

    const oid = await gitCommit(fs, REPO, { message: "first", timestamp: 1_757_500_000_000 });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitStatus(fs, REPO)).toEqual([{ path: "README.md", status: "unmodified", staged: false }]);

    const log = await gitLog(fs, REPO);
    expect(log).toHaveLength(1);
    expect(log[0]?.oid).toBe(oid);
    expect(log[0]?.message.trim()).toBe("first");
    expect(log[0]?.author).toEqual(DEFAULT_AUTHOR);
    expect(log[0]?.timestamp).toBe(1_757_500_000);
  });

  it("sees a modification, then a deletion", async () => {
    const fs = await repo();
    await fs.writeFile(`${REPO}/a.txt`, "one");
    await gitAdd(fs, REPO, "a.txt");
    await gitCommit(fs, REPO, { message: "a" });

    await fs.writeFile(`${REPO}/a.txt`, "two");
    expect(await gitStatus(fs, REPO)).toEqual([{ path: "a.txt", status: "modified", staged: false }]);
    expect(await gitDiffNames(fs, REPO)).toEqual(["a.txt"]);

    await fs.remove(`${REPO}/a.txt`);
    expect(await gitStatus(fs, REPO)).toEqual([{ path: "a.txt", status: "deleted", staged: false }]);
  });

  it('stages everything with "." — new files, edits and deletions alike', async () => {
    const fs = await repo();
    await fs.writeFile(`${REPO}/keep.txt`, "k");
    await fs.writeFile(`${REPO}/drop.txt`, "d");
    await gitAdd(fs, REPO, ".");
    const first = await gitCommit(fs, REPO, { message: "both" });

    await fs.writeFile(`${REPO}/keep.txt`, "k2");
    await fs.remove(`${REPO}/drop.txt`);
    await fs.writeFile(`${REPO}/new.txt`, "n");
    await gitAdd(fs, REPO, ".");
    const second = await gitCommit(fs, REPO, { message: "changed" });

    expect((await gitStatus(fs, REPO)).every((e) => e.status === "unmodified")).toBe(true);
    expect(await gitDiffNames(fs, REPO, { from: first, to: second })).toEqual(["drop.txt", "keep.txt", "new.txt"]);
    expect((await gitLog(fs, REPO)).map((c) => c.message.trim())).toEqual(["changed", "both"]);
    expect((await gitLog(fs, REPO, { depth: 1 })).map((c) => c.message.trim())).toEqual(["changed"]);
  });

  it("commits a nested tree and diffs it", async () => {
    const fs = await repo();
    await fs.writeFile(`${REPO}/src/deep/index.ts`, "export const a = 1;\n");
    await gitAdd(fs, REPO, ["src/deep/index.ts"]);
    const first = await gitCommit(fs, REPO, { message: "nested", author: { name: "Ada", email: "ada@example.com" } });
    await fs.writeFile(`${REPO}/src/deep/index.ts`, "export const a = 2;\n");
    await gitAdd(fs, REPO, "src/deep/index.ts");
    const second = await gitCommit(fs, REPO, { message: "changed" });
    expect(await gitDiffNames(fs, REPO, { from: first, to: second })).toEqual(["src/deep/index.ts"]);
    expect((await gitLog(fs, REPO, { ref: first }))[0]?.author).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("keeps two repositories in one agent folder apart", async () => {
    const fs = new MemoryFs();
    await gitInit(fs, "workspace/projects/one");
    await gitInit(fs, "workspace/projects/two");
    await fs.writeFile("workspace/projects/one/x.txt", "x");
    await fs.writeFile("workspace/projects/two/y.txt", "y");
    await gitAdd(fs, "workspace/projects/one", ".");
    await gitCommit(fs, "workspace/projects/one", { message: "one" });
    expect((await gitStatus(fs, "workspace/projects/two")).map((e) => e.path)).toEqual(["y.txt"]);
    expect(await gitLog(fs, "workspace/projects/two")).toEqual([]);
  });

  it("refuses clone, push and pull by name", async () => {
    for (const [op, call] of [
      ["clone", gitClone],
      ["push", gitPush],
      ["pull", gitPull],
    ] as const) {
      await expect(call()).rejects.toBeInstanceOf(GitRemoteUnavailableError);
      await expect(call()).rejects.toMatchObject({ code: "git_remote_not_available" });
      await expect(call()).rejects.toThrow(new RegExp(`git ${op} needs a CORS proxy`));
    }
  });
});

describe("the fs shim", () => {
  it("normalises the paths isomorphic-git passes and refuses one that climbs out", () => {
    expect(toRel("/workspace/projects/app/.git/config")).toBe("workspace/projects/app/.git/config");
    expect(toRel("workspace/./a//b")).toBe("workspace/a/b");
    expect(toRel("workspace/a/../b")).toBe("workspace/b");
    expect(toRel("/")).toBe("");
    expect(() => toRel("/../escape")).toThrow(/outside the agent/);
    expect(repoDir("workspace/projects/app")).toBe("/workspace/projects/app");
    expect(repoDir("")).toBe("/");
  });

  it("carries node's error codes, which is what isomorphic-git branches on", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("a.txt", "hello");
    const p = gitFs(fs).promises;
    await expect(p.readFile("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(p.readFile("/")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(p.readdir("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(p.readdir("/a.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(p.stat("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(p.mkdir("/a.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(p.readlink("/a.txt")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(p.symlink("/a.txt", "/b.txt")).rejects.toMatchObject({ code: "EPERM" });
  });

  it("reads text or bytes as asked, writes, unlinks and rmdirs", async () => {
    const fs = new MemoryFs();
    const p = gitFs(fs).promises;
    await p.writeFile("/dir/a.txt", "hello");
    expect(await p.readFile("/dir/a.txt", "utf8")).toBe("hello");
    expect(await p.readFile("/dir/a.txt", { encoding: "utf8" })).toBe("hello");
    expect(await p.readFile("/dir/a.txt")).toBeInstanceOf(Uint8Array);
    expect(await p.readdir("/dir")).toEqual(["a.txt"]);
    const stat = await p.stat("/dir/a.txt");
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.size).toBe(5);
    expect((await p.stat("/dir")).isDirectory()).toBe(true);
    expect((await p.stat("/")).isDirectory()).toBe(true);
    await p.chmod("/dir/a.txt", 0o644);
    await p.unlink("/dir/a.txt");
    expect(await fs.stat("dir/a.txt")).toBeNull();
    await p.mkdir("/dir/sub");
    await p.rmdir("/dir");
    expect(await fs.stat("dir")).toBeNull();
  });
});
