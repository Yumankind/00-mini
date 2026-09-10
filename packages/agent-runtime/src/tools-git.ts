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
 * credential this package has no business holding. It arrives with the auth work, not before.)
 */
import type { Tool } from "./api.js";
import { resolveInSandbox } from "./sandbox.js";

export interface GitOps {
  gitStatus(opts: { dir: string }): Promise<string>;
  gitLog(opts: { dir: string; limit?: number }): Promise<string>;
  gitDiff(opts: { dir: string; path?: string; staged?: boolean }): Promise<string>;
  gitAdd(opts: { dir: string; paths: string[] }): Promise<string>;
  gitCommit(opts: { dir: string; message: string }): Promise<string>;
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
  ];
}
