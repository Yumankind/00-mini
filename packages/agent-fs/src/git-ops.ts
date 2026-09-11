/**
 * THE GIT THE AGENT ACTUALLY MEETS — one object of string-answering methods.
 *
 * `git.ts` is the vocabulary over isomorphic-git: typed, structured, useful to a program. A MODEL is
 * not a program. It reads `git status` the way a person does, so the thing the runtime's git tools
 * are wired to is not the typed layer but this one — the same six-or-eight commands, each answering
 * with the sentences git itself would have printed. The shape is the runtime's `GitOps` interface
 * (packages/agent-runtime/src/tools-git.ts) and it is written out here rather than imported,
 * because @00/agent-fs must not depend on the runtime: the runtime is the loop, this is the
 * plumbing, and the arrow between them points one way. Structural typing makes the two meet.
 *
 * THE DIFF IS COMPUTED HERE, WITH NO DEPENDENCY. isomorphic-git ships no diff (issue #1006 is still
 * open), and a browser bundle is not the place to add a diff library for the one screen that wants
 * it. So `unifiedDiff()` below is ~90 lines of LCS over lines, emitting the format `git diff` emits
 * — `diff --git`, `---`/`+++`, `@@` hunks with three lines of context, and the
 * `\ No newline at end of file` marker — because that is the format every model has read a million
 * of, and a patch in a shape a model recognises is a patch it can reason about.
 *
 * WHAT `git_diff` COMPARES, stated once because it is a deliberate deviation: WORKING TREE vs HEAD,
 * not index vs working tree. `git diff` with no arguments shows only what is unstaged, which for an
 * agent that has just run `git_add` shows NOTHING — the worst possible answer to "what did you
 * change?". `staged: true` gives index vs HEAD, which is what a person is about to commit. It is the
 * same choice `gitDiffNames` in git.ts already made.
 */

import {
  gitAdd,
  gitBranches,
  gitCheckout,
  gitClone,
  gitCommit,
  gitCreateBranch,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitReadHeadFile,
  gitReadStagedFile,
  gitRemotes,
  gitStatus,
  type GitRemote,
  type GitStatusEntry,
} from "./git.js";
import { fail } from "./errors.js";
import { assertRelativePath, type AgentFs } from "./types.js";

// ── The unified diff ────────────────────────────────────────────────────────────────────────────

/** Lines of context around each hunk. Git's default, and the number every reader expects. */
const CONTEXT_LINES = 3;
/**
 * The LCS table is O(n·m) cells, so it is bounded rather than trusted. Past this — after the common
 * prefix and suffix have been trimmed, which is what makes a one-line edit to a 10 000-line file
 * cheap — the patch degrades to "the whole file was replaced", which is true, honest and cheap.
 */
const MAX_DIFF_CELLS = 1_000_000;

/**
 * How "this file does not end in a newline" is carried through the diff.
 *
 * It is a property of the LAST LINE, not of the file, and it makes that line DIFFERENT from the same
 * characters followed by a newline — `git diff` of "hello\n" against "hello" is a one-line change,
 * not an empty patch. So the flag rides on the compare key of the last line, where the LCS is forced
 * to notice it, and is stripped again when the line is printed. A NUL byte cannot appear here: a
 * file containing one is binary and never reaches this function.
 */
const NO_NEWLINE_KEY = "\u0000no-newline-at-eof";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** Compare keys for the LCS, in file order. */
function lineKeys(text: string): string[] {
  if (text === "") return [];
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  if (!finalNewline) lines[lines.length - 1] += NO_NEWLINE_KEY;
  return lines;
}

/** A key back to what is printed, plus whether the marker line follows it. */
function display(key: string): { text: string; noNewline: boolean } {
  return key.endsWith(NO_NEWLINE_KEY)
    ? { text: key.slice(0, -NO_NEWLINE_KEY.length), noNewline: true }
    : { text: key, noNewline: false };
}

/** Git's own hunk-range spelling: a one-line range is a bare number, an empty one starts before it. */
function range(start: number, count: number): string {
  if (count === 1) return `${start}`;
  return `${count === 0 ? start - 1 : start},${count}`;
}

type Op = { kind: " " | "-" | "+"; text: string };

/** The classic LCS table, in a flat Int32Array so a 1000×1000 diff is one allocation. */
function lcsOps(a: string[], b: string[]): Op[] {
  const w = b.length + 1;
  const table = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      out.push({ kind: "-", text: a[i++] });
    } else {
      out.push({ kind: "+", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "-", text: a[i++] });
  while (j < b.length) out.push({ kind: "+", text: b[j++] });
  return out;
}

/** Line-by-line ops for two files, with the common head and tail taken out of the expensive part. */
function diffOps(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle =
    midA.length * midB.length > MAX_DIFF_CELLS
      ? [...midA.map((text): Op => ({ kind: "-", text })), ...midB.map((text): Op => ({ kind: "+", text }))]
      : lcsOps(midA, midB);
  return [
    ...a.slice(0, head).map((text): Op => ({ kind: " ", text })),
    ...middle,
    ...a.slice(a.length - tail).map((text): Op => ({ kind: " ", text })),
  ];
}

/** A NUL byte is git's own binary test, and it is the right one here: OPFS holds no file modes. */
function isBinary(bytes: Uint8Array): boolean {
  const scan = Math.min(bytes.length, 8000);
  for (let i = 0; i < scan; i++) if (bytes[i] === 0) return true;
  return false;
}

export interface UnifiedDiffOptions {
  /** The `a/` side's name; `/dev/null` when the file is new. Defaults to `path`. */
  from?: string;
  /** The `b/` side's name; `/dev/null` when the file was deleted. Defaults to `path`. */
  to?: string;
}

/**
 * One file's patch, in `git diff` format. Returns `""` when the two texts are identical — a caller
 * joining several of these gets no empty stanzas.
 */
export function unifiedDiff(path: string, before: string, after: string, opts: UnifiedDiffOptions = {}): string {
  if (before === after) return "";
  const ops = diffOps(lineKeys(before), lineKeys(after));

  // Which ops are inside a hunk: every change, plus CONTEXT_LINES either side. Two changes closer
  // than 2×context become ONE hunk, exactly as git merges them.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === " ") continue;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(ops.length - 1, i + CONTEXT_LINES); j++) keep[j] = true;
  }

  const body: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i].kind !== "+") oldLine++;
      if (ops[i].kind !== "-") newLine++;
      i++;
      continue;
    }
    const hunk: string[] = [];
    const startOld = oldLine;
    const startNew = newLine;
    let countOld = 0;
    let countNew = 0;
    while (i < ops.length && keep[i]) {
      const op = ops[i];
      const shown = display(op.text);
      hunk.push(`${op.kind}${shown.text}`);
      // The marker is printed immediately under the line it belongs to, which is where the flag now
      // is — no line arithmetic, and a context line that is last on both sides still gets one.
      if (shown.noNewline) hunk.push(NO_NEWLINE_MARKER);
      if (op.kind !== "+") {
        oldLine++;
        countOld++;
      }
      if (op.kind !== "-") {
        newLine++;
        countNew++;
      }
      i++;
    }
    body.push(`@@ -${range(startOld, countOld)} +${range(startNew, countNew)} @@`, ...hunk);
  }

  return [`diff --git a/${path} b/${path}`, `--- ${opts.from ?? `a/${path}`}`, `+++ ${opts.to ?? `b/${path}`}`, ...body].join(
    "\n",
  );
}

// ── What a remote operation SAYS ────────────────────────────────────────────────────────────────
//
// Pure, exported and tested on their own, because the interesting cases are the ones a fake http
// client cannot reach: a push the far side REFUSED (isomorphic-git resolves that promise, with the
// reason on the ref, so a caller who only checked for a throw would print "Pushed" over a rejection),
// and a fetch that moved nothing. Building the sentence away from the call is what makes those
// testable at all.

/** Git's own per-ref verdict, structurally — `{ ok, error? }` per ref, plus a call-level error. */
export interface PushLikeResult {
  ok?: boolean;
  error?: string | null;
  refs?: Record<string, { ok: boolean; error?: string | null }>;
}

export function pushSummary(result: PushLikeResult, remoteName: string, branch?: string): string {
  const rejected = Object.entries(result.refs ?? {})
    .filter(([, status]) => !status.ok)
    .map(([ref, status]) => `${ref}: ${status.error ?? "refused"}`);
  const why = result.error ? [result.error, ...rejected] : rejected;
  if (why.length) return `${remoteName} refused the push — ${why.join("; ")}`;
  return `Pushed ${branch ?? "the current branch"} to ${remoteName}.`;
}

export function fetchSummary(fetchHead: string | null | undefined, remoteName: string, branch?: string): string {
  const where = branch ? `${remoteName}/${branch}` : remoteName;
  return fetchHead ? `Fetched ${where} — ${shortOid(fetchHead)}.` : `Fetched ${where}; nothing new.`;
}

export function cloneSummary(url: string, dir: string, branch: string | null): string {
  return `Cloned ${url} into ${dir}${branch ? ` on branch ${branch}` : ""}.`;
}

export function pullSummary(remoteName: string, branch: string | undefined, onto: string | null, url?: string): string {
  const where = branch ? `${remoteName}/${branch}` : remoteName;
  return `Pulled ${where} into ${onto ?? "HEAD"}${url ? ` (${url})` : ""}.`;
}

// ── The ops object the runtime's git tools are wired to ─────────────────────────────────────────

/**
 * The runtime's `GitOps`, structurally. Every method answers in prose, because a model reads it.
 *
 * `gitClone`, `gitFetch`, `gitPush` and `gitPull` are the four that leave this computer. They RUN
 * when the host handed `createGitOps` a `remote` (§14: the 00 engine on this same machine, in
 * companion mode, as the smart-HTTP proxy) and REFUSE BY NAME when it did not — an agent that asks
 * to push must be told why it cannot, in the one sentence that is true, not discover that the method
 * is missing. Their prose is git's own: what moved, to where, and on which branch.
 */
export interface AgentGitOps {
  gitStatus(opts: { dir: string }): Promise<string>;
  gitLog(opts: { dir: string; limit?: number }): Promise<string>;
  gitDiff(opts: { dir: string; path?: string; staged?: boolean }): Promise<string>;
  gitAdd(opts: { dir: string; paths: string[] }): Promise<string>;
  gitCommit(opts: { dir: string; message: string }): Promise<string>;
  gitBranch(opts: { dir: string; create?: string; checkout?: boolean }): Promise<string>;
  gitCheckout(opts: { dir: string; ref: string; force?: boolean }): Promise<string>;
  /** `dir` is where the working tree lands, inside the workspace like every other repository. */
  gitClone(opts: { url: string; dir: string; ref?: string; depth?: number }): Promise<string>;
  gitPush(opts: { dir: string; remote?: string; branch?: string }): Promise<string>;
  gitPull(opts: { dir: string; remote?: string; branch?: string }): Promise<string>;
  gitFetch(opts: { dir: string; remote?: string; branch?: string }): Promise<string>;
}

export interface GitOpsOptions {
  /** Author for commits this agent makes. Defaults to `git.ts`'s local one. */
  author?: { name: string; email: string };
  now?: () => Date;
  /**
   * The road out of this computer, or nothing (additive, 2026-09-11).
   *
   * Absent is the state this package shipped in and still ships in for a host that has no proxy: the
   * four remote methods reject with `git_remote_not_available`. Present, it is used verbatim — this
   * package neither builds an http client nor decides who signs.
   */
  remote?: GitRemote;
}

const decoder = new TextDecoder();

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function statusLines(entries: GitStatusEntry[]): string[] {
  return entries
    .filter((e) => e.status !== "unmodified")
    .map((e) => `  ${e.status}: ${e.path}${e.staged ? " (staged)" : ""}`);
}

/**
 * Build the ops for an agent whose repositories live under `root` (its workspace).
 *
 * `root` is CONTAINMENT, not decoration. The runtime resolves a `dir` argument inside the sandbox
 * before it gets here, but this object is also reachable from a host that has not — and a git
 * command pointed at `../../vault.json`'s folder would read and rewrite the agent's own record. So
 * the check is made where the operation is, in the same spirit as `sandbox.ts` in the runtime.
 */
export function createGitOps(fs: AgentFs, root = "workspace", opts: GitOpsOptions = {}): AgentGitOps {
  const base = assertRelativePath(root);
  const contain = (dir: string): string => {
    const rel = assertRelativePath(dir);
    if (rel !== base && !rel.startsWith(`${base}/`)) {
      fail("git_outside_workspace", `a git repository must be inside ${base}/ — refused: ${dir}`);
    }
    return rel;
  };

  /** Working-tree bytes for a repo-relative path, or `null` when the file is gone. */
  const workingBytes = async (repo: string, filepath: string): Promise<Uint8Array | null> => {
    const stat = await fs.stat(`${repo}/${filepath}`);
    if (!stat || stat.kind !== "file") return null;
    return fs.readFile(`${repo}/${filepath}`);
  };

  return {
    async gitStatus({ dir }) {
      const repo = contain(dir);
      const { current } = await gitBranches(fs, repo);
      const entries = await gitStatus(fs, repo);
      const changed = statusLines(entries);
      const head = `On branch ${current ?? "(no commits yet)"}`;
      if (!changed.length) return `${head}\nnothing to commit, working tree clean`;
      return `${head}\n\nChanges:\n${changed.join("\n")}`;
    },

    async gitLog({ dir, limit }) {
      const entries = await gitLog(fs, contain(dir), { depth: limit ?? 20 });
      if (!entries.length) return "No commits yet.";
      return entries
        .map((c) => {
          const when = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
          return `${shortOid(c.oid)}  ${when}  ${c.message.trim().split("\n")[0]}  (${c.author.name})`;
        })
        .join("\n");
    },

    async gitDiff({ dir, path, staged }) {
      const repo = contain(dir);
      const entries = await gitStatus(fs, repo);
      const wanted = entries.filter(
        (e) => e.status !== "unmodified" && (!path || e.path === path || e.path.startsWith(`${path}/`)),
      );
      // `staged` means index-vs-HEAD, so a change that was never `git add`ed is not part of it.
      const rows = staged ? wanted.filter((e) => e.staged) : wanted;
      if (!rows.length) return staged ? "Nothing is staged." : "No changes.";
      const patches: string[] = [];
      for (const entry of rows) {
        const beforeBytes = await gitReadHeadFile(fs, repo, entry.path);
        const afterBytes = staged ? await gitReadStagedFile(fs, repo, entry.path) : await workingBytes(repo, entry.path);
        if ((beforeBytes && isBinary(beforeBytes)) || (afterBytes && isBinary(afterBytes))) {
          patches.push(`diff --git a/${entry.path} b/${entry.path}\nBinary files differ`);
          continue;
        }
        const patch = unifiedDiff(entry.path, beforeBytes ? decoder.decode(beforeBytes) : "", afterBytes ? decoder.decode(afterBytes) : "", {
          ...(beforeBytes ? {} : { from: "/dev/null" }),
          ...(afterBytes ? {} : { to: "/dev/null" }),
        });
        if (patch) patches.push(patch);
      }
      return patches.length ? patches.join("\n") : staged ? "Nothing is staged." : "No changes.";
    },

    async gitAdd({ dir, paths }) {
      const repo = contain(dir);
      await gitAdd(fs, repo, paths);
      const staged = (await gitStatus(fs, repo)).filter((e) => e.staged);
      return `Staged ${staged.length} file${staged.length === 1 ? "" : "s"}: ${staged.map((e) => e.path).join(", ") || "(none)"}`;
    },

    async gitCommit({ dir, message }) {
      const repo = contain(dir);
      const staged = (await gitStatus(fs, repo)).filter((e) => e.staged);
      if (!staged.length) return "Nothing is staged — call git_add first.";
      const oid = await gitCommit(fs, repo, {
        message,
        ...(opts.author ? { author: opts.author } : {}),
        ...(opts.now ? { timestamp: opts.now().getTime() } : {}),
      });
      const { current } = await gitBranches(fs, repo);
      return `[${current ?? "HEAD"} ${shortOid(oid)}] ${message.trim().split("\n")[0]}\n ${staged.length} file${
        staged.length === 1 ? "" : "s"
      } committed`;
    },

    async gitBranch({ dir, create, checkout }) {
      const repo = contain(dir);
      if (create) {
        await gitCreateBranch(fs, repo, create, { checkout: checkout === true });
        return checkout ? `Created branch ${create} and switched to it.` : `Created branch ${create}.`;
      }
      const { current, branches } = await gitBranches(fs, repo);
      if (!branches.length) return "No branches yet — nothing has been committed.";
      return branches.map((b) => `${b === current ? "*" : " "} ${b}`).join("\n");
    },

    async gitCheckout({ dir, ref, force }) {
      const repo = contain(dir);
      await gitCheckout(fs, repo, ref, { force: force === true });
      return `Switched to ${ref}.${force ? " Uncommitted changes in the working tree were overwritten." : ""}`;
    },

    // ── The four that leave this computer ───────────────────────────────────────────────────────
    //
    // `opts.remote` is read at CALL TIME rather than captured, so a host that swaps the object it
    // passed (the companion appearing or going away mid-session) does not have to rebuild these ops
    // — and a host that never had one gets the same refusal it always got.

    async gitClone({ url, dir, ref, depth }) {
      const repo = contain(dir);
      await gitClone(fs, repo, { url, remote: opts.remote, ref, depth });
      return cloneSummary(url, repo, (await gitBranches(fs, repo)).current);
    },

    // `name` is worked out BEFORE the call in all three: the remote's name is what the REFUSAL
    // wants to say as much as the success does, and a default read after a throw is a default that
    // is never read at all.
    async gitFetch({ dir, remote, branch }) {
      const repo = contain(dir);
      const name = remote ?? "origin";
      const result = await gitFetch(fs, repo, { remote: opts.remote, remoteName: remote, branch });
      return fetchSummary(result.fetchHead, name, branch);
    },

    async gitPush({ dir, remote, branch }) {
      const repo = contain(dir);
      const name = remote ?? "origin";
      const result = await gitPush(fs, repo, { remote: opts.remote, remoteName: remote, branch });
      return pushSummary(result, name, branch);
    },

    async gitPull({ dir, remote, branch }) {
      const repo = contain(dir);
      const name = remote ?? "origin";
      await gitPull(fs, repo, { remote: opts.remote, remoteName: remote, branch, author: opts.author });
      const url = (await gitRemotes(fs, repo)).find((r) => r.remote === name)?.url;
      return pullSummary(name, branch, (await gitBranches(fs, repo)).current, url);
    },
  };
}
