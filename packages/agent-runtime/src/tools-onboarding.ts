/**
 * `finish_onboarding` — the end of the first conversation, and the only thing that ends it.
 *
 * The engine has had this since the beginning (`apps/00d/src/platform-doc.ts`: "call
 * `finish_onboarding` exactly once (it deletes BOOTSTRAP.md, restores your full toolset, and flips
 * you to 'ready')"). The browser scaffolded the same `BOOTSTRAP.md`, wrote the same
 * `profile.json { onboarded: false }` — and had no tool, no prompt rule and therefore no interview
 * (gap B13). An agent whose first act was supposed to be "learn who you work for" instead answered
 * "hi" like a chatbot, and `onboarded` stayed false forever.
 *
 * TWO WRITES, IN THIS ORDER, and the order is the recoverable one: flip `profile.json` FIRST, then
 * delete `BOOTSTRAP.md`. A crash between them leaves a flipped profile and a stale file, which the
 * next session sees as "onboarded, with a leftover file" — harmless, and the agent can delete it. The
 * other order leaves the interview's instructions gone and the agent still marked un-onboarded,
 * which would restart an interview with nothing to conduct it from.
 *
 * IT REACHES OUTSIDE THE SANDBOX, on purpose and by exactly one fixed path. `profile.json` sits at
 * the AGENT ROOT, beside `vault.json` and `sessions/`, which the file tools deliberately cannot
 * touch. This tool is not a file tool: it takes no path argument, it cannot be pointed anywhere, and
 * the one file it writes is the one whose entire content it is replacing a single boolean in.
 */
import type { AgentFs } from "@00/agent-fs";
import type { Tool } from "./api.js";
import { normalizeSandbox } from "./sandbox.js";

/** Where the first-run instructions live, relative to the workspace. */
export const BOOTSTRAP_FILE = "BOOTSTRAP.md";
/** Where the agent's profile lives, relative to the AGENT ROOT (not the sandbox). */
export const PROFILE_PATH = "profile.json";

export interface OnboardingState {
  /** True when `workspace/BOOTSTRAP.md` exists and the profile has not been flipped. */
  pending: boolean;
}

/**
 * Is this agent still in its first run? Both halves must agree: a `BOOTSTRAP.md` an agent forgot to
 * delete does not re-open an interview it has already finished, and a missing profile does not
 * either — the file is the instruction sheet, the flag is the record.
 */
export async function onboardingState(fs: AgentFs, sandbox: string, profilePath = PROFILE_PATH): Promise<OnboardingState> {
  const root = normalizeSandbox(sandbox);
  const hasBootstrap = (await fs.stat(`${root}/${BOOTSTRAP_FILE}`).catch(() => null))?.kind === "file";
  if (!hasBootstrap) return { pending: false };
  try {
    const profile = JSON.parse(await fs.readText(profilePath)) as { onboarded?: unknown };
    return { pending: profile.onboarded !== true };
  } catch {
    // No profile (a bare workspace, a test fixture): the BOOTSTRAP file is then the only evidence
    // there is, and it says setup has not happened.
    return { pending: true };
  }
}

export interface OnboardingToolOptions {
  /** Only a test moves it. */
  profilePath?: string;
}

export function finishOnboardingTool(opts: OnboardingToolOptions = {}): Tool {
  const profilePath = opts.profilePath ?? PROFILE_PATH;
  return {
    // `confirm`, like every other write: the person is sitting there, they have just been
    // interviewed, and "I'm done setting up — shall I save this?" is a reasonable last question.
    tier: "confirm",
    schema: {
      name: "finish_onboarding",
      description:
        "End first-run setup. Call this exactly ONCE, after you have written what you learned into USER.md, SOUL.md and IDENTITY.md: it deletes BOOTSTRAP.md and marks you as set up. Nothing else ends setup — do not delete BOOTSTRAP.md by hand.",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      const root = normalizeSandbox(ctx.sandbox);
      const bootstrap = `${root}/${BOOTSTRAP_FILE}`;
      const exists = (await ctx.fs.stat(bootstrap).catch(() => null))?.kind === "file";
      if (!exists) return { output: "Setup is already finished — there is no BOOTSTRAP.md left to remove." };

      let profile: Record<string, unknown> = {};
      try {
        profile = JSON.parse(await ctx.fs.readText(profilePath)) as Record<string, unknown>;
      } catch {
        /* no profile on this host — the flag still gets written, so the next session agrees */
      }
      await ctx.fs.writeFile(profilePath, `${JSON.stringify({ ...profile, onboarded: true }, null, 2)}\n`);
      ctx.emit({ type: "file_changed", path: profilePath, op: "write" });
      await ctx.fs.remove(bootstrap);
      ctx.emit({ type: "file_changed", path: bootstrap, op: "delete" });
      return {
        output:
          "Setup is finished: BOOTSTRAP.md is gone and you are marked as set up. Carry on with whatever they asked for.",
      };
    },
  };
}
