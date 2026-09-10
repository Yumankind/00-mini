/**
 * The class-aware route of §6, end to end: the picker's ranking, and the loop deriving a class per
 * model call. The pin that matters most is at the bottom — a single-provider setup must behave
 * exactly as it did before any of this existed.
 */
import { describe, expect, it } from "vitest";
import {
  ModelRouter,
  createAgentRuntime,
  fullTools,
  lightTools,
  readTool,
  type AgentEvent,
  type AgentRuntimeOptionsExt,
} from "../src/index.js";
import { FakeProvider, call } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

/** A cloud brain: strong only. */
const strongOnly = (id: string, opts: { ready?: boolean } = {}) =>
  new FakeProvider(id, [{ text: "ok" }], { classes: ["strong"], ...opts });
/** A local brain: small only. */
const smallOnly = (id: string, opts: { ready?: boolean } = {}) =>
  new FakeProvider(id, [{ text: "ok" }], { classes: ["small"], ...opts });

describe("the picker honours the class", () => {
  it("takes the first ready provider that offers the class, not simply the first ready one", async () => {
    const cloud = strongOnly("overblast");
    const local = smallOnly("local-litert");
    const router = new ModelRouter([cloud, local]);
    expect(await router.pick("auto", "small")).toMatchObject({ provider: local, brainClass: "small" });
    expect(await router.pick("auto", "strong")).toMatchObject({ provider: cloud, brainClass: "strong" });
  });

  it("keeps the caller's order among the providers that do offer it", async () => {
    const first = smallOnly("local-litert");
    const second = smallOnly("local");
    expect((await new ModelRouter([first, second]).pick("auto", "small")).provider.id).toBe("local-litert");
    expect((await new ModelRouter([second, first]).pick("auto", "small")).provider.id).toBe("local");
  });

  it("skips a provider of the right class that is not ready — readiness is still the door", async () => {
    const sleeping = smallOnly("local-litert", { ready: false });
    const cloud = strongOnly("overblast");
    const awake = smallOnly("local");
    const picked = await new ModelRouter([sleeping, cloud, awake]).pick("auto", "small");
    expect(picked.provider.id).toBe("local");
  });

  it("falls back to small when nothing ready offers strong, and says so", async () => {
    const local = smallOnly("local-litert");
    const picked = await new ModelRouter([local]).pick("auto", "strong");
    expect(picked).toMatchObject({ provider: local, brainClass: "small" });
  });

  it("uses strong when small was asked and only strong is ready — better than nothing", async () => {
    const cloud = strongOnly("overblast");
    const picked = await new ModelRouter([cloud]).pick("auto", "small");
    expect(picked).toMatchObject({ provider: cloud, brainClass: "strong" });
  });

  it("falls back past a provider of the wrong class only after every ready one was considered", async () => {
    const cloudA = strongOnly("byok:openai");
    const cloudB = strongOnly("overblast");
    const picked = await new ModelRouter([cloudA, cloudB]).pick("auto", "small");
    expect(picked.provider.id).toBe("byok:openai");
  });

  it("hands back the first provider when nothing is ready, so the failure carries the provider's own words", async () => {
    const a = smallOnly("local-litert", { ready: false });
    const b = strongOnly("overblast", { ready: false });
    expect(await new ModelRouter([a, b]).pick("auto", "strong")).toMatchObject({ provider: a, brainClass: "strong" });
  });

  it("reads a catalogue once per provider per router, however many calls a run makes", async () => {
    const cloud = strongOnly("overblast");
    const local = smallOnly("local-litert");
    const router = new ModelRouter([cloud, local]);
    await router.pick("auto", "small");
    await router.pick("auto", "small");
    await router.pick("auto", "strong");
    expect(cloud.modelsCalls).toBe(1);
    expect(local.modelsCalls).toBe(1);
  });

  it("treats an empty catalogue as strong — that is what a BYOK provider built without one is", async () => {
    const byok = new FakeProvider("byok:openai", [], { emptyCatalog: true });
    const local = smallOnly("local-litert");
    expect((await new ModelRouter([local, byok]).pick("auto", "strong")).provider.id).toBe("byok:openai");
  });

  it("treats a catalogue that throws as strong rather than as a second, quieter readiness check", async () => {
    const broken = new FakeProvider("byok:openai", [], { modelsThrows: true });
    const local = smallOnly("local-litert");
    expect((await new ModelRouter([local, broken]).pick("auto", "strong")).provider.id).toBe("byok:openai");
  });
});

describe("a named provider still wins", () => {
  it("answers from the brain the person picked, whatever class the call wanted", async () => {
    const cloud = strongOnly("overblast");
    const local = smallOnly("local-litert");
    const router = new ModelRouter([cloud, local]);
    const picked = await router.pick("overblast", "small");
    expect(picked).toMatchObject({ provider: cloud, brainClass: "strong" });
  });

  it("keeps the model id out of `<provider>/<model>`", async () => {
    const cloud = strongOnly("overblast");
    expect(await new ModelRouter([cloud]).pick("overblast/gpt-9", "small")).toMatchObject({
      provider: cloud,
      model: "gpt-9",
      brainClass: "strong",
    });
  });

  it("throws by name for a provider this runtime does not have", async () => {
    await expect(new ModelRouter([strongOnly("overblast")]).pick("nope", "small")).rejects.toThrow(/no model provider "nope"/);
  });
});

// ── Through the loop ────────────────────────────────────────────────────────────────────────────

function harness(over: Partial<AgentRuntimeOptionsExt> = {}) {
  const fs = (over.fs as MemoryFs) ?? new MemoryFs({ "workspace/AGENTS.md": "be brief" });
  const providers = over.providers ?? [smallOnly("local-litert"), strongOnly("overblast")];
  const runtime = createAgentRuntime({
    fs,
    providers,
    tools: over.tools ?? [],
    trust: "full",
    now,
    origin: "https://agent.example",
    async askPermission() {
      return { allowed: true };
    },
    ...over,
  } as AgentRuntimeOptionsExt);
  const events: AgentEvent[] = [];
  runtime.on((e) => events.push(e));
  const classes = () =>
    events.filter((e) => e.type === "model_started").map((e) => (e as { brainClass?: string }).brainClass);
  const brains = () =>
    events.filter((e) => e.type === "model_started").map((e) => (e as { providerId: string }).providerId);
  return { runtime, fs, events, classes, brains };
}

describe("the loop derives a class per call", () => {
  it("a tool-less, short, single-turn question is small — the embed's level-0 shape", async () => {
    const local = smallOnly("local-litert").say([{ text: "the basket is top right" }]);
    const cloud = strongOnly("overblast");
    // The cloud brain is listed FIRST and is ready: the class is what moves the call off it.
    const h = harness({ providers: [cloud, local] });
    await h.runtime.run({ prompt: "where is the basket?" });
    expect(h.classes()).toEqual(["small"]);
    expect(h.brains()).toEqual(["local-litert"]);
  });

  it("a first call with tools registered is strong, and so is the call after the tool result", async () => {
    const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief", "workspace/a.txt": "hello" });
    const cloud = strongOnly("overblast").say([{ toolCalls: [call("read", { path: "a.txt" })] }, { text: "it says hello" }]);
    const local = smallOnly("local-litert");
    const h = harness({ fs, providers: [local, cloud], tools: [readTool()] });
    await h.runtime.run({ prompt: "read a.txt" });
    expect(h.classes()).toEqual(["strong", "strong"]);
    expect(h.brains()).toEqual(["overblast", "overblast"]);
  });

  it("a long prompt with no tools is planning, not a question", async () => {
    const cloud = strongOnly("overblast").say([{ text: "here is the plan" }]);
    const local = smallOnly("local-litert");
    const h = harness({ providers: [local, cloud] });
    await h.runtime.run({ prompt: "x".repeat(400) });
    expect(h.classes()).toEqual(["strong"]);
    expect(h.brains()).toEqual(["overblast"]);
  });

  it("the light agent with its read-only allowlist stays small across a whole tool round", async () => {
    const fs = new MemoryFs({ "threads/t1/note.md": "open at nine" });
    const local = smallOnly("local-litert").say([
      { toolCalls: [call("read", { path: "note.md" })] },
      { text: "nine o'clock" },
    ]);
    const cloud = strongOnly("overblast");
    const h = harness({
      fs,
      providers: [local, cloud],
      tools: lightTools(),
      trust: "light",
      context: { light: { channel: "this website", from: "a visitor" } },
    });
    await h.runtime.run({ prompt: "when do you open?", workspace: "threads/t1" });
    expect(h.classes()).toEqual(["small", "small"]);
    expect(h.brains()).toEqual(["local-litert", "local-litert"]);
  });
});

describe("RunOptions.brain forces the class", () => {
  it("`small` keeps a tooled run on the small brain", async () => {
    const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief", "workspace/a.txt": "hello" });
    const local = smallOnly("local-litert").say([{ toolCalls: [call("read", { path: "a.txt" })] }, { text: "hello" }]);
    const cloud = strongOnly("overblast");
    const h = harness({ fs, providers: [cloud, local], tools: fullTools() });
    await h.runtime.run({ prompt: "read a.txt", brain: "small" });
    expect(h.classes()).toEqual(["small", "small"]);
    expect(h.brains()).toEqual(["local-litert", "local-litert"]);
  });

  it("`strong` puts a one-line question on the cloud brain", async () => {
    const cloud = strongOnly("overblast").say([{ text: "top right" }]);
    const local = smallOnly("local-litert");
    const h = harness({ providers: [local, cloud] });
    await h.runtime.run({ prompt: "where is the basket?", brain: "strong" });
    expect(h.classes()).toEqual(["strong"]);
    expect(h.brains()).toEqual(["overblast"]);
  });

  it("`auto` is the default and is not the same as either force", async () => {
    const cloud = strongOnly("overblast");
    const local = smallOnly("local-litert").say([{ text: "hi" }]);
    const h = harness({ providers: [cloud, local] });
    await h.runtime.run({ prompt: "hi", brain: "auto" });
    expect(h.classes()).toEqual(["small"]);
  });
});

// ── The pin ─────────────────────────────────────────────────────────────────────────────────────

describe("a single-provider setup behaves exactly as it did before class-aware routing", () => {
  /**
   * The whole risk of this change is a shipped loop quietly answering from somewhere else. With one
   * provider there is nowhere else, and this pins it for every class, every `brain` setting, and a
   * provider of the "wrong" class — the only thing that may differ from the old behaviour is the
   * ADDED `brainClass` field on `model_started`.
   */
  for (const cls of ["small", "strong"] as const) {
    for (const brain of [undefined, "auto", "small", "strong"] as const) {
      it(`the only ${cls} provider answers with brain=${brain ?? "(absent)"}`, async () => {
        const only = new FakeProvider("local-litert", [{ text: "done" }], { classes: [cls] });
        const h = harness({ providers: [only] });
        const result = await h.runtime.run({ prompt: "hi", ...(brain ? { brain } : {}) });
        expect(h.brains()).toEqual(["local-litert"]);
        expect(result).toMatchObject({ text: "done", steps: 1, stopped: "final", providerId: "local-litert" });
        // The stream's delta rides between the two, since the loop streams (gap B11); everything
        // else about a one-provider run is what it was.
        expect(h.events.map((e) => e.type)).toEqual([
          "model_started",
          "agent_delta",
          "model_completed",
          "agent_message",
        ]);
      });
    }
  }

  it("routes to the same provider whatever the class, through the picker itself", async () => {
    const only = smallOnly("local-litert");
    const router = new ModelRouter([only]);
    expect((await router.pick(undefined, "strong")).provider).toBe(only);
    expect((await router.pick("auto", "small")).provider).toBe(only);
    expect((await router.pick("local-litert", "strong")).provider).toBe(only);
  });

  it("still returns the sole provider when it is not ready at all", async () => {
    const only = new FakeProvider("local-litert", [], { ready: false, reason: "download", classes: ["small"] });
    expect((await new ModelRouter([only]).pick("auto", "strong")).provider).toBe(only);
  });
});
