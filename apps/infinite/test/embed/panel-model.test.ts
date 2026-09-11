import { describe, expect, it } from "vitest";
import { matchLandmark, planNoBrainReply, subjectOf } from "../../embed/src/panel/no-brain.js";
import {
  WELL_KNOWN_PATH,
  buildSiteConfig,
  checkSiteFile,
  defaultAnswers,
  isDevOrigin,
  sessionKindHelp,
  siteFileText,
  snippetFor,
} from "../../embed/src/panel/setup-model.js";
import { decodeDataSite, validateSiteConfig } from "../../embed/src/site-config.js";
import { fakeFetch } from "./helpers.js";

describe("the no-brain helper (§5.2.3)", () => {
  it("turns 'where is X' into a search and a highlight", () => {
    const plan = planNoBrainReply("Where can I change my password?");
    expect(plan.intent).toBe("where");
    expect(plan.subject).toBe("change my password");
    expect(plan.steps.map((s) => s.tool)).toEqual(["site_search", "page_highlight"]);
  });

  it("turns 'how do I X' into a search and, failing that, a targeted round", () => {
    const plan = planNoBrainReply("How do I return a jumper");
    expect(plan.intent).toBe("how");
    expect(plan.steps.map((s) => s.tool)).toEqual(["site_search", "site_crawl"]);
    expect(plan.status).toContain("looking through");
  });

  it("turns 'open X' into a search and a navigation", () => {
    expect(planNoBrainReply("open the pricing page").steps.map((s) => s.tool)).toEqual(["site_search", "page_open"]);
  });

  it("falls back to a plain search", () => {
    const plan = planNoBrainReply("refund policy");
    expect(plan.intent).toBe("search");
    expect(plan.subject).toBe("refund policy");
  });

  it("strips the question shell", () => {
    expect(subjectOf("where is the basket?")).toBe("basket");
    expect(subjectOf("boots")).toBe("boots");
  });

  it("points at a landmark only when the match is real", () => {
    const landmarks = [
      { name: "Search our whole catalogue of products", ref: "e9" },
      { name: "Basket", ref: "e2" },
      { name: "Sign in", ref: "e3" },
    ];
    expect(matchLandmark("basket", landmarks)?.target).toBe("e2");
    expect(matchLandmark("sign in", landmarks)?.target).toBe("e3");
    expect(matchLandmark("delivery times", landmarks)).toBeNull();
  });
});

describe("the owner's setup flow (§5.2.4)", () => {
  const ref = "ia_abc123_xyz";
  const answers = {
    ...defaultAnswers("https://shop.example"),
    depth: 1,
    ttlDays: 3,
    excludes: ["/drafts", "https://evil.example/x"],
    crawlAuthed: true,
    sessionKind: "cookie" as const,
    cookies: ["session_id"],
    logoutPaths: ["/logout"],
    introName: "The Acme guide",
    introLine: "Ask me where anything is.",
    knowledge: ["/faq.md"],
  };

  it("says dev mode on a local origin", () => {
    expect(isDevOrigin("http://localhost:5173")).toBe(true);
    expect(isDevOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isDevOrigin("https://shop.example")).toBe(false);
  });

  it("warns that an HttpOnly cookie is invisible", () => {
    expect(sessionKindHelp("cookie")).toContain("HttpOnly");
    expect(sessionKindHelp("temporary")).toContain("never written to disk");
  });

  it("builds a site.json that the loader's own validator accepts unchanged", () => {
    const config = buildSiteConfig({ ...answers, carrier: "site-file" }, ref);
    expect(config.ref).toBe(ref);
    expect(config.excludes).toEqual(["/drafts"]);
    expect(config.session).toEqual({ kind: "cookie", cookies: ["session_id"], storageKeys: [], logoutPaths: ["/logout"] });

    const { config: revalidated, notes } = validateSiteConfig(JSON.parse(siteFileText(config)));
    expect(revalidated).toEqual(config);
    expect(notes).toEqual([]);
  });

  it("keeps the ref out of the snippet carrier, where it would be a lie", () => {
    const config = buildSiteConfig({ ...answers, carrier: "snippet" }, ref);
    expect(config.ref).toBeUndefined();
  });

  it("writes a bare snippet for the site file and a data-site one for the attribute", () => {
    const siteFileConfig = buildSiteConfig({ ...answers, carrier: "site-file" }, ref);
    expect(snippetFor("https://infinite.example/", ref, siteFileConfig, "site-file")).toBe(
      `<script async src="https://infinite.example/e/${ref}.js"></script>`,
    );

    const snippetConfig = buildSiteConfig({ ...answers, carrier: "snippet" }, ref);
    const tag = snippetFor("https://infinite.example", ref, snippetConfig, "snippet");
    const encoded = /data-site='([^']+)'/.exec(tag)![1]!;
    expect(decodeDataSite(encoded)).toEqual(snippetConfig);
  });

  it("re-checks the URL until the file answers, and spots another agent's file", async () => {
    const good = fakeFetch({
      [`https://shop.example${WELL_KNOWN_PATH}`]: { body: JSON.stringify({ ref }), headers: { "content-type": "application/json" } },
    });
    expect((await checkSiteFile("https://shop.example", ref, good.fn)).ok).toBe(true);

    const wrong = fakeFetch({
      [`https://shop.example${WELL_KNOWN_PATH}`]: { body: JSON.stringify({ ref: "ia_someone_else" }) },
    });
    const answer = await checkSiteFile("https://shop.example", ref, wrong.fn);
    expect(answer.ok).toBe(false);
    expect(answer.message).toContain("ia_someone_else");

    const missing = await checkSiteFile("https://shop.example", ref, fakeFetch({}).fn);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("404");
  });
});
