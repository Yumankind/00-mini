/**
 * One git, two consumers — the terminal's `git` and the Git panel.
 *
 * WHY A BRIDGE AND NOT TWO CALL SITES. `@00/agent-fs` exposes git twice on purpose: a TYPED layer
 * (`gitStatus` → rows, `gitBranches` → names) that a program wants, and `createGitOps` — prose, for
 * a model to read. The panel needs the first, the shell's `git` subcommand needs something in
 * between, and the diff (the one thing neither of them can compute) only exists on the prose side.
 * Binding all of it to one filesystem in one place means the day the package grows a `git stash`
 * there is one file to teach, and the day a build is AHEAD of the package the optional members are
 * absent here rather than a compile error in four components.
 *
 * `dir` is always agent-root-relative (`workspace/projects/site`) because that is what every
 * `@00/agent-fs` git call takes; the shell converts its own `/`-rooted display path before calling.
 */
import type { AgentFs, GitRemote } from "@00/agent-fs";
import {
  createGitOps,
  gitAdd,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiffNames,
  gitInit,
  gitLog,
  gitStatus,
  type GitStatusEntry,
} from "@00/agent-fs";
import type { ShellGit } from "./shell.js";

export interface RepoStatus {
  branch: string | null;
  branches: string[];
  entries: GitStatusEntry[];
}

export interface RepoCommit {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
}

/** Everything both surfaces ask of git, over one filesystem. */
export interface PowerGit extends ShellGit {
  /** Is there a `.git` here at all? The panel's whole first question. */
  isRepo(dir: string): Promise<boolean>;
  /** Branch, branches and the changed rows in one round trip, because the panel draws them together. */
  repoStatus(dir: string): Promise<RepoStatus>;
  unstage(dir: string, path: string): Promise<void>;
}

/**
 * `git reset <path>` has no wrapper in the package, and writing one here would mean reaching into
 * isomorphic-git from the app — the exact dependency the bridge exists to avoid. So unstaging is
 * refused by name, with the sentence that says what to do instead.
 */
export const UNSTAGE_UNAVAILABLE = "unstaging needs `git reset`, which this build has no wrapper for yet";

/**
 * WHY GIT CAN BE ABSENT IN A BROWSER THAT HAS EVERYTHING ELSE.
 *
 * isomorphic-git 1.41 is written against node's `Buffer` — 122 references in its browser build — and
 * a page has no such global. The fix is a shim in the app's bundle (`apps/infinite/vite.config.ts`
 * and one dependency), which belongs to whoever owns that file; hand-rolling a Buffer here would be a
 * hundred lines of byte handling under every git object this agent ever writes, and a subtly wrong
 * one corrupts a repository silently. So git DETECTS the gap and refuses by name, the way `git push`
 * already refuses — a person is told which machine can do it, and nothing half-works.
 */
export const GIT_UNAVAILABLE =
  "Git cannot start in this browser yet: the app bundle is missing the `Buffer` shim isomorphic-git needs. It works on your Mac.";

/** True when git can run here at all. The panel asks before it offers a button. */
export function gitUsable(): boolean {
  return typeof (globalThis as { Buffer?: unknown }).Buffer !== "undefined";
}

export interface PowerGitOptions {
  /**
   * §14's road out of the tab, asked FRESH on every remote call — the companion is a process someone
   * starts and stops in a terminal, and the panel and the shell hold this object for the life of the
   * tab. `null` (or no option at all) leaves clone/push/pull/fetch refusing by name.
   */
  remote?: () => GitRemote | null;
}

export function createPowerGit(fs: AgentFs, root = "workspace", options: PowerGitOptions = {}): PowerGit {
  const ops = createGitOps(fs, root);
  /** The ops for a call that leaves this computer: the road that exists now, or the refusing one. */
  const remoteOps = (): ReturnType<typeof createGitOps> => {
    const road = options.remote?.() ?? null;
    return road ? createGitOps(fs, root, { remote: road }) : ops;
  };
  const ready = (): void => {
    if (!gitUsable()) throw new Error(GIT_UNAVAILABLE);
  };

  return {
    async isRepo(dir) {
      ready();
      return Boolean(await fs.stat(`${dir}/.git`));
    },

    async init(dir) {
      ready();
      await gitInit(fs, dir);
    },

    async status(dir) {
      ready();
      return gitStatus(fs, dir);
    },

    async repoStatus(dir) {
      ready();
      const [{ current, branches }, entries] = await Promise.all([gitBranches(fs, dir), gitStatus(fs, dir)]);
      return { branch: current, branches, entries: entries.filter((e) => e.status !== "unmodified") };
    },

    async log(dir, depth) {
      ready();
      const commits = await gitLog(fs, dir, { depth });
      return commits.map((c) => ({ oid: c.oid, message: c.message, timestamp: c.timestamp, author: c.author.name }));
    },

    async add(dir, paths) {
      ready();
      await gitAdd(fs, dir, paths);
    },

    async commit(dir, message) {
      ready();
      return gitCommit(fs, dir, { message });
    },

    async diffNames(dir) {
      ready();
      return gitDiffNames(fs, dir);
    },

    async diff(dir, path, opts) {
      ready();
      return ops.gitDiff({ dir, ...(path ? { path } : {}), staged: opts?.staged === true });
    },

    async branches(dir) {
      ready();
      return gitBranches(fs, dir);
    },

    async checkout(dir, ref, opts) {
      ready();
      if (opts?.create) {
        await gitCreateBranch(fs, dir, ref, { checkout: true });
        return;
      }
      await gitCheckout(fs, dir, ref);
    },

    async clone(url, dir) {
      ready();
      return remoteOps().gitClone({ url, dir });
    },

    async push(dir, remote, branch) {
      ready();
      return remoteOps().gitPush({ dir, remote, branch });
    },

    async pull(dir, remote, branch) {
      ready();
      return remoteOps().gitPull({ dir, remote, branch });
    },

    async fetch(dir, remote, branch) {
      ready();
      return remoteOps().gitFetch({ dir, remote, branch });
    },

    async unstage() {
      throw new Error(UNSTAGE_UNAVAILABLE);
    },
  };
}
