/**
 * THE PAGE'S OWN TABLE OF CONTENTS. It is data because two readers need it — the page draws it, the
 * agent is told it — and the thing that would break quietly is a mismatch: an anchor the agent can
 * name and the page does not have, or the two drifting out of the order DESIGN.md fixed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAQ, LANDING_SECTIONS, MODELS, sectionMapLine } from "../src/landing/sections.js";

/** DESIGN.md, "The landing": the ids, in this order. */
const EXPECTED = ["hero", "code", "mobile", "file", "qr", "vault", "offline", "brains", "embed", "faq"];

function landingMarkup(): string {
  const files = ["LandingPage", "HeroSection", "CodeSection", "CarrySection", "TrustSection", "BrainsSection", "EmbedSection", "FaqSection"];
  return files.map((name) => readFileSync(new URL(`../src/landing/${name}.vue`, import.meta.url), "utf8")).join("\n");
}

describe("the landing sections", () => {
  it("are the plan's ids, in the plan's order", () => {
    expect(LANDING_SECTIONS.map((s) => s.id)).toEqual(EXPECTED);
  });

  it("every one of them is actually on the page", () => {
    const markup = landingMarkup();
    for (const section of LANDING_SECTIONS) expect(markup, section.id).toContain(`id="${section.id}"`);
  });

  it("says something about each one, for the agent's map", () => {
    for (const section of LANDING_SECTIONS) {
      expect(section.title.length, section.id).toBeGreaterThan(3);
      expect(section.summary.length, section.id).toBeGreaterThan(20);
    }
    expect(sectionMapLine()).toContain("#hero An AI agent you don't install");
  });

  it("has six answers in the FAQ, as the plan asks", () => {
    expect(FAQ).toHaveLength(6);
    for (const item of FAQ) expect(item.a.length).toBeGreaterThan(40);
  });

  it("names the licence of every model row, and links Gemma's terms rather than summarising them", () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const model of MODELS) {
      expect(model.licence, model.name).toBeTruthy();
      expect(model.size, model.name).toMatch(/GB$/);
    }
    expect(MODELS.filter((m) => m.gemma).length).toBeGreaterThan(0);
  });

  it("keeps the voice: no exclamation marks in the copy", () => {
    const copy = [
      ...LANDING_SECTIONS.flatMap((s) => [s.title, s.summary]),
      ...FAQ.flatMap((f) => [f.q, f.a]),
      ...MODELS.map((m) => m.role),
    ];
    for (const line of copy) expect(line, line).not.toContain("!");
  });
});
