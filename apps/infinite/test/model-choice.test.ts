import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, shallowRef } from "vue";
import type { AgentEvent, RunOptions } from "@00/agent-runtime";
import type { LiteRtCatalogRow } from "@00/agent-models";
import type { Readiness } from "../src/lib/readiness.js";

/**
 * The composer chip's store and the send path under it, with the owned agent standing in for the
 * bootstrap — the same rig as local-models.test.ts, and for the same reason: the real one hands out
 * an agent that has scaffolded OPFS, and none of the logic being tested here is about that.
 */
interface Handle {
  id: string;
  peer: "local" | "sponsored" | "overblast" | "byok";
  provider: unknown;
  readiness: Readiness;
}

const loaded: string[] = [];
const fake = {
  settingsValue: { selected: "auto" } as Record<string, unknown>,
  handles: [] as Handle[],
  runs: [] as RunOptions[],
  listeners: [] as ((event: AgentEvent) => void)[],
  /** What the runtime does between `run()` being called and resolving. */
  duringRun: async (): Promise<void> => undefined,
  chosenRows: [] as string[],
  runtime: {
    on(listener: (event: AgentEvent) => void) {
      fake.listeners.push(listener);
      return () => undefined;
    },
    async run(opts: RunOptions) {
      fake.runs.push(opts);
      await fake.duringRun();
      return { sessionId: "s1", text: "", steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, stopped: "final" as const };
    },
    abort() {},
  },
  settings: () => fake.settingsValue,
  async saveSettings(next: Record<string, unknown>) {
    fake.settingsValue = next;
  },
  async providers() {
    return fake.handles;
  },
  async refreshBrains() {
    return fake.handles;
  },
  localBrain: () => ({ choice: null, picker: true, base: "https://dl.0-0.chat/litert", available: true }),
  async localCatalog() {
    return { rows: [], base: "https://dl.0-0.chat/litert", source: "live" as const };
  },
  async localRowReadiness() {
    return { ready: false as const, reason: "download" as const };
  },
  async chooseLocalModel(row: LiteRtCatalogRow) {
    fake.chosenRows.push(row.id);
    fake.settingsValue = { ...fake.settingsValue, localModel: { id: row.id, label: row.label } };
  },
};

vi.mock("../src/state/agent.js", () => ({ agent: shallowRef(fake) }));

const {
  brainPreference,
  chip,
  chipOpen,
  closeChip,
  download,
  openChip,
  pendingNote,
  preloadLocal,
  primeBrains,
  resetModelChoice,
  runBlockedReason,
  setBrainPreference,
  pickLocalRow,
} = await import("../src/state/model-choice.js");
const { resetConnections } = await import("../src/state/connections.js");
const { resetLocalModels } = await import("../src/state/local-models.js");
const { resetConversation, rows, send } = await import("../src/state/conversation.js");

function handle(over: Partial<Handle> = {}): Handle {
  return { id: "local", peer: "local", provider: null, readiness: { ready: true }, ...over };
}

const DOWNLOADING: Readiness = {
  ready: false,
  reason: "download",
  progress: { loadedBytes: 103_000_000, totalBytes: 250_000_000 },
};

function row(): LiteRtCatalogRow {
  return {
    id: "gemma3-270m-it-q4_0-web",
    label: "Gemma 3 270m",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 2048,
    vramMb: 600,
    assetFile: "gemma3-270m-it-q4_0-web.task",
    family: "gemma",
    license: { id: "gemma", name: "Gemma Terms of Use", url: "https://ai.google.dev/gemma/terms" },
    bytes: 249_233_408,
    onMirror: true,
  };
}

beforeEach(() => {
  resetModelChoice();
  resetConnections();
  resetLocalModels();
  resetConversation();
  fake.settingsValue = { selected: "auto" };
  fake.handles = [handle()];
  fake.runs = [];
  fake.listeners = [];
  fake.chosenRows = [];
  fake.duringRun = async () => undefined;
  loaded.length = 0;
});

describe("the composer chip's store", () => {
  it("names the brain that answers next, from the live handles", async () => {
    fake.settingsValue = { selected: "local", localModel: { id: "x", label: "Gemma 4 E2B" } };
    await primeBrains();
    expect(chip.value.text).toBe("Gemma 4 E2B · local");
    expect(download.value).toBeNull();
  });

  it("keeps naming the brain when the weights are simply not here yet, and notes it beside", async () => {
    fake.settingsValue = { selected: "local", localModel: { id: "x", label: "Gemma 4 E2B" } };
    fake.handles = [handle({ readiness: { ready: false, reason: "download" } })];
    await primeBrains();
    expect(chip.value.text).toBe("Gemma 4 E2B · local");
    expect(download.value).toBeNull();
    expect(pendingNote.value).toBe("Gemma 4 E2B downloads with your next message");
  });

  it("turns a download into one line and one percentage, for the chip and the row alike", async () => {
    fake.settingsValue = { selected: "local", localModel: { id: "x", label: "Gemma 3 270m" } };
    fake.handles = [handle({ readiness: DOWNLOADING })];
    await primeBrains();
    expect(download.value).toEqual({ text: "Downloading Gemma 3 270m · 41% · 103 of 250 MB", percent: 41 });
  });

  it("opens and closes the panel through the store, so the error row can open it too", () => {
    expect(chipOpen.value).toBe(false);
    openChip();
    expect(chipOpen.value).toBe(true);
    closeChip();
    expect(chipOpen.value).toBe(false);
  });

  it("writes a chosen row through the SAME settings the Connections card writes", async () => {
    await primeBrains();
    await pickLocalRow(row());
    expect(fake.chosenRows).toEqual(["gemma3-270m-it-q4_0-web"]);
    expect(fake.settingsValue).toMatchObject({
      selected: "local",
      localModel: { id: "gemma3-270m-it-q4_0-web", label: "Gemma 3 270m" },
    });
  });

  it("starts the download on the click that chooses the row, not at the next message", async () => {
    fake.handles = [handle({ readiness: DOWNLOADING, provider: { load: async () => void loaded.push("local") } })];
    await primeBrains();
    await preloadLocal();
    expect(loaded).toEqual(["local"]);
  });

  it("says nothing and breaks nothing when the provider cannot be asked to preload", async () => {
    fake.handles = [handle({ provider: {} })];
    await primeBrains();
    await expect(preloadLocal()).resolves.toBeUndefined();
  });
});

describe("the send path", () => {
  it("carries the class the segmented control chose into RunOptions.brain", async () => {
    await primeBrains();
    setBrainPreference("strong");
    expect(brainPreference.value).toBe("strong");
    await send("hello");
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]).toMatchObject({ prompt: "hello", brain: "strong" });
  });

  it("refuses to start when no brain can answer, and says which refused", async () => {
    fake.handles = [
      handle({ readiness: { ready: false, reason: "unsupported", detail: "no WebGPU here" } }),
      handle({ id: "byok:openai", peer: "byok", readiness: { ready: false, reason: "credential", detail: "needs a key" } }),
    ];
    fake.settingsValue = { selected: "auto", byok: { vendor: "openai" } };
    await send("hello");
    expect(fake.runs).toHaveLength(0);
    expect(runBlockedReason.value).toContain("no WebGPU here");
    const last = rows.value[rows.value.length - 1];
    expect(last).toMatchObject({ kind: "error", openChip: true });
    expect(last.kind === "error" && last.text).toContain("No brain can answer yet");
  });

  it("starts anyway on a brain that is only downloading — the download IS the first minute", async () => {
    fake.handles = [handle({ readiness: DOWNLOADING })];
    fake.settingsValue = { selected: "local", localModel: { id: "x", label: "Gemma 3 270m" } };
    await send("hello");
    expect(fake.runs).toHaveLength(1);
  });

  it("shows the download while the run waits, and lets the answer replace it", async () => {
    fake.handles = [handle({ readiness: DOWNLOADING })];
    fake.settingsValue = { selected: "local", localModel: { id: "x", label: "Gemma 3 270m" } };
    fake.duringRun = async () => {
      await nextTick();
      // The row is live while the run is still waiting on the weights.
      expect(rows.value.map((r) => r.kind)).toEqual(["user", "status"]);
      const status = rows.value[1];
      expect(status.kind === "status" && status.text).toBe("Downloading Gemma 3 270m · 41% · 103 of 250 MB");
      for (const listener of fake.listeners) listener({ type: "model_started", providerId: "local", model: "gemma3" });
      for (const listener of fake.listeners) listener({ type: "agent_message", text: "Hello.", final: true });
    };
    await send("hello");
    expect(rows.value.map((r) => r.kind)).toEqual(["user", "agent"]);
    const answer = rows.value[1];
    expect(answer.kind === "agent" && answer.by).toMatchObject({ providerId: "local", model: "gemma3" });
  });

  it("leaves no status row behind when a run ends without ever answering", async () => {
    fake.handles = [handle({ readiness: DOWNLOADING })];
    fake.settingsValue = { selected: "local", localModel: { id: "x", label: "Gemma 3 270m" } };
    await send("hello");
    expect(rows.value.map((r) => r.kind)).toEqual(["user"]);
  });
});
