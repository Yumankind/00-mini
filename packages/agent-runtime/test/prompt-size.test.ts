/**
 * THE SIZE OF WHAT THE MODEL IS HANDED, PINNED (2026-09-11).
 *
 * This file exists because the regression it guards was invisible to every other test: nothing was
 * wrong with the prompt except how MUCH of it there was, and no assertion in the suite could see
 * that. A fresh agent's system prompt plus the prompt-based tool block came to 14.2 KB — 4.1k
 * tokens by the /3.5 heuristic — in front of a local brain that asks for 4096 tokens of KV cache at
 * load, leaving nothing for the conversation, the tool results or the answer.
 *
 * Both numbers below are HEADROOM, not targets. The day a rule is genuinely worth adding, the
 * failure here is the conversation about what it replaces.
 */
import { describe, expect, it } from "vitest";
import { fallbackToolPrompt } from "@00/agent-models";
import { ContextManager, SYSTEM_PROMPT_SHARE, estimateTokens, fullTools } from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-11T09:00:00Z");

/** The very first turn of a brand-new agent: the interview is pending and nothing has been written. */
function freshAgent(): MemoryFs {
  return new MemoryFs({
    "workspace/BOOTSTRAP.md": "Ask the person who they are.",
    "workspace/profile.json": JSON.stringify({ onboarded: false }),
  });
}

describe("the prompt a fresh agent is handed", () => {
  it("keeps the FULL DEFAULT TOOL SET's fallback block under 1200 characters", () => {
    const block = fallbackToolPrompt(fullTools().map((tool) => tool.schema));
    // Was 8660 characters (~2.5k tokens) as a schema dump, for twelve tools.
    expect(block.length).toBeLessThan(1200);
    // Still a usable instruction: the shape to write, and every tool by name with its arguments.
    expect(block).toContain('{"tool_call": {"name": "<name>", "arguments": {<args>}}}');
    for (const tool of fullTools()) expect(block, tool.schema.name).toContain(`${tool.schema.name}(`);
  });

  it("keeps the whole thing — system prompt AND tool block — under 2000 tokens", async () => {
    const fs = freshAgent();
    const tools = fullTools({ fs, workspace: "workspace" });
    const toolNames = tools.map((tool) => tool.schema.name);
    const system = await new ContextManager(fs, { trust: "full", sandbox: "workspace", now, toolNames }).system();
    const block = fallbackToolPrompt(tools.map((tool) => tool.schema));
    expect(estimateTokens(system + block)).toBeLessThan(2000);
  });

  it("fits the 45% share of the row the default local brain actually loads (8192 tokens)", async () => {
    const fs = freshAgent();
    const tools = fullTools({ fs, workspace: "workspace" });
    const context = new ContextManager(fs, {
      trust: "full",
      sandbox: "workspace",
      now,
      toolNames: tools.map((tool) => tool.schema.name),
    });
    const tokens = Math.floor(8192 * SYSTEM_PROMPT_SHARE);
    const dropped: string[] = [];
    const fitted = await context.system({ tokens, onTrim: (info) => dropped.push(...info.dropped) });
    // Nothing is given up at all: the fix is that it fits, not that it is cut down to fit.
    expect(dropped).toEqual([]);
    expect(estimateTokens(fitted)).toBeLessThanOrEqual(tokens);
  });

  it("still leaves a phone's 2048-token row room to hold a conversation, after trimming", async () => {
    /**
     * The 270m and 1B rows stay at 2048 on purpose (litert.ts), so this is the tightest host the
     * platform ships to. It CANNOT fit the 45% share — the rules block and IDENTITY.md never drop,
     * and they are most of what is left after the six stages — so what is pinned is the thing that
     * actually matters there: prompt plus tool block leave a quarter of the window for the
     * conversation, where before this round they left none of it (they were twice the window).
     */
    const fs = freshAgent();
    const tools = fullTools({ fs, workspace: "workspace" });
    const context = new ContextManager(fs, {
      trust: "full",
      sandbox: "workspace",
      now,
      toolNames: tools.map((tool) => tool.schema.name),
    });
    const dropped: string[] = [];
    const fitted = await context.system({
      tokens: Math.floor(2048 * SYSTEM_PROMPT_SHARE),
      onTrim: (info) => dropped.push(...info.dropped),
    });
    expect(dropped).toContain("onboarding");
    const spent = estimateTokens(fitted + fallbackToolPrompt(tools.map((tool) => tool.schema)));
    expect(spent).toBeLessThanOrEqual(2048 * 0.75);
    // And the interview still happens: that is the whole of this turn.
    expect(fitted).toContain("FIRST-RUN SETUP");
    expect(fitted).toContain("finish_onboarding");
  });
});
