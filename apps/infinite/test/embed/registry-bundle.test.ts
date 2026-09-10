/**
 * The public bundle: the format, the precedence it wins, and what `read_public` does with it (§5.5).
 *
 * The format under test is the PUBLISHER's — `apps/infinite/src/registry/public-bundle.ts` builds
 * `{ version, ref, publishedAt, files: [{ path, text }] }` and PUTs it as `application/json`. These
 * fixtures are that document, written out by hand so that a change on either side shows up here as
 * a failing expectation rather than as a persona that silently stops arriving.
 */

import { describe, expect, it } from "vitest";
import { BUNDLE_MAX_BYTES, bundlePath, parsePublicBundle } from "../../embed/src/registry/bundle.js";
import { createKnowledgeReader } from "../../embed/src/knowledge.js";
import { resolveSiteConfig } from "../../embed/src/site-config.js";
import { fakeFetch } from "./helpers.js";

const bytes = (doc: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(doc));

const bundle = (files: { path: string; text: string }[]): Uint8Array =>
  bytes({ version: 1, ref: "ia_ktb4qz_abcdefghijkl", publishedAt: "2026-09-10T00:00:00.000Z", files });

describe("reading the publisher's document", () => {
  it("keeps every text file, by the path a visitor will ask for", () => {
    const read = parsePublicBundle(
      bundle([
        { path: "PERSONA.md", text: "I am the shop guide." },
        { path: "faq/shipping.md", text: "Two days." },
      ]),
    );
    expect(read.version).toBe(1);
    expect(read.ref).toBe("ia_ktb4qz_abcdefghijkl");
    expect(read.publishedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(read.files).toEqual({ "PERSONA.md": "I am the shop guide.", "faq/shipping.md": "Two days." });
    expect(read.siteFile).toBeNull();
  });

  it("lifts `site.json` out as the settings document, and never offers it as knowledge", () => {
    const read = parsePublicBundle(
      bundle([
        { path: "site.json", text: JSON.stringify({ version: 1, depth: 1, intro: { name: "Acme", line: "Ask me" } }) },
        { path: "PERSONA.md", text: "persona" },
      ]),
    );
    expect((read.siteFile as { intro: { name: string } }).intro.name).toBe("Acme");
    expect(Object.keys(read.files)).toEqual(["PERSONA.md"]);
  });

  it("treats a `site.json` that will not parse as no settings at all", () => {
    const read = parsePublicBundle(bundle([{ path: "site.json", text: "{oops" }]));
    expect(read.siteFile).toBeNull();
  });

  it("drops a path that could point outside the bundle, and keeps the rest", () => {
    const read = parsePublicBundle(
      bundle([
        { path: "../../etc/passwd", text: "no" },
        { path: "/absolute.md", text: "no" },
        { path: "https://elsewhere/x.md", text: "no" },
        { path: "a\\b.md", text: "no" },
        { path: "ok.md", text: "yes" },
      ]),
    );
    expect(Object.keys(read.files)).toEqual(["ok.md"]);
  });

  it("skips an entry that is not a { path, text } pair", () => {
    const read = parsePublicBundle(bytes({ version: 1, files: [null, 7, { path: "a.md" }, { text: "x" }, { path: "b.md", text: "kept" }] }));
    expect(read.files).toEqual({ "b.md": "kept" });
  });

  it("refuses bytes that are not a bundle, by name", () => {
    expect(() => parsePublicBundle(new Uint8Array(0))).toThrow(/empty/);
    expect(() => parsePublicBundle(new TextEncoder().encode("<html>"))).toThrow(/not a JSON/);
    expect(() => parsePublicBundle(bytes([1, 2, 3]))).toThrow(/not a JSON object/);
    expect(() => parsePublicBundle(new Uint8Array(BUNDLE_MAX_BYTES + 1))).toThrow(/256 KB/);
  });

  it("refuses an oversize document at the door, and reads one that fits", () => {
    const big = "x".repeat(200 * 1024);
    expect(() => parsePublicBundle(bundle([{ path: "a.md", text: big }, { path: "b.md", text: big }]))).toThrow(/256 KB/);
    const read = parsePublicBundle(bundle([{ path: "a.md", text: big }]));
    expect(Object.keys(read.files)).toEqual(["a.md"]);
    expect(read.bytes).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
  });

  it("normalises a path the way the site config does", () => {
    expect(bundlePath("./PERSONA.md")).toBe("PERSONA.md");
    expect(bundlePath("a//b.md")).toBeNull();
    expect(bundlePath("")).toBeNull();
    expect(bundlePath(42)).toBeNull();
  });
});

describe("§5.1 precedence, with a bundle present", () => {
  const siteFile = { version: 1, depth: 2, intro: { name: "From the site file", line: "" } };
  const snippet = { version: 1, depth: 1, intro: { name: "From the snippet", line: "" } };
  const fromBundle = { version: 1, depth: 1, intro: { name: "From the bundle", line: "" } };

  it("puts the signed bundle above the site file and the snippet", () => {
    const resolved = resolveSiteConfig({ bundle: fromBundle, siteFile, snippet, ref: "ia_x" });
    expect(resolved.carrier).toBe("bundle");
    expect(resolved.config.intro.name).toBe("From the bundle");
  });

  it("falls to the site file when the bundle carries no settings", () => {
    const resolved = resolveSiteConfig({ bundle: null, siteFile, snippet, ref: "ia_x" });
    expect(resolved.carrier).toBe("site-file");
    expect(resolved.config.intro.name).toBe("From the site file");
  });

  it("re-types the bundle's document as paranoidly as any other carrier", () => {
    const resolved = resolveSiteConfig({
      bundle: { version: 1, depth: 99, knowledge: ["../secret", "/faq.md"], evil: true },
      ref: "ia_x",
    });
    expect(resolved.carrier).toBe("bundle");
    expect(resolved.config.depth).toBe(2);
    expect(resolved.config.knowledge).toEqual(["/faq.md"]);
    expect(resolved.notes.join(" ")).toContain("evil");
  });

  it("carries the owner's link key through, and refuses one of the wrong shape", () => {
    const good = resolveSiteConfig({ bundle: { version: 1, linkPub: "A".repeat(43) } });
    expect(good.config.linkPub).toBe("A".repeat(43));
    const bad = resolveSiteConfig({ bundle: { version: 1, linkPub: "too-short" } });
    expect(bad.config.linkPub).toBeUndefined();
    expect(bad.notes.join(" ")).toContain("ed25519");
  });
});

describe("read_public, over the bundle", () => {
  it("answers from the bundle without a fetch, and lists it beside the site's own files", async () => {
    const fetcher = fakeFetch({ "https://shop.example/faq.md": { body: "the site's own faq" } });
    const files: Record<string, string> = { "PERSONA.md": "I am the shop guide." };
    const knowledge = createKnowledgeReader({
      origin: "https://shop.example",
      paths: ["/faq.md"],
      fetchImpl: fetcher.fn,
      bundle: () => files,
    });

    expect(knowledge.list()).toEqual(["PERSONA.md", "/faq.md"]);
    expect(await knowledge.read("PERSONA.md")).toBe("I am the shop guide.");
    // A leading slash is a URL habit, not an error: the same file answers either way.
    expect(await knowledge.read("/PERSONA.md")).toBe("I am the shop guide.");
    expect(fetcher.calls).toEqual([]);

    expect(await knowledge.read("/faq.md")).toBe("the site's own faq");
    expect(fetcher.calls).toHaveLength(1);
  });

  it("sees a bundle that arrives after the reader was built", async () => {
    const files: Record<string, string> = {};
    const knowledge = createKnowledgeReader({
      origin: "https://shop.example",
      paths: [],
      fetchImpl: fakeFetch({}).fn,
      bundle: () => files,
    });
    expect(await knowledge.read("PERSONA.md")).toBeNull();
    files["PERSONA.md"] = "late but here";
    expect(await knowledge.read("PERSONA.md")).toBe("late but here");
  });
});
