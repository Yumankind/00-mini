import { describe, expect, it } from "vitest";
import { canonicalise, isGuarded, prefixes, rejectReason, sameOrigin } from "../../embed/src/crawl/guards.js";
import { parseRobots, parseSitemap, robotsAllows } from "../../embed/src/crawl/robots.js";

const scope = { origin: "https://shop.example", includes: [], excludes: [], doNotTouch: [] };

describe("the state-change guard list (§5.2.1)", () => {
  // Every shape the plan names, one case each. A regression here is a crawl that logs somebody out.
  const guarded = [
    "/logout",
    "/signout",
    "/sign-out",
    "/posts/17/delete",
    "/cart/remove/3",
    "/orders/9/cancel",
    "/mail/unsubscribe?u=3",
    "/add-to-cart?id=7",
    "/checkout/complete",
    "/checkout/confirm",
    "/anything?action=destroy",
    "/anything?token=abc",
    "/password/reset",
    "/admin",
    "/admin/users",
    "/wp-admin/options.php",
    "/account/settings",
    "/account/delete",
  ];
  for (const path of guarded) {
    it(`refuses ${path}`, () => {
      expect(isGuarded(path, { excludes: [], doNotTouch: [] })).not.toBeNull();
      expect(rejectReason(`https://shop.example${path}`, scope)).not.toBeNull();
    });
  }

  const allowed = ["/", "/help", "/help/returns", "/products/shoes", "/account", "/blog/2026/deleted-scenes"];
  for (const path of allowed) {
    it(`allows ${path}`, () => {
      // NOTE the last one: "delete" inside a word is still a match on purpose — the guard is
      // deliberately over-eager, because a false skip costs a page and a false fetch costs data.
      const reason = rejectReason(`https://shop.example${path}`, scope);
      if (path.includes("deleted")) expect(reason).not.toBeNull();
      else expect(reason).toBeNull();
    });
  }
});

describe("scope", () => {
  it("is the same scheme AND host", () => {
    expect(sameOrigin("https://shop.example/a", "https://shop.example")).toBe(true);
    expect(sameOrigin("http://shop.example/a", "https://shop.example")).toBe(false);
    expect(sameOrigin("https://other.example/a", "https://shop.example")).toBe(false);
    expect(sameOrigin("https://shop.example:8443/a", "https://shop.example")).toBe(false);
  });

  it("drops assets and credential URLs", () => {
    expect(rejectReason("https://shop.example/logo.png", scope)).toContain("not a page");
    expect(rejectReason("https://user:pw@shop.example/x", scope)).toContain("credentials");
  });

  it("honours the owner's lists", () => {
    expect(rejectReason("https://shop.example/drafts/a", { ...scope, excludes: ["/drafts"] })).toContain("exclude");
    expect(rejectReason("https://shop.example/beta", { ...scope, doNotTouch: ["/beta"] })).toContain("do-not-touch");
    expect(rejectReason("https://shop.example/blog", { ...scope, includes: ["/help"] })).toContain("include list");
    expect(rejectReason("https://shop.example/help/x", { ...scope, includes: ["/help"] })).toBeNull();
  });

  it("prefixes match whole segments only", () => {
    expect(prefixes("/help", "/help")).toBe(true);
    expect(prefixes("/help", "/help/faq")).toBe(true);
    expect(prefixes("/help", "/helpful")).toBe(false);
  });

  it("canonicalises away the fragment and a trailing slash", () => {
    expect(canonicalise("/a/#top", "https://shop.example")).toBe("https://shop.example/a");
    expect(canonicalise("https://shop.example/", "https://shop.example")).toBe("https://shop.example/");
  });
});

describe("robots.txt", () => {
  const text = `
# comment
User-agent: *
Disallow: /private
Allow: /private/public-note
Sitemap: https://shop.example/sitemap.xml

User-agent: badbot
Disallow: /
`;
  it("parses the wildcard group and the sitemaps", () => {
    const rules = parseRobots(text);
    expect(rules.disallow).toContain("/private");
    expect(rules.sitemaps).toEqual(["https://shop.example/sitemap.xml"]);
    expect(robotsAllows(rules, "/help")).toBe(true);
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/private/public-note")).toBe(true);
  });

  it("lets a group naming us replace the wildcard group", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: infiniteagent\nDisallow: /nope\n");
    expect(robotsAllows(rules, "/help")).toBe(true);
    expect(robotsAllows(rules, "/nope")).toBe(false);
  });

  it("understands * and $", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\n");
    expect(robotsAllows(rules, "/a/b.pdf")).toBe(false);
    expect(robotsAllows(rules, "/a/b.pdf.html")).toBe(true);
  });
});

describe("sitemap.xml", () => {
  it("seeds the page list with lastmod", () => {
    const { urls } = parseSitemap(`<urlset>
      <url><loc>https://shop.example/a</loc><lastmod>2026-09-01</lastmod></url>
      <url><loc><![CDATA[https://shop.example/b?x=1&amp;y=2]]></loc></url>
    </urlset>`);
    expect(urls).toEqual([
      { loc: "https://shop.example/a", lastmod: "2026-09-01" },
      { loc: "https://shop.example/b?x=1&y=2" },
    ]);
  });

  it("reports a sitemap index as indexes, not as pages", () => {
    const { urls, indexes } = parseSitemap(
      `<sitemapindex><sitemap><loc>https://shop.example/s1.xml</loc></sitemap></sitemapindex>`,
    );
    expect(urls).toEqual([]);
    expect(indexes).toEqual(["https://shop.example/s1.xml"]);
  });
});
