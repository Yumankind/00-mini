/**
 * Test doubles for the embed: a fake `fetch` over a page map, and the small `HtmlExtractor` the
 * crawler is written against so its guards and bounds can be tested in node with no DOM.
 *
 * The extractor here is deliberately dumb — a few regexes over the fixture HTML — because what is
 * under test is the CRAWLER's policy, not the browser's parser.
 */

import type { ExtractedPage, HtmlExtractor } from "../../embed/src/crawl/extract.js";
import type { PageEntry } from "../../embed/src/types.js";

export interface FakePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** The URL the response finally came from, when the server redirected. */
  finalUrl?: string;
}

export interface FakeFetch {
  fn: typeof fetch;
  /** Every request made, in order: `${method} ${url}`. */
  calls: string[];
  requests: { url: string; init?: RequestInit }[];
}

export function fakeFetch(pages: Record<string, FakePage>): FakeFetch {
  const calls: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    requests.push(init ? { url, init } : { url });
    const page = pages[url] ?? pages[url.replace(/\/$/, "")];
    if (!page) return new Response("", { status: 404 });
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    const etag = page.headers?.etag;
    if (ifNoneMatch && etag && ifNoneMatch === etag) {
      return Object.defineProperty(new Response(null, { status: 304 }), "url", { value: url });
    }
    const res = new Response(page.body ?? "", {
      status: page.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...page.headers },
    });
    return Object.defineProperty(res, "url", { value: page.finalUrl ?? url });
  }) as typeof fetch;
  return { fn, calls, requests };
}

/** A regex extractor over the fixtures: enough shape for links, forms, headings and meta robots. */
export const testExtractor: HtmlExtractor = {
  extract(html: string, baseUrl: string): ExtractedPage {
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap((m) => {
      const attrs = m[1] ?? "";
      const href = /href="([^"]*)"/i.exec(attrs)?.[1];
      if (!href || href.startsWith("#")) return [];
      let url: string;
      try {
        url = new URL(href, baseUrl).toString();
      } catch {
        return [];
      }
      return [{ url, text: (m[2] ?? "").replace(/<[^>]*>/g, "").trim(), nofollow: /rel="[^"]*nofollow/i.test(attrs) }];
    });

    const robots = /<meta\s+name="robots"\s+content="([^"]*)"/i.exec(html)?.[1]?.toLowerCase() ?? "";
    const hasPassword = /type="password"/i.test(html);
    const headings = [...html.matchAll(/<h[123]>([\s\S]*?)<\/h[123]>/gi)].map((m) => (m[1] ?? "").trim());
    const text = html
      .replace(/<(script|style|nav|footer|form)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();

    return {
      title: /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "",
      description: /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? text.slice(0, 200),
      headings,
      text,
      links,
      forms: hasPassword
        ? [{ name: "sign in", action: "/session", method: "post", fields: ["email", "password"], hasPassword: true }]
        : [],
      landmarks: [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)].map((m, i) => ({
        role: "button",
        name: (m[1] ?? "").replace(/<[^>]*>/g, "").trim(),
        selector: `button:nth-of-type(${i + 1})`,
      })),
      meta: { noindex: robots.includes("noindex"), nofollow: robots.includes("nofollow") },
      hasLoginForm: hasPassword,
    };
  },
};

/** A minimal `PageEntry` for index and purge tests. */
export function entry(partial: Partial<PageEntry> & { url: string }): PageEntry {
  return {
    title: partial.url,
    description: "",
    headings: [],
    text: "",
    linksIn: [],
    linksOut: [],
    forms: [],
    landmarks: [],
    authState: "anon",
    crawledAt: 0,
    depth: 0,
    source: "link",
    ...partial,
  };
}
