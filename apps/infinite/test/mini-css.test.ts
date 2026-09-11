/**
 * ONE STYLESHEET, TWO IMPLEMENTATIONS — the invariants that make that true.
 *
 * The Vue widget and the embed panel both write these class names, and nothing in node can look at
 * either of them rendering. What CAN be checked is the contract between them: every class DESIGN.md
 * lists is styled, the module has no imports (the embed's byte budget), both themes are declared,
 * and no selector escapes `.mini` — a widget stylesheet that reached the host page would be a
 * modification of somebody else's website, which §13 forbids.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MINI_CSS } from "../src/mini/mini-css.js";
import { PANEL_CSS } from "../embed/src/panel/styles.js";

/** The names DESIGN.md freezes, plus the ones the embed's own furniture needs. */
const CLASSES = [
  "mini", "mini-launcher", "mini-panel", "mini-header", "mini-face", "mini-title", "mini-sub",
  "mini-actions", "mini-body", "mini-row", "mini-md", "mini-composer", "mini-input", "mini-send",
  "mini-footer", "mini-offer", "mini-ask", "mini-hit", "mini-setup",
];

describe("the widget's stylesheet", () => {
  it("styles every class both implementations write", () => {
    for (const name of CLASSES) expect(MINI_CSS, name).toContain(`.${name}`);
  });

  it("styles the six row kinds", () => {
    for (const kind of ["me", "them", "status", "tool", "error", "owner"]) {
      expect(MINI_CSS, kind).toContain(`.mini-row.${kind}`);
    }
  });

  it("is the SAME string the embed injects into its shadow root", () => {
    expect(PANEL_CSS).toBe(MINI_CSS);
  });

  it("imports nothing, because the embed carries it", () => {
    const source = readFileSync(new URL("../src/mini/mini-css.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("declares light, dark, and the app's explicit theme in both directions", () => {
    expect(MINI_CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(MINI_CSS).toContain('[data-theme="dark"] .mini');
    expect(MINI_CSS).toContain('[data-theme="light"] .mini');
  });

  it("opens the panel from an attribute, so neither implementation keeps that state twice", () => {
    expect(MINI_CSS).toContain('.mini-panel[data-open="1"]');
  });

  it("is a bottom sheet on a phone, and respects reduced motion", () => {
    expect(MINI_CSS).toContain("@media (max-width: 480px)");
    expect(MINI_CSS).toContain("@media (prefers-reduced-motion: no-preference)");
  });

  it("never styles anything outside itself", () => {
    // Every selector in the sheet, with the at-rules and declaration bodies taken away.
    // `@keyframes` goes first and whole: its `from`/`to` are steps, not selectors of anything.
    const selectors = MINI_CSS
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
      .replace(/\{[^{}]*\}/g, "")
      .split(/[\n{]/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("@") && !line.startsWith("}") && !line.startsWith("/*"));
    for (const group of selectors) {
      for (const selector of group.replace(/,$/, "").split(",")) {
        const one = selector.trim();
        if (!one) continue;
        // `:host` is the shadow host itself — the embed's own element, not the page's.
        const reaches = one.startsWith(":host") || one.includes(".mini");
        expect(reaches, one).toBe(true);
      }
    }
  });
});
