/**
 * WHICH BRAIN ANSWERS THE NEXT MESSAGE — the composer chip's store.
 *
 * WHY THIS IS NOT A SECOND SOURCE OF TRUTH. The Connections pane already owns the choice
 * (`state/connections.ts`, `selected` in the connection settings) and the local row
 * (`state/local-models.ts`, `localModel` in the same settings), and both are written through the
 * bootstrap so they survive a reload and travel with the agent. This module adds NO storage of its
 * own for either: it reads those two, writes through those two, and holds only what belongs to a
 * composer — whether its panel is open, which class of brain the next turn asks for, and the poll
 * that makes a download visible while a run waits on it.
 *
 * WHY THE DOWNLOAD IS POLLED AND ONLY WHILE SOMETHING IS WAITING. `readiness()` is the only honest
 * source for how far a download has got, it is not pushed, and asking for it rebuilds four small
 * provider objects and reads the vault. That is fine once a second while a person is watching a bar
 * move, and wasteful for the rest of the session — so the watch is started by the two moments that
 * create a wait (a row chosen in the picker, a run in flight) and stopped the moment the wait ends.
 */
import { computed, ref } from "vue";
import type { LiteRtCatalogRow } from "@00/agent-models";
import {
  autoSentence,
  chipLabel,
  downloadLine,
  noBrainReason,
  pendingDownloadNote,
  runStatusLine,
  type BrainPreference,
  type ChipBrain,
} from "../lib/model-chip.js";
import { downloadPercent } from "../lib/readiness.js";
import { agent } from "./agent.js";
import { brains, chooseBrain, refreshBrains, selectedBrain, settings } from "./connections.js";
import { chooseLocalModel, loadLocalRows, localRowsLoaded, syncLocalBrain } from "./local-models.js";

/**
 * WHAT A LOCAL PROVIDER CAN DO THAT THE FROZEN CONTRACT DOES NOT PROMISE.
 *
 * `ModelProvider` (packages/agent-models/src/types.ts) has no "fetch the weights now": a download
 * starts when something asks the provider to answer. Both local providers DO have `load()` —
 * `LiteRtProvider.load(signal?)` and `WebLLMProvider.load()` — and the picker's promise is that
 * choosing a row starts the download there and then, not at the next message. So this is a
 * duck-type over the handle the bootstrap already hands us, declared here rather than assumed:
 * a provider without it simply downloads with the next message, and the chip says exactly that.
 */
export interface Preloadable {
  load?(signal?: AbortSignal): Promise<unknown>;
}

const open = ref(false);
const preference = ref<BrainPreference>("auto");
const preloading = ref(false);
const preloadFailure = ref<string | null>(null);
let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchers = 0;

export const chipOpen = computed(() => open.value);
/** `RunOptions.brain` for the next turns — a preference, never a cap (§6). */
export const brainPreference = computed(() => preference.value);
export const preloadError = computed(() => preloadFailure.value);
export const preloadBusy = computed(() => preloading.value);

export function openChip(): void {
  open.value = true;
  // The catalogue is fetched when the picker OPENS, never at boot — the same rule the Local AI card
  // keeps, and the reason a first paint never waits on a bucket.
  if (!localRowsLoaded.value) void loadLocalRows();
}
export function closeChip(): void {
  open.value = false;
}
export function toggleChip(): void {
  if (open.value) closeChip();
  else openChip();
}

export function setBrainPreference(next: BrainPreference): void {
  preference.value = next;
}

/** The handles, as the pure module wants them: id, peer, readiness — nothing live. */
const chipBrains = computed<ChipBrain[]>(() =>
  brains.value.map((h) => ({ id: h.id, peer: h.peer, readiness: h.readiness })),
);

const names = computed(() => ({
  localModel: settings.value.localModel?.label ?? null,
  byokVendor: settings.value.byok?.vendor ?? null,
}));

/** The chip's own line: the brain answering next, and how ready it is. */
export const chip = computed(() =>
  chipLabel({ selected: selectedBrain.value, brains: chipBrains.value, ...names.value }),
);

/** What `Automatic` would pick, said out loud in the picker. */
export const autoLine = computed(() => autoSentence(chipBrains.value, names.value));

/**
 * The download the next answer is waiting on, if any — the chip's bar and A6's status row, one fact.
 *
 * It is about the brain that would ANSWER, not about every brain: a second local row downloading in
 * the background is not what this message is waiting for.
 */
export const download = computed<{ text: string; percent: number | null } | null>(() => {
  const brain = chip.value.brain;
  if (!brain) return null;
  const line = downloadLine(chipNameOf(brain), brain.readiness);
  if (!line) return null;
  return { text: line, percent: downloadPercent(brain.readiness) };
});

/** The chip's quiet second thought: the weights are not here, and nothing is fetching them yet. */
export const pendingNote = computed(() => {
  const brain = chip.value.brain;
  return brain ? pendingDownloadNote(chipNameOf(brain), brain.readiness) : null;
});

/** What A6's row says while a RUN waits — the download, from the first moment rather than the first byte. */
export const runStatus = computed<{ text: string; percent: number | null } | null>(() => {
  const brain = chip.value.brain;
  if (!brain) return null;
  const line = runStatusLine(chipNameOf(brain), brain.readiness);
  if (!line) return null;
  return { text: line, percent: downloadPercent(brain.readiness) };
});

function chipNameOf(brain: ChipBrain): string {
  return brain.peer === "local" ? names.value.localModel?.trim() || "the local model" : brain.id;
}

/** Why this message cannot be sent at all — named, with the chip one click away (A6). */
export const runBlockedReason = computed(() => noBrainReason(chipBrains.value, names.value));

// ── Choosing ──────────────────────────────────────────────────────────────────────────────────────

export async function chooseCloudBrain(id: string): Promise<void> {
  await chooseBrain(id);
  closeChip();
}

export async function useAutomatic(): Promise<void> {
  await chooseBrain("auto");
  closeChip();
}

/**
 * A local row, chosen from the composer: the SAME two writes the Connections card makes, so the two
 * pickers cannot disagree — the row into `localModel`, then `local` as the selected brain — and then
 * the download, started here rather than left for the next message.
 */
export async function pickLocalRow(row: LiteRtCatalogRow): Promise<void> {
  await chooseLocalModel(row);
  await chooseBrain("local");
  syncLocalBrain();
  void preloadLocal();
}

/**
 * Start the weights downloading now. Errors are kept and shown, never thrown at the caller: this is
 * started from a click that has already done its real work (the row is chosen either way).
 */
export async function preloadLocal(): Promise<void> {
  const handle = brains.value.find((h) => h.peer === "local");
  const provider = handle?.provider as Preloadable | null | undefined;
  if (!provider?.load) return;
  preloading.value = true;
  preloadFailure.value = null;
  const stop = startDownloadWatch();
  try {
    await provider.load();
    await refreshBrains();
  } catch (err) {
    preloadFailure.value = err instanceof Error ? err.message : String(err);
  } finally {
    preloading.value = false;
    stop();
  }
}

// ── The poll that makes a download visible ────────────────────────────────────────────────────────

/**
 * Re-ask readiness while something is waiting on it. Reference-counted, because a run and a preload
 * can both be waiting and the second to finish must not turn the first one's bar off.
 */
export function startDownloadWatch(everyMs = 1000): () => void {
  watchers += 1;
  if (!watchTimer) {
    void refreshBrains();
    watchTimer = setInterval(() => void refreshBrains(), everyMs);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers = Math.max(0, watchers - 1);
    if (watchers === 0 && watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  };
}

/** Readiness this app has not asked for yet — the composer needs it before the first message. */
export async function primeBrains(): Promise<void> {
  if (!agent.value || brains.value.length) return;
  await refreshBrains();
}

/** Test seam. */
export function resetModelChoice(): void {
  open.value = false;
  preference.value = "auto";
  preloading.value = false;
  preloadFailure.value = null;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  watchers = 0;
}
