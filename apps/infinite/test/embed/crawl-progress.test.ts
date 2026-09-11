import { describe, expect, it } from "vitest";
import { CRAWL_BAR_LINGER_MS, crawlBarState } from "../../embed/src/panel/crawl-progress.js";

describe("crawlBarState", () => {
  it("is invisible with nothing running", () => {
    expect(crawlBarState(null)).toEqual({ percent: 0, line: "", visible: false, finished: false });
  });

  it("draws the bar against what the round will actually do, never past the bound", () => {
    expect(crawlBarState({ phase: "load", done: 12, max: 60, queued: 48 })).toMatchObject({
      percent: 20,
      line: "Reading this site · 12 of 60 pages",
      visible: true,
    });
    // A frontier bigger than the bound: the denominator is the bound.
    expect(crawlBarState({ phase: "hint", done: 10, max: 40, queued: 500 }).line).toBe(
      "Looking further into this site · 10 of 40 pages",
    );
    // Nothing queued yet at the start: the bar shows a sliver, not an empty box.
    expect(crawlBarState({ phase: "refresh", done: 0, max: 60, queued: 0 }).percent).toBe(2);
  });

  it("finishes full and counts what it read", () => {
    expect(crawlBarState({ phase: "load", done: 23, max: 60, queued: 0, finished: true })).toMatchObject({
      percent: 100,
      line: "Read 23 pages",
      finished: true,
    });
    expect(crawlBarState({ phase: "load", done: 1, max: 60, queued: 0, finished: true }).line).toBe("Read 1 page");
    expect(crawlBarState({ phase: "refresh", done: 0, max: 60, queued: 0, finished: true }).line).toBe("Nothing new to read");
    expect(CRAWL_BAR_LINGER_MS).toBeGreaterThan(1000);
  });
});
