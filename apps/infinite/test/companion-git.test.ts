// GIT THAT FOLLOWS THE COMPANION — the swap of §14.4, and the shell subcommands on top of it.
//
// The agent's tool table is built ONCE, out of one ops object, and the companion is a process a
// person starts in a terminal minutes later. So what has to be true is: the same object, asked
// twice, takes two different roads — and everything that does NOT leave the computer keeps working
// while there is no road at all.

import { describe, expect, it } from "vitest";
import { MemoryFs, createGitOps, type AgentGitOps, type GitRemote } from "@00/agent-fs";
import { companionGitOps, delegatingGitOps } from "../src/companion/git.js";
import { BuiltinShell, GIT_REMOTE_LINE, defaultCloneDir } from "../src/power/shell.js";
import { createPowerGit } from "../src/power/git-bridge.js";
import { cloneFolder } from "../src/state/git.js";

/** An ops object that records which road it was built for. */
function spy(built: (string | null)[]): (remote: GitRemote | undefined) => AgentGitOps {
  return (remote) => {
    built.push(remote ? remote.corsProxy : null);
    const answer = async (): Promise<string> => (remote ? `via ${remote.corsProxy}` : "refused");
    return {
      gitStatus: answer,
      gitLog: answer,
      gitDiff: answer,
      gitAdd: answer,
      gitCommit: answer,
      gitBranch: answer,
      gitCheckout: answer,
      gitClone: answer,
      gitPush: answer,
      gitPull: answer,
      gitFetch: answer,
    } as unknown as AgentGitOps;
  };
}

const road: GitRemote = {
  http: { request: async () => ({ url: "", method: "GET", statusCode: 200, statusMessage: "", body: [], headers: {} }) } as never,
  corsProxy: "http://127.0.0.1:4600/api/companion/git",
};

describe("the delegating ops", () => {
  it("builds the local half once, and a road per remote call", async () => {
    const built: (string | null)[] = [];
    let remote: GitRemote | null = null;
    const ops = delegatingGitOps({ remote: () => remote, build: spy(built) });
    expect(built).toEqual([null]);

    // Local work never rebuilds anything and never asks about a companion.
    await ops.gitStatus({ dir: "workspace/projects/a" });
    await ops.gitCommit({ dir: "workspace/projects/a", message: "x" });
    expect(built).toEqual([null]);

    // With no road, a remote call lands on the local ops — whose refusal is the package's own.
    expect(await ops.gitPush({ dir: "workspace/projects/a" })).toBe("refused");

    remote = road;
    expect(await ops.gitPush({ dir: "workspace/projects/a" })).toBe(`via ${road.corsProxy}`);
    expect(await ops.gitClone({ url: "u", dir: "d" })).toBe(`via ${road.corsProxy}`);
    expect(await ops.gitPull({ dir: "d" })).toBe(`via ${road.corsProxy}`);
    expect(await ops.gitFetch({ dir: "d" })).toBe(`via ${road.corsProxy}`);
    expect(built.filter(Boolean)).toHaveLength(4);
  });

  it("over the real package, refuses by name with the companion sentence and no road", async () => {
    const fs = new MemoryFs();
    const ops = companionGitOps(createGitOps, fs, "workspace", () => null);
    await expect(ops.gitPush({ dir: "workspace/projects/a" })).rejects.toMatchObject({
      code: "git_remote_not_available",
    });
    await expect(ops.gitPush({ dir: "workspace/projects/a" })).rejects.toThrow(/This computer/);
    // And the local half is the real one: a status on a folder that is not a repo still fails as
    // git, not as "no companion".
    await expect(ops.gitStatus({ dir: "workspace/projects/a" })).rejects.not.toMatchObject({
      code: "git_remote_not_available",
    });
  });
});

describe("the shell's four remote subcommands", () => {
  async function shellWith(git: Record<string, unknown> | null) {
    const fs = new MemoryFs();
    await fs.writeFile("workspace/keep.txt", "x");
    return new BuiltinShell(fs, { git: git as never });
  }

  it("refuses with the companion sentence when the backend has no road", async () => {
    const shell = await shellWith({
      init: async () => undefined,
      status: async () => [],
      log: async () => [],
      add: async () => undefined,
      commit: async () => "0123456",
      diffNames: async () => [],
    });
    for (const command of ["git clone https://github.com/o/r.git", "git push", "git pull", "git fetch"]) {
      const result = await shell.exec(command, { cwd: "workspace" });
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain(GIT_REMOTE_LINE);
    }
    expect(GIT_REMOTE_LINE).toContain("Connections → This computer");
  });

  it("runs them through the backend when it has one, and prints what git said", async () => {
    const calls: string[] = [];
    const shell = await shellWith({
      init: async () => undefined,
      status: async () => [],
      log: async () => [],
      add: async () => undefined,
      commit: async () => "0123456",
      diffNames: async () => [],
      clone: async (url: string, dir: string) => {
        calls.push(`clone ${url} ${dir}`);
        return `Cloned ${url} into ${dir}.`;
      },
      push: async (dir: string, remote?: string, branch?: string) => {
        calls.push(`push ${dir} ${remote ?? "-"} ${branch ?? "-"}`);
        return "Pushed main to origin.";
      },
      pull: async () => "Pulled origin into main.",
      fetch: async () => "Fetched origin; nothing new.",
    });

    expect((await shell.exec("git clone https://github.com/o/r.git", { cwd: "workspace" })).stdout).toContain(
      "Cloned https://github.com/o/r.git into workspace/r.",
    );
    expect((await shell.exec("git push origin main", { cwd: "workspace" })).stdout).toContain("Pushed main to origin.");
    expect(calls).toEqual(["clone https://github.com/o/r.git workspace/r", "push workspace origin main"]);
    expect((await shell.exec("git pull", { cwd: "workspace" })).stdout).toContain("Pulled origin into main.");
    expect((await shell.exec("git fetch", { cwd: "workspace" })).stdout).toContain("nothing new");
  });

  it("asks which repository when `git clone` names none", async () => {
    const shell = await shellWith({
      init: async () => undefined,
      status: async () => [],
      log: async () => [],
      add: async () => undefined,
      commit: async () => "x",
      diffNames: async () => [],
      clone: async () => "never",
    });
    expect((await shell.exec("git clone", { cwd: "workspace" })).stderr).toContain("which repository");
  });

  it("`git remote` is still refused — a browser has no remotes to configure", async () => {
    const shell = await shellWith(null);
    const result = await shell.exec("git remote -v", { cwd: "workspace" });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain(GIT_REMOTE_LINE);
  });
});

describe("where a clone lands", () => {
  it("takes git's own rule for the folder name, in both places that need it", () => {
    for (const name of [defaultCloneDir, cloneFolder]) {
      expect(name("https://github.com/owner/project.git")).toBe("project");
      expect(name("https://github.com/owner/project")).toBe("project");
      expect(name("https://github.com/owner/project/")).toBe("project");
      expect(name("/")).toBe("repo");
    }
  });
});

describe("the panel's git", () => {
  it("carries the four remote methods, and they refuse with no road", async () => {
    const git = createPowerGit(new MemoryFs(), "workspace", { remote: () => null });
    expect(typeof git.clone).toBe("function");
    expect(typeof git.push).toBe("function");
    await expect(git.push!("workspace/projects/a")).rejects.toMatchObject({ code: "git_remote_not_available" });
  });
});
