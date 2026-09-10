import { describe, expect, it } from "vitest";
import { Crawler, rankCandidates } from "../../embed/src/crawl/crawler.js";
import { DEFAULT_SITE_CONFIG, type SiteConfig } from "../../embed/src/site-config.js";
import type { AuthState } from "../../embed/src/types.js";
import { fakeFetch, testExtractor, type FakePage } from "./helpers.js";

const ORIGIN = "https://shop.example";

const html = (body: string, head = ""): string => `<html><head>${head}</head><body>${body}</body></html>`;

function crawler(
  pages: Record<string, FakePage>,
  overrides: Partial<SiteConfig> = {},
  authState: AuthState = "anon",
): { crawler: Crawler; fetch: ReturnType<typeof fakeFetch> } {
  const f = fakeFetch(pages);
  return {
    crawler: new Crawler({
      origin: ORIGIN,
      config: { ...DEFAULT_SITE_CONFIG, ...overrides },
      extractor: testExtractor,
      authState: () => authState,
      fetchImpl: f.fn,
      now: () => 1_000,
      sleep: async () => {},
    }),
    fetch: f,
  };
}

describe("the shallow crawl on load (§5.2.1)", () => {
  const site: Record<string, FakePage> = {
    [`${ORIGIN}/`]: {
      body: html(
        `<title>Home</title><a href="/help">Help</a><a href="/products">Products</a>
         <a href="/logout">Sign out</a><a href="https://twitter.com/acme" >Us on Twitter</a>
         <a href="/sponsored" rel="nofollow">Sponsored</a>`,
      ),
    },
    [`${ORIGIN}/help`]: { body: html(`<title>Help</title><h1>Help</h1><a href="/help/returns">Returns</a>`) },
    [`${ORIGIN}/help/returns`]: { body: html(`<title>Returns</title>Return anything within 30 days.`) },
    [`${ORIGIN}/products`]: { body: html(`<title>Products</title><a href="/products/shoe">Shoe</a>`) },
    [`${ORIGIN}/products/shoe`]: { body: html(`<title>Shoe</title>A shoe.`) },
    [`${ORIGIN}/sponsored`]: { body: html(`<title>Sponsored</title>`) },
    [`${ORIGIN}/logout`]: { body: html(`<title>Bye</title>`) },
  };

  it("walks two levels, same origin, and never touches a guarded URL", async () => {
    const { crawler: c, fetch: f } = crawler(site);
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    const urls = result.pages.map((p) => p.url).sort();

    expect(urls).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/help`,
      `${ORIGIN}/help/returns`,
      `${ORIGIN}/products`,
      `${ORIGIN}/products/shoe`,
    ]);
    // The three things that must never have been fetched: the logout, the off-origin link, the
    // rel=nofollow link.
    expect(f.calls.join(" ")).not.toContain("/logout");
    expect(f.calls.join(" ")).not.toContain("twitter.com");
    expect(f.calls.join(" ")).not.toContain("/sponsored");
    // …and every request was a GET with the visitor's own credentials.
    expect(f.requests.every((r) => (r.init?.method ?? "GET") === "GET")).toBe(true);
    expect(f.requests.filter((r) => r.url.endsWith("/help")).every((r) => r.init?.credentials === "same-origin")).toBe(true);
  });

  it("records an external link as a link out with its anchor text", async () => {
    const { crawler: c } = crawler(site);
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    const home = result.pages.find((p) => p.url === `${ORIGIN}/`)!;
    expect(home.linksOut).toEqual([{ url: "https://twitter.com/acme", text: "Us on Twitter" }]);
  });

  it("stops at depth 1 when the owner said so", async () => {
    const { crawler: c } = crawler(site, { depth: 1 });
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    expect(result.pages.map((p) => p.url)).not.toContain(`${ORIGIN}/help/returns`);
  });

  it("reads robots.txt and the sitemap first, and honours both", async () => {
    const withRobots = {
      ...site,
      [`${ORIGIN}/robots.txt`]: { body: "User-agent: *\nDisallow: /products\nSitemap: https://shop.example/sitemap.xml" },
      [`${ORIGIN}/sitemap.xml`]: {
        body: `<urlset><url><loc>${ORIGIN}/pricing</loc><lastmod>2026-08-01</lastmod></url></urlset>`,
      },
      [`${ORIGIN}/pricing`]: { body: html("<title>Pricing</title>From $10.") },
    };
    const { crawler: c, fetch: f } = crawler(withRobots);
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    expect(f.calls[0]).toBe(`GET ${ORIGIN}/robots.txt`);
    const pricing = result.pages.find((p) => p.url === `${ORIGIN}/pricing`)!;
    expect(pricing.source).toBe("sitemap");
    expect(pricing.lastmod).toBe("2026-08-01");
    expect(result.pages.map((p) => p.url)).not.toContain(`${ORIGIN}/products`);
    expect(result.skipped.some((s) => s.reason.includes("robots.txt"))).toBe(true);
  });
});

describe("what the crawler drops", () => {
  it("drops a non-HTML answer, an oversize one, and an off-origin redirect", async () => {
    const { crawler: c } = crawler({
      [`${ORIGIN}/`]: { body: html(`<a href="/feed.rss">Feed</a><a href="/big">Big</a><a href="/away">Away</a>`) },
      [`${ORIGIN}/feed.rss`]: { body: "<rss/>", headers: { "content-type": "application/rss+xml" } },
      [`${ORIGIN}/big`]: { body: html("x"), headers: { "content-length": String(9 * 1024 * 1024) } },
      [`${ORIGIN}/away`]: { body: html("elsewhere"), finalUrl: "https://other.example/away" },
    });
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    expect(result.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`]);
    const reasons = result.skipped.map((s) => s.reason).join(" ");
    expect(reasons).toContain("over the cap");
    expect(reasons).toContain("redirected off-origin");
    // .rss never even reached the network: the extension pre-filter catches it.
    expect(reasons).toContain("not a page");
  });

  it("honours meta robots noindex", async () => {
    const { crawler: c } = crawler({
      [`${ORIGIN}/`]: { body: html(`<a href="/secret">Secret</a>`) },
      [`${ORIGIN}/secret`]: { body: html("hidden", `<meta name="robots" content="noindex">`) },
    });
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    expect(result.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`]);
    expect(result.skipped.some((s) => s.reason.includes("noindex"))).toBe(true);
  });

  it("marks a page that answered with a login form and does not follow it", async () => {
    const { crawler: c, fetch: f } = crawler({
      [`${ORIGIN}/`]: { body: html(`<a href="/account">Account</a>`) },
      [`${ORIGIN}/account`]: {
        body: html(`<title>Sign in</title><form><input type="password"></form><a href="/account/orders">Orders</a>`),
      },
      [`${ORIGIN}/account/orders`]: { body: html("orders") },
    });
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    const account = result.pages.find((p) => p.url === `${ORIGIN}/account`)!;
    expect(account.requiresAuth).toBe(true);
    expect(f.calls.join(" ")).not.toContain("/account/orders");
  });

  it("indexes nothing at all while signed in when crawlAuthed is off", async () => {
    const { crawler: c, fetch: f } = crawler({ [`${ORIGIN}/`]: { body: html("home") } }, { crawlAuthed: false }, "authed");
    const result = await c.crawlOnLoad(`${ORIGIN}/`);
    expect(result.pages).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("keeps a 304 answer as the entry it already had", async () => {
    const { crawler: c } = crawler({
      [`${ORIGIN}/help`]: { body: html("<title>Help</title>fresh"), headers: { etag: 'W/"1"' } },
    });
    const previous = {
      url: `${ORIGIN}/help`,
      title: "Help",
      description: "",
      headings: [],
      text: "kept",
      linksIn: [],
      linksOut: [],
      forms: [],
      landmarks: [],
      authState: "anon" as const,
      etag: 'W/"1"',
      crawledAt: 1,
      depth: 1,
      source: "link" as const,
    };
    const withKnown = new Crawler({
      origin: ORIGIN,
      config: DEFAULT_SITE_CONFIG,
      extractor: testExtractor,
      authState: () => "anon",
      fetchImpl: fakeFetch({ [`${ORIGIN}/help`]: { body: html("fresh"), headers: { etag: 'W/"1"' } } }).fn,
      known: () => previous,
      now: () => 2_000,
      sleep: async () => {},
    });
    const result = await withKnown.refresh([`${ORIGIN}/help`]);
    expect(result.pages[0]!.text).toBe("kept");
    expect(result.pages[0]!.crawledAt).toBe(2_000);
    void c;
  });
});

describe("the targeted round (§5.2.1, deeper on demand)", () => {
  it("ranks by the hint against path, title and anchor text", () => {
    const ranked = rankCandidates("refund policy", [
      { url: `${ORIGIN}/blog/hello` },
      { url: `${ORIGIN}/help/refunds`, title: "Refunds" },
      { url: `${ORIGIN}/terms`, anchor: "policy" },
    ]);
    expect(ranked.map((r) => r.url)).toEqual([`${ORIGIN}/help/refunds`, `${ORIGIN}/terms`]);
  });

  it("crawls at most 40 pages in a round", async () => {
    const pages: Record<string, FakePage> = {};
    for (let i = 0; i < 60; i += 1) pages[`${ORIGIN}/products/p${i}`] = { body: html(`<title>Product ${i}</title>`) };
    const { crawler: c } = crawler(pages);
    const round = await c.crawlWithHint(
      "products",
      [],
      Object.keys(pages).map((url) => ({ url, title: "Product" })),
    );
    expect(round.pages.length).toBeLessThanOrEqual(40);
    expect(round.pages.length).toBeGreaterThan(0);
  });
});
