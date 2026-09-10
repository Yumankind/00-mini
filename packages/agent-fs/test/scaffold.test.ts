// The scaffold is a CONTRACT with the Mac engine, so what is asserted here is the tree of
// docs/agent-layout.md and the starter text, not the fact that some files were written.

import { describe, expect, it } from "vitest";
import { MemoryFs } from "../src/memory-fs.js";
import { BROWSER_CAPABILITIES, SCAFFOLD_DIRS, SCAFFOLD_FILES, ensureWorkspaceTmp, scaffoldAgent } from "../src/scaffold.js";

const AT = new Date("2026-09-10T12:00:00.000Z");

async function fresh() {
  const fs = new MemoryFs();
  const profile = await scaffoldAgent(fs, { id: "ia-test-1", displayName: "Ada", emoji: "🦉", language: "pt", now: () => AT });
  return { fs, profile };
}

describe("scaffoldAgent", () => {
  it("writes the folder of docs/agent-layout.md", async () => {
    const { fs } = await fresh();
    const files = fs.snapshot().map((f) => f.path);
    expect(files).toEqual([
      "profile.json",
      "workspace/AGENTS.md",
      "workspace/BOOTSTRAP.md",
      "workspace/IDENTITY.md",
      "workspace/MEMORY.md",
      "workspace/SOUL.md",
      "workspace/TOOLS.md",
      "workspace/USER.md",
      "workspace/tmp/README.md",
    ]);
    for (const dir of SCAFFOLD_DIRS) expect(fs.dirList()).toContain(dir);
    for (const name of SCAFFOLD_FILES) expect(await fs.stat(`workspace/${name}`)).not.toBeNull();
  });

  it("keeps the empty identity and work folders, so they travel in a bundle", async () => {
    const { fs } = await fresh();
    expect(fs.dirList()).toEqual([
      "quarantine",
      "sessions",
      "timeline",
      "workspace",
      "workspace/files",
      "workspace/memory",
      "workspace/projects",
      "workspace/public",
      "workspace/schedules",
      "workspace/skills",
      "workspace/tmp",
      "workspace/tools",
      "workspace/watchers",
    ]);
  });

  it("persists a profile the engine can read back", async () => {
    const { fs, profile } = await fresh();
    const onDisk = JSON.parse(await fs.readText("profile.json")) as typeof profile;
    expect(onDisk).toEqual(profile);
    expect(onDisk.id).toBe("ia-test-1");
    expect(onDisk.displayName).toBe("Ada");
    expect(onDisk.emoji).toBe("🦉");
    expect(onDisk.language).toBe("pt");
    expect(onDisk.createdAt).toBe("2026-09-10T12:00:00.000Z");
    expect(onDisk.onboarded).toBe(false);
    expect(onDisk.engine).toBe("pi");
    expect(onDisk.capabilities).toEqual(BROWSER_CAPABILITIES);
    expect(onDisk.model).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("defaults the emoji and omits a language nobody set", async () => {
    const fs = new MemoryFs();
    const profile = await scaffoldAgent(fs, { id: "x", displayName: "Nameless" });
    expect(profile.emoji).toBe("🤖");
    expect(profile.language).toBeUndefined();
    expect(profile.capabilities?.shell).toBe(false);
  });

  it("takes the caller's model and capability overrides", async () => {
    const fs = new MemoryFs();
    const profile = await scaffoldAgent(fs, {
      id: "x",
      displayName: "Local",
      model: { provider: "webllm", model: "qwen2.5-1.5b" },
      capabilities: { shell: true },
    });
    expect(profile.model).toEqual({ provider: "webllm", model: "qwen2.5-1.5b" });
    expect(profile.capabilities?.shell).toBe(true);
  });

  it("names the agent in the files that carry its identity", async () => {
    const { fs } = await fresh();
    expect(await fs.readText("workspace/IDENTITY.md")).toContain("**Name:** Ada");
    expect(await fs.readText("workspace/IDENTITY.md")).toContain("**Emoji:** 🦉");
    expect(await fs.readText("workspace/SOUL.md")).toContain("You are **Ada**");
    expect(await fs.readText("workspace/AGENTS.md")).toContain("# Operating instructions for Ada");
    expect(await fs.readText("workspace/BOOTSTRAP.md")).toContain("your very first session as **Ada**");
  });

  it("tells the onboarding brain how to end onboarding", async () => {
    const { fs } = await fresh();
    const bootstrap = await fs.readText("workspace/BOOTSTRAP.md");
    expect(bootstrap).toContain("finish_onboarding");
    expect(bootstrap).toContain("```00-ask");
    expect(bootstrap).toContain("public/PERSONA.md");
    const agents = await fs.readText("workspace/AGENTS.md");
    expect(agents).toContain("BOOTSTRAP.md");
    expect(agents).toContain("MEMORY.md");
  });

  it("gives tmp/ its README and never overwrites an edited one", async () => {
    const { fs } = await fresh();
    expect(await fs.readText("workspace/tmp/README.md")).toContain("Nothing in this folder ever travels");
    await fs.writeFile("workspace/tmp/README.md", "mine");
    await ensureWorkspaceTmp(fs);
    expect(await fs.readText("workspace/tmp/README.md")).toBe("mine");
  });
});
