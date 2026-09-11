/**
 * WHERE THE LOCAL BRAIN PICKER'S ROWS COME FROM — the mirror, with the package as the fallback.
 *
 * WHY NOT JUST THE PACKAGE'S LIST. `@00/agent-models` ships `LITERT_CATALOG`, and it is a list of
 * names a human typed: it cannot know that a row was published this morning, withdrawn last week, or
 * that the E4B file is 2.96 GB rather than "about 3". `https://dl.0-0.chat/litert/catalog.json`
 * (§12.7) is written by the publish script itself and is the only thing that knows what the host
 * actually serves today. So the mirror decides WHAT IS THERE and the package decides WHAT IT COSTS
 * to run — `mergeMirrorCatalog` joins them on the file name.
 *
 * WHY A CACHE, AND WHY FIVE MINUTES. The document is small and edge-cached, but this app is
 * offline-first and a person opening Connections on a plane must still see the list they downloaded
 * from. Five minutes is short enough that a publish shows up in the session a person is having, and
 * long enough that opening the pane four times in a minute is one request. The cached copy is kept
 * FOREVER as the offline answer and only its freshness expires: a stale document is a far better
 * answer than no document, and the caller is told which it got.
 *
 * WHAT NEVER HAPPENS HERE: no download, no `HEAD`, no probing of the assets. This module fetches one
 * JSON file. Whether a model is already on the device is `readiness()`'s answer, asked of a provider
 * built for that row, and is computed lazily by the caller.
 *
 * THREE RUNTIMES, ONE CATALOGUE (2026-09-11). The package's side of the join is `LOCAL_MODEL_CATALOG`
 * — the LiteRT rows plus the Transformers.js ones — rather than `LITERT_CATALOG`, because a person
 * choosing a local brain is choosing a MODEL and should not have to know which runtime loads it. The
 * row's `runtime` field is how the bootstrap knows which provider to build for the row they picked,
 * and it is the only thing that distinguishes them here.
 */
import {
  LOCAL_MODEL_CATALOG,
  mergeMirrorCatalog,
  offeredOn,
  parseMirrorCatalog,
  type Host,
  type LiteRtCatalogRow,
  type LiteRtMirrorCatalog,
} from "@00/agent-models";
import { LITERT_CATALOG_KEY, kvGet, kvSet } from "./kv.js";

/** Five minutes, as §12.7's mirror is edge-cached and a publish should show up within a session. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

/** The document the publish script writes, beside the weights it wrote. */
export function catalogUrl(modelBaseUrl: string): string {
  return `${modelBaseUrl.replace(/\/+$/, "")}/catalog.json`;
}

interface CachedCatalog {
  url: string;
  fetchedAt: number;
  doc: LiteRtMirrorCatalog;
}

export interface CatalogResult {
  rows: LiteRtCatalogRow[];
  /** The `modelBaseUrl` the rows are served from — the mirror's own `base` when it answered. */
  base: string;
  /** `live` this minute, `cached` from a copy on this device, `offline` from the package's own list. */
  source: "live" | "cached" | "offline";
  notice?: string;
  noticeUrl?: string;
}

export interface CatalogOptions {
  modelBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  read?: (key: string) => Promise<CachedCatalog | null>;
  write?: (key: string, value: CachedCatalog) => Promise<void>;
  /** A fetch that never answers must not hold the pane; the package's list is right there. */
  timeoutMs?: number;
  force?: boolean;
}

async function fetchDoc(url: string, opts: CatalogOptions): Promise<LiteRtMirrorCatalog | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (!doFetch) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return parseMirrorCatalog(await response.json());
  } catch {
    // Offline, blocked, CORS, a bucket answering HTML: all of them mean the same thing here, and
    // the same thing is what the caller is handed — the rows this app already knows.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rows, from the freshest source that answered.
 *
 * The order is deliberate: a FRESH cache short-circuits before the network is touched at all, so a
 * pane that polls costs nothing; a stale cache is used only after the network has been asked and
 * failed, so a person online sees a publish rather than yesterday's copy.
 */
export async function loadLiteRtCatalog(opts: CatalogOptions): Promise<CatalogResult> {
  const now = opts.now ?? (() => Date.now());
  const read = opts.read ?? ((key: string) => kvGet<CachedCatalog>(key));
  const write = opts.write ?? ((key: string, value: CachedCatalog) => kvSet(key, value));
  const url = catalogUrl(opts.modelBaseUrl);
  const cached = await read(LITERT_CATALOG_KEY);
  const usable = cached && cached.url === url && cached.doc ? cached : null;

  if (!opts.force && usable && now() - usable.fetchedAt < CATALOG_TTL_MS) {
    return result(usable.doc, "cached", opts.modelBaseUrl);
  }

  const fresh = await fetchDoc(url, opts);
  if (fresh) {
    await write(LITERT_CATALOG_KEY, { url, fetchedAt: now(), doc: fresh });
    return result(fresh, "live", opts.modelBaseUrl);
  }
  if (usable) return result(usable.doc, "cached", opts.modelBaseUrl);
  return { rows: mergeMirrorCatalog(null, LOCAL_MODEL_CATALOG), base: opts.modelBaseUrl, source: "offline" };
}

function result(doc: LiteRtMirrorCatalog, source: "live" | "cached", fallbackBase: string): CatalogResult {
  return {
    rows: mergeMirrorCatalog(doc, LOCAL_MODEL_CATALOG),
    // The host's own `base` wins over the app's setting: it is the URL the catalogue's file names are
    // relative to, and a mirror that moved says so in the document it serves.
    base: doc.base || fallbackBase,
    source,
    notice: doc.notice,
    noticeUrl: doc.noticeUrl,
  };
}

// ── THE HARNESS GATE (2026-09-11) — one question, asked once ─────────────────────────────────────

/**
 * WHICH HARNESS THIS TAB IS, and the rule that replaced a VRAM comparison.
 *
 * Bruno, 2026-09-11: "gate the models to the compatible harness". Until today the phone rule was an
 * inequality — the smallest row under `PHONE_VRAM_CAP_MB` — which meant a NUMBER decided what a
 * device could run and every new row had to be measured against it. Now the ROW says where it may be
 * offered (`hosts`, one vocabulary with the Mac side in `@00/shared`) and this function says which of
 * those a tab is. Two lines of code and one gate instead of two.
 *
 * THE TEST IS A COARSE POINTER AND A NARROW WINDOW, both. A coarse pointer alone is a touchscreen
 * laptop, which is a desktop; a narrow window alone is a desktop browser dragged thin, which can
 * still run a 3 GB model and whose owner would be puzzled to be offered less. `matchMedia` is the
 * honest test for the first (it is what "this is a touch device" means in a browser) and 768px stays
 * the second, because it is the width §12.6's rule already used. Where there is no `matchMedia` at
 * all — a test, a worker, some embedded webview — Chromium's `userAgentData.mobile` answers instead,
 * and failing both the tab is a desktop, which is the reading that offers MORE rather than fewer.
 */
export const PHONE_MAX_WIDTH_PX = 768;

export interface HostView {
  innerWidth?: number;
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { userAgentData?: { mobile?: boolean } };
}

export function thisHost(view: HostView = globalThis as never): Host {
  const width = view?.innerWidth;
  const narrow = typeof width === "number" ? width < PHONE_MAX_WIDTH_PX : false;
  if (!narrow) return "browser-desktop";
  const coarse = view?.matchMedia ? view.matchMedia("(pointer: coarse)").matches : view?.navigator?.userAgentData?.mobile === true;
  return coarse ? "browser-phone" : "browser-desktop";
}

/** The rows this harness may be shown — `hosts` and nothing else, before any size rule. */
export function rowsForHost(rows: LiteRtCatalogRow[], host: Host = thisHost()): LiteRtCatalogRow[] {
  return rows.filter((row) => offeredOn(row, host));
}

/** Is this tab a phone? The same question as `thisHost`, kept for the boot's one-line read. */
export function isPhone(view: HostView = globalThis as never): boolean {
  return thisHost(view) === "browser-phone";
}

/**
 * The cap a phone's row must fit under — now a TIE-BREAKER, not the gate.
 *
 * `hosts` decides who may be offered a row; this number only orders what is left, and still keeps one
 * promise of its own: a row the package has never heard of (`estimated`, a mirror row with derived
 * numbers) is never handed to a phone as its default, however small the file looked.
 */
export const PHONE_VRAM_CAP_MB = 2000;

/**
 * The row a phone STARTS on: the smallest of the ones offered on a phone.
 *
 * §12.6 said "one model, not a picker", and the picker is now a list of the phone's own rows — two of
 * them today, Gemma 3 270m and Qwen3.5 0.8B, which are different answers to different questions (fast
 * and tiny, or able to see a photograph) rather than a better and a worse. So this chooses the DEFAULT
 * a phone that has never chosen gets, and the person can change it. Nothing offered ⇒ null, and the
 * caller says so and leaves the router's fallthrough to WebLLM alone.
 */
export function phoneRow(rows: LiteRtCatalogRow[], capMb = PHONE_VRAM_CAP_MB): LiteRtCatalogRow | null {
  const fits = rowsForHost(rows, "browser-phone").filter((r) => !r.estimated && r.vramMb > 0 && r.vramMb <= capMb);
  if (!fits.length) return null;
  return fits.reduce((best, row) => (row.vramMb < best.vramMb ? row : best));
}

/** The row a desktop opens on when the person has never chosen: the smallest that carries no gate. */
export function defaultRow(rows: LiteRtCatalogRow[], preferredId?: string): LiteRtCatalogRow | null {
  if (preferredId) {
    const chosen = rows.find((r) => r.id === preferredId);
    if (chosen) return chosen;
  }
  return rows.length ? rows.reduce((best, row) => (row.vramMb < best.vramMb ? row : best)) : null;
}

/** `2.0 GB` from the mirror's exact bytes, or the package's VRAM estimate when it is all there is. */
export function rowSize(row: LiteRtCatalogRow): { text: string; exact: boolean } {
  if (row.bytes) {
    const gb = row.bytes / 1_000_000_000;
    return { text: gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(row.bytes / 1_000_000)} MB`, exact: true };
  }
  const gb = row.vramMb / 1000;
  return { text: gb >= 1 ? `~${gb.toFixed(1)} GB` : `~${row.vramMb} MB`, exact: false };
}
