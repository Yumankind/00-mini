import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_CONFIG,
  decodeDataSite,
  encodeDataSite,
  normalisePath,
  resolveSiteConfig,
  validateSiteConfig,
} from "../../embed/src/site-config.js";
import { refFromSrc } from "../../embed/src/loader.js";

describe("site.json validation (§5.2.4)", () => {
  it("drops unknown fields rather than carrying them", () => {
    const { config, notes } = validateSiteConfig({ version: 1, evil: "rm -rf", tracking: { pixel: 1 } });
    expect("evil" in config).toBe(false);
    expect("tracking" in config).toBe(false);
    expect(notes.join(" ")).toContain("unknown field");
  });

  it("clamps depth to 1–2 and the TTL to a year", () => {
    const { config, notes } = validateSiteConfig({ depth: 9, ttlDays: 100000 });
    expect(config.depth).toBe(2);
    expect(config.ttlDays).toBe(365);
    expect(notes.some((n) => n.includes("depth clamped"))).toBe(true);
  });

  it("keeps at most 16 list entries", () => {
    const { config } = validateSiteConfig({ excludes: Array.from({ length: 40 }, (_, i) => `/x${i}`) });
    expect(config.excludes).toHaveLength(16);
  });

  it("refuses a path that could leave the origin", () => {
    const { config } = validateSiteConfig({
      knowledge: ["https://evil.example/x.md", "//evil.example/y.md", "/../../etc/passwd", "/faq.md", "faq2.md"],
    });
    expect(config.knowledge).toEqual(["/faq.md", "/faq2.md"]);
    expect(normalisePath("https://evil.example/x")).toBeNull();
  });

  it("keeps cookie names only for kind cookie, and never a value-looking name", () => {
    const { config } = validateSiteConfig({
      session: { kind: "cookie", cookies: ["session_id", "a=b", "x".repeat(200)], storageKeys: ["ignored"] },
    });
    expect(config.session.cookies).toEqual(["session_id", "x".repeat(64)]);
    expect(config.session.storageKeys).toEqual([]);
  });

  it("falls back to session kind none when the kind is not a kind", () => {
    const { config, notes } = validateSiteConfig({ session: { kind: "telepathy" } });
    expect(config.session.kind).toBe("none");
    expect(notes.join(" ")).toContain("telepathy");
  });

  it("caps the intro and defaults crawlAuthed to on", () => {
    const { config } = validateSiteConfig({ intro: { name: "n".repeat(200), line: 42 } });
    expect(config.intro.name).toHaveLength(64);
    expect(config.intro.line).toBe("");
    expect(config.crawlAuthed).toBe(true);
  });

  it("survives rubbish", () => {
    expect(validateSiteConfig(null).config).toEqual(DEFAULT_SITE_CONFIG);
    expect(validateSiteConfig("not json").config.depth).toBe(2);
  });
});

describe("carrier precedence (§5.1)", () => {
  it("prefers the public bundle, then the site file, then the snippet, then defaults", () => {
    expect(resolveSiteConfig({ bundle: { ttlDays: 1 }, siteFile: { ttlDays: 2 }, snippet: { ttlDays: 3 } }).carrier).toBe("bundle");
    expect(resolveSiteConfig({ siteFile: { ttlDays: 2 }, snippet: { ttlDays: 3 } }).carrier).toBe("site-file");
    expect(resolveSiteConfig({ snippet: { ttlDays: 3 } }).carrier).toBe("snippet");
    expect(resolveSiteConfig({}).carrier).toBe("defaults");
  });

  it("ignores a site file whose ref is another app's, and reports it", () => {
    const resolved = resolveSiteConfig({
      siteFile: { ref: "ia_other_app", ttlDays: 2 },
      snippet: { ttlDays: 3 },
      ref: "ia_mine_1234",
    });
    expect(resolved.carrier).toBe("snippet");
    expect(resolved.config.ttlDays).toBe(3);
    expect(resolved.notes.join(" ")).toContain("ia_other_app");
  });

  it("accepts a site file whose ref matches", () => {
    const resolved = resolveSiteConfig({ siteFile: { ref: "ia_mine_1234", ttlDays: 2 }, ref: "ia_mine_1234" });
    expect(resolved.carrier).toBe("site-file");
    expect(resolved.config.ttlDays).toBe(2);
  });
});

describe("the snippet attribute", () => {
  it("round-trips base64url", () => {
    const doc = { version: 1, intro: { name: "Acme ✓", line: "hi" } };
    const encoded = encodeDataSite(doc);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeDataSite(encoded)).toEqual(doc);
  });

  it("answers null for junk rather than throwing", () => {
    expect(decodeDataSite("!!!not base64!!!")).toBeNull();
  });
});

describe("the ref in the script src", () => {
  it("reads /e/<ref>.js and nothing else", () => {
    expect(refFromSrc("https://host/e/ia_abc123_xyz.js")).toBe("ia_abc123_xyz");
    expect(refFromSrc("https://host/e/ia_abc.js?v=2")).toBe("ia_abc");
    expect(refFromSrc("https://host/assets/main.js")).toBeNull();
    expect(refFromSrc("https://host/e/../evil.js")).toBeNull();
  });
});
