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

  /** The system prompt for this turn. */
  async system(): Promise<string> {
    const blocks =
      this.opts.trust === "light" ? await this.lightBlocks() : await this.fullBlocks();
    if (this.opts.extra) blocks.push(this.opts.extra);
    return blocks.filter(Boolean).join("\n\n");
  }

  private async fullBlocks(): Promise<string[]> {
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
    const blocks = [
      buildFullRules({
        shell: this.opts.shell,
        hasDocs: docSlugs.length > 0,
        docSlugs,
        secretNames: this.opts.secretNames,
        toolNames: this.opts.toolNames,
        onboarding,
      }),
    ];
    for (const name of IDENTITY_FILES) {
      const body = await this.readCapped(`${this.sandbox}/${name}`, IDENTITY_FILE_MAX_CHARS);
      if (body) blocks.push(`# ${name}\n\n${body}`);
    }
    const memory = await this.readCapped(`${this.sandbox}/${MEMORY_INDEX_FILE}`, MEMORY_INDEX_MAX_CHARS);
    if (memory) {
      blocks.push(
        `# MEMORY.md — the INDEX of your memory\n\nThe notes themselves are in \`memory/\`. Search for the one you need (grep/find); they are never loaded whole.\n\n${memory}`,
      );
    }
    blocks.push(await this.currentContext());
    blocks.push(await this.tree());
    return blocks;
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

  /** Top level plus one level of children, annotated — the engine's tree, same bounds. */
  private async tree(): Promise<string> {
    const lines = ["# Your workspace (this is your sandbox — full read/write)"];
    const top = (await this.list(this.sandbox)).filter((e) => !e.name.startsWith("."));
    top.sort((a, b) =>
      (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    for (let i = 0; i < top.length; i++) {
      const entry = top[i];
      const last = i === top.length - 1;
      const note = WORKSPACE_NOTES[entry.name];
      lines.push(`${last ? "└─" : "├─"} ${entry.kind === "dir" ? `${entry.name}/` : entry.name}${note ? `  — ${note}` : ""}`);
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
      lines.push(`   (no ${name}/ yet — create it whenever you want one: ${WORKSPACE_NOTES[name]})`);
    }
    return lines.join("\n");
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
