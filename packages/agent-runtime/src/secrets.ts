/**
 * `${secret:NAME}` — how a value the model must never see gets into a tool call anyway.
 *
 * THE PROBLEM, stated as the prompt already states it (prompt-text.ts): "you see NAMES ONLY; a tool
 * resolves the value at the moment it is used". Until now that sentence was a promise with nothing
 * behind it (gap B12): the vault was unreachable from `ToolContext`, so a BYOK key could be sealed
 * and never spent. The obvious fix — a `get_secret` tool — is the WRONG fix, and this module exists
 * because of why: the moment a value is a tool RESULT it is in the transcript, in the session file
 * and in the next request's messages, and it is in them forever. Handing a model a key is handing
 * every future turn a key.
 *
 * SO THE VALUE NEVER TRAVELS THROUGH THE MODEL. The model writes the NAME, in a placeholder any
 * string argument may contain:
 *
 *     http_get { url: "https://api.example.com/me?key=${secret:EXAMPLE_KEY}" }
 *
 * and the loop substitutes immediately before `run`, on a COPY of the arguments. The transcript, the
 * permission prompt and the session file keep the placeholder; only the tool's own execution sees
 * the value. On the way back the substitution is REVERSED on the output (`redact`), because a tool
 * that echoes its own input — a shell, an HTTP error quoting the URL — would otherwise put the
 * secret into the transcript by the back door. This is the engine's env-guard idea (`secret-store.ts`
 * plus the `$00_SECRET_` env handoff in apps/00d) with the one difference the browser forces: there
 * are no environment variables here, so the placeholder rides in the arguments instead.
 *
 * WHAT AN UNKNOWN NAME DOES: the call is refused before `run`, with a message that names the
 * placeholder and lists nothing. A locked vault and an absent name are answered identically, so a
 * model cannot use the tool as an oracle for which secrets exist — `list_secrets` is the one place
 * that answers that question, and it is the operator's own agent asking.
 */
import type { SecretsAccess } from "./api.js";

/** `${secret:NAME}` — names are word characters, dots and dashes, as vault names are. */
const PLACEHOLDER = /\$\{secret:([A-Za-z0-9_.:-]+)\}/g;

export function placeholderFor(name: string): string {
  return `\${secret:${name}}`;
}

/** Every secret name a value asks for, deduplicated, in first-seen order. */
export function secretNamesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) secretNamesIn(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) secretNamesIn(item, out);
  }
  return out;
}

export interface ResolvedArgs {
  /** The arguments to run with — a deep copy; the caller's own object is never touched. */
  args: Record<string, unknown>;
  /** name → value for every placeholder that was substituted; empty when there were none. */
  used: Map<string, string>;
  /** Set when a name could not be resolved: the call must be refused with this sentence. */
  error?: string;
}

function substitute(value: unknown, values: Map<string, string>): unknown {
  if (typeof value === "string") return value.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole);
  if (Array.isArray(value)) return value.map((item) => substitute(item, values));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = substitute(item, values);
    return out;
  }
  return value;
}

/**
 * Resolve every `${secret:NAME}` in `args`. With no vault wired, or no placeholder present, the
 * arguments come back unchanged — this is on the path of every tool call and must cost nothing when
 * nobody is using it.
 */
export async function resolveSecretArgs(
  args: Record<string, unknown>,
  secrets: SecretsAccess | undefined,
): Promise<ResolvedArgs> {
  const wanted = secretNamesIn(args);
  if (!wanted.size) return { args, used: new Map() };
  if (!secrets) {
    return {
      args,
      used: new Map(),
      error: `This host has no vault, so ${[...wanted].map(placeholderFor).join(", ")} cannot be resolved. Ask the person to put the value in themselves.`,
    };
  }
  const used = new Map<string, string>();
  for (const name of wanted) {
    const value = await secrets.get(name).catch(() => null);
    if (value === null || value === "") {
      return {
        args,
        used: new Map(),
        error: `No secret is available under ${placeholderFor(name)} — it is not in the vault, or the vault is locked. Do not guess the value; tell the person which name you needed.`,
      };
    }
    used.set(name, value);
  }
  return { args: substitute(args, used) as Record<string, unknown>, used };
}

/**
 * Put every resolved value back to its placeholder. Longest value first, so one secret that contains
 * another cannot leave half of it behind.
 */
export function redact(text: string, used: Map<string, string>): string {
  if (!used.size || !text) return text;
  let out = text;
  for (const [name, value] of [...used].sort((a, b) => b[1].length - a[1].length)) {
    if (!value) continue;
    out = out.split(value).join(placeholderFor(name));
  }
  return out;
}
