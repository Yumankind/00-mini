import { describe, expect, it } from "vitest";
import { Bm25Index, chunkPage } from "../../embed/src/index/bm25.js";
import { REBUILD_AFTER_MS, SiteIndex, pathOf } from "../../embed/src/index/site-index.js";
import { MemoryStore } from "../../embed/src/index/store.js";
import { DEFAULT_SITE_CONFIG } from "../../embed/src/site-config.js";
import { entry } from "./helpers.js";

const ORIGIN = "https://shop.example";
const DAY = 24 * 60 * 60 * 1000;

const pages = [
  entry({
    url: `${ORIGIN}/`,
    title: "Home",
    description: "The shop",
    text: "Welcome to the shop.\nWe sell shoes and boots.",
    depth: 0,
  }),
  entry({
    url: `${ORIGIN}/help/returns`,
    title: "Returns",
    headings: ["Refunds"],
    text: "Refunds\nA refund takes five working days once we have the parcel.",
    depth: 1,
    landmarks: [{ role: "button", name: "Start a return", selector: "#return" }],
  }),
];

function makeIndex(now = 10 * DAY, store = new MemoryStore()): SiteIndex {
  return new SiteIndex({ origin: ORIGIN, ref: "ia_test", store, config: { ...DEFAULT_SITE_CONFIG }, now: () => now });
}

describe("BM25", () => {
  it("chunks a page under its headings", () => {
    const chunks = chunkPage(pages[1]!);
    expect(chunks.some((c) => c.heading === "Refunds" && c.text.includes("five working days"))).toBe(true);
  });

  it("ranks the page that is about the query", () => {
    const bm25 = new Bm25Index(pages.flatMap((p) => chunkPage(p)));
    const [best] = bm25.search("refund");
    expect(best!.chunk.url).toBe(`${ORIGIN}/help/returns`);
    expect(bm25.search("nothing here at all")).toEqual([]);
  });
});

describe("the site index", () => {
  it("returns hits with the page, the heading and a passage", () => {
    const index = makeIndex();
    index.merge(pages);
    const [hit] = index.search("refund");
    expect(hit!.url).toBe(`${ORIGIN}/help/returns`);
    expect(hit!.heading).toBe("Refunds");
    expect(hit!.passage).toContain("five working days");
  });

  it("greps the indexed text AND the landmarks", () => {
    const index = makeIndex();
    index.merge(pages);
    expect(index.grep("five working").map((h) => h.where)).toEqual(["text"]);
    expect(index.grep("start a return").map((h) => h.where)).toEqual(["button"]);
    // A broken regex is treated as a literal rather than throwing at the agent.
    expect(() => index.grep("refund(")).not.toThrow();
  });

  it("gives the site map one line per page, shallowest first", () => {
    const index = makeIndex();
    index.merge(pages);
    expect(index.map().map((l) => l.path)).toEqual(["/", "/help/returns"]);
    expect(index.map("/help").map((l) => l.path)).toEqual(["/help/returns"]);
    expect(index.map("shop").map((l) => l.path)).toEqual(["/"]);
  });

  it("persists per origin + ref and reloads", async () => {
    const store = new MemoryStore();
    const index = makeIndex(10 * DAY, store);
    index.merge(pages);
    await index.save();
    expect(await store.keys()).toEqual([`index:${ORIGIN}|ia_test`]);

    const reopened = makeIndex(10 * DAY, store);
    const outcome = await reopened.load();
    expect(outcome.loaded).toBe(2);
    expect(reopened.search("refund")).toHaveLength(1);
  });

  it("rebuilds from scratch rather than patching an index older than 30 days", async () => {
    const store = new MemoryStore();
    const first = makeIndex(0, store);
    first.merge(pages);
    await first.save();

    const later = makeIndex(REBUILD_AFTER_MS + DAY, store);
    const outcome = await later.load();
    expect(outcome.rebuilt).toBe(true);
    expect(later.size()).toBe(0);
    expect(await store.get(`index:${ORIGIN}|ia_test`)).toBeNull();
  });
});

describe("staleness (§5.2.1)", () => {
  it("re-fetches past the TTL, home page first", () => {
    const index = makeIndex(20 * DAY);
    index.merge([
      entry({ url: `${ORIGIN}/`, crawledAt: 0, depth: 0 }),
      entry({ url: `${ORIGIN}/fresh`, crawledAt: 20 * DAY, depth: 1 }),
      entry({ url: `${ORIGIN}/old`, crawledAt: 0, depth: 1 }),
    ]);
    expect(index.staleUrls("anon")).toEqual([`${ORIGIN}/`, `${ORIGIN}/old`]);
  });

  it("re-fetches when the sitemap's lastmod moved", () => {
    const index = makeIndex(DAY);
    index.merge([entry({ url: `${ORIGIN}/a`, crawledAt: DAY, lastmod: "2026-01-01" })]);
    expect(index.staleUrls("anon", new Map([[`${ORIGIN}/a`, "2026-01-01"]]))).toEqual([]);
    expect(index.staleUrls("anon", new Map([[`${ORIGIN}/a`, "2026-09-01"]]))).toEqual([`${ORIGIN}/a`]);
  });

  it("re-fetches an entry crawled in another session state", () => {
    const index = makeIndex(DAY);
    index.merge([entry({ url: `${ORIGIN}/a`, crawledAt: DAY, authState: "anon" })]);
    expect(index.staleUrls("anon")).toEqual([]);
    expect(index.staleUrls("authed")).toEqual([`${ORIGIN}/a`]);
  });

  it("drops an entry that stopped answering", () => {
    const index = makeIndex();
    index.merge(pages);
    index.drop([`${ORIGIN}/help/returns`]);
    expect(index.map().map((l) => l.path)).toEqual(["/"]);
  });
});

describe("pathOf", () => {
  it("keeps the query, because two queries are two pages", () => {
    expect(pathOf(`${ORIGIN}/search?q=boots`)).toBe("/search?q=boots");
    expect(pathOf("not a url")).toBe("not a url");
  });
});
