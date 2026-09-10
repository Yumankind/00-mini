import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { LiteRtCatalogRow } from "@00/agent-models";
import type { CatalogResult } from "../src/lib/litert-catalog.js";

/**
 * The Local AI picker's store, with the owned agent standing in for the runtime bootstrap. Mocking
 * `state/agent.js` is the only way in: the real one hands out an agent that has scaffolded OPFS.
 */
const fake = {
  brain: { choice: null as { id: string; label?: string } | null, picker: true, base: "https://dl.0-0.chat/litert", available: true },
  catalog: null as CatalogResult | null,
  downloaded: new Set<string>(),
  chosen: [] as string[],
  unloaded: 0,
  catalogCalls: [] as boolean[],
  localBrain() {
    return fake.brain;
  },
  async localCatalog(force = false) {
    fake.catalogCalls.push(force);
    if (!fake.catalog) throw new Error("the mirror said no");
    return fake.catalog;
  },
  async localRowReadiness(row: LiteRtCatalogRow) {
    return fake.downloaded.has(row.id) ? { ready: true as const } : { ready: false as const, reason: "download" as const };
  },
  async chooseLocalModel(row: LiteRtCatalogRow) {
    fake.chosen.push(row.id);
    fake.brain = { ...fake.brain, choice: { id: row.id, label: row.label } };
  },
  async unloadLocal() {
    fake.unloaded++;
  },
};

vi.mock("../src/state/agent.js", () => ({ agent: shallowRef(fake) }));

const {
  chooseLocalModel,
  loadLocalRows,
  localAvailable,
  localCatalogSource,
  localChoice,
  localPicker,
  localRows,
  localRowsError,
  localRowsLoaded,
  resetLocalModels,
  syncLocalBrain,
  unloadLocal,
} = await import("../src/state/local-models.js");

function row(over: Partial<LiteRtCatalogRow> = {}): LiteRtCatalogRow {
  return {
    id: "gemma3-270m-it-q4_0-web",
    label: "Gemma 3 270m (q4)",
    class: "small",
    local: true,
    supportsTools: true,
    contextTokens: 2048,
    vramMb: 600,
    assetFile: "gemma3-270m-it-q4_0-web.task",
    family: "gemma",
    license: {
      id: "gemma",
      name: "Gemma Terms of Use",
      url: "https://ai.google.dev/gemma/terms",
      useRestrictionsUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
      termsCopyUrl: "https://dl.0-0.chat/litert/GEMMA_TERMS.md",
    },
    bytes: 249_233_408,
    onMirror: true,
    ...over,
  };
}

const twoRows: CatalogResult = {
  rows: [row(), row({ id: "gemma-4-E2B-it-web", label: "Gemma 4 E2B", assetFile: "gemma-4-E2B-it-web.task", vramMb: 3600, bytes: 2_003_697_664 })],
  base: "https://dl.0-0.chat/litert",
  source: "live",
};

describe("the local model picker's store", () => {
  beforeEach(() => {
    resetLocalModels();
    fake.brain = { choice: null, picker: true, base: "https://dl.0-0.chat/litert", available: true };
    fake.catalog = twoRows;
    fake.downloaded = new Set();
    fake.chosen = [];
    fake.unloaded = 0;
    fake.catalogCalls = [];
  });

  it("turns the catalogue into rows a card can draw, licence and all", async () => {
    await loadLocalRows();
    expect(localRowsLoaded.value).toBe(true);
    expect(localCatalogSource.value).toBe("live");
    expect(localRows.value.map((r) => r.row.id)).toEqual(["gemma3-270m-it-q4_0-web", "gemma-4-E2B-it-web"]);
    expect(localRows.value[0]).toMatchObject({
      size: "249 MB",
      sizeExact: true,
      vision: false,
      licenseName: "Gemma Terms of Use",
      useRestrictionsUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
      termsCopyUrl: "https://dl.0-0.chat/litert/GEMMA_TERMS.md",
    });
  });

  it("fills in what is already on the device, lazily, after the rows exist", async () => {
    fake.downloaded.add("gemma-4-E2B-it-web");
    await loadLocalRows();
    // The pass is started, not awaited: the list paints first.
    await vi.waitFor(() => expect(localRows.value.every((r) => r.downloaded !== null)).toBe(true));
    expect(localRows.value.map((r) => r.downloaded)).toEqual([false, true]);
  });

  it("marks the row the person chose, and tells the bootstrap once", async () => {
    await loadLocalRows();
    await expect(chooseLocalModel(twoRows.rows[1])).resolves.toBe("Gemma 4 E2B");
    expect(fake.chosen).toEqual(["gemma-4-E2B-it-web"]);
    expect(localRows.value.map((r) => r.selected)).toEqual([false, true]);
    expect(localChoice.value?.id).toBe("gemma-4-E2B-it-web");
  });

  it("keeps a failure as a line rather than an empty screen", async () => {
    fake.catalog = null;
    await loadLocalRows();
    expect(localRowsError.value).toBe("the mirror said no");
    expect(localRows.value).toHaveLength(0);
  });

  it("only refetches when asked to", async () => {
    await loadLocalRows();
    await loadLocalRows(true);
    expect(fake.catalogCalls).toEqual([false, true]);
  });

  it("passes the phone rule and the no-weights case straight through", async () => {
    await loadLocalRows();
    expect(localPicker.value).toBe(true);
    expect(localAvailable.value).toBe(true);
    fake.brain = { ...fake.brain, picker: false, available: false };
    // The answer is COPIED, not read through a computed, so it takes a sync — which is exactly what
    // stops a chosen model showing as the old one on every screen.
    resetLocalModels();
    await loadLocalRows();
    expect(localPicker.value).toBe(false);
    expect(localAvailable.value).toBe(false);
  });

  it("has no opinion before the agent exists", () => {
    resetLocalModels();
    syncLocalBrain();
    expect(localChoice.value).toBeNull();
  });

  it("gives the GPU back and says so", async () => {
    await expect(unloadLocal()).resolves.toMatch(/GPU is free/);
    expect(fake.unloaded).toBe(1);
  });
});
