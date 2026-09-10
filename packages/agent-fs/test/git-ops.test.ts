// The prose layer over git, and the diff that has no dependency behind it.
//
// The patches below are written BY HAND, not captured from the implementation: a diff whose expected
// value is whatever the code printed last week tests nothing. Every one of them is what `git diff`
// prints for the same two files — hunk header, three lines of context, `\ No newline at end of file`
// where a file does not end in one.

import { describe, expect, it } from "vitest";
import { MemoryFs } from "../src/memory-fs.js";
import { createGitOps, unifiedDiff } from "../src/git-ops.js";
import { gitAdd, gitBranches, gitCommit, gitInit } from "../src/git.js";
import { AgentFsError } from "../src/errors.js";

const REPO = "workspace/projects/app";

async function repo(): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await gitInit(fs, REPO);
  return fs;
}

async function commit(fs: MemoryFs, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, body] of Object.entries(files)) await fs.writeFile(`${REPO}/${path}`, body);
  await gitAdd(fs, REPO, ".");
  await gitCommit(fs, REPO, { message, timestamp: 1_757_500_000_000 });
}

describe("unifiedDiff", () => {
  it("prints one hunk with three lines of context, exactly as git does", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\ntwo\nCHANGED\nfour\nfive\n";
    expect(unifiedDiff("notes.txt", before, after)).toBe(
      [
        "diff --git a/notes.txt b/notes.txt",
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -1,5 +1,5 @@",
        " one",
        " two",
        "-three",
        "+CHANGED",
        " four",
        " five",
      ].join("\n"),
    );
  });

  it("leaves untouched lines outside the context window out of the patch", () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 8", "line eight");
    expect(unifiedDiff("long.txt", before, after)).toBe(
      [
        "diff --git a/long.txt b/long.txt",
        "--- a/long.txt",
        "+++ b/long.txt",
        "@@ -5,7 +5,7 @@",
        " line 5",
        " line 6",
        " line 7",
        "-line 8",
        "+line eight",
        " line 9",
        " line 10",
        " line 11",
      ].join("\n"),
    );
  });

  it("merges two nearby changes into ONE hunk and keeps two distant ones apart", () => {
    const before = Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const after = before.replace("l2\n", "L2\n").replace("l4\n", "L4\n").replace("l20\n", "L20\n");
    const patch = unifiedDiff("x.txt", before, after);
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
    expect(patch).toContain("@@ -1,7 +1,7 @@");
    expect(patch).toContain("@@ -17,7 +17,7 @@");
  });

  it("says when a side does not end in a newline", () => {
    expect(unifiedDiff("a.txt", "hello\n", "hello")).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-hello",
        "+hello",
        "\\ No newline at end of file",
      ].join("\n"),
    );
  });

  it("renders a new file against /dev/null with a zero-length old side", () => {
    expect(unifiedDiff("new.txt", "", "hi\nthere\n", { from: "/dev/null" })).toBe(
      [
        "diff --git a/new.txt b/new.txt",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+hi",
        "+there",
      ].join("\n"),
    );
  });

  it("renders a deletion the same way round", () => {
    expect(unifiedDiff("gone.txt", "bye\n", "", { to: "/dev/null" })).toBe(
      ["diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n"),
    );
  });

  it("is empty for two identical files — a caller joining patches gets no blank stanzas", () => {
    expect(unifiedDiff("same.txt", "a\n", "a\n")).toBe("");
  });

  it("degrades to whole-file replacement rather than allocating an enormous table", () => {
    // Past the cell bound the patch is still TRUE (everything went, everything came); it just stops
    // being minimal. The common head and tail are trimmed first, so this needs two big DIFFERENT files.
    const before = Array.from({ length: 1400 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 1400 }, (_, i) => `b${i}`).join("\n");
    const patch = unifiedDiff("big.txt", before, after);
    expect(patch.split("\n").filter((l) => l.startsWith("-a"))).toHaveLength(1400);
    expect(patch.split("\n").filter((l) => l.startsWith("+b"))).toHaveLength(1400);
  });
});

describe("createGitOps", () => {
  it("answers status, add, commit and log in the sentences git itself prints", async () => {
    const fs = await repo();
    const ops = createGitOps(fs);

    expect(await ops.gitStatus({ dir: REPO })).toContain("nothing to commit, working tree clean");
    expect(await ops.gitLog({ dir: REPO })).toBe("No commits yet.");

    await fs.writeFile(`${REPO}/README.md`, "# app\n");
    expect(await ops.gitStatus({ dir: REPO })).toContain("untracked: README.md");
    expect(await ops.gitCommit({ dir: REPO, message: "too early" })).toContain("Nothing is staged");

    expect(await ops.gitAdd({ dir: REPO, paths: ["README.md"] })).toBe("Staged 1 file: README.md");
    const committed = await ops.gitCommit({ dir: REPO, message: "first\nbody" });
    expect(committed).toMatch(/^\[main [0-9a-f]{7}\] first\n 1 file committed$/);
    expect(await ops.gitLog({ dir: REPO })).toMatch(/^[0-9a-f]{7} {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}first {2}\(00 agent\)$/);
  });

  it("diffs the WORKING TREE against HEAD, and `staged` against the index", async () => {
    const fs = await repo();
    const ops = createGitOps(fs);
    await commit(fs, { "a.txt": "one\ntwo\n" }, "base");

    await fs.writeFile(`${REPO}/a.txt`, "one\nTWO\n");
    const unstaged = await ops.gitDiff({ dir: REPO });
    expect(unstaged).toContain("diff --git a/a.txt b/a.txt");
    expect(unstaged).toContain("-two");
    expect(unstaged).toContain("+TWO");
    // Nothing is staged yet, so the staged view is empty while the working view is not — the whole
    // reason the default is working-tree-vs-HEAD.
    expect(await ops.gitDiff({ dir: REPO, staged: true })).toBe("Nothing is staged.");

    await ops.gitAdd({ dir: REPO, paths: ["a.txt"] });
    expect(await ops.gitDiff({ dir: REPO, staged: true })).toContain("+TWO");
  });

  it("diffs a new file, a deleted file and narrows to one path", async () => {
    const fs = await repo();
    const ops = createGitOps(fs);
    await commit(fs, { "keep.txt": "kept\n", "gone.txt": "bye\n" }, "base");

    await fs.writeFile(`${REPO}/fresh.txt`, "new file\n");
    await fs.remove(`${REPO}/gone.txt`);

    const all = await ops.gitDiff({ dir: REPO });
    expect(all).toContain("--- /dev/null");
    expect(all).toContain("+++ /dev/null");

    const one = await ops.gitDiff({ dir: REPO, path: "fresh.txt" });
    expect(one).toContain("fresh.txt");
    expect(one).not.toContain("gone.txt");
    expect(await ops.gitDiff({ dir: REPO, path: "keep.txt" })).toBe("No changes.");
  });

  it("names a binary file instead of printing it", async () => {
    const fs = await repo();
    const ops = createGitOps(fs);
    await commit(fs, { "logo.png": "old-header\n" }, "base");
    await fs.writeFile(`${REPO}/logo.png`, new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect(await ops.gitDiff({ dir: REPO })).toBe("diff --git a/logo.png b/logo.png\nBinary files differ");
  });

  it("lists, creates and switches branches", async () => {
    const fs = await repo();
    const ops = createGitOps(fs);
    expect(await ops.gitBranch({ dir: REPO })).toBe("No branches yet — nothing has been committed.");
    await commit(fs, { "a.txt": "one\n" }, "base");

    expect(await ops.gitBranch({ dir: REPO })).toBe("* main");
    expect(await ops.gitBranch({ dir: REPO, create: "feature" })).toBe("Created branch feature.");
    expect(await ops.gitBranch({ dir: REPO })).toBe("  feature\n* main");

    expect(await ops.gitCheckout({ dir: REPO, ref: "feature" })).toBe("Switched to feature.");
    expect((await gitBranches(fs, REPO)).current).toBe("feature");
    expect(await ops.gitBranch({ dir: REPO, create: "third", checkout: true })).toContain("switched to it");
    expect((await gitBranches(fs, REPO)).current).toBe("third");
  });

  it("says out loud when a forced checkout overwrote the working tree", async () => {
    const fs = await repo();
    const ops = createGitOps(fs);
    await commit(fs, { "a.txt": "one\n" }, "base");
    await ops.gitBranch({ dir: REPO, create: "feature" });
    await fs.writeFile(`${REPO}/a.txt`, "uncommitted work\n");

    const said = await ops.gitCheckout({ dir: REPO, ref: "feature", force: true });
    expect(said).toContain("Uncommitted changes in the working tree were overwritten.");
    expect(await fs.readText(`${REPO}/a.txt`)).toBe("one\n");
  });

  it("refuses a repository outside the workspace, by name", async () => {
    const fs = await repo();
    const ops = createGitOps(fs, "workspace");
    await expect(ops.gitStatus({ dir: "sessions" })).rejects.toMatchObject({ code: "git_outside_workspace" });
    await expect(ops.gitStatus({ dir: "workspace-other/app" })).rejects.toBeInstanceOf(AgentFsError);
  });

  it("still refuses clone, push and pull by name, with the CORS-proxy reason", async () => {
    const ops = createGitOps(new MemoryFs());
    for (const call of [ops.gitClone(), ops.gitPush(), ops.gitPull()]) {
      await expect(call).rejects.toMatchObject({ code: "git_remote_not_available" });
    }
    await expect(ops.gitPush()).rejects.toThrow(/CORS proxy/);
  });
});
