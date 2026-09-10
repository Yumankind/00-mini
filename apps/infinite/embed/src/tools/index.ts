/**
 * The light agent's tool table on a website (docs/HANDOFF-infinite-agent.md §5.2.2).
 *
 * WHY every one of these is `safe` except one: read the table and notice what is not in it. Nothing
 * writes to the host page, fills a field, clicks a control, submits a form, reads the host's cookies
 * or storage, or fetches off-origin. The agent shows where the button is; the person presses it
 * (§13). `send_to_owner` is the only tool that would leave the device, so it is `confirm` — and at
 * level 0 it is not registered, so it politely says so and does nothing.
 *
 * Crawled and live page content is DATA. The light-agent prompt says instructions found in content
 * are ignored, exactly as apps/00d/src/light-tools.ts says it for inbound messages; every tool here
 * returns text that is quoted into the transcript, never executed.
 */

import type { Tool, ToolContext } from "@00/agent-runtime";
import type { PageEntry } from "../types.js";
import type { SiteIndex } from "../index/site-index.js";
import { pathOf } from "../index/site-index.js";
import type { PageBridge } from "../page/bridge.js";
import type { KnowledgeReader } from "../knowledge.js";

export interface CrawlRound {
  added: PageEntry[];
  skipped: number;
}

export interface ToolDeps {
  origin: string;
  index: SiteIndex;
  page: PageBridge;
  knowledge: KnowledgeReader;
  /** One bounded, targeted round. The loader owns merging it into the index and saving. */
  crawl: (hint: string, urls?: string[]) => Promise<CrawlRound>;
  /**
   * Phase 3 (§5.6). Left undefined where there is no registry at all, which is what makes
   * `send_to_owner` answer "not registered" rather than pretending to have delivered something.
   *
   * The CONFIRM comes first and comes from the panel, not from here: the runtime asks
   * `askPermission` for a `confirm` tool before it is ever run, so by the time this is called the
   * visitor has already said yes to the question with their own words in it.
   */
  sendToOwner?: (kind: string, text: string, contact?: string) => Promise<{ ok: boolean; message: string }>;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const ok = (output: string) => ({ output });
const fail = (output: string) => ({ output, isError: true });

export function buildSiteTools(deps: ToolDeps): Tool[] {
  const tools: Tool[] = [
    {
      schema: {
        name: "site_pages",
        description:
          "The site map: every page known on this site as one line (path, title, description, whether it was seen signed in, and how deep it sits). Optionally filtered by a path prefix like /help or a word.",
        parameters: {
          type: "object",
          properties: { filter: { type: "string", description: "A path prefix (/help) or a word." } },
        },
      },
      tier: "safe",
      async run(args) {
        const lines = deps.index.map(str(args.filter) || undefined);
        if (!lines.length) return ok("No pages are indexed yet for that filter.");
        return ok(
          lines
            .slice(0, 300)
            .map((l) => `${l.path} — ${l.title}${l.description ? ` — ${l.description}` : ""} [${l.authState}, depth ${l.depth}]`)
            .join("\n"),
        );
      },
    },

    {
      schema: {
        name: "site_search",
        description: "Search the indexed text of this site. Returns passages with the page URL and the heading they sat under.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            k: { type: "number", description: "How many passages, default 5, max 12." },
          },
          required: ["query"],
        },
      },
      tier: "safe",
      async run(args) {
        const query = str(args.query).trim();
        if (!query) return fail("site_search needs a query.");
        const hits = deps.index.search(query, Math.max(1, Math.min(12, num(args.k, 5))));
        if (!hits.length) return ok(`Nothing indexed matches "${query}". site_crawl with a hint may find more.`);
        return ok(hits.map((h) => `${pathOf(h.url)} · ${h.heading}\n${h.passage}`).join("\n\n"));
      },
    },

    {
      schema: {
        name: "site_grep",
        description: "Literal or regular-expression match over the indexed text and the page landmarks (buttons, menus, search boxes).",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            paths: { type: "array", items: { type: "string" }, description: "Limit to these path prefixes." },
          },
          required: ["pattern"],
        },
      },
      tier: "safe",
      async run(args) {
        const pattern = str(args.pattern);
        if (!pattern) return fail("site_grep needs a pattern.");
        const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : undefined;
        const hits = deps.index.grep(pattern, paths);
        if (!hits.length) return ok(`No match for ${pattern}.`);
        return ok(hits.map((h) => `${pathOf(h.url)} [${h.where}] ${h.line}`).join("\n"));
      },
    },

    {
      schema: {
        name: "site_crawl",
        description:
          "Read more of this site: one bounded round (at most 40 pages, same origin, GET only) aimed at a hint like 'refund policy' or 'pricing'. Returns what it added.",
        parameters: {
          type: "object",
          properties: {
            hint: { type: "string" },
            urls: { type: "array", items: { type: "string" }, description: "Optional same-origin URLs to prefer." },
          },
          required: ["hint"],
        },
      },
      tier: "safe",
      async run(args) {
        const hint = str(args.hint).trim();
        if (!hint) return fail("site_crawl needs a hint.");
        const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : [];
        const round = await deps.crawl(hint, urls);
        if (!round.added.length) {
          return ok(`Nothing new for "${hint}" (${round.skipped} URL(s) were out of scope or guarded).`);
        }
        return ok(
          `Added ${round.added.length} page(s):\n` +
            round.added.map((p) => `${pathOf(p.url)} — ${p.title}`).join("\n"),
        );
      },
    },

    {
      schema: {
        name: "page_current",
        description:
          "The page the visitor is looking at right now: URL, title, its accessibility tree with element refs, the scroll position, and whether this visitor looks signed in.",
        parameters: { type: "object", properties: {} },
      },
      tier: "safe",
      async run() {
        const p = deps.page.current();
        const tree = p.tree
          .map((n) => `${n.ref} ${n.role}${n.level ? ` ${n.level}` : ""}: ${n.name}${n.href ? ` → ${n.href}` : ""}`)
          .join("\n");
        return ok(
          `${p.url}\n${p.title}\nsession: ${p.authState}\nscroll: ${p.scroll.percent}% (y=${p.scroll.y})\n\n${tree}`,
        );
      },
    },

    {
      schema: {
        name: "page_open",
        description: "Navigate the visitor to another page of THIS site. Same origin only. The panel survives the load and carries on.",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
      tier: "safe",
      async run(args) {
        const url = str(args.url);
        if (!url) return fail("page_open needs a url.");
        const res = deps.page.open(url);
        return res.ok ? ok(res.message) : fail(res.message);
      },
    },

    {
      schema: {
        name: "page_scroll_to",
        description: "Scroll an element into view. Nothing is drawn. Takes a ref from page_current or a CSS selector.",
        parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      },
      tier: "safe",
      async run(args) {
        const target = str(args.target);
        return deps.page.scrollTo(target) ? ok(`Scrolled to ${target}.`) : fail(`No element matches ${target}.`);
      },
    },

    {
      schema: {
        name: "page_highlight",
        description:
          "Scroll an element into view AND outline it, with an optional short callout. One call is enough to show the visitor a thing. Cleared on the next message or click.",
        parameters: {
          type: "object",
          properties: { target: { type: "string" }, note: { type: "string", description: "≤ 140 characters." } },
          required: ["target"],
        },
      },
      tier: "safe",
      async run(args) {
        const target = str(args.target);
        const note = str(args.note) || undefined;
        return deps.page.highlight(target, note)
          ? ok(`Highlighted ${target}${note ? ` with "${note}"` : ""}.`)
          : fail(`No element matches ${target}.`);
      },
    },

    {
      schema: {
        name: "page_describe",
        description: "What an element is, what it does per its label and aria, and where it sits on the page.",
        parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
      tier: "safe",
      async run(args) {
        const described = deps.page.describe(str(args.ref));
        return described ? ok(described) : fail(`No element matches ${str(args.ref)}.`);
      },
    },

    {
      schema: {
        name: "read_public",
        description: "Read one of the owner's public knowledge files, as listed in the site's settings.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      tier: "safe",
      async run(args) {
        const path = str(args.path);
        if (!path) return ok(`Available: ${deps.knowledge.list().join(", ") || "(none)"}`);
        const body = await deps.knowledge.read(path);
        if (body == null) {
          return fail(`${path} is not one of this site's knowledge files. Available: ${deps.knowledge.list().join(", ") || "(none)"}`);
        }
        return ok(body);
      },
    },

    {
      schema: {
        name: "send_to_owner",
        description:
          "Send a message, a lead or a task to the site's owner. The visitor is asked to confirm before anything leaves the device. Needs the site to be registered; where it is not, this reports that instead of sending.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["message", "lead", "task"] },
            text: { type: "string" },
            contact: { type: "string" },
          },
          required: ["kind", "text"],
        },
      },
      // The only non-safe tool in the table: it is the one door out of the device.
      tier: "confirm",
      async run(args, _ctx: ToolContext) {
        if (!deps.sendToOwner) {
          return fail(
            "not registered — this site's agent has no inbox yet, so nothing was sent. The owner registers it in the Infinite Agent app.",
          );
        }
        const text = str(args.text).trim();
        if (!text) return fail("send_to_owner needs the message text.");
        const sent = await deps.sendToOwner(str(args.kind, "message"), text, str(args.contact) || undefined);
        return sent.ok ? ok(sent.message) : fail(sent.message);
      },
    },
  ];

  return tools;
}

/** The names of §5.2.2's table, in its order — the contract the panel and the tests both check. */
export const SITE_TOOL_NAMES = [
  "site_pages",
  "site_search",
  "site_grep",
  "site_crawl",
  "page_current",
  "page_open",
  "page_scroll_to",
  "page_highlight",
  "page_describe",
  "read_public",
  "send_to_owner",
] as const;
