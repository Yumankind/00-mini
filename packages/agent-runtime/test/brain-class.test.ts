/**
 * `classifyCall` is a pure function of five facts, so it is tested EXHAUSTIVELY rather than by
 * example: every combination of the five is listed with the class it must answer, and a guard
 * asserts the table covers the whole product. The expectations are written out by hand on purpose —
 * a table computed from a second copy of the rule tests that two copies agree, not that either is
 * right.
 */
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOL_NAMES, SHORT_PROMPT_CHARS, classifyCall, isReadOnlyTool, type BrainCallContext } from "../src/index.js";
import { LIGHT_TOOL_NAMES } from "../src/index.js";

const TRUSTS = ["full", "light"] as const;
const TOOLSETS = {
  none: [] as string[],
  read: ["read", "grep", "find"],
  writing: ["read", "write", "bash"],
} as const;
const STEPS = [1, 2] as const;
const AFTER = [false, true] as const;
const PROMPTS = { short: 10, long: SHORT_PROMPT_CHARS + 1 } as const;

type Key = `${(typeof TRUSTS)[number]}|${keyof typeof TOOLSETS}|step${(typeof STEPS)[number]}|after${boolean}|${keyof typeof PROMPTS}`;

/**
 * The whole rule, as 48 answers.
 *
 * Read the `light` half first: every `light` row whose tools are `none` or `read` is `small`,
 * whatever the step, whatever the prompt, whatever came back from a tool — that is rule 1, the
 * whole-exchange rule, and this table is where it is visible. A `light` agent holding a writing tool
 * is not a shape the runtime's allowlist can produce, but the function is total, so it is listed and
 * it behaves like the full agent.
 */
const EXPECTED: Record<Key, "small" | "strong"> = {
  // ── full trust, no tools ──────────────────────────────────────────────────────────────────────
  "full|none|step1|afterfalse|short": "small", // the level-0 Q&A shape, and the only `small` a full agent gets
  "full|none|step1|afterfalse|long": "strong", // a long prompt is a task description, not a question
  "full|none|step1|aftertrue|short": "strong", // planning over an observation, even with no tools left registered
  "full|none|step1|aftertrue|long": "strong",
  "full|none|step2|afterfalse|short": "strong", // a continued turn is not a Q&A
  "full|none|step2|afterfalse|long": "strong",
  "full|none|step2|aftertrue|short": "strong",
  "full|none|step2|aftertrue|long": "strong",
  // ── full trust, read/search tools only ────────────────────────────────────────────────────────
  "full|read|step1|afterfalse|short": "strong", // tools registered at all means the answer may be an action
  "full|read|step1|afterfalse|long": "strong",
  "full|read|step1|aftertrue|short": "strong",
  "full|read|step1|aftertrue|long": "strong",
  "full|read|step2|afterfalse|short": "strong",
  "full|read|step2|afterfalse|long": "strong",
  "full|read|step2|aftertrue|short": "strong",
  "full|read|step2|aftertrue|long": "strong",
  // ── full trust, tools that write ──────────────────────────────────────────────────────────────
  "full|writing|step1|afterfalse|short": "strong",
  "full|writing|step1|afterfalse|long": "strong",
  "full|writing|step1|aftertrue|short": "strong",
  "full|writing|step1|aftertrue|long": "strong",
  "full|writing|step2|afterfalse|short": "strong",
  "full|writing|step2|afterfalse|long": "strong",
  "full|writing|step2|aftertrue|short": "strong",
  "full|writing|step2|aftertrue|long": "strong",
  // ── light trust, no tools ─────────────────────────────────────────────────────────────────────
  "light|none|step1|afterfalse|short": "small",
  "light|none|step1|afterfalse|long": "small",
  "light|none|step1|aftertrue|short": "small",
  "light|none|step1|aftertrue|long": "small",
  "light|none|step2|afterfalse|short": "small",
  "light|none|step2|afterfalse|long": "small",
  "light|none|step2|aftertrue|short": "small",
  "light|none|step2|aftertrue|long": "small",
  // ── light trust, read/search tools only — the embed's whole shape ─────────────────────────────
  "light|read|step1|afterfalse|short": "small",
  "light|read|step1|afterfalse|long": "small",
  "light|read|step1|aftertrue|short": "small",
  "light|read|step1|aftertrue|long": "small",
  "light|read|step2|afterfalse|short": "small",
  "light|read|step2|afterfalse|long": "small",
  "light|read|step2|aftertrue|short": "small",
  "light|read|step2|aftertrue|long": "small",
  // ── light trust holding a tool that writes — not a shape the allowlist allows, still answered ─
  "light|writing|step1|afterfalse|short": "strong",
  "light|writing|step1|afterfalse|long": "strong",
  "light|writing|step1|aftertrue|short": "strong",
  "light|writing|step1|aftertrue|long": "strong",
  "light|writing|step2|afterfalse|short": "strong",
  "light|writing|step2|afterfalse|long": "strong",
  "light|writing|step2|aftertrue|short": "strong",
  "light|writing|step2|aftertrue|long": "strong",
};

function contexts(): { key: Key; ctx: BrainCallContext }[] {
  const out: { key: Key; ctx: BrainCallContext }[] = [];
  for (const trust of TRUSTS) {
    for (const tools of Object.keys(TOOLSETS) as (keyof typeof TOOLSETS)[]) {
      for (const step of STEPS) {
        for (const afterToolResult of AFTER) {
          for (const prompt of Object.keys(PROMPTS) as (keyof typeof PROMPTS)[]) {
            out.push({
              key: `${trust}|${tools}|step${step}|after${afterToolResult}|${prompt}`,
              ctx: { trust, toolNames: TOOLSETS[tools], step, afterToolResult, promptChars: PROMPTS[prompt] },
            });
          }
        }
      }
    }
  }
  return out;
}

describe("classifyCall, exhaustively", () => {
  it("covers every combination of the five facts, and nothing else", () => {
    const keys = contexts().map((c) => c.key);
    expect(keys.length).toBe(TRUSTS.length * 3 * STEPS.length * AFTER.length * 2);
    expect(keys.length).toBe(48);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const { key, ctx } of contexts()) {
    it(`${key} → ${EXPECTED[key]}`, () => {
      expect(classifyCall(ctx)).toBe(EXPECTED[key]);
    });
  }

  it("is pure: the same context answers the same class, every time", () => {
    const ctx: BrainCallContext = { trust: "full", toolNames: [], step: 1, afterToolResult: false, promptChars: 10 };
    expect([classifyCall(ctx), classifyCall(ctx), classifyCall(ctx)]).toEqual(["small", "small", "small"]);
  });
});

describe("the short-prompt threshold", () => {
  it("is the boundary it says it is: 280 is short, 281 is not", () => {
    const base = { trust: "full", toolNames: [], step: 1, afterToolResult: false } as const;
    expect(SHORT_PROMPT_CHARS).toBe(280);
    expect(classifyCall({ ...base, promptChars: SHORT_PROMPT_CHARS })).toBe("small");
    expect(classifyCall({ ...base, promptChars: SHORT_PROMPT_CHARS + 1 })).toBe("strong");
    expect(classifyCall({ ...base, promptChars: 0 })).toBe("small");
  });
});

describe("what counts as a read", () => {
  it("holds the whole light allowlist — the two lists cannot drift apart", () => {
    for (const name of LIGHT_TOOL_NAMES) expect(isReadOnlyTool(name)).toBe(true);
  });

  it("holds the embed's site and page tools of §5.2.2", () => {
    for (const name of ["site_pages", "site_search", "site_grep", "site_crawl", "page_current", "page_open", "page_scroll_to", "page_highlight", "page_describe"]) {
      expect(isReadOnlyTool(name)).toBe(true);
    }
  });

  it("does NOT hold the tools that leave the page or the workspace", () => {
    for (const name of ["write", "edit", "bash", "remember", "git_commit", "send_to_owner"]) {
      expect(isReadOnlyTool(name)).toBe(false);
    }
  });

  it("treats a name it has never heard of as more than a read, which errs towards the better brain", () => {
    expect(isReadOnlyTool("site_purchase")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES).not.toContain("send_to_owner");
    expect(classifyCall({ trust: "light", toolNames: ["read", "brand_new_tool"], step: 1, afterToolResult: false, promptChars: 5 })).toBe(
      "strong",
    );
  });
});
