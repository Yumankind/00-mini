/**
 * WHICH BRAIN THIS CALL WANTS — §6 of docs/HANDOFF-infinite-agent.md, made into one function.
 *
 * §6 says the router picks "by request class: small local for search, edits and navigation; the
 * strongest available for planning and code". Until now `auto` meant "the first ready provider",
 * and the gap was honest but real (finding 5). The thing that was missing was never the router: it
 * was a per-call class, and the reason nobody wrote one is that "is this prompt about code?" is not
 * answerable from a string. So this file does not try. It classifies the SHAPE OF THE CALL, which
 * the loop knows exactly, and every input is a fact rather than a guess.
 *
 * THE RULE, in the order it is applied — the first line that matches wins:
 *
 *   1. LIGHT AND LIGHT-HANDED → small. Trust is `light` and every registered tool only reads,
 *      searches or navigates (the allowlist below). This is the embedded agent of §5, whose whole
 *      level-0 shape is a small local model answering questions about a website, and it is a
 *      WHOLE-EXCHANGE rule rather than a per-call one: the turns that follow a `site_search` are
 *      still the same small exchange, and promoting them would put a stranger's page questions on
 *      the owner's strongest brain. The light agent cannot write, cannot shell out and cannot reach
 *      another conversation, so there is nothing here for a stronger brain to do.
 *   2. AFTER AN OBSERVATION → strong. Any call that follows a tool result is the model planning over
 *      what came back — reading a file it just listed, deciding what the grep means, writing the
 *      code. That is the half of the loop §6 names as the strong one, and it is where the small
 *      brains actually fall over: an 0.6B model summarises an observation, it does not plan on one.
 *   3. THE FIRST CALL → strong when tools are registered at all, or when the prompt is longer than
 *      `SHORT_PROMPT_CHARS`. Tools present means the answer may be an action, and choosing an action
 *      is planning; a long prompt is a person describing a task rather than asking a question. With
 *      neither — no tools, a short prompt — it is the level-0 Q&A shape, and that is `small`.
 *   4. ANYTHING ELSE → strong. A continued turn that did not follow a tool result is not a Q&A, and
 *      the loop never produces one today; the line exists so this function is total.
 *
 * WHERE IT ERRS, deliberately: towards `strong`. A class is a PREFERENCE, not a cap — the picker
 * falls back to whatever is ready — so the cost of guessing `strong` for a question is one answer
 * from a bigger model, and the cost of guessing `small` for a plan is an agent that cannot do the
 * job it was asked for. `RunOptions.brain` overrides all of it in both directions.
 *
 * Pure: same context in, same class out, no clock, no I/O, nothing remembered between calls.
 */
import type { ModelClass } from "@00/agent-models";

/**
 * Longer than this and the first call is planning, not a question.
 *
 * 280 characters is a deliberate borrow: it is the length at which people stop asking and start
 * describing, and it comfortably holds every question the embed was built for ("where do I change my
 * password", "do you ship to Portugal"). It is not tuned against a corpus and does not pretend to
 * be; it is the one number in this file, and it is stated so it can be argued with.
 */
export const SHORT_PROMPT_CHARS = 280;

/**
 * Tools that only READ, SEARCH or NAVIGATE — the ones §6 names as small work.
 *
 * The first five are `LIGHT_TOOL_NAMES` from tools.ts, this package's security-critical allowlist.
 * The rest are the embed's site and page tools (§5.2.2), which live in `apps/infinite/embed` and so
 * cannot be imported here; they are listed by name because the contract lists them by name, and
 * because the alternative — a prefix match on `site_`/`page_` — would silently admit whatever the
 * embed adds next. `send_to_owner` is deliberately absent: it is the one tool in that table that
 * leaves the page, and it is `confirm`-tier for the same reason.
 *
 * An unknown name is NOT read-only. A tool this list has never heard of is treated as more than a
 * read, which errs towards the stronger brain — the safe direction (see the module note).
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "read",
  "ls",
  "grep",
  "find",
  "read_public",
  // Added with the tool round of 2026-09-10 (B9, B14). Both only look: `stat` answers "does this
  // exist and how big is it", `search_workspace` ranks passages the agent has already written.
  // `list_secrets`, `http_get` and the four mutating file tools are deliberately NOT here — one
  // reads the vault's shape, one leaves the page, and the rest change the disk.
  "stat",
  "search_workspace",
  "site_pages",
  "site_search",
  "site_grep",
  "site_crawl",
  "page_current",
  "page_open",
  "page_scroll_to",
  "page_highlight",
  "page_describe",
];

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.includes(name);
}

/** Everything the rule above needs, and nothing the loop does not already hold. */
export interface BrainCallContext {
  /** Which model call of THIS run is about to be made; 1 is the first. */
  step: number;
  /** True when the last thing in the transcript is a tool result. */
  afterToolResult: boolean;
  /** The tool names actually registered for this run, after `RunOptions.tools` filtering. */
  toolNames: readonly string[];
  /** The person's prompt, in characters. */
  promptChars: number;
  /** `full` is the agent you own, `light` is the agent on someone else's website. */
  trust: "full" | "light";
}

/** The rule stated above, and nothing else. */
export function classifyCall(ctx: BrainCallContext): ModelClass {
  if (ctx.trust === "light" && ctx.toolNames.every(isReadOnlyTool)) return "small";
  if (ctx.afterToolResult) return "strong";
  if (ctx.step <= 1) return ctx.toolNames.length > 0 || ctx.promptChars > SHORT_PROMPT_CHARS ? "strong" : "small";
  return "strong";
}
