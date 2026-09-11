import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { LiteRtCatalogRow } from "@00/agent-models";
import type { CatalogResult } from "../src/lib/litert-catalog.js";

/**
 * The Local AI picker's store, with the owned agent standing in for the runtime bootstrap. Mocking
 * `state/agent.js` is the only way in: the real one hands out an agent that has scaffolded OPFS.
 */
const fake = {
  brain: { choice: null as { id: string; label?: string } | null, base: "https://dl.0-0.chat/litert", available: true },
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
  localHost,
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
    fake.brain = { choice: null, base: "https://dl.0-0.chat/litert", available: true };
    fake.catalog = twoRows;
    fake.downloaded = new Set();
    fake.chosen = [];
    fake.unloaded = 0;
    fake.catalogCalls = [];
  });

  // A stubbed window must never outlive its test: the rows are filtered by what it says, so a leak
  // would empty the NEXT test's list and read as a bug in the filter.
  afterEach(() => vi.unstubAllGlobals());

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
    // A LiteRT row says `litert` by saying nothing, and carries no caveat line at all — the picker
    // shows a note only where the package wrote one, never a reassuring sentence nobody wrote.
    expect(localRows.value[0]!.runtime).toBe("litert");
    expect(localRows.value[0]!.runtimeNote).toBeUndefined();
  });

  it("names the runtime and repeats its caveat for the ONNX vision row", async () => {
    // The one thing that marks the third runtime's row out on a screen full of LiteRT ones: it sees
    // pictures, and it costs 3.4 GB on a slower runtime whose download does not resume.
    fake.catalog = {
      ...twoRows,
      rows: [
        ...twoRows.rows,
        row({
          id: "gemma-4-E2B-it-onnx-q4f16",
          label: "Gemma 4 E2B · vision (ONNX)",
          assetFile: "gemma-4-E2B-it-ONNX",
          runtime: "transformers",
          vision: true,
          vramMb: 4600,
          bytes: 3_401_448_652,
          license: { id: "apache-2.0", name: "Apache License 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
          note: "Sees pictures · ONNX runtime, slower than LiteRT · the download does not resume",
        } as Partial<LiteRtCatalogRow>),
      ],
    };
    await loadLocalRows();
    const onnx = localRows.value.find((r) => r.row.id === "gemma-4-E2B-it-onnx-q4f16");
    expect(onnx).toMatchObject({
      runtime: "transformers",
      vision: true,
      size: "3.4 GB",
      sizeExact: true,
      licenseName: "Apache License 2.0",
      runtimeNote: "Sees pictures · ONNX runtime, slower than LiteRT · the download does not resume",
    });
    // Apache-2.0 carries no use restrictions, so that half of the consent line is simply absent.
    expect(onnx?.useRestrictionsUrl).toBeUndefined();
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

  it("passes the no-weights case straight through, and names this harness", async () => {
    await loadLocalRows();
    expect(localAvailable.value).toBe(true);
    // Node has no window, so a test run is a desktop — and the rows above, which name no harness,
    // are therefore all offered. `localPicker` is gone: a phone gets a picker now, of its own rows.
    expect(localHost.value).toBe("browser-desktop");
    fake.brain = { ...fake.brain, available: false };
    // The answer is COPIED, not read through a computed, so it takes a sync — which is exactly what
    // stops a chosen model showing as the old one on every screen.
    resetLocalModels();
    await loadLocalRows();
    expect(localAvailable.value).toBe(false);
  });

  it("shows a phone the rows offered on a phone, and a desktop the rest", async () => {
    // ONE GATE, and it is the row's own `hosts` — the size rule that used to stand here is now only a
    // tie-breaker for which phone row is the DEFAULT (lib/litert-catalog.ts, `phoneRow`).
    const phoneRows: CatalogResult = {
      ...twoRows,
      rows: [
        row({ hosts: ["browser-desktop", "browser-phone"] }),
        row({ id: "qwen3.5-0.8B-onnx-q4f16", label: "Qwen3.5 0.8B · vision (ONNX)", assetFile: "Qwen3.5-0.8B-ONNX", vision: true, vramMb: 1500, hosts: ["browser-desktop", "browser-phone"] }),
        row({ id: "gemma-4-E2B-it-web", label: "Gemma 4 E2B", assetFile: "gemma-4-E2B-it-web.task", vramMb: 3600, hosts: ["browser-desktop"] }),
      ],
    };
    fake.catalog = phoneRows;
    await loadLocalRows();
    expect(localRows.value.map((r) => r.row.id)).toEqual(["gemma3-270m-it-q4_0-web", "qwen3.5-0.8B-onnx-q4f16", "gemma-4-E2B-it-web"]);

    // The same catalogue, read on a phone: the 2 GB row is not in the list at all.
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    resetLocalModels();
    await loadLocalRows();
    expect(localHost.value).toBe("browser-phone");
    expect(localRows.value.map((r) => r.row.id)).toEqual(["gemma3-270m-it-q4_0-web", "qwen3.5-0.8B-onnx-q4f16"]);
    vi.unstubAllGlobals();
  });

  it("carries the line a licence asks to be shown, for the rows whose licence asks", async () => {
    fake.catalog = {
      ...twoRows,
      rows: [
        row({
          id: "llama-3.2-3B-instruct-onnx-q4f16",
          label: "Llama 3.2 3B (ONNX)",
          assetFile: "Llama-3.2-3B-Instruct-ONNX",
          license: {
            id: "llama3.2",
            name: "Llama 3.2 Community License",
            url: "https://www.llama.com/llama3_2/license/",
            useRestrictionsUrl: "https://www.llama.com/llama3_2/use-policy/",
            attribution: "Built with Llama",
          },
        }),
        row(),
      ],
    };
    await loadLocalRows();
    expect(localRows.value[0]!.attribution).toBe("Built with Llama");
    // Apache and the Gemma terms ask for no such line, and a row without one shows nothing.
    expect(localRows.value[1]!.attribution).toBeUndefined();
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
