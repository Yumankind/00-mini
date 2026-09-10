import { describe, expect, it } from "vitest";
import {
  LIGHT_TOOL_NAMES,
  MAX_OUTPUT_LINES,
  SeenFiles,
  editTool,
  findTool,
  fullTools,
  grepTool,
  lightTools,
  NoShell,
  bashTool,
  lsTool,
  readPublicTool,
  readTool,
  writeTool,
  type AgentEvent,
  type Shell,
  type Tool,
  type ToolContext,
} from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

function ctxFor(fs: MemoryFs, sandbox = "workspace"): { ctx: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    ctx: { fs, sandbox, signal: new AbortController().signal, emit: (e) => events.push(e) },
  };
}

const run = (tool: Tool, args: Record<string, unknown>, ctx: ToolContext) => tool.run(args, ctx);

describe("read", () => {
  it("reads a file, relative to the sandbox", async () => {
    const fs = new MemoryFs({ "workspace/AGENTS.md": "line1\nline2\n" });
    const { ctx } = ctxFor(fs);
    expect((await run(readTool(), { path: "AGENTS.md" }, ctx)).output).toBe("line1\nline2\n");
  });

  it("honours offset and limit, and says how to continue", async () => {
    const fs = new MemoryFs({ "workspace/a.txt": "1\n2\n3\n4\n5" });
    const { ctx } = ctxFor(fs);
    const result = await run(readTool(), { path: "a.txt", offset: 2, limit: 2 }, ctx);
    expect(result.output).toContain("2\n3");
    expect(result.output).toContain("[2 more lines in file. Use offset=4 to continue.]");
  });

  it("truncates a long file at pi's line limit and points at the next offset", async () => {
    const body = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const fs = new MemoryFs({ "workspace/big.txt": body });
    const { ctx } = ctxFor(fs);
    const result = await run(readTool(), { path: "big.txt" }, ctx);
    expect(result.output).toContain(`[Showing lines 1-${MAX_OUTPUT_LINES} of ${MAX_OUTPUT_LINES + 50}. Use offset=${MAX_OUTPUT_LINES + 1} to continue.]`);
  });

  it("refuses a missing file, a directory, and an out-of-range offset — each as an error result", async () => {
    const fs = new MemoryFs({ "workspace/dir/a.txt": "x" });
    const { ctx } = ctxFor(fs);
    expect(await run(readTool(), { path: "nope.md" }, ctx)).toMatchObject({ isError: true });
    expect(await run(readTool(), { path: "dir" }, ctx)).toMatchObject({ isError: true });
    expect(await run(readTool(), { path: "dir/a.txt", offset: 99 }, ctx)).toMatchObject({ isError: true });
  });

  it("throws on a path that escapes the sandbox — the loop turns it into an observation", async () => {
    const { ctx } = ctxFor(new MemoryFs({ "vault.json": "{}" }));
    await expect(run(readTool(), { path: "../vault.json" }, ctx)).rejects.toThrow(/outside this agent's sandbox/);
  });

  it("insists on a path argument", async () => {
    const { ctx } = ctxFor(new MemoryFs());
    await expect(run(readTool(), {}, ctx)).rejects.toThrow(/path is required/);
  });
});

describe("write", () => {
  it("creates a file and its parents, and emits file_changed", async () => {
    const fs = new MemoryFs();
    const { ctx, events } = ctxFor(fs);
    const result = await run(writeTool(), { path: "projects/site/README.md", content: "hi" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(fs.readSync("workspace/projects/site/README.md")).toBe("hi");
    expect(events).toContainEqual({ type: "file_changed", path: "workspace/projects/site/README.md", op: "write" });
  });

  it("refuses to overwrite a file this session has not read (the engine's guard)", async () => {
    const fs = new MemoryFs({ "workspace/NOTES.md": "existing" });
    const seen = new SeenFiles();
    const { ctx } = ctxFor(fs);
    const blocked = await run(writeTool(seen), { path: "NOTES.md", content: "new" }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("without reading it first");
    expect(fs.readSync("workspace/NOTES.md")).toBe("existing");

    await run(readTool(seen), { path: "NOTES.md" }, ctx);
    const allowed = await run(writeTool(seen), { path: "NOTES.md", content: "new" }, ctx);
    expect(allowed.isError).toBeUndefined();
    expect(fs.readSync("workspace/NOTES.md")).toBe("new");
  });

  it("clearing the seen book puts the guard back — that is what a new session means", async () => {
    const fs = new MemoryFs({ "workspace/NOTES.md": "existing" });
    const seen = new SeenFiles();
    const { ctx } = ctxFor(fs);
    await run(readTool(seen), { path: "NOTES.md" }, ctx);
    seen.clear();
    expect(await run(writeTool(seen), { path: "NOTES.md", content: "x" }, ctx)).toMatchObject({ isError: true });
  });

  it("refuses to write over a directory", async () => {
    const fs = new MemoryFs({ "workspace/dir/a.txt": "x" });
    const { ctx } = ctxFor(fs);
    expect(await run(writeTool(), { path: "dir", content: "x" }, ctx)).toMatchObject({ isError: true });
  });
});

describe("edit", () => {
  it("applies several disjoint edits against the ORIGINAL text, in one call", async () => {
    const fs = new MemoryFs({ "workspace/a.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n" });
    const { ctx, events } = ctxFor(fs);
    const result = await run(
      editTool(),
      {
        path: "a.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 10;" },
          { oldText: "const c = 3;", newText: "const c = 30;" },
        ],
      },
      ctx,
    );
    expect(result.output).toContain("Applied 2 edits");
    expect(fs.readSync("workspace/a.ts")).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
    expect(events.filter((e) => e.type === "file_changed")).toHaveLength(1);
  });

  it("accepts edits that arrive as a JSON string, the way some models send them", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "hello" });
    const { ctx } = ctxFor(fs);
    await run(editTool(), { path: "a.md", edits: JSON.stringify([{ oldText: "hello", newText: "bye" }]) }, ctx);
    expect(fs.readSync("workspace/a.md")).toBe("bye");
  });

  it("refuses a non-unique oldText, a missing one, an empty one and an overlap — writing nothing", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "aa bb aa" });
    const { ctx } = ctxFor(fs);
    expect(await run(editTool(), { path: "a.md", edits: [{ oldText: "aa", newText: "x" }] }, ctx)).toMatchObject({
      isError: true,
    });
    expect(await run(editTool(), { path: "a.md", edits: [{ oldText: "zz", newText: "x" }] }, ctx)).toMatchObject({
      isError: true,
    });
    expect(await run(editTool(), { path: "a.md", edits: [{ oldText: "", newText: "x" }] }, ctx)).toMatchObject({
      isError: true,
    });
    const overlap = await run(
      editTool(),
      { path: "a.md", edits: [{ oldText: "aa bb", newText: "x" }, { oldText: "bb aa", newText: "y" }] },
      ctx,
    );
    expect(overlap).toMatchObject({ isError: true });
    expect(fs.readSync("workspace/a.md")).toBe("aa bb aa");
  });

  it("refuses a malformed edits array up front", async () => {
    const { ctx } = ctxFor(new MemoryFs({ "workspace/a.md": "x" }));
    await expect(run(editTool(), { path: "a.md", edits: [] }, ctx)).rejects.toThrow(/non-empty array/);
    await expect(run(editTool(), { path: "a.md", edits: "not json" }, ctx)).rejects.toThrow(/array of/);
    await expect(run(editTool(), { path: "a.md", edits: [{ oldText: 1 }] }, ctx)).rejects.toThrow(/edits\[0\]/);
  });

  it("refuses a file that is not there", async () => {
    const { ctx } = ctxFor(new MemoryFs());
    expect(await run(editTool(), { path: "gone.md", edits: [{ oldText: "a", newText: "b" }] }, ctx)).toMatchObject({
      isError: true,
    });
  });
});

describe("ls", () => {
  it("lists alphabetically with a trailing slash for folders, dotfiles included", async () => {
    const fs = new MemoryFs({
      "workspace/SOUL.md": "x",
      "workspace/.00ignore": "x",
      "workspace/projects/site/a.txt": "x",
    });
    const { ctx } = ctxFor(fs);
    const out = (await run(lsTool(), {}, ctx)).output.split("\n");
    // pi's order: case-insensitive on the NAME, so `projects/` sorts before `SOUL.md`.
    expect(out).toEqual([".00ignore", "projects/", "SOUL.md"]);
  });

  it("limits and says it did", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 10; i++) seed[`workspace/f${i}.txt`] = "x";
    const { ctx } = ctxFor(new MemoryFs(seed));
    const out = (await run(lsTool(), { limit: 3 }, ctx)).output;
    expect(out).toContain("[Showing 3 of 10 entries.");
  });

  it("says so for an empty folder and refuses a non-folder", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x" });
    await fs.mkdir("workspace/empty");
    const { ctx } = ctxFor(fs);
    expect((await run(lsTool(), { path: "empty" }, ctx)).output).toBe("(empty directory)");
    expect(await run(lsTool(), { path: "a.md" }, ctx)).toMatchObject({ isError: true });
  });
});

describe("grep", () => {
  const fs = () =>
    new MemoryFs({
      "workspace/a.ts": "const x = 1;\nconst needle = 2;\n",
      "workspace/deep/b.md": "NEEDLE here\nnothing\n",
      "workspace/deep/c.txt": "nothing at all\n",
    });

  it("returns path:line:text for every match", async () => {
    const { ctx } = ctxFor(fs());
    const out = (await run(grepTool(), { pattern: "needle" }, ctx)).output;
    expect(out).toContain("a.ts:2:const needle = 2;");
    expect(out).not.toContain("b.md");
  });

  it("ignoreCase, literal and glob all narrow it the way pi's do", async () => {
    const { ctx } = ctxFor(fs());
    expect((await run(grepTool(), { pattern: "needle", ignoreCase: true }, ctx)).output).toContain("deep/b.md:1:");
    expect((await run(grepTool(), { pattern: "needle", glob: "*.ts" }, ctx)).output).not.toContain("b.md");
    // `.` as a literal must not match every character.
    expect((await run(grepTool(), { pattern: "n.thing", literal: true }, ctx)).output).toBe("No matches found.");
  });

  it("shows context lines with a dash separator", async () => {
    const { ctx } = ctxFor(fs());
    const out = (await run(grepTool(), { pattern: "needle", context: 1 }, ctx)).output;
    expect(out).toContain("a.ts:1-const x = 1;");
    expect(out).toContain("a.ts:2:const needle = 2;");
  });

  it("stops at the limit and says so", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 5; i++) seed[`workspace/f${i}.txt`] = "hit\nhit\n";
    const { ctx } = ctxFor(new MemoryFs(seed));
    const out = (await run(grepTool(), { pattern: "hit", limit: 3 }, ctx)).output;
    expect(out.split("\n").filter((l) => l.includes(":"))).toHaveLength(3);
    expect(out).toContain("[Reached the 3-match limit.");
  });

  it("truncates a very long matching line", async () => {
    const { ctx } = ctxFor(new MemoryFs({ "workspace/a.txt": `${"x".repeat(600)}needle` }));
    const out = (await run(grepTool(), { pattern: "needle" }, ctx)).output;
    expect(out).toContain("... [truncated]");
    expect(out.length).toBeLessThan(700);
  });

  it("searches one file when the path names one, and refuses a broken regex", async () => {
    const { ctx } = ctxFor(fs());
    expect((await run(grepTool(), { pattern: "NEEDLE", path: "deep/b.md" }, ctx)).output).toContain("deep/b.md:1:");
    expect(await run(grepTool(), { pattern: "([" }, ctx)).toMatchObject({ isError: true });
  });
});

describe("find", () => {
  const fs = () =>
    new MemoryFs({
      "workspace/a.md": "x",
      "workspace/memory/2026-09-10.md": "x",
      "workspace/projects/site/index.html": "x",
    });

  it("finds by basename glob at any depth, relative to the search folder", async () => {
    const { ctx } = ctxFor(fs());
    const out = (await run(findTool(), { pattern: "*.md" }, ctx)).output.split("\n");
    expect(out).toEqual(["a.md", "memory/2026-09-10.md"]);
  });

  it("searches inside a named folder, and says when nothing matched", async () => {
    const { ctx } = ctxFor(fs());
    expect((await run(findTool(), { pattern: "*.html", path: "projects" }, ctx)).output).toBe("site/index.html");
    expect((await run(findTool(), { pattern: "*.zip" }, ctx)).output).toBe("No files found.");
  });

  it("limits and refuses a non-folder", async () => {
    const { ctx } = ctxFor(fs());
    expect((await run(findTool(), { pattern: "*.md", limit: 1 }, ctx)).output).toContain("[Showing 1 of 2 results.");
    expect(await run(findTool(), { pattern: "*", path: "a.md" }, ctx)).toMatchObject({ isError: true });
  });
});

describe("read_public", () => {
  it("reads under workspace/public/ whatever the agent's own sandbox is", async () => {
    const fs = new MemoryFs({ "workspace/public/faq.md": "we open at nine" });
    const { ctx } = ctxFor(fs, "threads-fs/web/42");
    expect((await run(readPublicTool(), { path: "faq.md" }, ctx)).output).toBe("we open at nine");
  });

  it("cannot be talked out of the public folder, and says nothing about what is outside it", async () => {
    const fs = new MemoryFs({ "workspace/MEMORY.md": "private", "workspace/public/ok.md": "x" });
    const { ctx } = ctxFor(fs, "threads-fs/web/42");
    expect(await run(readPublicTool(), { path: "../MEMORY.md" }, ctx)).toEqual({
      output: "Path is outside the public folder.",
      isError: true,
    });
    expect(await run(readPublicTool(), { path: "missing.md" }, ctx)).toEqual({
      output: "File not found in public folder.",
      isError: true,
    });
  });

  it("caps a large public file at the engine's 20 000 characters", async () => {
    const fs = new MemoryFs({ "workspace/public/big.md": "y".repeat(30000) });
    const { ctx } = ctxFor(fs, "threads-fs/web/42");
    expect((await run(readPublicTool(), { path: "big.md" }, ctx)).output).toHaveLength(20000);
  });
});

describe("the two tool sets", () => {
  it("the full set carries the engine's names, plus the four with no pi twin", () => {
    const names = fullTools().map((t) => t.schema.name);
    expect(names).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "grep",
      "find",
      "stat",
      "delete",
      "move",
      "copy",
      "remember",
      "finish_onboarding",
    ]);
  });

  it("registers `bash` ONLY when a real shell was passed (A5)", () => {
    const has = (tools: Tool[]) => tools.some((t) => t.schema.name === "bash");
    expect(has(fullTools())).toBe(false);
    // NoShell is not a shell: it is the sentence a shell would have said, and a registered tool is a
    // claim of ability the agent was caught repeating.
    expect(has(fullTools({ shell: NoShell }))).toBe(false);
    const wasm: Shell = { available: true, label: "WASM shell", async run() { return { output: "", exitCode: 0 }; } };
    expect(has(fullTools({ shell: wasm }))).toBe(true);
  });

  it("adds retrieval, secrets and the network tool only when the host wires each one", () => {
    const bare = fullTools().map((t) => t.schema.name);
    expect(bare).not.toContain("search_workspace");
    expect(bare).not.toContain("list_secrets");
    expect(bare).not.toContain("http_get");

    const wired = fullTools({
      fs: new MemoryFs(),
      secrets: { async names() { return []; }, async get() { return null; } },
      network: { allow: [] },
    }).map((t) => t.schema.name);
    expect(wired).toContain("search_workspace");
    expect(wired).toContain("list_secrets");
    expect(wired).toContain("http_get");

    // `index: false` is the way to say "no retrieval" out loud, and `onboarding: false` the way to
    // leave the first-run tool out of a host that never scaffolds one.
    const off = fullTools({ fs: new MemoryFs(), index: false, onboarding: false }).map((t) => t.schema.name);
    expect(off).not.toContain("search_workspace");
    expect(off).not.toContain("finish_onboarding");
  });

  it("git tools appear only when a GitOps is injected", () => {
    const ops = {
      gitStatus: async () => "",
      gitLog: async () => "",
      gitDiff: async () => "",
      gitAdd: async () => "",
      gitCommit: async () => "",
    };
    expect(fullTools({ git: ops }).map((t) => t.schema.name)).toContain("git_commit");
  });

  it("the LIGHT set is the allowlist and nothing else — no write, no shell, no memory, no git", () => {
    const names = lightTools().map((t) => t.schema.name);
    expect(names).toEqual([...LIGHT_TOOL_NAMES]);
    for (const forbidden of ["write", "edit", "bash", "remember", "git_commit"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("every light tool is `safe`, and every mutating full tool is `confirm`", () => {
    for (const tool of lightTools()) expect(tool.tier).toBe("safe");
    const byName = new Map(fullTools().map((t) => [t.schema.name, t.tier]));
    expect(byName.get("read")).toBe("safe");
    expect(byName.get("write")).toBe("confirm");
    expect(byName.get("edit")).toBe("confirm");
    expect(byName.get("remember")).toBe("confirm");
    expect(byName.get("stat")).toBe("safe");
    for (const mutating of ["delete", "move", "copy", "finish_onboarding"]) {
      expect(byName.get(mutating)).toBe("confirm");
    }
    expect(bashTool().tier).toBe("confirm");
  });
});
