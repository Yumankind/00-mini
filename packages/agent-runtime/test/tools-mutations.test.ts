// delete / move / copy / stat, and what `read` does with a picture.
//
// The four file tools have no pi twin (see the box in tools-fs.ts), so these tests ARE the spec:
// what each refuses, what it emits, and which of them is `high-risk`.

import { describe, expect, it } from "vitest";
import {
  IMAGE_MAX_BYTES,
  createAgentRuntime,
  fullTools,
  copyTool,
  deleteTool,
  moveTool,
  readTool,
  statTool,
  type AgentEvent,
  type AgentRuntimeOptionsExt,
  type ToolContext,
} from "../src/index.js";
import { FakeProvider, call } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

function ctxFor(fs: MemoryFs, sandbox = "workspace"): { ctx: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { events, ctx: { fs, sandbox, signal: new AbortController().signal, emit: (e) => events.push(e) } };
}

describe("stat", () => {
  it("describes a file, a directory and an absence without failing on any of them", async () => {
    const fs = new MemoryFs({ "workspace/notes/a.md": "hello" });
    const { ctx } = ctxFor(fs);
    expect((await statTool().run({ path: "notes/a.md" }, ctx)).output).toMatch(/^notes\/a\.md {2}file {2}5 bytes {2}modified /);
    expect((await statTool().run({ path: "notes" }, ctx)).output).toContain("notes/  directory");
    // An absence is an ANSWER, not an error: "does this exist" is the question the tool is for.
    expect(await statTool().run({ path: "nope.md" }, ctx)).toEqual({ output: "nope.md does not exist." });
  });

  it("stops at the sandbox like every other file tool", async () => {
    const { ctx } = ctxFor(new MemoryFs({ "vault.json": "{}" }));
    await expect(statTool().run({ path: "../vault.json" }, ctx)).rejects.toThrow(/outside this agent's sandbox/);
  });
});

describe("delete", () => {
  it("deletes a file and emits file_changed with op delete — the arm that could never fire before", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x" });
    const { ctx, events } = ctxFor(fs);
    expect((await deleteTool().run({ path: "a.md" }, ctx)).output).toBe("Deleted a.md.");
    expect(fs.readSync("workspace/a.md")).toBeUndefined();
    expect(events).toEqual([{ type: "file_changed", path: "workspace/a.md", op: "delete" }]);
  });

  it("refuses a directory without `recursive`, and takes the whole subtree with it", async () => {
    const fs = new MemoryFs({ "workspace/proj/a.md": "x", "workspace/proj/deep/b.md": "y" });
    const { ctx } = ctxFor(fs);
    expect(await deleteTool().run({ path: "proj" }, ctx)).toMatchObject({ isError: true });
    expect(fs.readSync("workspace/proj/a.md")).toBe("x");

    expect((await deleteTool().run({ path: "proj", recursive: true }, ctx)).output).toContain("and everything in it");
    expect(fs.paths()).toEqual([]);
  });

  it("says so rather than pretending, when there is nothing there", async () => {
    const { ctx } = ctxFor(new MemoryFs());
    const result = await deleteTool().run({ path: "ghost.md" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("does not exist");
  });

  it("is `confirm` for a file and `high-risk` for a folder", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x", "workspace/dir/b.md": "y" });
    const { ctx } = ctxFor(fs);
    const tool = deleteTool();
    expect(tool.tier).toBe("confirm");
    expect(await tool.tierFor!({ path: "a.md" }, ctx)).toBe("confirm");
    expect(await tool.tierFor!({ path: "dir" }, ctx)).toBe("high-risk");
    // A path that will not even resolve asks the stricter question rather than the looser one.
    expect(await tool.tierFor!({ path: "../../etc" }, ctx)).toBe("high-risk");
  });
});

describe("move", () => {
  it("renames a file, makes the parent, and reports one `rename`", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x" });
    const { ctx, events } = ctxFor(fs);
    expect((await moveTool().run({ from: "a.md", to: "notes/b.md" }, ctx)).output).toBe("Moved a.md → notes/b.md");
    expect(fs.readSync("workspace/notes/b.md")).toBe("x");
    expect(events).toEqual([{ type: "file_changed", path: "workspace/notes/b.md", op: "rename" }]);
  });

  it("never clobbers, never moves nothing, never moves onto itself", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x", "workspace/b.md": "y" });
    const { ctx } = ctxFor(fs);
    expect(await moveTool().run({ from: "a.md", to: "b.md" }, ctx)).toMatchObject({ isError: true });
    expect(fs.readSync("workspace/b.md")).toBe("y");
    expect(await moveTool().run({ from: "ghost.md", to: "c.md" }, ctx)).toMatchObject({ isError: true });
    expect(await moveTool().run({ from: "a.md", to: "a.md" }, ctx)).toMatchObject({ isError: true });
  });

  it("cannot move anything out of the sandbox, in either direction", async () => {
    const { ctx } = ctxFor(new MemoryFs({ "workspace/a.md": "x" }));
    await expect(moveTool().run({ from: "a.md", to: "../a.md" }, ctx)).rejects.toThrow(/outside this agent's sandbox/);
    await expect(moveTool().run({ from: "../vault.json", to: "a.md" }, ctx)).rejects.toThrow(/outside this agent's sandbox/);
  });
});

describe("copy", () => {
  it("copies a file", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x" });
    const { ctx, events } = ctxFor(fs);
    await copyTool().run({ from: "a.md", to: "backup/a.md" }, ctx);
    expect(fs.readSync("workspace/backup/a.md")).toBe("x");
    expect(fs.readSync("workspace/a.md")).toBe("x");
    expect(events).toEqual([{ type: "file_changed", path: "workspace/backup/a.md", op: "write" }]);
  });

  it("copies a directory whole, and refuses to copy one into itself", async () => {
    const fs = new MemoryFs({ "workspace/proj/a.md": "1", "workspace/proj/deep/b.md": "2" });
    const { ctx } = ctxFor(fs);
    expect((await copyTool().run({ from: "proj", to: "proj-copy" }, ctx)).output).toContain("Copied 2 files");
    expect(fs.readSync("workspace/proj-copy/deep/b.md")).toBe("2");
    expect(await copyTool().run({ from: "proj", to: "proj/inner" }, ctx)).toMatchObject({ isError: true });
  });

  it("refuses an occupied destination and a missing source", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "x", "workspace/b.md": "y" });
    const { ctx } = ctxFor(fs);
    expect(await copyTool().run({ from: "a.md", to: "b.md" }, ctx)).toMatchObject({ isError: true });
    expect(await copyTool().run({ from: "ghost", to: "c" }, ctx)).toMatchObject({ isError: true });
    expect(await copyTool().run({ from: "a.md", to: "a.md" }, ctx)).toMatchObject({ isError: true });
  });
});

describe("read, when the file is a picture (gap B10)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("hands back the BYTES as `images`, and a caption as the text", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("workspace/files/shot.png", png);
    const { ctx } = ctxFor(fs);
    const result = await readTool().run({ path: "files/shot.png" }, ctx);
    expect(result.images).toEqual([{ mime: "image/png", data: png, source: "files/shot.png" }]);
    expect(result.output).toBe("[image files/shot.png — image/png, 0 KB]");
  });

  it("knows the four formats by extension, case-insensitively, and leaves everything else as text", async () => {
    const fs = new MemoryFs({ "workspace/a.md": "# text" });
    for (const name of ["a.JPG", "b.jpeg", "c.webp", "d.gif"]) await fs.writeFile(`workspace/${name}`, png);
    const { ctx } = ctxFor(fs);
    for (const [name, mime] of [
      ["a.JPG", "image/jpeg"],
      ["b.jpeg", "image/jpeg"],
      ["c.webp", "image/webp"],
      ["d.gif", "image/gif"],
    ] as const) {
      expect((await readTool().run({ path: name }, ctx)).images?.[0].mime).toBe(mime);
    }
    expect((await readTool().run({ path: "a.md" }, ctx)).images).toBeUndefined();
  });

  it("refuses one that is too big, and names the size so the agent can say it", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("workspace/huge.png", new Uint8Array(IMAGE_MAX_BYTES + 1024));
    const { ctx } = ctxFor(fs);
    const result = await readTool().run({ path: "huge.png" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("over the 4 MB limit");
    expect(result.images).toBeUndefined();
  });
});

describe("a picture through the loop", () => {
  it("reaches the provider on the tool result, and the session file keeps the caption", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief" });
    await fs.writeFile("workspace/files/shot.png", png);
    const provider = new FakeProvider("local", [
      { toolCalls: [call("read", { path: "files/shot.png" })] },
      { text: "It is a screenshot of a login form." },
    ]);
    const runtime = createAgentRuntime({
      fs,
      providers: [provider],
      tools: fullTools(),
      trust: "full",
      now: () => new Date("2026-09-10T10:00:00Z"),
      async askPermission() {
        return { allowed: true };
      },
    } as AgentRuntimeOptionsExt);

    await runtime.run({ prompt: "what is in that screenshot?" });

    const observation = provider.requests[1].messages.at(-1)!;
    expect(observation.images).toEqual([{ mime: "image/png", data: png, source: "files/shot.png" }]);
    expect(observation.content).toContain("[image files/shot.png");

    // The transcript on disk carries the caption and the path, never the bytes.
    const session = fs.paths().find((p) => p.startsWith("sessions/"))!;
    const raw = fs.readSync(session)!;
    expect(raw).toContain("[image files/shot.png");
    expect(raw).not.toContain("image/png\",\"data");
  });
});
