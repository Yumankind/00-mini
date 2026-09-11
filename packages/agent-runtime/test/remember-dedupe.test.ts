import { describe, expect, it } from "vitest";
import { rememberTool } from "../src/tools-memory.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-11T12:05:00");

describe("remember, asked twice (2026-09-11)", () => {
  it("writes a note once and says so the second time, so a stuck model cannot fill the memory", async () => {
    const fs = new MemoryFs({});
    const tool = rememberTool({ now });
    const ctx = { fs, sandbox: "workspace", signal: new AbortController().signal, emit: () => {} };
    const first = await tool.run({ note: "Waiting for the correct image path." }, ctx);
    expect(first.output).toMatch(/^Remembered in memory\/2026-09-11\.md/);
    const second = await tool.run({ note: "Waiting for the correct image path." }, ctx);
    expect(second.isError).toBeFalsy();
    expect(second.output).toMatch(/^Already remembered today/);
    const page = await fs.readText("workspace/memory/2026-09-11.md");
    expect(page.match(/Waiting for the correct image path\./g)?.length).toBe(1);
    // A different note on the same day is still written.
    const third = await tool.run({ note: "The person likes green rockets." }, ctx);
    expect(third.output).toMatch(/^Remembered/);
  });
});
