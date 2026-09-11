/**
 * THE LANDING AGENT'S FIVE TOOLS, against a fake page — the same trick `test/embed/tools.test.ts`
 * plays, and for the same reason: the whole table is policy, and policy does not need a browser.
 *
 * The section resolver is the interesting half. A person asks "where do I set the vault?", and the
 * model answers with whatever word it heard; if `vault`, `#vault` and the section's own heading do
 * not all land on the same anchor, the page does not move and the demo is a paragraph.
 */
import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@00/agent-runtime";
import type { CurrentPage, PageBridge } from "../embed/src/page/bridge.js";
import {
  PAGE_TOOL_NAMES,
  buildPageTools,
  installPageTools,
  uninstallPageTools,
  landingContext,
  resolveSection,
  splitLandingContext,
  withLandingContext,
} from "../src/mini/page-tools.js";
import { LANDING_SECTIONS, sectionMapLine } from "../src/landing/sections.js";

function fakePage(overrides: Partial<PageBridge> = {}): PageBridge & { calls: string[] } {
  const calls: string[] = [];
  const current: CurrentPage = {
    url: "https://0-0.chat/",
    title: "00 Mini",
    tree: [{ ref: "e1", role: "heading", name: "An AI agent you don't install", level: 1 }],
    scroll: { y: 0, height: 4000, percent: 0 },
    authState: "anon",
  };
  return {
    calls,
    current: () => current,
    open: (url) => {
      calls.push(`open ${url}`);
      return { ok: true, message: `opening ${url}` };
    },
    scrollTo: (target) => {
      calls.push(`scroll ${target}`);
      return target.startsWith("#");
    },
    highlight: (target, note) => {
      calls.push(`highlight ${target}${note ? ` "${note}"` : ""}`);
      return target.startsWith("#");
    },
    describe: (target) => (target === "#vault" ? `section "Encrypted at rest"` : null),
    clearHighlights: () => calls.push("clear"),
    ...overrides,
  } as PageBridge & { calls: string[] };
}

const run = (tools: Tool[], name: string, args: Record<string, unknown> = {}) => {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, {} as never);
};

describe("resolveSection", () => {
  it("takes the anchor, the id, the heading, or a sentence that contains one", () => {
    expect(resolveSection("#vault")?.id).toBe("vault");
    expect(resolveSection("vault")?.id).toBe("vault");
    expect(resolveSection("Encrypted at rest")?.id).toBe("vault");
    expect(resolveSection("the brains section")?.id).toBe("brains");
  });

  it("says no rather than guessing at something the page does not have", () => {
    expect(resolveSection("pricing")).toBeNull();
    expect(resolveSection("  ")).toBeNull();
  });
});

describe("the landing page tools", () => {
  it("are the five of the plan, in order, and every one of them is safe", () => {
    const tools = buildPageTools({ page: fakePage() });
    expect(tools.map((t) => t.schema.name)).toEqual([...PAGE_TOOL_NAMES]);
    for (const tool of tools) expect(tool.tier).toBe("safe");
  });

  it("cannot click, fill or submit — those are absent, not disabled", () => {
    const names = buildPageTools({ page: fakePage() }).map((t) => t.schema.name);
    for (const forbidden of ["page_click", "page_fill", "page_submit", "page_read_value"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("page_current hands over the section map as well as the tree", async () => {
    const result = await run(buildPageTools({ page: fakePage() }), "page_current");
    expect(result.output).toContain("#vault — Encrypted at rest");
    expect(result.output).toContain("e1 heading 1: An AI agent you don't install");
  });

  it("page_scroll turns a section name into its anchor", async () => {
    const page = fakePage();
    const result = await run(buildPageTools({ page }), "page_scroll", { target: "the vault" });
    expect(page.calls).toContain("scroll #vault");
    expect(result.isError).toBeUndefined();
  });

  it("page_highlight reports the miss instead of pretending", async () => {
    const page = fakePage();
    const result = await run(buildPageTools({ page }), "page_highlight", { target: "pricing", note: "here" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("pricing");
  });

  it("page_describe answers about a section it can find", async () => {
    const result = await run(buildPageTools({ page: fakePage() }), "page_describe", { target: "vault" });
    expect(result.output).toContain("Encrypted at rest");
  });

  it("page_open scrolls for an anchor and navigates for a path", async () => {
    const page = fakePage();
    const tools = buildPageTools({ page });
    await run(tools, "page_open", { url: "#brains" });
    await run(tools, "page_open", { url: "/app" });
    expect(page.calls).toEqual(["scroll #brains", "open /app"]);
  });

  it("refuses an empty argument by name", async () => {
    const tools = buildPageTools({ page: fakePage() });
    for (const name of ["page_scroll", "page_highlight", "page_describe", "page_open"]) {
      const result = await run(tools, name, {});
      expect(result.isError, name).toBe(true);
    }
  });
});

describe("the landing context line", () => {
  it("names every anchor the agent can scroll to", () => {
    expect(landingContext()).toContain(sectionMapLine(LANDING_SECTIONS));
  });

  it("rides on the first message of a thread and not the ones after it", () => {
    const first = withLandingContext("where is the vault?", false);
    expect(first.startsWith("[You are the 00 Mini widget")).toBe(true);
    expect(withLandingContext("and the brains?", true)).toBe("and the brains?");
  });

  it("splits back off for drawing, without changing what was said", () => {
    const sent = withLandingContext("where is the vault?", false);
    const split = splitLandingContext(sent);
    expect(split.message).toBe("where is the vault?");
    expect(split.context).toContain("#vault");
    expect(splitLandingContext("plain words").context).toBeNull();
  });
});

describe("installPageTools", () => {
  it("reports the gap rather than pretending, when the runtime has no door", () => {
    const report = installPageTools({ run: () => undefined }, buildPageTools({ page: fakePage() }));
    expect(report.installed).toBe(false);
    expect(report.detail).toContain("setExtraTools");
    expect(report.names).toEqual([...PAGE_TOOL_NAMES]);
  });

  it("hands the five tools through setExtraTools, and takes them away with an empty list", () => {
    const setExtraTools = vi.fn();
    const report = installPageTools({ setExtraTools }, buildPageTools({ page: fakePage() }));
    expect(report.installed).toBe(true);
    expect(setExtraTools).toHaveBeenCalledTimes(1);
    expect((setExtraTools.mock.calls[0]![0] as { schema: { name: string } }[]).map((t) => t.schema.name)).toEqual([
      ...PAGE_TOOL_NAMES,
    ]);
    uninstallPageTools({ setExtraTools });
    expect(setExtraTools).toHaveBeenLastCalledWith([]);
  });

  it("survives a runtime that refuses them, and an uninstall on a runtime without the door", () => {
    const report = installPageTools(
      {
        setExtraTools: () => {
          throw new Error('tool "page_open" is already registered');
        },
      },
      buildPageTools({ page: fakePage() }),
    );
    expect(report.installed).toBe(false);
    expect(report.detail).toContain("already registered");
    expect(() => uninstallPageTools({})).not.toThrow();
    expect(() => uninstallPageTools(null)).not.toThrow();
  });
});
