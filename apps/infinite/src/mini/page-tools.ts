/**
 * THE AGENT CAN SEE THE PAGE IT IS FLOATING OVER — five tools over the embed's own `PageBridge`.
 *
 * The widget on the landing page is the demo: asking it "where do I set the vault?" should end with
 * the page scrolled to `#vault` and the section outlined, which is exactly what the same widget does
 * on somebody else's website. So this reuses `embed/src/page/dom-bridge.ts` rather than growing a
 * second way to read a document, and the tool table is the embed's five page tools, narrowed: no
 * crawl, no index, no owner inbox — the landing page is one document and the agent is standing on it.
 *
 * THE BOUNDARY IS THE EMBED'S BOUNDARY (§13): read, scroll, outline, describe, and navigate within
 * this origin. There is no click, no fill, no submit — not disabled, ABSENT.
 *
 * ── THE DOOR ────────────────────────────────────────────────────────────────────────────────────
 * `AgentRuntime.setExtraTools` (contract revision 2026-09-11 (e)) takes a second list beside the
 * host's base table and replaces it on every call; the next run sees it, a run in flight keeps its
 * own. `installPageTools` hands the five tools through it and `uninstallPageTools` hands `[]`, which
 * is what Root does when the full app takes the screen — `/app` has no page under it to point at.
 * The install never throws: a landing page that cannot point at its own sections is a smaller
 * failure than a landing page that does not load, so the report says what happened instead.
 */

import type { Tool } from "@00/agent-runtime";
import type { PageBridge } from "../../embed/src/page/bridge.js";
import { LANDING_SECTIONS, sectionMapLine, type LandingSection } from "../landing/sections.js";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const ok = (output: string) => ({ output });
const fail = (output: string) => ({ output, isError: true });

export interface PageToolDeps {
  page: PageBridge;
  /** The anchors this page has, so `page_scroll` can take "vault" as readily as "#vault". */
  sections?: LandingSection[];
}

/**
 * `vault`, `#vault`, `the vault section` and `Encrypted at rest` all mean the same anchor.
 *
 * Pure, because it is the whole of the "did it understand me" question and the only part of these
 * tools a node test can exercise without a document.
 */
export function resolveSection(target: string, sections: LandingSection[] = LANDING_SECTIONS): LandingSection | null {
  const wanted = target.trim().toLowerCase().replace(/^#/, "");
  if (!wanted) return null;
  const byId = sections.find((s) => s.id === wanted);
  if (byId) return byId;
  const byTitle = sections.find((s) => s.title.toLowerCase() === wanted);
  if (byTitle) return byTitle;
  return (
    sections.find((s) => wanted.includes(s.id)) ??
    sections.find((s) => s.title.toLowerCase().includes(wanted) || wanted.includes(s.title.toLowerCase())) ??
    null
  );
}

/** A section name becomes its CSS selector; anything else is passed through as the caller wrote it. */
function targetSelector(target: string, sections: LandingSection[]): string {
  const section = resolveSection(target, sections);
  return section ? `#${section.id}` : target;
}

export function buildPageTools(deps: PageToolDeps): Tool[] {
  const sections = deps.sections ?? LANDING_SECTIONS;
  return [
    {
      schema: {
        name: "page_current",
        description:
          "The page the person is looking at right now: its URL and title, the sections it has, and its accessibility tree with element refs.",
        parameters: { type: "object", properties: {} },
      },
      tier: "safe",
      async run() {
        const page = deps.page.current();
        const map = sections.map((s) => `#${s.id} — ${s.title}: ${s.summary}`).join("\n");
        const tree = page.tree
          .map((n) => `${n.ref} ${n.role}${n.level ? ` ${n.level}` : ""}: ${n.name}${n.href ? ` → ${n.href}` : ""}`)
          .join("\n");
        return ok(`${page.url}\n${page.title}\nscroll: ${page.scroll.percent}%\n\nSections:\n${map}\n\nOn screen:\n${tree}`);
      },
    },

    {
      schema: {
        name: "page_scroll",
        description:
          "Scroll something into view. Takes a section name or anchor from page_current (vault, #brains), or a CSS selector, or a ref.",
        parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      },
      tier: "safe",
      async run(args) {
        const wanted = str(args.target);
        if (!wanted) return fail("page_scroll needs a target.");
        const selector = targetSelector(wanted, sections);
        return deps.page.scrollTo(selector) ? ok(`Scrolled to ${selector}.`) : fail(`Nothing on this page matches ${wanted}.`);
      },
    },

    {
      schema: {
        name: "page_highlight",
        description:
          "Scroll something into view AND outline it, with an optional short note beside it. One call shows the person the thing.",
        parameters: {
          type: "object",
          properties: { target: { type: "string" }, note: { type: "string", description: "≤ 140 characters." } },
          required: ["target"],
        },
      },
      tier: "safe",
      async run(args) {
        const wanted = str(args.target);
        if (!wanted) return fail("page_highlight needs a target.");
        const selector = targetSelector(wanted, sections);
        const note = str(args.note) || undefined;
        return deps.page.highlight(selector, note)
          ? ok(`Highlighted ${selector}${note ? ` with "${note}"` : ""}.`)
          : fail(`Nothing on this page matches ${wanted}.`);
      },
    },

    {
      schema: {
        name: "page_describe",
        description: "What an element is, what it does per its label and aria, and where it sits on the page.",
        parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      },
      tier: "safe",
      async run(args) {
        const wanted = str(args.target);
        if (!wanted) return fail("page_describe needs a target.");
        const described = deps.page.describe(targetSelector(wanted, sections));
        return described ? ok(described) : fail(`Nothing on this page matches ${wanted}.`);
      },
    },

    {
      schema: {
        name: "page_open",
        description:
          "Open another page of this site, or an anchor on this one (/app, #brains). Same origin only — this cannot leave the site.",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
      tier: "safe",
      async run(args) {
        const url = str(args.url);
        if (!url) return fail("page_open needs a url.");
        // An anchor is a scroll, not a navigation: reloading the document to move down the page
        // would throw away the conversation for something the scroll already does.
        if (url.startsWith("#")) {
          const selector = targetSelector(url, sections);
          return deps.page.scrollTo(selector) ? ok(`Scrolled to ${selector}.`) : fail(`No ${url} on this page.`);
        }
        const res = deps.page.open(url);
        return res.ok ? ok(res.message) : fail(res.message);
      },
    },
  ];
}

/** The names, in order — what a test and the widget both check the table against. */
export const PAGE_TOOL_NAMES = ["page_current", "page_scroll", "page_highlight", "page_describe", "page_open"] as const;

/**
 * The one line the landing agent is told about where it is standing.
 *
 * It needs no door into the runtime: it is prefixed to the FIRST message of a thread, the way
 * `power/inspector-context.ts` prefixes a picked element — visible in the transcript, because a
 * person should be able to see everything their agent was actually told.
 */
export function landingContext(sections: LandingSection[] = LANDING_SECTIONS): string {
  return `[You are the 00 Mini widget on the 00 Mini landing page. Its sections: ${sectionMapLine(sections)}.]`;
}

/** Whether a message already carries the line, so a thread is told once and not on every turn. */
export function withLandingContext(message: string, already: boolean, sections?: LandingSection[]): string {
  return already ? message : `${landingContext(sections)}\n\n${message}`;
}

const CONTEXT_OPENER = "[You are the 00 Mini widget";

/**
 * The line back off the front of a message, for drawing.
 *
 * The transcript keeps the FULL text — a person must be able to see what their agent was actually
 * told, and a session reopened in the full app replays exactly that. The widget merely draws the
 * context smaller than the sentence the person typed, which is the shape of the fact.
 */
export function splitLandingContext(text: string): { context: string | null; message: string } {
  if (!text.startsWith(CONTEXT_OPENER)) return { context: null, message: text };
  const end = text.indexOf("]\n\n");
  if (end < 0) return { context: null, message: text };
  return { context: text.slice(0, end + 1), message: text.slice(end + 3) };
}

export interface InstallReport {
  installed: boolean;
  /** The method that took the tools, or why none did. */
  detail: string;
  names: string[];
}

interface ExtraToolsHost {
  setExtraTools?: (tools: Tool[]) => unknown;
}

/** Hand the tools to a runtime through `setExtraTools`; report, never throw. */
export function installPageTools(runtime: unknown, tools: Tool[]): InstallReport {
  const names = tools.map((t) => t.schema.name);
  const host = runtime as ExtraToolsHost | null;
  if (!host) return { installed: false, detail: "no runtime", names };
  if (typeof host.setExtraTools !== "function") {
    return { installed: false, detail: "this runtime has no setExtraTools (contract revision 2026-09-11 (e))", names };
  }
  try {
    host.setExtraTools(tools);
    return { installed: true, detail: "runtime.setExtraTools", names };
  } catch (err) {
    return { installed: false, detail: `the runtime refused them: ${err instanceof Error ? err.message : String(err)}`, names };
  }
}

/** Take them away again — the next run has only the base table. Safe on a runtime without the door. */
export function uninstallPageTools(runtime: unknown): void {
  const host = runtime as ExtraToolsHost | null;
  if (host && typeof host.setExtraTools === "function") {
    try {
      host.setExtraTools([]);
    } catch {
      /* nothing to take away */
    }
  }
}
