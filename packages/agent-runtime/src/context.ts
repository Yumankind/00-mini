/**
 * What the model sees this turn — and, much more importantly, what it does NOT.
 *
 * The rule this module exists to enforce (docs/HANDOFF-infinite-agent.md §2): the agent never
 * receives the filesystem. It receives its identity files, its memory INDEX, the operating rules,
 * and a bounded picture of where it is standing. `memory/` notes are RETRIEVED by search when a
 * question needs them; bulk-injecting them is how a 300-note agent stops fitting in a phone's local
 * model, and how one stale note outweighs the ten fresh ones nobody read.
 *
 * The tree is bounded exactly as the engine bounds it (`buildWorkspaceTree` in platform-doc.ts): top
 * level plus one level of children, twelve per folder, annotated. That is a MAP, not a listing — it
 * tells the agent that `projects/` exists so it knows to look, and it costs the same on an agent with
 * four files and one with forty thousand.
 *
 * The light agent gets none of it: `public/PERSONA.md` and the light rules, full stop. It has no
 * identity files to read (they are the operator's), and its own folder is one conversation deep.
 */
import type { AgentFs } from "@00/agent-fs";
import {
  IDENTITY_FILES,
  MEMORY_INDEX_FILE,
  PUBLIC_PERSONA_MAX,
  WORKSPACE_NOTES,
  buildFullRules,
  buildLightRules,
  type FullRulesOptions,
  type LightRulesOptions,
} from "./prompt-text.js";
import { normalizeSandbox } from "./sandbox.js";
import { onboardingState } from "./tools-onboarding.js";

/** Identity files ride EVERY turn, so one that grew to a novel would tax every prompt. */
export const IDENTITY_FILE_MAX_CHARS = 16000;
/** MEMORY.md is an index; an index that needs more than this has stopped being one. */
export const MEMORY_INDEX_MAX_CHARS = 8000;
const TREE_CHILDREN_SHOWN = 12;

/**
 * ── THE TOKEN BUDGET (2026-09-11) ──────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. The caps above are per-FILE and they were never a budget: five identity files at
 * 16 KB each, a tree, a memory index and the rules can be individually legal and collectively wider
 * than the whole context of the model about to read them. That is what happened — a 5.2k-token
 * system prompt in front of a LiteRT row that asks for 4096 tokens of KV cache at load, so the
 * default local brain failed on EVERY turn, before the conversation had said a word.
 *
 * HOW TOKENS ARE COUNTED: `chars / 3.5`, rounded up, and nothing else. It is a HEURISTIC and it is
 * named as one everywhere it appears. A real tokenizer would be a dependency (a different one per
 * model family), megabytes of vocabulary in a browser bundle, for a number this only needs to the
 * nearest ten percent — it decides what to drop, not what to send. English prose is ~4 chars a
 * token and Markdown with punctuation and paths is denser, so 3.5 errs toward over-counting, which
 * is the safe direction: over-count and you trim a paragraph you did not have to.
 *
 * WHAT DROPS, IN ORDER (`TRIM_ORDER`), and why that order — cheapest loss first:
 *   1. the tree below the top level  — the MAP survives; the map is what tells the agent to look
 *   2. the memory index past 20 lines — it is an index of an index by then
 *   3. TOOLS.md                       — notes ABOUT tools, while every tool carries its own
 *   4. the shell paragraph's examples — the rule stays, the illustrations go
 *   5. USER.md / SOUL.md past 1200 chars each — who the person is, in the first paragraph
 *   6. the onboarding interview, condensed to three lines
 * THE RULES BLOCK AND IDENTITY.md NEVER DROP. The rules are what makes this an agent on 00 rather
 * than a chat model with a filesystem, and IDENTITY.md is who it is: an agent that forgets its own
 * name to fit a tree listing has been trimmed in the wrong place.
 */
export const CHARS_PER_TOKEN = 3.5;

/** Tokens in a string, by the /3.5 heuristic. Rounded up: a budget is not a place to be optimistic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** What each stage drops, in the order it is dropped. The names are what a `context_trimmed` reports. */
export const TRIM_ORDER = ["tree-children", "memory-index", "TOOLS.md", "shell-examples", "identity-files", "onboarding"] as const;
export type TrimStage = (typeof TRIM_ORDER)[number];

/** Lines of MEMORY.md that survive stage 2. */
export const MEMORY_INDEX_TRIM_LINES = 20;
/** Characters of USER.md and SOUL.md that survive stage 5. */
export const IDENTITY_TRIM_CHARS = 1200;
/** The identity files stage 5 cuts, and the one it never touches. */
export const TRIMMABLE_IDENTITY_FILES = ["USER.md", "SOUL.md"] as const;
const TRIM_MARK = "\n…trimmed…";

export interface ContextBudget {
  /** Tokens the SYSTEM PROMPT may use — the runtime hands over 45% of the model row's context. */
  tokens: number;
  /** Called ONCE per build, only when something was dropped. The loop turns it into an event. */
  onTrim?(info: { dropped: string[]; budgetTokens: number; usedTokens: number }): void;
}

export interface ContextManagerOptions {
  trust: "full" | "light";
  /** Agent-root-relative sandbox: `workspace`, or a thread folder for the light agent. */
  sandbox: string;
  now?: () => Date;
  /** Passed through to the rules text so it never names a tool this run did not register. */
  toolNames?: string[];
  /** Full agent only. */
  shell?: FullRulesOptions["shell"];
  secretNames?: string[];
  /** Force the first-run interview on or off; read from the workspace when absent (see fullBlocks). */
  onboarding?: boolean;
  /** Where `profile.json` lives, relative to the agent root. Only a test moves it. */
  profilePath?: string;
  /** Light agent only. */
  light?: Omit<LightRulesOptions, "persona" | "toolNames" | "nowIso">;
  /** Appended verbatim at the end (the PWA's own additions, a skill's preamble). */
  extra?: string;
}

/** The full prompt before it is joined — the shape the fitter takes apart. */
interface FullDraft {
  docSlugs: string[];
  onboarding: boolean;
  onboardingBrief: boolean;
  shellExamples: boolean;
  /** Whether THIS host's shell paragraph renders examples at all (only two of the four do). */
  hasShellExamples: boolean;
  identity: { name: string; body: string }[];
  memory: string;
  current: string;
  tree: { full: string; top: string };
  treeChildren: boolean;
}

/** Head of a string with the cut marked, or the string when there was nothing to cut. */
function head(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return null;
  return `${text.slice(0, maxChars).trimEnd()}${TRIM_MARK}`;
}

/**
 * Apply ONE stage to the draft. Returns whether it actually gave anything up — a stage that had
 * nothing to drop is skipped silently rather than reported as a loss the agent did not take.
 */
function trimStage(draft: FullDraft, stage: TrimStage): boolean {
  switch (stage) {
    case "tree-children": {
      if (!draft.treeChildren || draft.tree.top === draft.tree.full) return false;
      draft.treeChildren = false;
      return true;
    }
    case "memory-index": {
      const lines = draft.memory.split("\n");
      if (lines.length <= MEMORY_INDEX_TRIM_LINES) return false;
      draft.memory = `${lines.slice(0, MEMORY_INDEX_TRIM_LINES).join("\n")}${TRIM_MARK}`;
      return true;
    }
    case "TOOLS.md": {
      const before = draft.identity.length;
      draft.identity = draft.identity.filter((file) => file.name !== "TOOLS.md");
      return draft.identity.length !== before;
    }
    case "shell-examples": {
      // Only two of the four shell paragraphs HAVE examples; on the other two this stage would
      // report a drop that saved nothing.
      if (!draft.hasShellExamples || !draft.shellExamples) return false;
      draft.shellExamples = false;
      return true;
    }
    case "identity-files": {
      let cut = false;
      for (const file of draft.identity) {
        if (!(TRIMMABLE_IDENTITY_FILES as readonly string[]).includes(file.name)) continue;
        const shorter = head(file.body, IDENTITY_TRIM_CHARS);
        if (!shorter) continue;
        file.body = shorter;
        cut = true;
      }
      return cut;
    }
    default: {
      if (!draft.onboarding || draft.onboardingBrief) return false;
      draft.onboardingBrief = true;
      return true;
    }
  }
}

export class ContextManager {
  private readonly sandbox: string;
  private readonly now: () => Date;

  constructor(
    private readonly fs: AgentFs,
    private readonly opts: ContextManagerOptions,
  ) {
    this.sandbox = normalizeSandbox(opts.sandbox);
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * The system prompt for this turn — FITTED to `budget` when the caller passes one.
   *
   * Without a budget nothing is dropped and the answer is exactly what it always was, which is what
   * keeps every existing caller (and the light agent) unchanged. With one, the stages of
   * `TRIM_ORDER` are applied in order until the estimate fits, and `onTrim` is called once with
   * everything that went.
   */
  async system(budget?: ContextBudget): Promise<string> {
    if (this.opts.trust === "light") {
      // Nothing in `TRIM_ORDER` exists in the light prompt: it is the rules plus a persona already
      // capped at PUBLIC_PERSONA_MAX, and there is no identity, no memory and no tree to give up.
      const blocks = await this.lightBlocks();
      if (this.opts.extra) blocks.push(this.opts.extra);
      return blocks.filter(Boolean).join("\n\n");
    }
    const draft = await this.fullDraft();
    if (!budget) return this.assemble(draft);

    const dropped: string[] = [];
    let text = this.assemble(draft);
    for (const stage of TRIM_ORDER) {
      if (estimateTokens(text) <= budget.tokens) break;
      // A stage with nothing to give up is not a drop, and must not be reported as one — an agent
      // with no TOOLS.md did not lose its TOOLS.md.
      if (!trimStage(draft, stage)) continue;
      dropped.push(stage);
      text = this.assemble(draft);
    }
    if (dropped.length) budget.onTrim?.({ dropped, budgetTokens: budget.tokens, usedTokens: estimateTokens(text) });
    return text;
  }

  /** The blocks, still addressable — so the fitter can take one apart rather than re-read the disk. */
  private async fullDraft(): Promise<FullDraft> {
    const docSlugs = await this.docSlugs();
    /**
     * WHETHER THE INTERVIEW STILL HAS TO HAPPEN is read off the disk every turn, not cached and not
     * passed in (gap B13). Two files have to agree — `workspace/BOOTSTRAP.md` exists AND
     * `profile.json` says `onboarded: false` — and both change during the run that finishes setup,
     * so the very next turn stops leading with the interview without anything having to invalidate
     * anything. A host may still force it either way with `onboarding`, which is what a test does.
     */
    const onboarding =
      this.opts.onboarding ??
      (await onboardingState(this.fs, this.sandbox, this.opts.profilePath).catch(() => ({ pending: false }))).pending;
    const identity: { name: string; body: string }[] = [];
    for (const name of IDENTITY_FILES) {
      const body = await this.readCapped(`${this.sandbox}/${name}`, IDENTITY_FILE_MAX_CHARS);
      if (body) identity.push({ name, body });
    }
    const shell = this.opts.shell ?? "none";
    const bashRegistered = this.opts.toolNames?.includes("bash") ?? false;
    return {
      docSlugs,
      onboarding,
      onboardingBrief: false,
      shellExamples: true,
      hasShellExamples: shell === "wasm" || (shell === "none" && !bashRegistered),
      identity,
      memory: await this.readCapped(`${this.sandbox}/${MEMORY_INDEX_FILE}`, MEMORY_INDEX_MAX_CHARS),
      current: await this.currentContext(),
      tree: await this.tree(),
      treeChildren: true,
    };
  }

  private assemble(draft: FullDraft): string {
    const blocks = [
      buildFullRules({
        shell: this.opts.shell,
        hasDocs: draft.docSlugs.length > 0,
        docSlugs: draft.docSlugs,
        secretNames: this.opts.secretNames,
        toolNames: this.opts.toolNames,
        onboarding: draft.onboarding,
        onboardingBrief: draft.onboardingBrief,
        shellExamples: draft.shellExamples,
      }),
      ...draft.identity.map((file) => `# ${file.name}\n\n${file.body}`),
      draft.memory ? `# MEMORY.md — the INDEX of your memory (the notes are in \`memory/\`)\n\n${draft.memory}` : "",
      draft.current,
      draft.treeChildren ? draft.tree.full : draft.tree.top,
    ];
    if (this.opts.extra) blocks.push(this.opts.extra);
    return blocks.filter(Boolean).join("\n\n");
  }

  private async lightBlocks(): Promise<string[]> {
    // `workspace/public/` is the ONLY thing of the operator's this agent can see — and the persona is
    // the only part of it that rides every turn. Same file, same cap, same placement as the engine.
    const persona = await this.readCapped("workspace/public/PERSONA.md", PUBLIC_PERSONA_MAX);
    return [
      buildLightRules({
        ...this.opts.light,
        nowIso: this.now().toISOString(),
        persona: persona || undefined,
        toolNames: this.opts.toolNames,
      }),
    ];
  }

  private async currentContext(): Promise<string> {
    const lines = [
      "# Current context",
      `- Now: ${this.now().toISOString()}`,
      "- Host: a browser tab on this person's device. Everything here is local unless a tool says otherwise.",
      `- Your sandbox: \`${this.sandbox}/\``,
    ];
    if (this.opts.toolNames?.length) lines.push(`- Tools this session: ${this.opts.toolNames.join(", ")}`);
    const skills = await this.skillLine();
    if (skills) lines.push(skills);
    return lines.join("\n");
  }

  /** Installed skills, by name — the list the engine puts in `buildRuntimeContext`. Names only. */
  private async skillLine(): Promise<string | null> {
    const entries = await this.list(`${this.sandbox}/skills`);
    const names = entries.filter((e) => e.kind === "dir").map((e) => e.name);
    if (!names.length) return null;
    return `- Installed skills (auto-loaded from skills/ — FOLLOW their steps yourself; answer "what can you do" from this list): ${names.join(", ")}`;
  }

  private async docSlugs(): Promise<string[]> {
    // The engine syncs docs/ into the workspace each session; a browser agent only has them if its
    // bundle carried them. Absent is normal, and the prompt must not promise a file that isn't there.
    const entries = await this.list(`${this.sandbox}/docs`);
    return entries
      .filter((e) => e.kind === "file" && e.name.endsWith(".md") && e.name !== "index.md")
      .map((e) => e.name.slice(0, -3))
      .sort();
  }

  /**
   * Top level plus one level of children, annotated — the engine's tree, same bounds.
   *
   * Built in two readings at once, because the fitter needs both and the filesystem walk is the
   * expensive half: `full` is the tree as it has always been, `top` is the same tree WITHOUT the
   * child lines — still a map of where everything is, which is the part that earns its tokens.
   */
  private async tree(): Promise<{ full: string; top: string }> {
    const header = "# Your workspace (this is your sandbox — full read/write)";
    const lines = [header];
    const topLines = [header];
    const top = (await this.list(this.sandbox)).filter((e) => !e.name.startsWith("."));
    top.sort((a, b) =>
      (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    for (let i = 0; i < top.length; i++) {
      const entry = top[i];
      const last = i === top.length - 1;
      const note = WORKSPACE_NOTES[entry.name];
      const line = `${last ? "└─" : "├─"} ${entry.kind === "dir" ? `${entry.name}/` : entry.name}${note ? `  — ${note}` : ""}`;
      lines.push(line);
      topLines.push(line);
      if (entry.kind !== "dir") continue;
      const prefix = last ? "   " : "│  ";
      const kids = (await this.list(`${this.sandbox}/${entry.name}`))
        .filter((k) => !k.name.startsWith("."))
        .map((k) => (k.kind === "dir" ? `${k.name}/` : k.name))
        .sort();
      const shown = kids.slice(0, TREE_CHILDREN_SHOWN);
      shown.forEach((k, j) => {
        const kLast = j === shown.length - 1 && kids.length <= TREE_CHILDREN_SHOWN;
        lines.push(`${prefix}${kLast ? "└─" : "├─"} ${k}`);
      });
      if (kids.length > TREE_CHILDREN_SHOWN) {
        lines.push(`${prefix}   …and ${kids.length - TREE_CHILDREN_SHOWN} more`);
      }
    }
    // The two JOB folders are how an agent arranges its own future work, and an empty folder is not
    // there to be listed — so an agent that has never written one would never learn it could.
    for (const name of ["schedules", "watchers"] as const) {
      if (top.some((e) => e.name === name)) continue;
      const line = `   (no ${name}/ yet — create it whenever you want one: ${WORKSPACE_NOTES[name]})`;
      lines.push(line);
      topLines.push(line);
    }
    return { full: lines.join("\n"), top: topLines.join("\n") };
  }

  private async list(path: string): Promise<{ name: string; kind: "file" | "dir" }[]> {
    try {
      return (await this.fs.readdir(path)).map((e) => ({ name: e.name, kind: e.kind }));
    } catch {
      return []; // an absent folder is the common case, not an error
    }
  }

  private async readCapped(path: string, maxChars: number): Promise<string> {
    try {
      const raw = (await this.fs.readText(path)).trim();
      if (!raw) return "";
      return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…(truncated)` : raw;
    } catch {
      return "";
    }
  }
}
