import { describe, expect, it } from "vitest";
import {
  GREP_MAX_LINE_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  capToolOutput,
  truncateHead,
  truncateLine,
} from "../src/index.js";

describe("truncateHead", () => {
  it("leaves short content alone", () => {
    expect(truncateHead("a\nb\n")).toMatchObject({ content: "a\nb\n", truncated: false, totalLines: 2 });
  });

  it("counts the trailing newline the way pi does — as a terminator, not a line", () => {
    expect(truncateHead("a\nb").totalLines).toBe(2);
    expect(truncateHead("a\nb\n").totalLines).toBe(2);
    expect(truncateHead("").totalLines).toBe(0);
  });

  it("cuts at the line limit and says so", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const t = truncateHead(content, { maxLines: 3 });
    expect(t).toMatchObject({ truncated: true, truncatedBy: "lines", outputLines: 3, totalLines: 10 });
    expect(t.content).toBe("line0\nline1\nline2");
  });

  it("cuts at the char limit, never mid-line", () => {
    const content = "aaaa\nbbbb\ncccc";
    const t = truncateHead(content, { maxChars: 7 });
    expect(t).toMatchObject({ truncated: true, truncatedBy: "chars" });
    expect(t.content).toBe("aaaa"); // "aaaa\nbbbb" would be 9
  });

  it("returns nothing rather than half a line when the first line alone blows the budget", () => {
    const t = truncateHead("x".repeat(100), { maxChars: 10 });
    expect(t.content).toBe("");
    expect(t.truncated).toBe(true);
  });

  it("carries pi's numbers", () => {
    expect(MAX_OUTPUT_LINES).toBe(2000);
    expect(MAX_OUTPUT_CHARS).toBe(50 * 1024);
    expect(GREP_MAX_LINE_CHARS).toBe(500);
  });
});

describe("capToolOutput", () => {
  it("passes anything within the cap through untouched", () => {
    expect(capToolOutput("small")).toBe("small");
  });

  it("appends a note that says what was shown and how to ask for less", () => {
    const capped = capToolOutput("y".repeat(200), 50);
    expect(capped).toContain("[Output truncated:");
    expect(capped).toContain("of 200 characters shown");
    expect(capped).toContain("Narrow the request");
  });

  it("still cuts when there is no newline to cut at", () => {
    const capped = capToolOutput("z".repeat(200), 50);
    expect(capped.startsWith("z".repeat(50))).toBe(true);
    expect(capped.length).toBeLessThan(250);
  });
});

describe("truncateLine", () => {
  it("marks a long line and leaves a short one", () => {
    expect(truncateLine("short")).toBe("short");
    const long = truncateLine("q".repeat(600));
    expect(long.endsWith("... [truncated]")).toBe(true);
    expect(long.length).toBe(GREP_MAX_LINE_CHARS + "... [truncated]".length);
  });
});
