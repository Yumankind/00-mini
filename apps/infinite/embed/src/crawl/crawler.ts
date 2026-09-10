/**
 * The crawl (docs/HANDOFF-infinite-agent.md §5.2.1).
 *
 * WHY it looks so restrained: this code runs on a stranger's website, in a visitor's browser, with
 * that visitor's own cookies attached. Every bound in here — same origin, GET only, the guard list,
 * two fetches in flight 250 ms apart, the page and byte caps, the login-form stop — exists so that a
 * site owner who pasted one script tag never has to wonder what it did to their site or to their
 * customer's account. Nothing it produces leaves the device.
 *
 * The crawler never parses HTML itself (see extract.ts) and never touches storage (see index/), so
 * the whole of the policy below is testable in node with a fake fetch.
 */

import type { AuthState, CrawlSource, PageEntry } from "../types.js";
import type { SiteConfig } from "../site-config.js";
import { canonicalise, prefixes, rejectReason, sameOrigin } from "./guards.js";
import type { HtmlExtractor } from "./extract.js";
import { EMPTY_ROBOTS, parseRobots, parseSitemap, robotsAllows, type RobotsRules } from "./robots.js";

/** The defaults of §5.2.1, named once. Caps are characters of extracted text; ~1 byte each in latin. */
export const CRAWL_DEFAULTS = {
  depth: 2,
  maxPagesOnLoad: 60,
  maxPagesPerRound: 40,
  maxPageText: 400 * 1024,
  maxTotalText: 8 * 1024 * 1024,
  /** Hard stop on the response itself, before it is even read as text. */
  maxResponseBytes: 2 * 1024 * 1024,
  concurrency: 2,
  delayMs: 250,
} as const;

export interface CrawlBounds {
  depth: number;
  maxPages: number;
  maxPageText: number;
  maxTotalText: number;
  concurrency: number;
  delayMs: number;
}

export interface CrawlResult {
  pages: PageEntry[];
  /** URL → why it was not fetched. The owner panel shows these; the tools never see them. */
  skipped: { url: string; reason: string }[];
  fetched: number;
  /** True when the round stopped on a bound rather than on an empty frontier. */
  hitBound: boolean;
}

export interface CrawlerOptions {
  origin: string;
  config: SiteConfig;
  extractor: HtmlExtractor;
  /** The visitor's session as the loader currently reads it (§5.2.1, the session signal). */
  authState: () => AuthState;
  /** Injected so tests need no network; the browser passes `fetch.bind(globalThis)`. */
  fetchImpl: typeof fetch;
  /** What is already indexed, so a page is not fetched twice and an ETag can be sent. */
  known?: (url: string) => PageEntry | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `looking through the catalog…` — the one line the visitor sees while a round runs. */
  onProgress?: (line: string) => void;
}

export class Crawler {
  private robots: RobotsRules = EMPTY_ROBOTS;
  private sitemap = new Map<string, string | undefined>();
  /** Pages that answered with a login form: not retried in this session (§5.2.1). */
  private readonly loginWalled = new Set<string>();
  private prepared = false;

  constructor(private readonly opts: CrawlerOptions) {}

  /** robots.txt and sitemap.xml, read first when present. Failures are silent: they are hints. */
  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    const robotsText = await this.text(new URL("/robots.txt", this.opts.origin).toString());
    if (robotsText) this.robots = parseRobots(robotsText);

    const seeds = [
      ...new Set([new URL("/sitemap.xml", this.opts.origin).toString(), ...this.robots.sitemaps]),
    ].filter((u) => sameOrigin(u, this.opts.origin));

    for (const seed of seeds.slice(0, 4)) {
      const xml = await this.text(seed);
      if (!xml) continue;
      const { urls, indexes } = parseSitemap(xml);
      this.absorbSitemap(urls);
      // One level of <sitemapindex>, no deeper: a sitemap tree is not a reason to fetch all day.
      for (const child of indexes.slice(0, 4)) {
        if (!sameOrigin(child, this.opts.origin)) continue;
        const childXml = await this.text(child);
        if (childXml) this.absorbSitemap(parseSitemap(childXml).urls);
      }
    }
  }

  private absorbSitemap(urls: { loc: string; lastmod?: string }[]): void {
    for (const u of urls.slice(0, 2000)) {
      const abs = canonicalise(u.loc, this.opts.origin);
      if (abs && sameOrigin(abs, this.opts.origin)) this.sitemap.set(abs, u.lastmod);
    }
  }

  /** Sitemap URLs, `lastmod` first, as the on-load crawl's extra seeds. */
  sitemapSeeds(): { url: string; lastmod?: string }[] {
    return [...this.sitemap].map(([url, lastmod]) => (lastmod ? { url, lastmod } : { url }));
  }

  /**
   * `crawlAuthed` off means nothing is indexed while this visitor is signed in — and nothing is
   * FETCHED either, not even robots.txt, because there is nothing to fetch it for (§5.2.1).
   */
  private blocked(): CrawlResult | null {
    if (this.opts.config.crawlAuthed || this.opts.authState() !== "authed") return null;
    return {
      pages: [],
      skipped: [{ url: this.opts.origin, reason: "the owner turned off indexing of signed-in pages" }],
      fetched: 0,
      hitBound: false,
    };
  }

  /** The shallow crawl on load: the current page, then its links, then theirs. */
  async crawlOnLoad(startUrl: string, extraSeeds: string[] = []): Promise<CrawlResult> {
    const stop = this.blocked();
    if (stop) return stop;
    await this.prepare();
    const bounds = this.bounds(this.opts.config.depth, CRAWL_DEFAULTS.maxPagesOnLoad);
    const seeds = [
      { url: startUrl, depth: 0, source: "link" as CrawlSource },
      ...extraSeeds.map((url) => ({ url, depth: 1, source: "link" as CrawlSource })),
      // The sitemap seeds the page list, so a page nobody links to is still on the map.
      ...this.sitemapSeeds()
        .slice(0, bounds.maxPages)
        .map((s) => ({ url: s.url, depth: 1, source: "sitemap" as CrawlSource })),
    ];
    return this.run(seeds, bounds);
  }

  /**
   * A targeted round (§5.2.1, "deeper on demand, never the whole site"). Candidates are ranked by
   * the hint against title, URL and anchor text, so a product question walks `/products` and a
   * policy question walks `/help` — and at most 40 pages either way.
   */
  async crawlWithHint(hint: string, urls: string[] = [], candidates: RankCandidate[] = []): Promise<CrawlResult> {
    const stop = this.blocked();
    if (stop) return stop;
    await this.prepare();
    const bounds = this.bounds(1, CRAWL_DEFAULTS.maxPagesPerRound);
    const explicit = urls
      .map((u) => canonicalise(u, this.opts.origin))
      .filter((u): u is string => !!u)
      .map((url) => ({ url, depth: 0, source: "hint" as CrawlSource }));

    const pool: RankCandidate[] = [
      ...candidates,
      ...this.sitemapSeeds().map((s) => ({ url: s.url, title: "", anchor: "" })),
    ];
    const ranked = rankCandidates(hint, pool)
      .filter((c) => !this.opts.known?.(c.url))
      .slice(0, bounds.maxPages)
      .map((c) => ({ url: c.url, depth: 0, source: "hint" as CrawlSource }));

    this.opts.onProgress?.(`looking through ${hintLabel(hint)}…`);
    return this.run([...explicit, ...ranked], bounds);
  }

  /** Re-fetch named pages under the on-load bounds (staleness, §5.2.1). ETags make most a 304. */
  async refresh(urls: string[]): Promise<CrawlResult> {
    const stop = this.blocked();
    if (stop) return stop;
    await this.prepare();
    const bounds = this.bounds(0, Math.min(urls.length, CRAWL_DEFAULTS.maxPagesOnLoad));
    const seeds = urls
      .map((u) => canonicalise(u, this.opts.origin))
      .filter((u): u is string => !!u)
      .map((url) => ({ url, depth: this.opts.known?.(url)?.depth ?? 1, source: "link" as CrawlSource }));
    return this.run(seeds, bounds, { refresh: true });
  }

  private bounds(depth: number, maxPages: number): CrawlBounds {
    return {
      depth: Math.max(0, Math.min(2, depth)),
      maxPages,
      maxPageText: CRAWL_DEFAULTS.maxPageText,
      maxTotalText: CRAWL_DEFAULTS.maxTotalText,
      concurrency: CRAWL_DEFAULTS.concurrency,
      delayMs: CRAWL_DEFAULTS.delayMs,
    };
  }

  private async run(
    seeds: { url: string; depth: number; source: CrawlSource }[],
    bounds: CrawlBounds,
    opts: { refresh?: boolean } = {},
  ): Promise<CrawlResult> {
    const result: CrawlResult = { pages: [], skipped: [], fetched: 0, hitBound: false };

    const queued = new Set<string>();
    const frontier: { url: string; depth: number; source: CrawlSource }[] = [];
    let textBudget = bounds.maxTotalText;

    const enqueue = (url: string, depth: number, source: CrawlSource, seed = false): void => {
      const abs = canonicalise(url, this.opts.origin);
      if (!abs || queued.has(abs)) return;
      // A seed is asked for by name (the current page, the sitemap, a refresh, a hint), so the depth
      // bound applies to what is DISCOVERED from a page, not to what was asked for.
      if (!seed && depth > bounds.depth) return;
      if (this.loginWalled.has(abs)) return;
      const reason = rejectReason(abs, {
        origin: this.opts.origin,
        includes: this.opts.config.includes,
        excludes: this.opts.config.excludes,
        doNotTouch: this.opts.config.doNotTouch,
      });
      if (reason) {
        result.skipped.push({ url: abs, reason: `${abs} ${reason}` });
        return;
      }
      if (!robotsAllows(this.robots, new URL(abs).pathname)) {
        result.skipped.push({ url: abs, reason: `${abs} is disallowed by robots.txt` });
        return;
      }
      if (!opts.refresh && this.opts.known?.(abs)) return;
      queued.add(abs);
      frontier.push({ url: abs, depth, source });
    };

    for (const s of seeds) enqueue(s.url, s.depth, s.source, true);

    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (result.pages.length >= bounds.maxPages) {
          result.hitBound = true;
          return;
        }
        if (cursor >= frontier.length) return;
        const job = frontier[cursor++]!;
        const fetched = await this.fetchPage(job.url, job.depth, job.source, bounds, result);
        await sleep(bounds.delayMs);
        if (!fetched) continue;
        result.fetched += 1;
        if (fetched.text.length > textBudget) {
          fetched.text = fetched.text.slice(0, Math.max(0, textBudget));
          result.hitBound = true;
        }
        textBudget -= fetched.text.length;
        result.pages.push(fetched);
        if (job.depth < bounds.depth && !fetched.requiresAuth) {
          for (const link of fetched.linksIn) enqueue(link, job.depth + 1, "link");
        }
      }
    };

    await Promise.all(Array.from({ length: bounds.concurrency }, () => worker()));
    return result;
  }

  private async fetchPage(
    url: string,
    depth: number,
    source: CrawlSource,
    bounds: CrawlBounds,
    result: CrawlResult,
  ): Promise<PageEntry | null> {
    const previous = this.opts.known?.(url);
    const headers: Record<string, string> = { accept: "text/html,application/xhtml+xml" };
    if (previous?.etag) headers["if-none-match"] = previous.etag;

    let res: Response;
    try {
      // GET, always. Same-origin credentials, so a signed-in visitor's crawl sees their own site
      // and a signed-out one's sees the public site. Never POST, never a form submission (§5.2.1).
      res = await this.opts.fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        redirect: "follow",
        headers,
      });
    } catch (err) {
      result.skipped.push({ url, reason: `${url} did not answer (${String(err)})` });
      return null;
    }

    if (res.status === 304 && previous) {
      return { ...previous, crawledAt: this.now(), authState: this.opts.authState() };
    }
    if (!res.ok) {
      result.skipped.push({ url, reason: `${url} answered ${res.status}` });
      return null;
    }
    // A redirect that left the origin is dropped, not followed home: the destination is somebody
    // else's site and §5.2.1 says the crawl never leaves this one.
    const finalUrl = canonicalise(res.url || url, this.opts.origin) ?? url;
    if (!sameOrigin(finalUrl, this.opts.origin)) {
      result.skipped.push({ url, reason: `${url} redirected off-origin to ${res.url}` });
      return null;
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) {
      result.skipped.push({ url, reason: `${url} is ${type.split(";")[0]}, not HTML` });
      return null;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > CRAWL_DEFAULTS.maxResponseBytes) {
      result.skipped.push({ url, reason: `${url} is ${declared} bytes, over the cap` });
      return null;
    }

    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      result.skipped.push({ url, reason: `${url} could not be read (${String(err)})` });
      return null;
    }
    if (html.length > CRAWL_DEFAULTS.maxResponseBytes) {
      result.skipped.push({ url, reason: `${url} is over the size cap` });
      return null;
    }

    const page = this.opts.extractor.extract(html, finalUrl);
    if (page.meta.noindex) {
      result.skipped.push({ url, reason: `${url} asks not to be indexed (meta robots noindex)` });
      return null;
    }

    const linksIn: string[] = [];
    const linksOut: { url: string; text: string }[] = [];
    for (const link of page.links) {
      if (sameOrigin(link.url, this.opts.origin)) {
        // `rel=nofollow` and a page-level `nofollow` both stop the link being followed; it is still
        // a fact about the page, so it stays out of the frontier rather than out of the record.
        if (link.nofollow || page.meta.nofollow) continue;
        const abs = canonicalise(link.url, this.opts.origin);
        if (abs && !linksIn.includes(abs)) linksIn.push(abs);
      } else if (linksOut.length < 60 && !linksOut.some((l) => l.url === link.url)) {
        // External links are recorded so the agent can mention them, and NEVER fetched.
        linksOut.push({ url: link.url, text: link.text });
      }
    }

    if (page.hasLoginForm) this.loginWalled.add(finalUrl);
    const etag = res.headers.get("etag") ?? undefined;
    const lastmod = this.sitemap.get(finalUrl) ?? res.headers.get("last-modified") ?? undefined;

    const entry: PageEntry = {
      url: finalUrl,
      title: page.title || new URL(finalUrl).pathname,
      description: page.description,
      headings: page.headings,
      text: page.text.slice(0, bounds.maxPageText),
      linksIn,
      linksOut,
      forms: page.forms.map((f) => ({ name: f.name, action: f.action, method: f.method, fields: f.fields })),
      landmarks: page.landmarks,
      authState: this.opts.authState(),
      ...(page.hasLoginForm ? { requiresAuth: true } : {}),
      ...(lastmod ? { lastmod } : {}),
      ...(etag ? { etag } : {}),
      crawledAt: this.now(),
      depth,
      source,
    };
    return entry;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async text(url: string): Promise<string | null> {
    try {
      const res = await this.opts.fetchImpl(url, { method: "GET", credentials: "same-origin" });
      if (!res.ok) return null;
      const body = await res.text();
      return body.length > CRAWL_DEFAULTS.maxResponseBytes ? null : body;
    } catch {
      return null;
    }
  }
}

export interface RankCandidate {
  url: string;
  title?: string;
  anchor?: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "are", "do", "i", "my", "me",
  "how", "what", "where", "can", "with", "it", "that", "this", "you", "your",
]);

export function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * The crudest possible stem, and deliberately so: a URL says `/refunds` and a person asks about a
 * `refund`. Matching the two is the whole difference between a targeted round finding the right
 * pages and finding none, and anything cleverer would need a dictionary this bundle cannot afford.
 */
function stem(t: string): string {
  return t.replace(/(ies|es|s)$/, "");
}

const stems = (s: string): Set<string> => new Set(tokenise(s).map(stem));

/**
 * Rank by the hint against title, URL path and anchor text — the three things known about a page
 * before it is fetched. A token in the path counts double: `/products` is a stronger promise about
 * a page's subject than the word "products" appearing in a link to it.
 */
export function rankCandidates(hint: string, candidates: RankCandidate[]): (RankCandidate & { score: number })[] {
  const terms = tokenise(hint);
  if (!terms.length) return candidates.map((c) => ({ ...c, score: 0 }));
  const scored: (RankCandidate & { score: number })[] = [];
  for (const c of candidates) {
    let path = c.url;
    try {
      path = new URL(c.url).pathname;
    } catch {
      /* keep the raw string */
    }
    const inPath = stems(path);
    const inTitle = stems(c.title ?? "");
    const inAnchor = stems(c.anchor ?? "");
    let score = 0;
    for (const raw of terms) {
      const t = stem(raw);
      // A token in the PATH counts double: `/products` is a stronger promise about a page's subject
      // than the same word appearing in a link to it.
      if (inPath.has(t)) score += 2;
      if (inTitle.has(t)) score += 1.5;
      if (inAnchor.has(t)) score += 1;
    }
    if (score > 0) scored.push({ ...c, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

function hintLabel(hint: string): string {
  const terms = tokenise(hint).slice(0, 3);
  return terms.length ? `the ${terms.join(" ")} pages` : "the site";
}

/** Owner include lists are prefixes; exported so the panel can explain a rejection in the same words. */
export { prefixes };
