import { describe, expect, it, vi } from "vitest";
import { LITERT_CATALOG, LOCAL_MODEL_CATALOG, TRANSFORMERS_CATALOG, mergeMirrorCatalog } from "@00/agent-models";
import {
  CATALOG_TTL_MS,
  catalogUrl,
  defaultRow,
  isPhone,
  loadLiteRtCatalog,
  phoneRow,
  rowSize,
  rowsForHost,
  thisHost,
  PHONE_MAX_WIDTH_PX,
  PHONE_VRAM_CAP_MB,
} from "../src/lib/litert-catalog.js";

const BASE = "https://dl.0-0.chat/litert";

const DOC = {
  version: 1,
  base: BASE,
  notice: "Gemma is provided under and subject to the Gemma Terms of Use",
  noticeUrl: `${BASE}/NOTICE.txt`,
  assets: [
    {
      file: "gemma3-270m-it-q4_0-web.task",
      bytes: 249_233_408,
      license: "gemma",
      licenseName: "Gemma Terms of Use",
      licenseUrl: "https://ai.google.dev/gemma/terms",
      useRestrictionsUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
      termsCopyUrl: `${BASE}/GEMMA_TERMS.md`,
      vision: false,
    },
    {
      file: "gemma-3n-E2B-it-int4-Web.litertlm",
      bytes: 3_038_117_888,
      license: "gemma",
      licenseName: "Gemma Terms of Use",
      licenseUrl: "https://ai.google.dev/gemma/terms",
      vision: true,
    },
  ],
};

/** A `fetch` that answers with `DOC`, counting the calls, unless told to fail. */
function fetcher(opts: { fail?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    if (opts.fail) throw new Error("offline");
    return new Response(JSON.stringify(DOC), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  return { calls, fetch: fn as unknown as typeof fetch };
}

function store() {
  const map = new Map<string, unknown>();
  return {
    map,
    read: async (key: string) => (map.get(key) ?? null) as never,
    write: async (key: string, value: unknown) => void map.set(key, value),
  };
}

describe("the mirror's catalogue, fetched and cached", () => {
  it("asks the host for catalog.json beside the weights", () => {
    expect(catalogUrl(BASE)).toBe(`${BASE}/catalog.json`);
    expect(catalogUrl(`${BASE}/`)).toBe(`${BASE}/catalog.json`);
  });

  it("fetches once and answers from the cache for five minutes", async () => {
    const net = fetcher();
    const kv = store();
    let clock = 1_000_000;
    const opts = { modelBaseUrl: BASE, fetch: net.fetch, now: () => clock, ...kv };

    const first = await loadLiteRtCatalog(opts);
    expect(first.source).toBe("live");
    expect(first.rows.map((r) => r.id)).toEqual(["gemma3-270m-it-q4_0-web", "gemma-3n-E2B-it-int4-Web"]);
    expect(net.calls).toEqual([`${BASE}/catalog.json`]);

    clock += CATALOG_TTL_MS - 1;
    const second = await loadLiteRtCatalog(opts);
    expect(second.source).toBe("cached");
    expect(net.calls).toHaveLength(1);

    clock += 2;
    const third = await loadLiteRtCatalog(opts);
    expect(third.source).toBe("live");
    expect(net.calls).toHaveLength(2);
  });

  it("keeps the stale copy as the offline answer rather than losing the list", async () => {
    const kv = store();
    let clock = 0;
    await loadLiteRtCatalog({ modelBaseUrl: BASE, fetch: fetcher().fetch, now: () => clock, ...kv });
    clock += CATALOG_TTL_MS * 10;
    const offline = await loadLiteRtCatalog({ modelBaseUrl: BASE, fetch: fetcher({ fail: true }).fetch, now: () => clock, ...kv });
    expect(offline.source).toBe("cached");
    expect(offline.rows).toHaveLength(2);
  });

  it("falls back to the package's own rows when nothing has ever been fetched", async () => {
    const offline = await loadLiteRtCatalog({ modelBaseUrl: BASE, fetch: fetcher({ fail: true }).fetch, ...store() });
    expect(offline.source).toBe("offline");
    // EVERY local row, across all three runtimes (2026-09-11): the offline list must hold the same
    // rows the mirror serves, or the picker shrinks when the network drops and reads as broken.
    expect(offline.rows).toHaveLength(LOCAL_MODEL_CATALOG.length);
    expect(LOCAL_MODEL_CATALOG.length).toBe(LITERT_CATALOG.length + TRANSFORMERS_CATALOG.length);
    expect(offline.rows.every((r) => r.onMirror === false)).toBe(true);
    // The ONNX row is there, and it says which runtime it needs — the only thing that marks it out.
    const onnx = offline.rows.find((r) => r.runtime === "transformers");
    expect(onnx?.id).toBe("gemma-4-E2B-it-onnx-q4f16");
    expect(onnx?.vision).toBe(true);
  });

  it("treats a non-200 and a document that is not a catalogue the same way: as no answer", async () => {
    await expect(loadLiteRtCatalog({ modelBaseUrl: BASE, fetch: fetcher({ status: 404 }).fetch, ...store() })).resolves.toMatchObject({
      source: "offline",
    });
    const rubbish = { fetch: (async () => new Response("<html>nope</html>")) as unknown as typeof fetch };
    await expect(loadLiteRtCatalog({ modelBaseUrl: BASE, ...rubbish, ...store() })).resolves.toMatchObject({ source: "offline" });
  });

  it("ignores a cache written for a different host", async () => {
    const kv = store();
    const net = fetcher();
    await loadLiteRtCatalog({ modelBaseUrl: "https://elsewhere.example/litert", fetch: net.fetch, ...kv });
    await loadLiteRtCatalog({ modelBaseUrl: BASE, fetch: net.fetch, ...kv });
    expect(net.calls).toEqual(["https://elsewhere.example/litert/catalog.json", `${BASE}/catalog.json`]);
  });

  it("`force` goes past a fresh cache — the refresh button", async () => {
    const net = fetcher();
    const kv = store();
    const opts = { modelBaseUrl: BASE, fetch: net.fetch, now: () => 5, ...kv };
    await loadLiteRtCatalog(opts);
    await loadLiteRtCatalog({ ...opts, force: true });
    expect(net.calls).toHaveLength(2);
  });

  it("takes the base the document names, so a mirror that moved is followed", async () => {
    const moved = { ...DOC, base: "https://cdn.example/litert" };
    const fetchMoved = (async () => new Response(JSON.stringify(moved))) as unknown as typeof fetch;
    const result = await loadLiteRtCatalog({ modelBaseUrl: BASE, fetch: fetchMoved, ...store() });
    expect(result.base).toBe("https://cdn.example/litert");
    expect(result.notice).toContain("Gemma Terms of Use");
  });
});

describe("which harness this tab is, and which rows it may be shown (§12.6, rewritten 2026-09-11)", () => {
  /**
   * THE RULE: a coarse pointer AND a narrow window. Either alone is a device this gate would get
   * wrong — a touchscreen laptop is a desktop, and a desktop browser dragged thin can still hold a
   * three-gigabyte model and would be puzzled to be offered less.
   */
  const coarse = { matchMedia: () => ({ matches: true }) };
  const fine = { matchMedia: () => ({ matches: false }) };

  it("is a phone only when the pointer is coarse and the window is narrow", () => {
    expect(thisHost({ innerWidth: 390, ...coarse })).toBe("browser-phone");
    expect(thisHost({ innerWidth: 390, ...fine })).toBe("browser-desktop");
    expect(thisHost({ innerWidth: 1400, ...coarse })).toBe("browser-desktop");
    expect(thisHost({ innerWidth: PHONE_MAX_WIDTH_PX, ...coarse })).toBe("browser-desktop");
    expect(thisHost({ innerWidth: PHONE_MAX_WIDTH_PX - 1, ...coarse })).toBe("browser-phone");
  });

  it("asks Chromium's own answer where there is no matchMedia at all, and otherwise says desktop", () => {
    expect(thisHost({ innerWidth: 390, navigator: { userAgentData: { mobile: true } } })).toBe("browser-phone");
    expect(thisHost({ innerWidth: 390, navigator: { userAgentData: { mobile: false } } })).toBe("browser-desktop");
    // No window to measure (a worker, a test): a desktop, which is the reading that offers MORE.
    expect(thisHost({})).toBe("browser-desktop");
    expect(isPhone({ innerWidth: 390, ...coarse })).toBe(true);
    expect(isPhone({})).toBe(false);
  });

  it("filters the rows by `hosts` and by nothing else — the one gate, before any size rule", () => {
    const rows = mergeMirrorCatalog(null, LOCAL_MODEL_CATALOG);
    const phone = rowsForHost(rows, "browser-phone");
    // Two rows on a phone today: the 270m, and the 0.67 GB Qwen3.5 that can see a picture.
    expect(phone.map((r) => r.id)).toEqual(["gemma3-270m-it-q4_0-web", "gemma3-1b-it-int4-web", "qwen3.5-0.8B-onnx-q4f16"]);
    expect(rowsForHost(rows, "browser-desktop")).toHaveLength(rows.length);
    // A row that names no harness is desktop-only. Said in a test because it is the rule a mirror row
    // this app has never heard of falls under, and the reason it cannot land on a phone.
    const unclassified = [{ ...rows[0]!, id: "unknown", hosts: undefined }];
    expect(rowsForHost(unclassified, "browser-phone")).toEqual([]);
    expect(rowsForHost(unclassified, "browser-desktop")).toHaveLength(1);
  });

  it("starts a phone on the SMALLEST row offered to a phone, never a guessed one", () => {
    const rows = mergeMirrorCatalog(null, LOCAL_MODEL_CATALOG);
    const row = phoneRow(rows);
    expect(row?.id).toBe("gemma3-270m-it-q4_0-web");
    expect(row!.vramMb).toBeLessThanOrEqual(PHONE_VRAM_CAP_MB);

    // A row whose numbers were derived from a file size is not the one to keep a promise with.
    const guessed = [{ ...rows[0]!, id: "guess", vramMb: 100, estimated: true, hosts: ["browser-phone" as const] }];
    expect(phoneRow(guessed)).toBeNull();
    expect(phoneRow([])).toBeNull();
  });

  it("says nothing fits rather than offering a phone a 2 GB download", () => {
    const desktopOnly = mergeMirrorCatalog(null, LOCAL_MODEL_CATALOG).filter((r) => r.vramMb > PHONE_VRAM_CAP_MB);
    expect(phoneRow(desktopOnly)).toBeNull();
    // And the gate holds even when a row's numbers would have passed the old inequality: `hosts` is
    // what is read, so a small row nobody offered to a phone is still not offered to one.
    const smallButDesktop = [{ ...mergeMirrorCatalog(null, LOCAL_MODEL_CATALOG)[0]!, vramMb: 200, hosts: ["browser-desktop" as const] }];
    expect(phoneRow(smallButDesktop)).toBeNull();
  });

  it("opens a desktop on the person's choice, and otherwise on the smallest row", () => {
    const rows = mergeMirrorCatalog(null);
    expect(defaultRow(rows, "gemma-4-E4B-it-web")?.id).toBe("gemma-4-E4B-it-web");
    // A remembered choice the mirror no longer serves falls back rather than breaking the screen.
    expect(defaultRow(rows, "gone")?.id).toBe("gemma3-270m-it-q4_0-web");
    expect(defaultRow([])).toBeNull();
  });
});

describe("what a row says it costs", () => {
  it("prefers the mirror's exact bytes, and marks the package's estimate as one", () => {
    const [row] = mergeMirrorCatalog({ version: 1, base: BASE, assets: [DOC.assets[0]] });
    expect(rowSize(row)).toEqual({ text: "249 MB", exact: true });
    expect(rowSize({ ...row, bytes: 2_003_697_664 })).toEqual({ text: "2.0 GB", exact: true });
    expect(rowSize({ ...row, bytes: undefined, vramMb: 600 })).toEqual({ text: "~600 MB", exact: false });
    expect(rowSize({ ...row, bytes: undefined, vramMb: 3600 })).toEqual({ text: "~3.6 GB", exact: false });
  });
});
