/**
 * GIT OPS THAT CHANGE THEIR MIND — the swap §14.4 needs, without rebuilding anything.
 *
 * The agent's git tools are built ONCE, at boot, out of one `GitOps` object (`fullTools({ git })`),
 * and the companion appears and disappears while that object is in use: someone runs
 * `00d companion`, someone closes the terminal, someone's laptop sleeps. Rebuilding the ops would
 * mean rebuilding the tool table, which would mean rebuilding the runtime, which would drop the
 * listeners every pane subscribed at mount.
 *
 * So the object handed to the runtime is this one: the seven LOCAL methods are the package's own,
 * untouched, and the four that leave the computer ask `remote()` at CALL time and build a fresh ops
 * object for the road that exists right now. `createGitOps` is closures over a filesystem — making
 * one per remote call costs nothing and is the only way the answer can be current.
 *
 * When `remote()` says `null` the call lands on the package's own refusal, which is the honest
 * sentence with the road in it (`git push needs this computer's companion…`). Nothing here invents
 * a second way of saying no.
 */
import type { AgentGitOps, AgentFs, GitRemote } from "@00/agent-fs";

export interface DelegatingGitOptions {
  /** The road out, asked fresh on every remote call. `null` = there is none right now. */
  remote: () => GitRemote | null;
  /** How an ops object is built. Injected so a test does not need a filesystem. */
  build: (remote: GitRemote | undefined) => AgentGitOps;
}

/**
 * One `AgentGitOps` whose four remote methods follow the companion.
 *
 * `local` is what everything else delegates to — built once, because nothing about status, diff or
 * commit depends on whether a proxy exists.
 */
export function delegatingGitOps(opts: DelegatingGitOptions): AgentGitOps {
  const local = opts.build(undefined);
  /** The ops to run a remote call on: the road that exists now, or the refusing local one. */
  const road = (): AgentGitOps => {
    const remote = opts.remote();
    return remote ? opts.build(remote) : local;
  };
  return {
    gitStatus: (o) => local.gitStatus(o),
    gitLog: (o) => local.gitLog(o),
    gitDiff: (o) => local.gitDiff(o),
    gitAdd: (o) => local.gitAdd(o),
    gitCommit: (o) => local.gitCommit(o),
    gitBranch: (o) => local.gitBranch(o),
    gitCheckout: (o) => local.gitCheckout(o),
    gitClone: (o) => road().gitClone(o),
    gitPush: (o) => road().gitPush(o),
    gitPull: (o) => road().gitPull(o),
    gitFetch: (o) => road().gitFetch(o),
  };
}

/** The same thing, for the ordinary case: one filesystem, one workspace, the package's factory. */
export function companionGitOps(
  createGitOps: (fs: AgentFs, root: string, opts: { remote?: GitRemote }) => AgentGitOps,
  fs: AgentFs,
  root: string,
  remote: () => GitRemote | null,
): AgentGitOps {
  return delegatingGitOps({
    remote,
    build: (road) => createGitOps(fs, root, road ? { remote: road } : {}),
  });
}
