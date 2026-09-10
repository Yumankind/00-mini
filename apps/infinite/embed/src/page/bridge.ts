/**
 * The live host page, as the embed is allowed to see and touch it.
 *
 * WHY this interface is short: it IS the boundary of §13. The embed may navigate, scroll, highlight
 * and describe — and that is the entire list. There is deliberately no `click`, no `fill`, no
 * `submit`, no `readValue`, no `cookies`: not disabled, not permission-gated, ABSENT, so that no
 * later tool can reach for one. The agent shows where the button is; the person presses it.
 *
 * The DOM implementation is ../page/dom-bridge.ts; the tools take the interface, so the whole tool
 * table is exercised in node against a double (see test/embed/tools.test.ts).
 */

import type { AuthState } from "../types.js";

/** One node of the accessibility tree handed to `page_current`, with a ref the tools can resolve. */
export interface AxNode {
  /** `e12` — stable for as long as the page is not reloaded. */
  ref: string;
  role: string;
  name: string;
  /** Heading level, for h1–h6. */
  level?: number;
  /** Same-origin href for links, so the agent can offer to open it. */
  href?: string;
}

export interface CurrentPage {
  url: string;
  title: string;
  tree: AxNode[];
  scroll: { y: number; height: number; percent: number };
  authState: AuthState;
}

export interface PageBridge {
  current(): CurrentPage;
  /** Same-origin navigation only; the panel survives it via sessionStorage and resumes. */
  open(url: string): { ok: boolean; message: string };
  /** Scrolls a `ref` or CSS selector into view. Nothing is drawn. */
  scrollTo(target: string): boolean;
  /** Scrolls into view AND outlines, with an optional callout. Cleared on the next message or click. */
  highlight(target: string, note?: string): boolean;
  /** What an element is, what it does per its label/aria, and where it sits. */
  describe(target: string): string | null;
  clearHighlights(): void;
}
