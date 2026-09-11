// Git over an AgentFs — thin on purpose.
//
// The agent's whole reason for using git is the one AGENTS.md states: "prefer small, reversible
// steps; for code, commit checkpoints". That needs init, add, commit, log, status and a list of what
// changed, and nothing else. So these six wrap isomorphic-git and normalise its two awkward
// surfaces — the status MATRIX, which is a triple per file that nobody reads correctly the first
// time, and the fact that every call wants `fs` and `dir` repeated — into the vocabulary the tools
// use.
//
// CLONE, PUSH AND PULL NEED A ROAD OUT OF THE TAB, and when there is none they are absent LOUDLY.
// Reaching a git host from a browser needs a proxy (github.com sends no `Access-Control-Allow-Origin`),
// which is a server, an origin and a trust decision. §14 of docs/HANDOFF-infinite-agent.md took it:
// the proxy is the person's OWN 00 engine in companion mode, on this same computer, and the browser
// hands it to this package as a `GitRemote` — isomorphic-git's web http client behind whatever
// signing wrapper the host wants, plus the `corsProxy` base to send every smart-HTTP call through.
// WITHOUT one the four remote operations still refuse BY NAME (`git_remote_not_available`), because a
// stub that returned an empty result, or one that quietly used somebody's public proxy, is worse than
// a sentence a caller can repeat.
//
// The remote is INJECTED and never constructed here: this package must run in node (where the http
// client is a different module), in a Worker and in a tab, and it must not decide who signs.

import * as isogit from "isomorphic-git";
import type { AuthCallback, HttpClient } from "isomorphic-git";
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

// ── Remotes: injected, or named and refused ─────────────────────────────────────────────────────

/**
 * The road out of the tab, handed in by the host.
 *
 * `http` is isomorphic-git's own `HttpClient` shape (`request({url, method, headers, body})`), so the
 * web client, the node client and a signing wrapper around either all fit. `corsProxy` is the base
 * every smart-HTTP call is rewritten onto — isomorphic-git spells that `<corsProxy>/<host>/<path>` —
 * and for §14 it is `<engine base>/api/companion/git`.
 *
 * `headers` ride on every request (a static credential, a device id); `onAuth` is git's own
 * username/password callback, for a host that asks the person. Neither is filled in this package.
 */
export interface GitRemote {
  http: HttpClient;
  corsProxy: string;
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
}

export class GitRemoteUnavailableError extends AgentFsError {
  constructor(operation: string) {
    super(
      "git_remote_not_available",
      `git ${operation} needs this computer's companion (Connections → This computer) — nothing was sent`,
    );
    this.name = "GitRemoteUnavailableError";
  }
}

/** What every remote call carries: the road, and git's own two names for "where". */
export interface GitRemoteOptions {
  /** Absent = the refusal above. It is never defaulted, and never guessed from the repository. */
  remote?: GitRemote;
  /** The REMOTE'S NAME (`origin`), not the road. */
  remoteName?: string;
  /** The branch to push or pull. Absent = whatever HEAD is on. */
  branch?: string;
  /** A URL, when the repository has no remote configured yet. */
  url?: string;
}

export interface GitCloneOptions extends GitRemoteOptions {
  url: string;
  /** The branch to clone. Absent = the remote's default. */
  ref?: string;
  /** A shallow clone's depth. Absent = the whole history of that one branch. */
  depth?: number;
}

/**
 * A `GitRemote` as isomorphic-git's four transport fields.
 *
 * `undefined` is passed THROUGH rather than conditionally omitted: every one of these is a
 * destructuring default in isomorphic-git (`headers = {}`, `remote = 'origin'`), so an absent field
 * and an absent key mean the same thing to it — and a spread per optional argument would be a branch
 * per argument in a file whose interesting behaviour is none of them.
 */
function wire(remote: GitRemote) {
  return { http: remote.http, corsProxy: remote.corsProxy, headers: remote.headers, onAuth: remote.onAuth };
}

function road(remote: GitRemote | undefined, operation: string): GitRemote {
  if (!remote) throw new GitRemoteUnavailableError(operation);
  return remote;
}

/**
 * `git clone <url> <root>`. `root` is the agent-root-relative folder the working tree lands in.
 *
 * SINGLE BRANCH, ALWAYS. A browser tab pays for every object it downloads in OPFS quota and in wall
 * clock on someone's home connection, and an agent that was asked to work on a repository wants the
 * branch it was pointed at, not eleven years of release branches. `ref` chooses which one.
 */
export async function gitClone(fs: AgentFs, root: string, opts: GitCloneOptions): Promise<void> {
  const remote = road(opts.remote, "clone");
  await isogit.clone({
    ...ctx(fs, root),
    ...wire(remote),
    url: opts.url,
    ref: opts.ref,
    depth: opts.depth,
    remote: opts.remoteName,
    singleBranch: true,
  });
}

/** `git fetch`. Returns what isomorphic-git reports, which names the fetched head. */
export async function gitFetch(fs: AgentFs, root: string, opts: GitRemoteOptions = {}): Promise<isogit.FetchResult> {
  const remote = road(opts.remote, "fetch");
  return isogit.fetch({
    ...ctx(fs, root),
    ...wire(remote),
    url: opts.url,
    remote: opts.remoteName,
    ref: opts.branch,
    singleBranch: true,
  });
}

/** `git push`. The result carries `ok`/`error` per ref, which the caller turns into a sentence. */
export async function gitPush(fs: AgentFs, root: string, opts: GitRemoteOptions = {}): Promise<isogit.PushResult> {
  const remote = road(opts.remote, "push");
  return isogit.push({
    ...ctx(fs, root),
    ...wire(remote),
    url: opts.url,
    remote: opts.remoteName,
    ref: opts.branch,
  });
}

export interface GitPullOptions extends GitRemoteOptions {
  /** A merge writes a commit, and a commit needs a name. Defaults to `DEFAULT_AUTHOR`. */
  author?: GitAuthor;
}

/**
 * `git pull --ff-only`.
 *
 * FAST-FORWARD ONLY, ALWAYS, for the same reason `git checkout --force` is the one high-risk tier in
 * this package: a merge that conflicts leaves a working tree full of markers, and the surface that
 * would have to resolve them is a chat box. A pull that cannot fast-forward fails with git's own
 * words, and the person is told to do it on a machine with a git in it.
 */
export async function gitPull(fs: AgentFs, root: string, opts: GitPullOptions = {}): Promise<void> {
  const remote = road(opts.remote, "pull");
  await isogit.pull({
    ...ctx(fs, root),
    ...wire(remote),
    url: opts.url,
    remote: opts.remoteName,
    ref: opts.branch,
    author: opts.author ?? DEFAULT_AUTHOR,
    fastForward: true,
    singleBranch: true,
  });
}

/** The remotes a repository knows, as `git remote -v` would list them. */
export async function gitRemotes(fs: AgentFs, root: string): Promise<{ remote: string; url: string }[]> {
  return isogit.listRemotes(ctx(fs, root));
}

// ── Branches ────────────────────────────────────────────────────────────────────────────────────
//
// Added 2026-09-10 with the git tools (gap B8). They are here rather than in git-ops.ts for the
// reason the header gives: this file is the vocabulary over isomorphic-git, and a branch is a
// primitive, not a policy. The policy — which of these an agent may call, and at what tier — is the
// runtime's.

/** Local branch names, plus which one HEAD is on (`null` in a repo with no commits yet). */
export async function gitBranches(fs: AgentFs, root: string): Promise<{ current: string | null; branches: string[] }> {
  const branches = await isogit.listBranches(ctx(fs, root));
  const current = (await isogit.currentBranch({ ...ctx(fs, root), fullname: false })) ?? null;
  return { current, branches: [...branches].sort() };
}

/** `git branch <name>` — and, when `checkout` is set, `git switch -c <name>`. */
export async function gitCreateBranch(
  fs: AgentFs,
  root: string,
  name: string,
  opts: { checkout?: boolean } = {},
): Promise<void> {
  await isogit.branch({ ...ctx(fs, root), ref: name, checkout: opts.checkout === true });
}

/**
 * `git checkout <ref>`.
 *
 * `force` is passed through UNCHANGED and is exactly as dangerous as it is in git: isomorphic-git
 * overwrites files that differ from the target, so uncommitted work in the working tree is gone.
 * That is why the tool above it is the one place this package's callers meet a `high-risk` tier.
 */
export async function gitCheckout(
  fs: AgentFs,
  root: string,
  ref: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  await isogit.checkout({ ...ctx(fs, root), ref, force: opts.force === true });
}

/** The bytes of `filepath` as HEAD has them; `null` when HEAD has no such file (or no HEAD at all). */
export async function gitReadHeadFile(fs: AgentFs, root: string, filepath: string): Promise<Uint8Array | null> {
  try {
    const oid = await isogit.resolveRef({ ...ctx(fs, root), ref: "HEAD" });
    const { blob } = await isogit.readBlob({ ...ctx(fs, root), oid, filepath });
    return blob;
  } catch {
    // A missing file, a missing HEAD and a path that is a directory in HEAD are all "HEAD does not
    // have this file as a blob", which is the one answer a diff needs.
    return null;
  }
}

/** The bytes of `filepath` as the INDEX has them (`git add`ed), or `null` when it is not staged. */
export async function gitReadStagedFile(fs: AgentFs, root: string, filepath: string): Promise<Uint8Array | null> {
  const found = await isogit.walk({
    ...ctx(fs, root),
    trees: [isogit.STAGE()],
    map: async (path, entries) => {
      if (path !== filepath) return undefined;
      const entry = entries?.[0];
      if (!entry || (await entry.type()) !== "blob") return undefined;
      return entry.oid();
    },
  });
  const oid = (found as string[])[0];
  if (!oid) return null;
  const { blob } = await isogit.readBlob({ ...ctx(fs, root), oid });
  return blob;
}
