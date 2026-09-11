/**
 * The Local AI card's rows — §12.7's picker, fed by the mirror.
 *
 * WHY READINESS IS ASKED PER ROW, AND LAZILY. "Already downloaded" is the single fact that changes
 * what a person does on this screen (choose the 2 GB one, or the one that is already here), and the
 * only honest source for it is a provider built for that row asking Cache Storage. Seven of those is
 * seven cache lookups and no network at all — but they are still started AFTER the rows paint, so a
 * pane opens at the speed of the cached catalogue rather than at the speed of IndexedDB.
 *
 * WHY THE ROWS ARE NOT REFRESHED ON A TIMER, unlike the brain cards. The catalogue changes when
 * someone publishes to the mirror, which is not something that happens while a person is looking at
 * a settings pane; the five-minute cache in `lib/litert-catalog.ts` covers it, and a manual refresh
 * is one call away. What DOES change second by second is the download, and that is the brain card's
 * readiness poll, not this list.
 */
import { computed, ref, shallowRef } from "vue";
import type { LiteRtCatalogRow } from "@00/agent-models";
import { rowSize } from "../lib/litert-catalog.js";
import type { Readiness } from "../lib/readiness.js";
import { agent } from "./agent.js";

export interface LocalModelRow {
  row: LiteRtCatalogRow;
  /** `2.0 GB` from the mirror's bytes, or the package's estimate with a `~`. */
  size: string;
  sizeExact: boolean;
  vision: boolean;
  /**
   * WHICH RUNTIME ANSWERS, and the sentence that goes with it (2026-09-11).
   *
   * A person picking a local brain is picking a MODEL, so the runtime is not a column — but it is not
   * invisible either, because the trade is real and it is the reason this row exists: the ONNX row is
   * the only one that sees pictures, it is three and a half gigabytes, it is slower than LiteRT, and
   * its download does not resume. `runtimeNote` is the package's own `note` on the row, shown as
   * written rather than composed here, so the caveat lives beside the fact that produced it.
   */
  runtime: "litert" | "transformers";
  runtimeNote?: string;
  selected: boolean;
  /** null until the lazy readiness pass reaches this row. */
  downloaded: boolean | null;
  /** The row's own licence, so the consent line is about the model being chosen, not "local models". */
  licenseName: string;
  licenseUrl: string;
  useRestrictionsUrl?: string;
  termsCopyUrl?: string;
  estimated: boolean;
}

const rowsRef = shallowRef<LocalModelRow[]>([]);
const busy = ref(false);
const failure = ref<string | null>(null);
const origin = ref<"live" | "cached" | "offline" | null>(null);
const notice = ref<string | null>(null);
const loaded = ref(false);

export const localRows = computed(() => rowsRef.value);
export const localRowsBusy = computed(() => busy.value);
export const localRowsError = computed(() => failure.value);
export const localCatalogSource = computed(() => origin.value);
export const localCatalogNotice = computed(() => notice.value);
export const localRowsLoaded = computed(() => loaded.value);

/**
 * The bootstrap's answer, COPIED into a ref rather than read through a computed.
 *
 * `localBrain()` is a method on a plain object held in a `shallowRef`, so a computed over it tracks
 * the ref and not the answer: choosing a model would change what the bootstrap says and leave every
 * screen showing the old choice. One explicit sync, at the two moments the answer can change.
 */
type LocalBrain = ReturnType<NonNullable<typeof agent.value>["localBrain"]>;
const brainRef = ref<LocalBrain | null>(null);

/** What this device gets: a picker, or one row and a sentence (§12.6). */
export const localPicker = computed(() => brainRef.value?.picker ?? true);
export const localChoice = computed(() => brainRef.value?.choice ?? null);
export const localAvailable = computed(() => brainRef.value?.available ?? false);

/** Re-read the bootstrap's local-brain answer. Safe before boot: it simply stays null. */
export function syncLocalBrain(): void {
  brainRef.value = agent.value?.localBrain() ?? null;
}

function toRow(row: LiteRtCatalogRow, chosenId: string | null): LocalModelRow {
  const size = rowSize(row);
  return {
    row,
    size: size.text,
    sizeExact: size.exact,
    vision: row.vision === true,
    runtime: row.runtime ?? "litert",
    // The package's own sentence. Only the Transformers.js row carries one today, and a row with no
    // caveat gets no line rather than a reassuring one nobody wrote.
    runtimeNote: (row as { note?: string }).note,
    selected: row.id === chosenId,
    downloaded: null,
    licenseName: row.license.name,
    licenseUrl: row.license.url,
    useRestrictionsUrl: row.license.useRestrictionsUrl,
    termsCopyUrl: row.license.termsCopyUrl,
    estimated: row.estimated === true,
  };
}

export async function loadLocalRows(force = false): Promise<void> {
  const owned = agent.value;
  if (!owned || busy.value) return;
  syncLocalBrain();
  busy.value = true;
  failure.value = null;
  try {
    const result = await owned.localCatalog(force);
    const chosen = owned.localBrain().choice?.id ?? null;
    rowsRef.value = result.rows.map((row) => toRow(row, chosen));
    origin.value = result.source;
    notice.value = result.notice ?? null;
    loaded.value = true;
    void fillDownloaded();
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** The lazy pass: one row at a time, each answer painted as it lands. */
async function fillDownloaded(): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  for (const entry of rowsRef.value) {
    const readiness: Readiness = await owned.localRowReadiness(entry.row);
    // The list may have been replaced while this walked it; write into the CURRENT one or not at all.
    rowsRef.value = rowsRef.value.map((r) => (r.row.id === entry.row.id ? { ...r, downloaded: readiness.ready } : r));
  }
}

export async function chooseLocalModel(row: LiteRtCatalogRow): Promise<string> {
  const owned = agent.value;
  if (!owned) throw new Error("No agent yet.");
  await owned.chooseLocalModel(row);
  syncLocalBrain();
  const chosen = brainRef.value?.choice?.id ?? null;
  rowsRef.value = rowsRef.value.map((r) => ({ ...r, selected: r.row.id === chosen }));
  return row.label;
}

export async function unloadLocal(): Promise<string> {
  const owned = agent.value;
  if (!owned) throw new Error("No agent yet.");
  await owned.unloadLocal();
  return "The GPU is free. The next answer loads the model again.";
}

/** Test seam. */
export function resetLocalModels(): void {
  rowsRef.value = [];
  busy.value = false;
  failure.value = null;
  origin.value = null;
  notice.value = null;
  loaded.value = false;
  brainRef.value = null;
}
