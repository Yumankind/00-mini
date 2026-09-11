/**
 * The Git panel's state — one repository at a time.
 *
 * WHY ONE REPOSITORY AND WHY `projects/<name>`. The workspace rule of this platform is that a project
 * is one folder (`workspace/projects/<name>/`, stated to every agent in `platform-doc.ts`), so those
 * folders are the only places a repository is expected and the only places this panel offers to make
 * one. It does not scan the whole tree for `.git`: a repository somewhere else would be a mistake the
 * panel should not normalise, and walking for it costs a pass over OPFS on every open.
 *
 * WHAT IS PURE AND WHY. Everything above `refresh()` is a function from state to state, because the
 * interesting part of a git panel is not the calls — it is the bookkeeping around a status list that
 * changes under you: a file you selected that is no longer changed, a stage that empties a commit
 * box, a message you typed surviving a refresh. That is what the test pins.
 */
import { computed, ref, shallowRef } from "vue";
import type { GitStatusEntry } from "@00/agent-fs";
import { createPowerGit, type PowerGit, type RepoCommit, type RepoStatus } from "../power/git-bridge.js";
import type { TreeNode } from "../lib/files-tree.js";
import { agent } from "./agent.js";
import { companionGitBlocked, companionGitRemote } from "./companion.js";
import { fileTree, refreshFiles } from "./files.js";

/**
 * The plan's §4.2 line, said in the UI rather than only in a package's error — and, since §14, the
 * line for the case where the road EXISTS and has not been connected. `companionGitBlocked()` says
 * which of the three reasons applies right now; this is the one for "nothing has been set up".
 */
export const REMOTE_LINE =
  "Clone, push and pull go through 00 on this computer — connect it in Connections → This computer.";

/** Where a repository is expected to live. */
export const PROJECTS_DIR = "workspace/projects";

export interface GitPanelState {
  /** Agent-root-relative repo folder, or null when none is chosen. */
  repo: string | null;
  status: RepoStatus | null;
  log: RepoCommit[];
  /** The file whose diff is showing. */
  selected: string | null;
  diff: string | null;
  message: string;
  error: string | null;
  busy: boolean;
}

export function emptyGitState(): GitPanelState {
  return { repo: null, status: null, log: [], selected: null, diff: null, message: "", error: null, busy: false };
}

// ── The pure reducer ──────────────────────────────────────────────────────────────────────────────

/** The project folders of this agent, from the tree the Files pane already walked. */
export function projectRepos(tree: TreeNode[]): string[] {
  const workspace = tree.find((n) => n.path === "workspace");
  const projects = workspace?.children?.find((n) => n.path === PROJECTS_DIR);
  return (projects?.children ?? []).filter((n) => n.kind === "dir").map((n) => n.path);
}

/** Staged and unstaged, in the two lists the panel draws. */
export function splitStatus(entries: GitStatusEntry[]): { staged: GitStatusEntry[]; unstaged: GitStatusEntry[] } {
  const rows = entries.filter((e) => e.status !== "unmodified");
  return { staged: rows.filter((e) => e.staged), unstaged: rows.filter((e) => !e.staged) };
}

/** Git's own one-letter shorthand, which is what fits in a dense list. */
export function statusLetter(status: string): string {
  return { modified: "M", added: "A", deleted: "D", untracked: "?" }[status] ?? " ";
}

/** Why this commit cannot happen, or `null`. */
export function commitProblem(message: string, staged: number): string | null {
  if (!staged) return "Nothing is staged.";
  if (!message.trim()) return "A commit needs a message — say why, not what.";
  return null;
}

/**
 * A new status arriving. The selection survives only if the file is still changed, and the diff goes
 * with it — a panel still showing yesterday's patch under today's list is the one failure mode here.
 */
export function applyStatus(state: GitPanelState, status: RepoStatus): GitPanelState {
  const stillChanged = state.selected && status.entries.some((e) => e.path === state.selected);
  return {
    ...state,
    status,
    selected: stillChanged ? state.selected : null,
    diff: stillChanged ? state.diff : null,
    error: null,
  };
}

/** Choosing another repository clears everything that belonged to the last one, except nothing. */
export function selectRepo(state: GitPanelState, repo: string | null): GitPanelState {
  if (state.repo === repo) return state;
  return { ...emptyGitState(), repo };
}

// ── The store ─────────────────────────────────────────────────────────────────────────────────────

const state = ref<GitPanelState>(emptyGitState());
const opsRef = shallowRef<PowerGit | null>(null);

export const gitState = computed(() => state.value);
export const gitRepos = computed(() => projectRepos(fileTree.value));
export const gitSplit = computed(() => splitStatus(state.value.status?.entries ?? []));
export const gitCommitProblem = computed(() => commitProblem(state.value.message, gitSplit.value.staged.length));

function ops(): PowerGit | null {
  const owned = agent.value;
  if (!owned) return null;
  // The road out is a GETTER, not a value: this object outlives any one state of the companion.
  if (!opsRef.value) opsRef.value = createPowerGit(owned.fs, "workspace", { remote: companionGitRemote });
  return opsRef.value;
}

/**
 * Why the remote buttons are off, or `null` when they are on.
 *
 * A computed over the companion's status rather than a check inside each handler: a greyed button
 * teaches nothing, and this is the sentence printed under them (§14.4 — "every companion feature
 * greys out when it is gone", with the reason).
 */
export const gitRemoteBlocked = computed(() => companionGitBlocked());
export const gitRemoteReady = computed(() => gitRemoteBlocked.value === null);

async function guard(fn: (git: PowerGit, repo: string) => Promise<void>): Promise<void> {
  const git = ops();
  const repo = state.value.repo;
  if (!git || !repo) return;
  state.value = { ...state.value, busy: true, error: null };
  try {
    await fn(git, repo);
  } catch (err) {
    state.value = { ...state.value, error: err instanceof Error ? err.message : String(err) };
  } finally {
    state.value = { ...state.value, busy: false };
  }
}

export async function chooseRepo(repo: string | null): Promise<void> {
  state.value = selectRepo(state.value, repo);
  if (repo) await refreshGit();
}

export async function refreshGit(): Promise<void> {
  const git = ops();
  const repo = state.value.repo;
  if (!git || !repo) return;
  state.value = { ...state.value, busy: true, error: null };
  try {
    if (!(await git.isRepo(repo))) {
      state.value = { ...state.value, status: null, log: [], error: null, busy: false };
      return;
    }
    const status = await git.repoStatus(repo);
    state.value = applyStatus(state.value, status);
    state.value = { ...state.value, log: await git.log(repo, 20) };
    if (state.value.selected) await openDiff(state.value.selected);
  } catch (err) {
    state.value = { ...state.value, error: err instanceof Error ? err.message : String(err) };
  } finally {
    state.value = { ...state.value, busy: false };
  }
}

/** True when the chosen folder is a repository; false is what makes "Initialise" appear. */
export const gitInitialised = computed(() => state.value.status !== null);

export async function initRepo(): Promise<void> {
  await guard(async (git, repo) => {
    await git.init(repo);
  });
  await refreshGit();
  await refreshFiles();
}

export async function openDiff(path: string): Promise<void> {
  const git = ops();
  const repo = state.value.repo;
  if (!git || !repo) return;
  state.value = { ...state.value, selected: path, diff: null };
  try {
    const staged = state.value.status?.entries.find((e) => e.path === path)?.staged === true;
    const text = git.diff
      ? await git.diff(repo, path, { staged })
      : `${(await git.diffNames(repo)).join("\n")}\n\n(names only — this build has no textual diff)`;
    state.value = { ...state.value, diff: text };
  } catch (err) {
    state.value = { ...state.value, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function stagePaths(paths: string[]): Promise<void> {
  await guard(async (git, repo) => {
    await git.add(repo, paths);
  });
  await refreshGit();
}

/** Named refusal, not a dead button: `git reset` has no wrapper in `@00/agent-fs` yet. */
export async function unstagePath(path: string): Promise<void> {
  await guard(async (git, repo) => {
    await git.unstage(repo, path);
  });
  await refreshGit();
}

export function setCommitMessage(message: string): void {
  state.value = { ...state.value, message };
}

export async function commitStaged(): Promise<void> {
  if (gitCommitProblem.value) return;
  const message = state.value.message;
  await guard(async (git, repo) => {
    await git.commit(repo, message);
    state.value = { ...state.value, message: "" };
  });
  await refreshGit();
}

export async function switchBranch(ref: string, create = false): Promise<void> {
  await guard(async (git, repo) => {
    if (!git.checkout) throw new Error("this build of @00/agent-fs has no checkout");
    await git.checkout(repo, ref, { create });
  });
  await refreshGit();
  await refreshFiles();
}

// ── The three that leave this computer ───────────────────────────────────────────────────────────
//
// Each one goes through `guard`, so a refusal from the package (the companion went away between the
// button being drawn and being pressed) lands in `error` and is read on screen rather than thrown
// into the console. The result line is kept too: "origin refused the push — non-fast-forward" is the
// whole of what a person needs, and it is git's own sentence.

const remoteSaid = ref<string | null>(null);
export const gitRemoteSaid = computed(() => remoteSaid.value);

export async function pushRepo(): Promise<void> {
  await guard(async (git, repo) => {
    if (!git.push) throw new Error(REMOTE_LINE);
    remoteSaid.value = await git.push(repo);
  });
  await refreshGit();
}

export async function pullRepo(): Promise<void> {
  await guard(async (git, repo) => {
    if (!git.pull) throw new Error(REMOTE_LINE);
    remoteSaid.value = await git.pull(repo);
  });
  await refreshGit();
  await refreshFiles();
}

/** `git clone <url>` into `workspace/projects/<name>` — the one folder a project may live in. */
export async function cloneRepo(url: string): Promise<void> {
  const git = ops();
  const trimmed = url.trim();
  if (!git || !trimmed) return;
  state.value = { ...state.value, busy: true, error: null };
  try {
    if (!git.clone) throw new Error(REMOTE_LINE);
    const dir = `${PROJECTS_DIR}/${cloneFolder(trimmed)}`;
    remoteSaid.value = await git.clone(trimmed, dir);
    await refreshFiles();
    await chooseRepo(dir);
  } catch (err) {
    state.value = { ...state.value, error: err instanceof Error ? err.message : String(err) };
  } finally {
    state.value = { ...state.value, busy: false };
  }
}

/** git's own rule for the folder a clone lands in: the last segment, minus `.git`. */
export function cloneFolder(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return last.replace(/\.git$/, "") || "repo";
}

export function resetGit(): void {
  remoteSaid.value = null;
  state.value = emptyGitState();
  opsRef.value = null;
}
