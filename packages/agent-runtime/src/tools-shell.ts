/**
 * `bash` — the tool that is honest about where it can and cannot run.
 *
 * The engine gives the full agent a real shell (`createBashToolDefinition` in apps/00d/src/tools.ts).
 * A browser tab has, at best, a WASM coreutils shell (docs/HANDOFF-infinite-agent.md §12.4 has not
 * chosen one yet) and at worst nothing. The plan's rule for that case is explicit and is the whole
 * design of this module: a command this host cannot run is **shown as "wakes on your Mac / in the
 * cloud", never hidden and never deleted**.
 *
 * So `bash` is always registered, with the engine's name and the engine's argument schema, and the
 * SHELL behind it is injected. `NoShell` answers in one sentence the model can repeat to the person.
 * Hiding the tool instead would teach the model it has no shell at all, and a skill that shells out
 * would fail with "tool not found" — which tells the person nothing about the Mac sitting next to
 * them.
 */
import type { Tool } from "./api.js";

export interface ShellRunOptions {
  /** Agent-root-relative working directory (the run's sandbox). */
  cwd: string;
  timeoutSec?: number;
  signal: AbortSignal;
}

export interface ShellResult {
  output: string;
  exitCode: number;
}

export interface Shell {
  /** False when `run` will only ever explain itself — the prompt says so (see buildFullRules). */
  readonly available: boolean;
  /** Human name for the UI and for the prompt: `WASM shell`, `cloud computer`, `no shell`. */
  readonly label: string;
  run(command: string, opts: ShellRunOptions): Promise<ShellResult>;
}

/** The exit code a POSIX shell uses for "command not found" — the closest true thing to say. */
const NO_SHELL_EXIT = 127;

export const NoShell: Shell = {
  available: false,
  label: "no shell",
  async run(command) {
    return {
      exitCode: NO_SHELL_EXIT,
      output:
        `this needs a real shell — wakes on your Mac. This agent is running in a browser tab, which has no ` +
        `shell, so \`${command}\` did NOT run. Tell the person plainly: it can run on their Mac (the 00 app) ` +
        `or on a cloud computer, and nothing has happened yet. Meanwhile your file tools — read, write, edit, ` +
        `ls, grep, find — do most of what a shell is usually reached for.`,
    };
  },
};

export function bashTool(shell: Shell = NoShell): Tool {
  return {
    // Confirm even when the shell is NoShell: the tier is a property of what the tool MEANS, and the
    // day a WASM shell is wired in behind the same tool, the standing answers people gave must still
    // be answers about running commands.
    tier: "confirm",
    schema: {
      name: "bash",
      description:
        "Execute a bash command in the current working directory. Returns stdout and stderr. Optionally provide a timeout in seconds.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
        },
        required: ["command"],
      },
    },
    async run(args, ctx) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) return { output: "A command is required.", isError: true };
      const timeoutSec = typeof args.timeout === "number" ? args.timeout : undefined;
      ctx.emit({ type: "command_started", command });
      try {
        const result = await shell.run(command, { cwd: ctx.sandbox, timeoutSec, signal: ctx.signal });
        ctx.emit({ type: "command_completed", command, exitCode: result.exitCode });
        return { output: result.output, isError: result.exitCode !== 0 };
      } catch (err) {
        ctx.emit({ type: "command_completed", command, exitCode: -1 });
        return { output: `Shell failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
