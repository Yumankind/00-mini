// The first-run interview, end to end (gap B13).
//
// The path the audit found broken was not one function: it was "BOOTSTRAP.md is written and
// ignored". So the last test here is the WHOLE path with a scripted model — prompt leads with the
// interview, the agent writes the identity files, calls `finish_onboarding`, and the NEXT run's
// prompt no longer mentions setup.

import { describe, expect, it } from "vitest";
import {
  ContextManager,
  createAgentRuntime,
  finishOnboardingTool,
  fullTools,
  onboardingState,
  type AgentEvent,
  type AgentRuntimeOptionsExt,
  type ToolContext,
} from "../src/index.js";
import { FakeProvider, call } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

function freshAgent(): MemoryFs {
  return new MemoryFs({
    "workspace/AGENTS.md": "be brief",
    "workspace/BOOTSTRAP.md": "Ask them their name and what they want you for.",
    "profile.json": JSON.stringify({ id: "a1", displayName: "Zero", onboarded: false }, null, 2),
  });
}

function ctxFor(fs: MemoryFs): { ctx: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { events, ctx: { fs, sandbox: "workspace", signal: new AbortController().signal, emit: (e) => events.push(e) } };
}

describe("onboardingState", () => {
  it("is pending only when BOTH the file and the flag say so", async () => {
    const fs = freshAgent();
    expect((await onboardingState(fs, "workspace")).pending).toBe(true);

    // A BOOTSTRAP.md left behind after setup does not re-open the interview.
    await fs.writeFile("profile.json", JSON.stringify({ onboarded: true }));
    expect((await onboardingState(fs, "workspace")).pending).toBe(false);

    // And no BOOTSTRAP.md means nothing to conduct an interview from, whatever the flag says.
    await fs.writeFile("profile.json", JSON.stringify({ onboarded: false }));
    await fs.remove("workspace/BOOTSTRAP.md");
    expect((await onboardingState(fs, "workspace")).pending).toBe(false);
  });

  it("treats a missing or broken profile as not-yet-set-up, since the file is the only evidence", async () => {
    const fs = new MemoryFs({ "workspace/BOOTSTRAP.md": "steps" });
    expect((await onboardingState(fs, "workspace")).pending).toBe(true);
    await fs.writeFile("profile.json", "{ not json");
    expect((await onboardingState(fs, "workspace")).pending).toBe(true);
  });
});

describe("the prompt", () => {
  it("leads with the interview while setup is pending, and drops it afterwards", async () => {
    const fs = freshAgent();
    const system = await new ContextManager(fs, { trust: "full", sandbox: "workspace", now }).system();
    expect(system.startsWith("# ⚑ FIRST-RUN SETUP")).toBe(true);
    expect(system).toContain("Interview the person IN THIS CONVERSATION");
    expect(system).toContain("USER.md");
    expect(system).toContain("finish_onboarding");

    await fs.writeFile("profile.json", JSON.stringify({ onboarded: true }));
    const after = await new ContextManager(fs, { trust: "full", sandbox: "workspace", now }).system();
    expect(after).not.toContain("FIRST-RUN SETUP");
    expect(after.startsWith("# 00 platform — essentials")).toBe(true);
  });

  it("never puts it in front of the LIGHT agent — a stranger is not the operator", async () => {
    const fs = freshAgent();
    const system = await new ContextManager(fs, { trust: "light", sandbox: "threads-fs/web/1", now }).system();
    expect(system).not.toContain("FIRST-RUN SETUP");
  });
});

describe("finish_onboarding", () => {
  it("flips the profile, deletes the file, and reports both changes", async () => {
    const fs = freshAgent();
    const { ctx, events } = ctxFor(fs);
    const result = await finishOnboardingTool().run({}, ctx);

    expect(result.output).toContain("Setup is finished");
    expect(JSON.parse(fs.readSync("profile.json")!)).toMatchObject({ id: "a1", displayName: "Zero", onboarded: true });
    expect(fs.readSync("workspace/BOOTSTRAP.md")).toBeUndefined();
    expect(events).toEqual([
      { type: "file_changed", path: "profile.json", op: "write" },
      { type: "file_changed", path: "workspace/BOOTSTRAP.md", op: "delete" },
    ]);
  });

  it("is idempotent: called twice, the second one says setup is already done", async () => {
    const fs = freshAgent();
    const { ctx } = ctxFor(fs);
    await finishOnboardingTool().run({}, ctx);
    expect((await finishOnboardingTool().run({}, ctx)).output).toContain("already finished");
  });

  it("still records the flag on a host with no profile.json at all", async () => {
    const fs = new MemoryFs({ "workspace/BOOTSTRAP.md": "steps" });
    const { ctx } = ctxFor(fs);
    await finishOnboardingTool().run({}, ctx);
    expect(JSON.parse(fs.readSync("profile.json")!)).toEqual({ onboarded: true });
  });

  it("asks first — it is a `confirm`, like every other write", () => {
    expect(finishOnboardingTool().tier).toBe("confirm");
  });
});

describe("the whole path, with a scripted brain", () => {
  it("interviews, writes the files, finishes, and the next run is a normal one", async () => {
    const fs = freshAgent();
    const provider = new FakeProvider("local", [
      { text: "Before anything else — what should I call you, and what do you want me for?" },
    ]);
    const asked: string[] = [];
    const runtime = createAgentRuntime({
      fs,
      providers: [provider],
      tools: fullTools({ now }),
      trust: "full",
      now,
      async askPermission(req) {
        asked.push(req.name);
        return { allowed: true };
      },
    } as AgentRuntimeOptionsExt);

    // Turn one: the model is handed the interview rule and asks rather than answering "hi".
    await runtime.run({ prompt: "hi" });
    expect(provider.requests[0].messages[0].content).toContain("FIRST-RUN SETUP");
    expect(provider.requests[0].tools?.map((t) => t.name)).toContain("finish_onboarding");

    // Turn two: the answers arrive, the files get written, setup ends.
    provider.say([
      {
        text: "Noted.",
        toolCalls: [
          call("write", { path: "USER.md", content: "# Bruno\nCalls me Bruno. Ships things." }),
          call("write", { path: "IDENTITY.md", content: "# Zero\n🤖" }),
          call("write", { path: "SOUL.md", content: "Short sentences. No flattery." }),
          call("finish_onboarding", {}),
        ],
      },
      { text: "All set — what shall we do first?" },
    ]);
    const second = await runtime.run({ prompt: "I'm Bruno, I want help shipping things." });

    expect(second.stopped).toBe("final");
    expect(fs.readSync("workspace/USER.md")).toContain("Bruno");
    expect(fs.readSync("workspace/BOOTSTRAP.md")).toBeUndefined();
    expect(JSON.parse(fs.readSync("profile.json")!).onboarded).toBe(true);
    expect(asked).toContain("finish_onboarding");

    // Turn three: a normal run, with no interview in front of it.
    provider.say([{ text: "Let's start." }]);
    await runtime.run({ prompt: "ok" });
    expect(provider.requests.at(-1)!.messages[0].content).not.toContain("FIRST-RUN SETUP");
  });
});
