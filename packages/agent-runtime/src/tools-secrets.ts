/**
 * `list_secrets` — the ONE tool that touches the vault, and it never touches a value.
 *
 * The prompt has always told the full agent that "the vault holds the operator's keys; you see NAMES
 * ONLY". This is the tool that makes that sentence usable rather than merely true: without it the
 * names came from `ContextManagerOptions.secretNames`, a list the host had to remember to pass, and
 * an agent that had not been passed one believed there were no secrets at all (gap B12).
 *
 * There is deliberately no `get_secret` twin. The value never travels through the model; it is
 * substituted into a tool's arguments at the moment of use and taken back out of the output
 * (secrets.ts). This tool's whole job is to tell the agent which NAMES it may write in a
 * `${secret:NAME}` placeholder, which is the only thing it needs to know.
 *
 * It is `safe`: a name is not a secret, and asking the person to confirm reading a list of names
 * would teach them to click through vault prompts, which is the habit an attacker needs.
 */
import type { Tool } from "./api.js";
import { placeholderFor } from "./secrets.js";

export function listSecretsTool(): Tool {
  return {
    tier: "safe",
    schema: {
      name: "list_secrets",
      description:
        "List the NAMES of the secrets in your operator's vault. Values are never shown — to use one, put ${secret:NAME} inside a string argument of another tool and it is filled in at the moment the tool runs, without the value ever appearing in this conversation.",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      if (!ctx.secrets) return { output: "This host has no vault, so there are no secrets to use." };
      const names = await ctx.secrets.names().catch(() => [] as string[]);
      if (!names.length) return { output: "The vault is empty — no secrets are stored." };
      return {
        output: [
          `${names.length} secret${names.length === 1 ? "" : "s"} (names only):`,
          ...names.map((n) => `- ${n}   use as ${placeholderFor(n)}`),
        ].join("\n"),
      };
    },
  };
}
