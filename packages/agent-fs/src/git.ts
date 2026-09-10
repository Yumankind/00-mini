// Git over an AgentFs — thin on purpose.
//
// The agent's whole reason for using git is the one AGENTS.md states: "prefer small, reversible
// steps; for code, commit checkpoints". That needs init, add, commit, log, status and a list of what
// changed, and nothing else. So these six wrap isomorphic-git and normalise its two awkward
// surfaces — the status MATRIX, which is a triple per file that nobody reads correctly the first
// time, and the fact that every call wants `fs` and `dir` repeated — into the vocabulary the tools
// use.
//
// CLONE, PUSH AND PULL ARE ABSENT, and absent LOUDLY. Reaching a git host from a browser needs a
// CORS proxy (github.com sends no `Access-Control-Allow-Origin`), which is a server, an origin and
// a trust decision that HANDOFF-infinite-agent.md has not taken. A stub that returned an empty
// result, or one that quietly used somebody's public proxy, would both be worse than the named
// refusal below: a caller can catch `git_remote_not_available` and say the true sentence.

import * as isogit from "isomorphic-git";
import { AgentFsError } from "./errors.js";
import { gitFs, repoDir } from "./git-fs.js";
import type { AgentFs } from "./types.js";

export interface GitAuthor {
  name: string;
  email: string;
}

/** What a commit is attributed to when the caller says nothing. Local by construction: an agent's
 *  checkpoints are not somebody's identity, and a real one arrives with the person's git config. */
export const DEFAULT_AUTHOR: GitAuthor = { name: "00 agent", email: "agent@00.local" };

function ctx(fs: AgentFs, root: string) {
  return { fs: gitFs(fs) as never, dir: repoDir(root) };
}

/** `git init` at an agent-root-relative folder. Idempotent, as isomorphic-git's is. */
export async function gitInit(fs: AgentFs, root: string, opts: { defaultBranch?: string } = {}): Promise<void> {
  await isogit.init({ ...ctx(fs, root), defaultBranch: opts.defaultBranch ?? "main" });
}

/** `git add` — one path or many, repo-relative. `"."` stages everything, including deletions. */
export async function gitAdd(fs: AgentFs, root: string, paths: string | string[]): Promise<void> {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const filepath of list) {
    if (filepath === "." || filepath === "") {
      // isomorphic-git's add takes a glob-free path, so "everything" is the status matrix' own list
      // — and it has to include the DELETIONS, which `add` cannot express and `remove` can.
      for (const entry of await gitStatus(fs, root)) {
        if (entry.status === "deleted") await isogit.remove({ ...ctx(fs, root), filepath: entry.path });
        else if (entry.status !== "unmodified") await isogit.add({ ...ctx(fs, root), filepath: entry.path });
      }
      continue;
    }
    await isogit.add({ ...ctx(fs, root), filepath });
  }
}

export interface GitCommitOptions {
  message: string;
  author?: GitAuthor;
  /** Milliseconds since epoch; a test pins it so an oid is reproducible. */
  timestamp?: number;
}

/** `git commit`. Returns the new commit's oid. */
export async function gitCommit(fs: AgentFs, root: string, opts: GitCommitOptions): Promise<string> {
  const author = opts.author ?? DEFAULT_AUTHOR;
  return isogit.commit({
    ...ctx(fs, root),
    message: opts.message,
    author: {
      ...author,
      ...(opts.timestamp === undefined ? {} : { timestamp: Math.floor(opts.timestamp / 1000), timezoneOffset: 0 }),
    },
  });
}

export interface GitLogEntry {
  oid: string;
  message: string;
  author: GitAuthor;
  /** Seconds since epoch, as git stores it. */
  timestamp: number;
}

/** `git log`, newest first. An empty repository logs as an empty list, not as an error. */
export async function gitLog(fs: AgentFs, root: string, opts: { depth?: number; ref?: string } = {}): Promise<GitLogEntry[]> {
  try {
    const commits = await isogit.log({ ...ctx(fs, root), ...(opts.depth ? { depth: opts.depth } : {}), ...(opts.ref ? { ref: opts.ref } : {}) });
    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message,
      author: { name: c.commit.author.name, email: c.commit.author.email },
      timestamp: c.commit.author.timestamp,
    }));
  } catch (e) {
    // A repo with no commits has no HEAD to resolve — "nothing has happened yet" is a list, not a
    // failure, and every caller would otherwise write this same try/catch.
    if ((e as { code?: string }).code === "NotFoundError") return [];
    throw e;
  }
}

export type GitFileStatus = "unmodified" | "modified" | "added" | "deleted" | "untracked";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  /** Whether the change is in the index (`git add`ed) as well as in the working tree. */
  staged: boolean;
}

/**
 * `git status`, one row per file. isomorphic-git returns a matrix of `[head, workdir, stage]` where
 * 0/1/2 mean absent / same-as-HEAD / different; this is that table read once, here, so no caller has
 * to hold it in their head.
 */
export async function gitStatus(fs: AgentFs, root: string): Promise<GitStatusEntry[]> {
  const matrix = await isogit.statusMatrix(ctx(fs, root));
  const out: GitStatusEntry[] = [];
  for (const [path, head, workdir, stage] of matrix) {
    let status: GitFileStatus;
    if (head === 0 && workdir === 0) continue; // staged then deleted before commit — nothing to say
    if (head === 0) status = stage === 0 ? "untracked" : "added";
    else if (workdir === 0) status = "deleted";
    else if (workdir === 1 && stage === 1) status = "unmodified";
    else status = "modified";
    out.push({ path, status, staged: status !== "unmodified" && stage === workdir });
  }
  return out;
}

/**
 * The names that differ between two trees (`git diff --name-only`). `to` defaults to the working
 * tree, `from` to HEAD, which is the comparison an agent asks for after doing some work.
 */
export async function gitDiffNames(fs: AgentFs, root: string, opts: { from?: string; to?: string } = {}): Promise<string[]> {
  if (!opts.to) {
    const status = await gitStatus(fs, root);
    return status.filter((e) => e.status !== "unmodified").map((e) => e.path).sort();
  }
  const from = opts.from ?? "HEAD";
  const trees = [isogit.TREE({ ref: from }), isogit.TREE({ ref: opts.to })];
  const changed = await isogit.walk({
    ...ctx(fs, root),
    trees,
    map: async (filepath, entries) => {
      if (filepath === ".") return undefined;
      const [a, b] = entries ?? [];
      const oidA = a ? await a.oid() : undefined;
      const oidB = b ? await b.oid() : undefined;
      if (oidA === oidB) return undefined;
      const typeA = a ? await a.type() : undefined;
      const typeB = b ? await b.type() : undefined;
      if (typeA === "tree" || typeB === "tree") return undefined; // a directory differs whenever its files do
      return filepath;
    },
  });
  return (changed as string[]).sort();
}

// ── Remotes: named, typed, and not available here ────────────────────────────────────────────────

export class GitRemoteUnavailableError extends AgentFsError {
  constructor(operation: string) {
    super(
      "git_remote_not_available",
      `git ${operation} needs a CORS proxy to reach a remote from a browser, and this runtime has none configured`,
    );
    this.name = "GitRemoteUnavailableError";
  }
}

export function gitClone(): Promise<never> {
  return Promise.reject(new GitRemoteUnavailableError("clone"));
}

export function gitPush(): Promise<never> {
  return Promise.reject(new GitRemoteUnavailableError("push"));
}

export function gitPull(): Promise<never> {
  return Promise.reject(new GitRemoteUnavailableError("pull"));
}
