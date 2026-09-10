/**
 * Git, as five thin wrappers over an injected `GitOps`.
 *
 * THE ONE DEVIATION FROM THE ENGINE THAT IS DELIBERATE. A Mac agent runs `git` through `bash`; a
 * browser agent has no shell, and git in the browser is `isomorphic-git` — a library, not a binary
 * (docs/HANDOFF-infinite-agent.md §4.2). So the browser gets NAMED tools where the Mac gets a shell
 * command. A skill that says "run `git status`" still works on the Mac and, here, gets `bash`'s
 * "wakes on your Mac" answer, which is the truth; a skill that wants git to work in both places
 * should say "check the repo status" and let the agent pick the tool it has.
 *
 * The implementation lives behind `GitOps` because `@00/agent-fs` owns the isomorphic-git backend
 * and this package must not import it: the runtime is the loop, not the plumbing, and a test needs a
 * fake, not a repository.
 *
 * Tiers follow §4.3: reading is safe, staging and committing change the record, so they confirm.
 * (`push` is absent on purpose — it is an external mutation, i.e. high-risk, and it needs a
 * credential this package has no business holding. It arrives with the auth work, not before. The
 * implementation side says the same thing out loud: `gitClone`/`gitPush`/`gitPull` in
 * @00/agent-fs REFUSE BY NAME with the CORS-proxy sentence, so a host that wires them into a tool
 * later inherits an honest failure rather than a stub.)
 *
 * `git_branch` and `git_checkout` joined the set on 2026-09-10 (gap B8) and brought the first
 * `high-risk` tier with them — see `tierFor` on the checkout.
 */
import type { PermissionTier, Tool } from "./api.js";
import { resolveInSandbox } from "./sandbox.js";

export interface GitOps {
  gitStatus(opts: { dir: string }): Promise<string>;
  gitLog(opts: { dir: string; limit?: number }): Promise<string>;
  gitDiff(opts: { dir: string; path?: string; staged?: boolean }): Promise<string>;
  gitAdd(opts: { dir: string; paths: string[] }): Promise<string>;
  gitCommit(opts: { dir: string; message: string }): Promise<string>;
  /**
   * BRANCHES ARE OPTIONAL ON THE INTERFACE, and the tools appear only when the implementation does
   * (gap B8, 2026-09-10). `createGitOps` in @00/agent-fs has both; a host with a cut-down ops object
   * — an embed, a test, a future remote-git bridge that only reads — keeps compiling and simply gets
   * six tools instead of eight. The alternative, two methods that throw "not implemented", would put
   * a tool in front of the model that can only ever fail.
   */
  gitBranch?(opts: { dir: string; create?: string; checkout?: boolean }): Promise<string>;
  gitCheckout?(opts: { dir: string; ref: string; force?: boolean }): Promise<string>;
}

const DEFAULT_LOG_LIMIT = 20;

function dirArg(sandbox: string, args: Record<string, unknown>): string {
  return resolveInSandbox(sandbox, typeof args.dir === "string" ? args.dir : undefined);
}

const dirProperty = {
  type: "string",
  description: "Repository folder, relative to your workspace (e.g. 'projects/site'). Defaults to your workspace root.",
} as const;

export function gitTools(ops: GitOps): Tool[] {
  return [
    {
      tier: "safe",
      schema: {
        name: "git_status",
        description: "Show the working tree status of a git repository: branch, staged, changed and untracked files.",
        parameters: { type: "object", properties: { dir: dirProperty } },
      },
      async run(args, ctx) {
        return { output: await ops.gitStatus({ dir: dirArg(ctx.sandbox, args) }) };
      },
    },
    {
      tier: "safe",
      schema: {
        name: "git_log",
        description: "Show recent commits of a git repository, newest first.",
        parameters: {
          type: "object",
          properties: {
            dir: dirProperty,
            limit: { type: "number", description: `Maximum number of commits (default: ${DEFAULT_LOG_LIMIT})` },
          },
        },
      },
      async run(args, ctx) {
        const limit = typeof args.limit === "number" ? args.limit : DEFAULT_LOG_LIMIT;
        return { output: await ops.gitLog({ dir: dirArg(ctx.sandbox, args), limit }) };
      },
    },
    {
      tier: "safe",
      schema: {
        name: "git_diff",
        description: "Show what changed in a git repository. Without `staged`, shows unstaged changes.",
        parameters: {
          type: "object",
          properties: {
            dir: dirProperty,
            path: { type: "string", description: "Limit the diff to one path inside the repository." },
            staged: { type: "boolean", description: "Diff what is staged rather than what is not (default: false)" },
          },
        },
      },
      async run(args, ctx) {
        return {
          output: await ops.gitDiff({
            dir: dirArg(ctx.sandbox, args),
            path: typeof args.path === "string" ? args.path : undefined,
            staged: args.staged === true,
          }),
        };
      },
    },
    {
      tier: "confirm",
      schema: {
        name: "git_add",
        description: "Stage files in a git repository for the next commit.",
        parameters: {
          type: "object",
          properties: {
            dir: dirProperty,
            paths: {
              type: "array",
              description: "Paths inside the repository to stage. Use ['.'] for everything changed.",
              items: { type: "string" },
            },
          },
          required: ["paths"],
        },
      },
      async run(args, ctx) {
        const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
        if (!paths.length) return { output: "Nothing to stage — pass one or more paths.", isError: true };
        return { output: await ops.gitAdd({ dir: dirArg(ctx.sandbox, args), paths }) };
      },
    },
    {
      tier: "confirm",
      schema: {
        name: "git_commit",
        description: "Commit what is staged in a git repository. Write a message that says why, not what.",
        parameters: {
          type: "object",
          properties: { dir: dirProperty, message: { type: "string", description: "Commit message." } },
          required: ["message"],
        },
      },
      async run(args, ctx) {
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!message) return { output: "A commit needs a message.", isError: true };
        return { output: await ops.gitCommit({ dir: dirArg(ctx.sandbox, args), message }) };
      },
    },
    ...(ops.gitBranch
      ? [
          {
            // Listing is a read; creating a branch is a change. One tool, because that is how a
            // person says it ("branch"), and the tier is decided per call — declared `safe` and
            // RAISED, because the loop only ever takes the stricter of the two (runtime.ts).
            tier: "safe" as PermissionTier,
            // Trimmed, exactly as `run` trims it: the tier must be decided on the same reading of
            // the argument as the behaviour, or a blank `create` asks a question and then lists.
            tierFor: (args: Record<string, unknown>): PermissionTier =>
              typeof args.create === "string" && args.create.trim() ? "confirm" : "safe",
            schema: {
              name: "git_branch",
              description: "List the branches of a git repository, or create a new one.",
              parameters: {
                type: "object",
                properties: {
                  dir: dirProperty,
                  create: { type: "string", description: "Name of a new branch to create. Omit to list." },
                  checkout: { type: "boolean", description: "Switch to the new branch after creating it (default: false)" },
                },
              },
            },
            async run(args: Record<string, unknown>, ctx: { sandbox: string }) {
              const create = typeof args.create === "string" ? args.create.trim() : "";
              return {
                output: await ops.gitBranch!({
                  dir: dirArg(ctx.sandbox, args),
                  ...(create ? { create } : {}),
                  checkout: args.checkout === true,
                }),
              };
            },
          } satisfies Tool,
        ]
      : []),
    ...(ops.gitCheckout
      ? [
          {
            tier: "confirm" as PermissionTier,
            /**
             * `force` IS THE HIGH-RISK CASE, and it is the reason that tier exists (gap B17). A plain
             * checkout refuses when it would overwrite uncommitted work; a forced one silently throws
             * that work away, and there is no reflog an agent could restore it from in a browser.
             */
            tierFor: (args: Record<string, unknown>): PermissionTier => (args.force === true ? "high-risk" : "confirm"),
            schema: {
              name: "git_checkout",
              description:
                "Switch a git repository to another branch or commit. Uncommitted changes stop the switch unless you pass force, which DESTROYS them.",
              parameters: {
                type: "object",
                properties: {
                  dir: dirProperty,
                  ref: { type: "string", description: "Branch name or commit to switch to." },
                  force: {
                    type: "boolean",
                    description: "Discard uncommitted changes in the working tree (default: false). There is no undo.",
                  },
                },
                required: ["ref"],
              },
            },
            async run(args: Record<string, unknown>, ctx: { sandbox: string }) {
              const ref = typeof args.ref === "string" ? args.ref.trim() : "";
              if (!ref) return { output: "A checkout needs a branch or commit to switch to.", isError: true };
              return {
                output: await ops.gitCheckout!({ dir: dirArg(ctx.sandbox, args), ref, force: args.force === true }),
              };
            },
          } satisfies Tool,
        ]
      : []),
  ];
}
