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
import { LOCAL_MODEL_CATALOG, mergeMirrorCatalog, parseMirrorCatalog, type LiteRtCatalogRow, type LiteRtMirrorCatalog } from "@00/agent-models";
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

// ── §12.6: a phone gets one model, not a picker ─────────────────────────────────────────────────

/**
 * The cap a phone's row must fit under. §12.6 says "cap at 1.5B and ship one model, not a picker",
 * which in this package's units is the 270m (600 MB) and the 1B (1200 MB) and nothing above them.
 */
export const PHONE_VRAM_CAP_MB = 2000;

/**
 * Is this a phone? Two signals, and the width one is not a proxy for a small GPU — it is a proxy for
 * A SCREEN WITH NO ROOM FOR A PICKER, which is what §12.6 is actually about. `userAgentData.mobile`
 * is the honest answer where it exists (Chromium); everything else falls back to the width, and a
 * desktop window dragged narrow gets the phone's single row, which is the safe way to be wrong.
 */
export function isPhone(view: { innerWidth?: number; navigator?: { userAgentData?: { mobile?: boolean } } } = globalThis as never): boolean {
  const mobile = view?.navigator?.userAgentData?.mobile;
  if (typeof mobile === "boolean") return mobile;
  const width = view?.innerWidth;
  return typeof width === "number" ? width < 768 : false;
}

/**
 * The one row a phone is given: the SMALLEST that fits the cap.
 *
 * Rows whose numbers were derived rather than measured (`estimated`, a mirror row this app's package
 * has never heard of) are not eligible — §12.6's promise is that a phone is handed something that
 * runs, and a guess at a model's memory is not the thing to keep that promise with. Nothing fits ⇒
 * null, and the caller says so and leaves the router's fallthrough to WebLLM alone.
 */
export function phoneRow(rows: LiteRtCatalogRow[], capMb = PHONE_VRAM_CAP_MB): LiteRtCatalogRow | null {
  const fits = rows.filter((r) => !r.estimated && r.vramMb > 0 && r.vramMb <= capMb);
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
