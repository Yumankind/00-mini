import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tool, ToolContext } from "@00/agent-runtime";
import { SITE_TOOL_NAMES, buildSiteTools } from "../../embed/src/tools/index.js";
import { SiteIndex } from "../../embed/src/index/site-index.js";
import { MemoryStore } from "../../embed/src/index/store.js";
import { DEFAULT_SITE_CONFIG } from "../../embed/src/site-config.js";
import { createKnowledgeReader } from "../../embed/src/knowledge.js";
import type { CurrentPage, PageBridge } from "../../embed/src/page/bridge.js";
import { entry, fakeFetch } from "./helpers.js";

const ORIGIN = "https://shop.example";

const ctx = (): ToolContext => ({
  fs: undefined as never,
  sandbox: "thread",
  signal: new AbortController().signal,
  emit: () => {},
});

function fakeBridge(): PageBridge & { log: string[] } {
  const log: string[] = [];
  const current: CurrentPage = {
    url: `${ORIGIN}/`,
    title: "Home",
    tree: [{ ref: "e1", role: "button", name: "Sign in" }],
    scroll: { y: 0, height: 2000, percent: 0 },
    authState: "anon",
  };
  return {
    log,
    current: () => {
      log.push("current");
      return current;
    },
    open: (url) => {
      log.push(`open ${url}`);
      return url.startsWith(ORIGIN) ? { ok: true, message: `opening ${url}` } : { ok: false, message: "not this site" };
    },
    scrollTo: (t) => {
      log.push(`scrollTo ${t}`);
      return t === "e1";
    },
    highlight: (t, note) => {
      log.push(`highlight ${t} ${note ?? ""}`.trim());
      return t === "e1";
    },
    describe: (t) => {
      log.push(`describe ${t}`);
      return t === "e1" ? 'button "Sign in"; on screen now' : null;
    },
    clearHighlights: () => log.push("clear"),
  };
}

function build(overrides: Partial<Parameters<typeof buildSiteTools>[0]> = {}): {
  tools: Tool[];
  bridge: ReturnType<typeof fakeBridge>;
  crawled: string[];
} {
  const index = new SiteIndex({ origin: ORIGIN, ref: "ia_test", store: new MemoryStore(), config: DEFAULT_SITE_CONFIG });
  index.merge([
    entry({ url: `${ORIGIN}/`, title: "Home", description: "The shop", text: "We sell shoes.", depth: 0 }),
    entry({
      url: `${ORIGIN}/help/returns`,
      title: "Returns",
      headings: ["Refunds"],
      text: "Refunds\nA refund takes five working days.",
      depth: 1,
      landmarks: [{ role: "button", name: "Start a return", selector: "#return" }],
    }),
  ]);
  const bridge = fakeBridge();
  const crawled: string[] = [];
  const knowledge = createKnowledgeReader({
    origin: ORIGIN,
    paths: ["/faq.md"],
    fetchImpl: fakeFetch({
      [`${ORIGIN}/faq.md`]: { body: "We are open on weekdays.", headers: { "content-type": "text/markdown" } },
      [`${ORIGIN}/secrets.md`]: { body: "not declared", headers: { "content-type": "text/markdown" } },
    }).fn,
  });
  const tools = buildSiteTools({
    origin: ORIGIN,
    index,
    page: bridge,
    knowledge,
    crawl: async (hint) => {
      crawled.push(hint);
      return { added: [entry({ url: `${ORIGIN}/pricing`, title: "Pricing" })], skipped: 0 };
    },
    ...overrides,
  });
  return { tools, bridge, crawled };
}

const run = (tools: Tool[], name: string, args: Record<string, unknown> = {}) =>
  tools.find((t) => t.schema.name === name)!.run(args, ctx());

afterEach(() => vi.unstubAllGlobals());

describe("the tool table (§5.2.2)", () => {
  it("is exactly the eleven tools of the table, safe except send_to_owner", () => {
    const { tools } = build();
    expect(tools.map((t) => t.schema.name)).toEqual([...SITE_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.tier).toBe(tool.schema.name === "send_to_owner" ? "confirm" : "safe");
    }
  });

  it("contains NO capability that writes to the host page or leaves the origin (§13)", async () => {
    const { tools, bridge } = build();

    // 1. The bridge the page tools are built on has no such method to call. Not disabled: absent.
    for (const forbidden of ["click", "fill", "submit", "type", "setValue", "cookies", "storage", "eval"]) {
      expect(forbidden in bridge).toBe(false);
    }

    // 2. No tool is NAMED for one, and no description offers one. (page_highlight's prose says the
    // outline is cleared on the next click — reading a click is not performing one, so the check is
    // on the verbs a capability would be described with, not on the word.)
    for (const tool of tools) {
      expect(tool.schema.name).not.toMatch(/click|fill|submit|cookie|storage|eval|write/);
      const params = JSON.stringify(tool.schema.parameters).toLowerCase();
      expect(params).not.toMatch(/value|cookie|storage|credential|password/);
    }
    const prose = tools.map((t) => t.schema.description).join(" ").toLowerCase();
    for (const phrase of ["click the", "click on", "fill in", "submit the", "read the cookie", "sign in as"]) {
      expect(prose).not.toContain(phrase);
    }

    // 3. Running every tool never makes a non-GET request, and never one off-origin.
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("", { headers: { "content-type": "text/plain" } });
    });
    for (const tool of tools) {
      await tool.run({ query: "refund", pattern: "refund", hint: "refund", target: "e1", ref: "e1", url: `${ORIGIN}/x`, path: "/faq.md", kind: "message", text: "hi" }, ctx());
    }
    for (const call of seen) {
      expect(call.startsWith("GET ")).toBe(true);
      expect(call.includes(ORIGIN)).toBe(true);
    }
  });
});

describe("what each tool answers", () => {
  it("site_pages gives the map, filtered", async () => {
    const { tools } = build();
    expect((await run(tools, "site_pages")).output).toContain("/help/returns — Returns");
    expect((await run(tools, "site_pages", { filter: "/help" })).output).not.toContain("/ — Home");
  });

  it("site_search returns a passage with its path and heading", async () => {
    const { tools } = build();
    const out = (await run(tools, "site_search", { query: "refund" })).output;
    expect(out).toContain("/help/returns · Refunds");
    expect(out).toContain("five working days");
    expect((await run(tools, "site_search", {})).isError).toBe(true);
  });

  it("site_grep matches the landmarks too", async () => {
    const { tools } = build();
    expect((await run(tools, "site_grep", { pattern: "start a return" })).output).toContain("[button]");
  });

  it("site_crawl runs one round and reports what it added", async () => {
    const { tools, crawled } = build();
    const out = (await run(tools, "site_crawl", { hint: "pricing" })).output;
    expect(crawled).toEqual(["pricing"]);
    expect(out).toContain("/pricing — Pricing");
  });

  it("page_current reports the tree, the scroll and the session", async () => {
    const { tools } = build();
    const out = (await run(tools, "page_current")).output;
    expect(out).toContain("session: anon");
    expect(out).toContain("e1 button: Sign in");
  });

  it("page_open refuses another origin", async () => {
    const { tools } = build();
    expect((await run(tools, "page_open", { url: `${ORIGIN}/help` })).isError).toBeUndefined();
    expect((await run(tools, "page_open", { url: "https://evil.example" })).isError).toBe(true);
  });

  it("page_scroll_to, page_highlight and page_describe work on a ref and fail loudly on a miss", async () => {
    const { tools, bridge } = build();
    expect((await run(tools, "page_highlight", { target: "e1", note: "here" })).output).toContain("here");
    expect(bridge.log).toContain("highlight e1 here");
    expect((await run(tools, "page_scroll_to", { target: "nope" })).isError).toBe(true);
    expect((await run(tools, "page_describe", { ref: "e1" })).output).toContain("Sign in");
  });

  it("read_public reads only the paths the owner declared", async () => {
    const { tools } = build();
    expect((await run(tools, "read_public", { path: "/faq.md" })).output).toContain("weekdays");
    const refused = await run(tools, "read_public", { path: "/secrets.md" });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("/faq.md");
    expect((await run(tools, "read_public")).output).toContain("/faq.md");
  });

  it("send_to_owner reports that it is not registered, and sends nothing", async () => {
    const { tools } = build();
    const res = await run(tools, "send_to_owner", { kind: "message", text: "hello" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not registered");
  });

  it("send_to_owner uses the door once one exists", async () => {
    const sent: string[] = [];
    const { tools } = build({
      sendToOwner: async (kind, text) => {
        sent.push(`${kind}:${text}`);
        return "queued";
      },
    });
    expect((await run(tools, "send_to_owner", { kind: "lead", text: "call me" })).output).toBe("queued");
    expect(sent).toEqual(["lead:call me"]);
  });
});
