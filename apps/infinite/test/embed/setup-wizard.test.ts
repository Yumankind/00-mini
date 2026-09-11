/**
 * The owner's setup wizard, in the parts a node test can hold: the walk, the refusals, the review,
 * and — the one that matters — the two documents step 5 hands over.
 *
 * WHY THE ROUND TRIP IS THE POINT. The owner may get one paste. Whatever the wizard prints has to
 * come back out of the loader's own reader unchanged: `siteFileText` → `validateSiteConfig`, and the
 * `data-site` attribute → `decodeDataSite` → `validateSiteConfig`. If a field the wizard collects
 * cannot survive that trip it is a field that does not exist, however nice the screen looked.
 */

import { describe, expect, it } from "vitest";
import { WELL_KNOWN_PATH } from "../../embed/src/panel/setup-model.js";
import {
  PERSONA_SUGGESTION,
  SITE_FILE_NAME,
  WIZARD_STEPS,
  carrierOutputs,
  defaultWizardAnswers,
  firstInvalidStep,
  summarise,
  validateStep,
  wizardKnowledge,
  wizardSiteConfig,
  type WizardAnswers,
} from "../../embed/src/panel/wizard-model.js";
import { decodeDataSite, validateSiteConfig } from "../../embed/src/site-config.js";
import { MINI_CSS } from "../../src/mini/mini-css.js";

const REF = "ia_abc123_xyz";
const ORIGIN = "https://shop.example";
const HOST = "https://infinite.example";

const filled = (over: Partial<WizardAnswers> = {}): WizardAnswers => ({
  ...defaultWizardAnswers(ORIGIN),
  introName: "The Acme guide",
  introLine: "Ask me where anything is.",
  depth: 1,
  ttlDays: 3,
  excludes: ["/drafts"],
  doNotTouch: ["/cart"],
  crawlAuthed: true,
  sessionKind: "cookie",
  cookies: ["session_id"],
  logoutPaths: ["/logout"],
  personaPath: PERSONA_SUGGESTION,
  knowledge: ["/faq.md"],
  brain: "local",
  ...over,
});

describe("the walk (§5.2.4, as a wizard)", () => {
  it("asks the five questions in the order a person can answer them", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["intro", "read", "knowledge", "brain", "review"]);
  });

  it("marks only the knowledge step as skippable", () => {
    expect(WIZARD_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["knowledge"]);
  });

  it("gives every step a question and a line under it", () => {
    for (const step of WIZARD_STEPS) {
      expect(step.title.length, step.id).toBeGreaterThan(3);
      expect(step.help.length, step.id).toBeGreaterThan(20);
      expect(step.label.length, step.id).toBeLessThan(12);
    }
  });
});

describe("what each step refuses", () => {
  it("lets an owner through with nothing typed at all: the defaults are a working agent", () => {
    const empty = defaultWizardAnswers(ORIGIN);
    for (const step of WIZARD_STEPS) expect(validateStep(step.id, empty), step.id).toBeNull();
    expect(firstInvalidStep(empty)).toBe(-1);
  });

  it("refuses an intro longer than the document would keep", () => {
    expect(validateStep("intro", filled({ introName: "n".repeat(65) }))).toContain("64");
    expect(validateStep("intro", filled({ introLine: "l".repeat(201) }))).toContain("200");
    expect(validateStep("intro", filled({ introName: "n".repeat(64) }))).toBeNull();
  });

  it("asks a dev origin for a domain that is a domain", () => {
    expect(validateStep("intro", filled({ finalDomain: "example.com" }))).toContain("https://");
    expect(validateStep("intro", filled({ finalDomain: "https://example.com" }))).toBeNull();
  });

  it("keeps depth and the TTL inside the loader's clamps", () => {
    expect(validateStep("read", filled({ depth: 3 }))).toContain("1 or 2");
    expect(validateStep("read", filled({ ttlDays: 0 }))).toContain("365");
    expect(validateStep("read", filled({ ttlDays: 400 }))).toContain("365");
  });

  it("will not take a session kind with nothing named, which would index and never forget", () => {
    expect(validateStep("read", filled({ sessionKind: "cookie", cookies: [] }))).toContain("cookie");
    expect(validateStep("read", filled({ sessionKind: "localStorage", storageKeys: [] }))).toContain("key");
    // Off, and the question does not apply: the answers are kept but nothing is indexed behind a login.
    expect(validateStep("read", filled({ crawlAuthed: false, sessionKind: "cookie", cookies: [] }))).toBeNull();
    expect(validateStep("read", filled({ sessionKind: "none" }))).toBeNull();
  });

  it("never blocks on the optional step or on the brain", () => {
    expect(validateStep("knowledge", filled({ personaPath: "", knowledge: [] }))).toBeNull();
    for (const brain of ["local", "router", "later"] as const) {
      expect(validateStep("brain", filled({ brain })), brain).toBeNull();
    }
  });

  it("names the first step that is wrong, so Next can refuse on the right screen", () => {
    expect(firstInvalidStep(filled({ ttlDays: 0 }))).toBe(1);
    expect(firstInvalidStep(filled({ introName: "n".repeat(200) }))).toBe(0);
  });
});

describe("the persona file", () => {
  it("rides in front of the knowledge list, because site.json has one list", () => {
    expect(wizardKnowledge(filled())).toEqual([PERSONA_SUGGESTION, "/faq.md"]);
  });

  it("is not listed twice when it is also in the knowledge list", () => {
    expect(wizardKnowledge(filled({ knowledge: ["/faq.md", PERSONA_SUGGESTION] }))).toEqual([PERSONA_SUGGESTION, "/faq.md"]);
  });

  it("is simply absent when it was skipped", () => {
    expect(wizardKnowledge(filled({ personaPath: "" }))).toEqual(["/faq.md"]);
  });

  it("cannot point off the origin", () => {
    const config = wizardSiteConfig(filled({ personaPath: "https://evil.example/p.md" }), REF, "site-file");
    expect(config.knowledge).toEqual(["/faq.md"]);
  });
});

describe("the review", () => {
  it("reads back every answer, and says where each one was given", () => {
    const lines = summarise(filled(), REF);
    const by = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(by["Name"]).toBe("The Acme guide");
    expect(by["Reads"]).toBe(ORIGIN);
    expect(by["Depth on load"]).toContain("1");
    expect(by["Keep a page for"]).toBe("3 day(s)");
    expect(by["Never these paths"]).toBe("/drafts");
    expect(by["Do not touch"]).toBe("/cart");
    expect(by["Signed-in pages"]).toContain("own device");
    expect(by["Session"]).toContain("session_id");
    expect(by["Sign-out paths"]).toBe("/logout");
    expect(by["Persona file"]).toBe(PERSONA_SUGGESTION);
    expect(by["Knowledge files"]).toContain("/faq.md");
    expect(by["Brain"]).toContain("visitor's device");
    expect(new Set(lines.map((l) => l.step))).toEqual(new Set(["intro", "read", "knowledge", "brain"]));
  });

  it("says what a blank answer will mean rather than leaving a gap", () => {
    const by = Object.fromEntries(summarise(defaultWizardAnswers(ORIGIN), REF).map((l) => [l.label, l.value]));
    expect(by["Name"]).toBe("00 Mini");
    expect(by["Only these paths"]).toBe("all of them");
    expect(by["Never these paths"]).toContain("built-in guard");
    expect(by["Persona file"]).toBe("none");
    expect(by["Sign-out paths"]).toContain("guessed");
  });

  it("reads back the CLAMPED document, not the raw answer", () => {
    const by = Object.fromEntries(summarise(filled({ introName: "n".repeat(80) }), REF).map((l) => [l.label, l.value]));
    expect(by["Name"]).toHaveLength(64);
  });

  it("says the brain honestly, including that later is a real answer", () => {
    const later = summarise(filled({ brain: "later" }), REF).find((l) => l.label === "Brain")!;
    expect(later.value).toContain("later");
    const router = summarise(filled({ brain: "router" }), REF).find((l) => l.label === "Brain")!;
    expect(router.value).toContain("router");
  });
});

describe("the two carriers step 5 hands over (§5.1)", () => {
  const out = carrierOutputs(filled(), REF, HOST);

  it("names the file and where it goes", () => {
    expect(out.path).toBe(WELL_KNOWN_PATH);
    expect(out.filename).toBe(SITE_FILE_NAME);
    expect(WELL_KNOWN_PATH.endsWith(SITE_FILE_NAME)).toBe(true);
  });

  it("round-trips the site file through the loader's own reader, unchanged", () => {
    const { config, notes } = validateSiteConfig(JSON.parse(out.fileText));
    expect(config).toEqual(out.fileConfig);
    expect(notes).toEqual([]);
    expect(config.ref).toBe(REF);
  });

  it("round-trips the script tag's data-site through decodeDataSite, unchanged", () => {
    const attr = /data-site='([^']+)'/.exec(out.snippet)?.[1];
    expect(attr, out.snippet).toBeTruthy();
    const { config, notes } = validateSiteConfig(decodeDataSite(attr!));
    expect(config).toEqual(out.snippetConfig);
    expect(notes).toEqual([]);
    // The ref binds a FILE to a snippet; inside the snippet it would be a claim about itself.
    expect(config.ref).toBeUndefined();
  });

  it("says the same thing both ways, apart from that ref", () => {
    const { ref: _dropped, ...file } = out.fileConfig;
    expect(out.snippetConfig).toEqual(file);
  });

  it("points both tags at this ref on the product host", () => {
    expect(out.bareSnippet).toBe(`<script async src="${HOST}/e/${REF}.js"></script>`);
    expect(out.snippet).toContain(`src="${HOST}/e/${REF}.js"`);
  });

  it("carries the owner's agent key in both, and only when it is one (§5.1)", () => {
    const key = "a".repeat(43);
    const withKey = carrierOutputs(filled({ linkPub: key }), REF, HOST);
    expect(withKey.fileConfig.linkPub).toBe(key);
    expect(withKey.snippetConfig.linkPub).toBe(key);
    expect(carrierOutputs(filled({ linkPub: "nope" }), REF, HOST).fileConfig.linkPub).toBeUndefined();
  });

  it("reaches every field the loader's reader accepts", () => {
    // Nothing the site-config reader takes may become unreachable from the wizard.
    const reachable = new Set(Object.keys(out.fileConfig));
    for (const field of [
      "version", "ref", "linkPub", "depth", "includes", "excludes", "ttlDays", "doNotTouch",
      "crawlAuthed", "session", "intro", "knowledge",
    ]) {
      if (field === "linkPub") continue; // asked for on step 4, proven above
      expect(reachable.has(field), field).toBe(true);
    }
    const full = carrierOutputs(filled({ includes: ["/help"], storageKeys: [], linkPub: "b".repeat(43) }), REF, HOST);
    expect(full.fileConfig.includes).toEqual(["/help"]);
  });
});

describe("the modal's stylesheet", () => {
  it("styles every class the wizard writes, in the one stylesheet both widgets render", () => {
    for (const name of [
      "mini-modal", "mini-modal-backdrop", "mini-wizard", "mini-steps", "mini-step", "mini-field",
      "mini-chips", "mini-chip", "mini-cards", "mini-card", "mini-wizard-foot",
    ]) {
      expect(MINI_CSS, name).toContain(`.${name}`);
    }
    expect(MINI_CSS).toContain('.mini-card[data-picked="1"]');
    expect(MINI_CSS).toContain("rgba(0,0,0,.45)");
    expect(MINI_CSS).toContain("max-width: 560px");
    expect(MINI_CSS).toContain("max-height: calc(100vh - 48px)");
  });
});
