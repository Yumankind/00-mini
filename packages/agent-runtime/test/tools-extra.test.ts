import { describe, expect, it } from "vitest";
import {
  NoShell,
  bashTool,
  gitTools,
  noteDate,
  rememberTool,
  type AgentEvent,
  type GitOps,
  type Shell,
  type ToolContext,
} from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

function ctxFor(fs: MemoryFs, sandbox = "workspace") {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const ctx: ToolContext = { fs, sandbox, signal: controller.signal, emit: (e) => events.push(e) };
  return { ctx, events, controller };
}

describe("bash / NoShell", () => {
  it("is always registered, and NoShell says where the work actually runs", async () => {
    const { ctx } = ctxFor(new MemoryFs());
    const result = await bashTool().run({ command: "npm test" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("this needs a real shell — wakes on your Mac");
    expect(result.output).toContain("npm test"); // names the command that did NOT run
  });

  it("brackets a command with command_started / command_completed", async () => {
    const { ctx, events } = ctxFor(new MemoryFs());
    await bashTool().run({ command: "ls" }, ctx);
    expect(events).toEqual([
      { type: "command_started", command: "ls" },
      { type: "command_completed", command: "ls", exitCode: 127 },
    ]);
  });

  it("is `confirm` even with no shell, so a standing answer survives a real shell arriving", () => {
    expect(bashTool().tier).toBe("confirm");
    expect(NoShell.available).toBe(false);
  });

  it("passes cwd, timeout and the abort signal through to a real shell", async () => {
    let seen: unknown;
    const shell: Shell = {
      available: true,
      label: "WASM shell",
      async run(command, opts) {
        seen = { command, cwd: opts.cwd, timeoutSec: opts.timeoutSec, aborted: opts.signal.aborted };
        return { output: "hello\n", exitCode: 0 };
      },
    };
    const { ctx, events } = ctxFor(new MemoryFs(), "workspace");
    const result = await bashTool(shell).run({ command: "echo hello", timeout: 5 }, ctx);
    expect(result).toEqual({ output: "hello\n", isError: false });
    expect(seen).toEqual({ command: "echo hello", cwd: "workspace", timeoutSec: 5, aborted: false });
    expect(events.at(-1)).toEqual({ type: "command_completed", command: "echo hello", exitCode: 0 });
  });

  it("turns a thrown shell into an error result rather than a thrown loop", async () => {
    const shell: Shell = {
      available: true,
      label: "broken",
      async run() {
        throw new Error("wasm module gone");
      },
    };
    const { ctx, events } = ctxFor(new MemoryFs());
    const result = await bashTool(shell).run({ command: "x" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("wasm module gone");
    expect(events.at(-1)).toMatchObject({ type: "command_completed", exitCode: -1 });
  });

  it("insists on a command", async () => {
    const { ctx } = ctxFor(new MemoryFs());
    expect(await bashTool().run({ command: "   " }, ctx)).toMatchObject({ isError: true });
  });
});

describe("remember", () => {
  const at = new Date("2026-09-10T14:05:00Z");
  const now = () => at;

  it("writes a dated note and adds the index line to MEMORY.md", async () => {
    const fs = new MemoryFs();
    const { ctx, events } = ctxFor(fs);
    const date = noteDate(at);
    const result = await rememberTool({ now }).run({ note: "Bruno prefers pnpm", title: "Tooling" }, ctx);

    expect(result.output).toContain(`memory/${date}.md`);
    const note = fs.readSync(`workspace/memory/${date}.md`)!;
    expect(note).toContain(`# ${date}`);
    expect(note).toContain("— Tooling");
    expect(note).toContain("Bruno prefers pnpm");

    const index = fs.readSync("workspace/MEMORY.md")!;
    expect(index).toContain("## Dated notes");
    expect(index).toContain(`- [${date}](memory/${date}.md)`);
    expect(events.filter((e) => e.type === "file_changed")).toHaveLength(2);
  });

  it("appends a second note the same day and does NOT duplicate the index line", async () => {
    const fs = new MemoryFs();
    const { ctx } = ctxFor(fs);
    const tool = rememberTool({ now });
    await tool.run({ note: "one" }, ctx);
    await tool.run({ note: "two" }, ctx);

    const date = noteDate(at);
    const note = fs.readSync(`workspace/memory/${date}.md`)!;
    expect(note).toContain("one");
    expect(note).toContain("two");
    expect(note.match(new RegExp(`# ${date}`, "g"))).toHaveLength(1);

    const index = fs.readSync("workspace/MEMORY.md")!;
    expect(index.match(new RegExp(`memory/${date}\\.md`, "g"))).toHaveLength(1);
  });

  it("keeps an existing MEMORY.md and threads the new date in under the heading", async () => {
    const fs = new MemoryFs({ "workspace/MEMORY.md": "# MEMORY\n\nWhat I know.\n\n## Dated notes\n- [2026-01-01](memory/2026-01-01.md)\n" });
    const { ctx } = ctxFor(fs);
    await rememberTool({ now }).run({ note: "new fact" }, ctx);
    const index = fs.readSync("workspace/MEMORY.md")!;
    expect(index).toContain("What I know.");
    expect(index).toContain("- [2026-01-01](memory/2026-01-01.md)");
    expect(index).toContain(`- [${noteDate(at)}](memory/${noteDate(at)}.md)`);
    expect(index.match(/## Dated notes/g)).toHaveLength(1);
  });

  it("adds the heading to a MEMORY.md that has none", async () => {
    const fs = new MemoryFs({ "workspace/MEMORY.md": "# MEMORY\n\nJust prose.\n" });
    const { ctx } = ctxFor(fs);
    await rememberTool({ now }).run({ note: "fact" }, ctx);
    const index = fs.readSync("workspace/MEMORY.md")!;
    expect(index).toContain("Just prose.");
    expect(index).toContain("## Dated notes");
  });

  it("refuses an empty note, and is `confirm` because memory travels in every bundle", async () => {
    const { ctx } = ctxFor(new MemoryFs());
    expect(await rememberTool().run({ note: "  " }, ctx)).toMatchObject({ isError: true });
    expect(rememberTool().tier).toBe("confirm");
  });
});

describe("git tools", () => {
  function fakeOps() {
    const calls: { name: string; args: unknown }[] = [];
    const record = (name: string) => async (args: unknown) => {
      calls.push({ name, args });
      return `${name} ok`;
    };
    const ops: GitOps = {
      gitStatus: record("gitStatus"),
      gitLog: record("gitLog"),
      gitDiff: record("gitDiff"),
      gitAdd: record("gitAdd"),
      gitCommit: record("gitCommit"),
    };
    return { ops, calls };
  }

  it("registers the five names with reads safe and writes confirm", () => {
    const { ops } = fakeOps();
    const tiers = Object.fromEntries(gitTools(ops).map((t) => [t.schema.name, t.tier]));
    expect(tiers).toEqual({
      git_status: "safe",
      git_log: "safe",
      git_diff: "safe",
      git_add: "confirm",
      git_commit: "confirm",
    });
  });

  it("resolves `dir` inside the sandbox and defaults it to the sandbox root", async () => {
    const { ops, calls } = fakeOps();
    const tools = Object.fromEntries(gitTools(ops).map((t) => [t.schema.name, t]));
    const { ctx } = ctxFor(new MemoryFs());
    await tools.git_status.run({ dir: "projects/site" }, ctx);
    await tools.git_log.run({}, ctx);
    expect(calls[0].args).toEqual({ dir: "workspace/projects/site" });
    expect(calls[1].args).toEqual({ dir: "workspace", limit: 20 });
  });

  it("refuses a `dir` that climbs out of the sandbox", async () => {
    const { ops } = fakeOps();
    const status = gitTools(ops).find((t) => t.schema.name === "git_status")!;
    const { ctx } = ctxFor(new MemoryFs());
    await expect(status.run({ dir: "../../elsewhere" }, ctx)).rejects.toThrow(/outside this agent's sandbox/);
  });

  it("passes diff and add options through, and refuses empty ones", async () => {
    const { ops, calls } = fakeOps();
    const tools = Object.fromEntries(gitTools(ops).map((t) => [t.schema.name, t]));
    const { ctx } = ctxFor(new MemoryFs());
    await tools.git_diff.run({ path: "src", staged: true }, ctx);
    expect(calls[0].args).toEqual({ dir: "workspace", path: "src", staged: true });

    await tools.git_add.run({ paths: ["."] }, ctx);
    expect(calls[1].args).toEqual({ dir: "workspace", paths: ["."] });
    expect(await tools.git_add.run({ paths: [] }, ctx)).toMatchObject({ isError: true });

    await tools.git_commit.run({ message: "why, not what" }, ctx);
    expect(calls[2].args).toEqual({ dir: "workspace", message: "why, not what" });
    expect(await tools.git_commit.run({ message: "   " }, ctx)).toMatchObject({ isError: true });
  });
});

describe("git branches and checkout (gap B8)", () => {
  function branchingOps() {
    const calls: { name: string; args: unknown }[] = [];
    const record = (name: string) => async (args: unknown) => {
      calls.push({ name, args });
      return `${name} ok`;
    };
    const ops: GitOps = {
      gitStatus: record("gitStatus"),
      gitLog: record("gitLog"),
      gitDiff: record("gitDiff"),
      gitAdd: record("gitAdd"),
      gitCommit: record("gitCommit"),
      gitBranch: record("gitBranch"),
      gitCheckout: record("gitCheckout"),
    };
    return { ops, calls };
  }

  it("appears only when the ops object implements it — a cut-down host gets six tools, not eight", () => {
    const withBranches = gitTools(branchingOps().ops).map((t) => t.schema.name);
    expect(withBranches).toContain("git_branch");
    expect(withBranches).toContain("git_checkout");

    const readOnlyOps: GitOps = {
      gitStatus: async () => "",
      gitLog: async () => "",
      gitDiff: async () => "",
      gitAdd: async () => "",
      gitCommit: async () => "",
    };
    const names = gitTools(readOnlyOps).map((t) => t.schema.name);
    expect(names).not.toContain("git_branch");
    expect(names).not.toContain("git_checkout");
  });

  it("lists as `safe`, creates as `confirm`", async () => {
    const { ops, calls } = branchingOps();
    const branch = gitTools(ops).find((t) => t.schema.name === "git_branch")!;
    const { ctx } = ctxFor(new MemoryFs());
    expect(branch.tierFor!({}, ctx)).toBe("safe");
    expect(branch.tierFor!({ create: "feature" }, ctx)).toBe("confirm");
    expect(branch.tierFor!({ create: "  " }, ctx)).toBe("safe");

    await branch.run({}, ctx);
    await branch.run({ create: "feature", checkout: true }, ctx);
    expect(calls[0].args).toEqual({ dir: "workspace", checkout: false });
    expect(calls[1].args).toEqual({ dir: "workspace", create: "feature", checkout: true });
  });

  it("makes a FORCED checkout `high-risk` — the first shipped use of that tier", async () => {
    const { ops, calls } = branchingOps();
    const checkout = gitTools(ops).find((t) => t.schema.name === "git_checkout")!;
    const { ctx } = ctxFor(new MemoryFs());
    expect(checkout.tierFor!({ ref: "main" }, ctx)).toBe("confirm");
    expect(checkout.tierFor!({ ref: "main", force: true }, ctx)).toBe("high-risk");
    expect(checkout.schema.description).toContain("DESTROYS");

    await checkout.run({ ref: "feature", force: true }, ctx);
    expect(calls[0].args).toEqual({ dir: "workspace", ref: "feature", force: true });
    expect(await checkout.run({ ref: "  " }, ctx)).toMatchObject({ isError: true });
  });
});
