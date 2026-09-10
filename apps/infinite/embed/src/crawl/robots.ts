/**
 * robots.txt and sitemap.xml, read before anything else (§5.2.1).
 *
 * WHY the crawler obeys robots at all, when it runs in a visitor's browser with that visitor's own
 * credentials and could simply not care: the embed acts on behalf of the site owner, and robots.txt
 * is how a site owner says "not this". Honouring it costs one fetch and makes the crawl defensible
 * to whoever runs the site — the same reason `rel=nofollow` and `<meta name=robots>` are honoured
 * in extract.ts.
 *
 * Both parsers are string-in, data-out: no DOM (the sitemap is read with a regex, deliberately, so
 * this module runs in a test with no DOMParser).
 */

export interface RobotsRules {
  /** Path prefixes that may not be fetched, longest-first. */
  disallow: string[];
  /** Explicit allows, which win over a longer disallow per the de-facto standard. */
  allow: string[];
  /** Absolute sitemap URLs the file advertised. */
  sitemaps: string[];
}

export const EMPTY_ROBOTS: RobotsRules = { disallow: [], allow: [], sitemaps: [] };

/** Our token, so an owner can address the embed by name in robots.txt. */
export const USER_AGENT_TOKEN = "infiniteagent";

/**
 * Parse the groups that apply to us: the `*` group and any group naming our token. A group naming
 * our token replaces the wildcard group rather than adding to it, which is what the standard says.
 */
export function parseRobots(text: string): RobotsRules {
  const wildcard: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  const mine: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  let applies: RobotsRules[] = [];
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      const token = value.toLowerCase();
      if (!lastWasAgent) applies = [];
      if (token === "*") applies.push(wildcard);
      else if (token === USER_AGENT_TOKEN) applies.push(mine);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") {
      wildcard.sitemaps.push(value);
      continue;
    }
    if (field !== "disallow" && field !== "allow") continue;
    for (const group of applies) {
      if (field === "disallow" && value) group.disallow.push(value);
      else if (field === "allow" && value) group.allow.push(value);
    }
  }

  const chosen = mine.disallow.length || mine.allow.length ? mine : wildcard;
  return {
    disallow: chosen.disallow.sort((a, b) => b.length - a.length),
    allow: chosen.allow.sort((a, b) => b.length - a.length),
    sitemaps: wildcard.sitemaps,
  };
}

/** Longest match wins; an equally long `Allow` beats a `Disallow`. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const match = (pattern: string): number => (matchesRobotsPattern(pattern, path) ? pattern.length : -1);
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const a of rules.allow) bestAllow = Math.max(bestAllow, match(a));
  for (const d of rules.disallow) bestDisallow = Math.max(bestDisallow, match(d));
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

/** Supports the two wildcards the standard grew: `*` for any run and `$` for end-of-path. */
function matchesRobotsPattern(pattern: string, path: string): boolean {
  if (pattern === "/") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$") ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

/** URLs plus `lastmod`, and nested sitemap indexes so one level of `<sitemapindex>` is followed. */
export function parseSitemap(xml: string): { urls: SitemapUrl[]; indexes: string[] } {
  const urls: SitemapUrl[] = [];
  const indexes: string[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  for (const m of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const body = m[2] ?? "";
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(body)?.[1];
    if (!loc) continue;
    const clean = decodeXml(loc.trim());
    if (m[1].toLowerCase() === "sitemap" || isIndex) {
      indexes.push(clean);
      continue;
    }
    const lastmod = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(body)?.[1];
    urls.push(lastmod ? { loc: clean, lastmod: lastmod.trim() } : { loc: clean });
  }
  return { urls, indexes };
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
