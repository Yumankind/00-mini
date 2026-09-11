/**
 * FITTING THE SYSTEM PROMPT TO THE BRAIN THAT WILL READ IT (2026-09-11).
 *
 * The regression this pins: a system prompt of ~5.2k tokens in front of a local model whose whole
 * KV cache is 4096 tokens, so every turn failed before the conversation started. The per-file caps
 * in context.ts were never a budget — five legal files are collectively illegal — and this is the
 * budget.
 *
 * Each stage of `TRIM_ORDER` is tested IN ISOLATION, against a filesystem where that stage is the
 * only one with anything to give up, so a passing test names exactly which drop happened rather
 * than asserting on a pile of them. Then one test where everything is droppable, for the order.
 */
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  ContextManager,
  IDENTITY_TRIM_CHARS,
  MEMORY_INDEX_TRIM_LINES,
  TRIM_ORDER,
  estimateTokens,
  type ContextManagerOptions,
} from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-11T09:00:00Z");

/** A drop this small cannot fit anything: it forces every stage that HAS something to give. */
const NOTHING_FITS = { tokens: 1 };

interface Trim {
  dropped: string[];
  budgetTokens: number;
  usedTokens: number;
}

async function build(
  seed: Record<string, string>,
  opts: Partial<ContextManagerOptions> = {},
  budget: { tokens: number } | null = NOTHING_FITS,
): Promise<{ text: string; trims: Trim[] }> {
  const trims: Trim[] = [];
  const ctx = new ContextManager(new MemoryFs(seed), { trust: "full", sandbox: "workspace", now, ...opts });
  const text = await ctx.system(budget ? { ...budget, onTrim: (info) => trims.push(info) } : undefined);
  return { text, trims };
}

/**
 * The BASELINE agent: nothing in it is droppable. No folders (so no tree children), a memory index
 * inside its line budget, no TOOLS.md, short identity files, no interview pending, and the one
 * shell paragraph that renders no examples.
 */
const NOTHING_TO_DROP: Record<string, string> = {
  "workspace/AGENTS.md": "Answer briefly.",
  "workspace/IDENTITY.md": "Name: Ada",
  "workspace/USER.md": "Works for Bruno.",
  "workspace/SOUL.md": "Dry, precise.",
  "workspace/MEMORY.md": "# MEMORY\n- one note",
  "workspace/notes.txt": "loose file, no children to list",
};
const REMOTE_SHELL: Partial<ContextManagerOptions> = { shell: "remote" };

describe("the system prompt fits the model's context, or gives something up", () => {
  it("counts tokens as chars/3.5, rounded up, and says so rather than importing a tokenizer", () => {
    expect(CHARS_PER_TOKEN).toBe(3.5);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(7))).toBe(2);
    expect(estimateTokens("a".repeat(8))).toBe(3);
  });

  it("drops NOTHING and reports nothing when no budget is passed at all", async () => {
    const { text, trims } = await build(NOTHING_TO_DROP, REMOTE_SHELL, null);
    expect(trims).toEqual([]);
    expect(estimateTokens(text)).toBeGreaterThan(1);
  });

  it("drops nothing when the budget is generous", async () => {
    const loose = await build(NOTHING_TO_DROP, REMOTE_SHELL, { tokens: 100_000 });
    const none = await build(NOTHING_TO_DROP, REMOTE_SHELL, null);
    expect(loose.trims).toEqual([]);
    expect(loose.text).toBe(none.text);
  });

  it("reports NOTHING when no stage has anything to give up, however small the budget", async () => {
    // The honest answer to "I cannot fit": the rules and IDENTITY.md are not for sale, so the
    // prompt comes back over budget rather than mutilated — and no drop is claimed that did not
    // happen. An agent with no TOOLS.md did not lose its TOOLS.md.
    const { text, trims } = await build(NOTHING_TO_DROP, REMOTE_SHELL);
    expect(trims).toEqual([]);
    expect(text).toContain("# 00 platform — essentials");
    expect(text).toContain("Name: Ada");
  });

  it("1. drops the tree below its top level, and keeps the map", async () => {
    const seed = { ...NOTHING_TO_DROP };
    for (let i = 0; i < 9; i++) seed[`workspace/projects/site/page${i}.html`] = "x";
    seed["workspace/files/report.pdf"] = "x";
    const { text, trims } = await build(seed, REMOTE_SHELL);
    expect(trims).toHaveLength(1);
    expect(trims[0]?.dropped).toEqual(["tree-children"]);
    expect(trims[0]?.budgetTokens).toBe(1);
    expect(trims[0]?.usedTokens).toBe(estimateTokens(text));
    // The MAP survives — knowing `projects/` exists is what makes the agent look in it.
    expect(text).toContain("projects/  — your work");
    expect(text).toContain("files/");
    // The listing does not.
    expect(text).not.toContain("site/");
    expect(text).not.toContain("report.pdf");
  });

  it("2. drops the memory index past twenty lines, marked", async () => {
    const index = Array.from({ length: 40 }, (_, i) => `- [note ${i}](memory/n${i}.md)`).join("\n");
    const { text, trims } = await build({ ...NOTHING_TO_DROP, "workspace/MEMORY.md": index }, REMOTE_SHELL);
    expect(trims[0]?.dropped).toEqual(["memory-index"]);
    expect(text).toContain(`- [note ${MEMORY_INDEX_TRIM_LINES - 1}](memory/n${MEMORY_INDEX_TRIM_LINES - 1}.md)`);
    expect(text).not.toContain(`- [note ${MEMORY_INDEX_TRIM_LINES}](memory/n${MEMORY_INDEX_TRIM_LINES}.md)`);
    expect(text).toContain("…trimmed…");
  });

  it("3. drops TOOLS.md — notes ABOUT tools, while every tool carries its own description", async () => {
    const { text, trims } = await build({ ...NOTHING_TO_DROP, "workspace/TOOLS.md": "NOTES-ABOUT-TOOLS" }, REMOTE_SHELL);
    expect(trims[0]?.dropped).toEqual(["TOOLS.md"]);
    expect(text).not.toContain("NOTES-ABOUT-TOOLS");
    expect(text).not.toContain("# TOOLS.md");
    // The identity files around it are untouched.
    expect(text).toContain("Answer briefly.");
    expect(text).toContain("Name: Ada");
  });

  it("4. drops the shell paragraph's examples and keeps its rule", async () => {
    // The default host: no shell, and therefore no `bash` tool — the paragraph WITH examples.
    const { text, trims } = await build(NOTHING_TO_DROP);
    expect(trims[0]?.dropped).toEqual(["shell-examples"]);
    expect(text).toContain("There is no shell in this browser, and no `bash` tool.");
    expect(text).toContain("wakes on the operator's Mac");
    expect(text).not.toContain("not `git` on the command line");
  });

  it("4. …and the WASM paragraph's too, while a remote shell has none to drop", async () => {
    const wasm = await build(NOTHING_TO_DROP, { shell: "wasm" });
    expect(wasm.trims[0]?.dropped).toEqual(["shell-examples"]);
    expect(wasm.text).toContain("WASM shell in this tab");
    expect(wasm.text).not.toContain("no package installs");
    // `remote` renders no examples, so this stage must not claim a drop it did not make.
    const remote = await build(NOTHING_TO_DROP, REMOTE_SHELL);
    expect(remote.trims).toEqual([]);
  });

  it("5. cuts USER.md and SOUL.md to their heads, and never touches IDENTITY.md or AGENTS.md", async () => {
    const seed = {
      ...NOTHING_TO_DROP,
      "workspace/USER.md": `USER-HEAD${"u".repeat(4000)}USER-TAIL`,
      "workspace/SOUL.md": `SOUL-HEAD${"s".repeat(4000)}SOUL-TAIL`,
      "workspace/IDENTITY.md": `IDENTITY-HEAD${"i".repeat(4000)}IDENTITY-TAIL`,
      "workspace/AGENTS.md": `AGENTS-HEAD${"a".repeat(4000)}AGENTS-TAIL`,
    };
    const { text, trims } = await build(seed, REMOTE_SHELL);
    expect(trims[0]?.dropped).toEqual(["identity-files"]);
    expect(text).toContain("USER-HEAD");
    expect(text).not.toContain("USER-TAIL");
    expect(text).toContain("SOUL-HEAD");
    expect(text).not.toContain("SOUL-TAIL");
    // WHO IT IS is not for sale, and neither are its own operating instructions.
    expect(text).toContain("IDENTITY-TAIL");
    expect(text).toContain("AGENTS-TAIL");
    // The head is the head, with the cut marked.
    expect(text).toContain(`USER-HEAD${"u".repeat(IDENTITY_TRIM_CHARS - "USER-HEAD".length)}\n…trimmed…`);
  });

  it("6. condenses the first-run interview to three lines, and keeps the instruction", async () => {
    const seed = { ...NOTHING_TO_DROP, "workspace/BOOTSTRAP.md": "steps", "workspace/profile.json": '{"onboarded":false}' };
    const full = await build(seed, REMOTE_SHELL, null);
    const { text, trims } = await build(seed, REMOTE_SHELL);
    expect(trims[0]?.dropped).toEqual(["onboarding"]);
    expect(text).toContain("FIRST-RUN SETUP");
    expect(text).toContain("finish_onboarding");
    // Three lines, not the script: the numbered steps are what went.
    expect(text).not.toContain("1. Read BOOTSTRAP.md");
    expect(text.length).toBeLessThan(full.text.length);
  });

  it("gives things up IN ORDER, one event, when everything is droppable", async () => {
    const seed: Record<string, string> = {
      "workspace/AGENTS.md": "Answer briefly.",
      "workspace/IDENTITY.md": "Name: Ada",
      "workspace/TOOLS.md": "NOTES-ABOUT-TOOLS",
      "workspace/USER.md": `USER-HEAD${"u".repeat(4000)}USER-TAIL`,
      "workspace/SOUL.md": `SOUL-HEAD${"s".repeat(4000)}SOUL-TAIL`,
      "workspace/MEMORY.md": Array.from({ length: 40 }, (_, i) => `- note ${i}`).join("\n"),
      "workspace/BOOTSTRAP.md": "steps",
      "workspace/profile.json": '{"onboarded":false}',
    };
    for (let i = 0; i < 9; i++) seed[`workspace/projects/site/page${i}.html`] = "x";
    const { text, trims } = await build(seed);
    // ONE event, carrying everything that went, in the order it went.
    expect(trims).toHaveLength(1);
    expect(trims[0]?.dropped).toEqual([...TRIM_ORDER]);
    // What never drops, whatever the budget.
    expect(text).toContain("# 00 platform — essentials");
    expect(text).toContain("- **Workspace**");
    expect(text).toContain("Name: Ada");
  });

  it("stops as soon as it fits, rather than spending every stage it has", async () => {
    const seed: Record<string, string> = { ...NOTHING_TO_DROP, "workspace/TOOLS.md": "NOTES-ABOUT-TOOLS" };
    for (let i = 0; i < 9; i++) seed[`workspace/projects/site/page${i}.html`] = "x";
    const whole = await build(seed, REMOTE_SHELL, null);
    // One token under the untrimmed size: the first stage covers it, and the second is never asked.
    const { text, trims } = await build(seed, REMOTE_SHELL, { tokens: estimateTokens(whole.text) - 1 });
    expect(trims[0]?.dropped).toEqual(["tree-children"]);
    expect(text).toContain("NOTES-ABOUT-TOOLS");
    expect(estimateTokens(text)).toBeLessThanOrEqual(estimateTokens(whole.text) - 1);
  });

  it("leaves the light agent's prompt alone: it has nothing on the list to give up", async () => {
    const trims: Trim[] = [];
    const fs = new MemoryFs({ "workspace/public/PERSONA.md": "I am the support desk." });
    const ctx = new ContextManager(fs, { trust: "light", sandbox: "threads/t1", now });
    const text = await ctx.system({ tokens: 1, onTrim: (info) => trims.push(info) });
    expect(trims).toEqual([]);
    expect(text).toContain("# Untrusted inbound conversation");
    expect(text).toContain("I am the support desk.");
  });
});
