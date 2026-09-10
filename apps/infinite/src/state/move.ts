/**
 * Move to my Mac, as state — docs/HANDOFF-infinite-agent.md §7.
 *
 * WHY THE STEPS ARE STATE AND NOT A WIZARD COMPONENT'S LOCALS. Half of this flow happens OUTSIDE the
 * tab: a file lands in Downloads, an OS prompt asks whether to open 00, an app the browser cannot see
 * either imports the agent or does not. The person comes back to this tab to say what happened, and
 * they may come back to it after a reload. So the step, the code and the file name live here, where
 * the shell can paint them from wherever the person left off, and the RECEIPT lives in IndexedDB
 * beside the connection settings, because §7's one-live-residence rule has to outlive a refresh or it
 * is not a rule.
 *
 * THE CODE IS NEVER LOGGED, NEVER PUT IN A URL AND NEVER PERSISTED. It is the bundle key. It exists
 * in this module's memory for as long as the flow is open and dies with the tab; the receipt that
 * survives carries the file name and the date, which are the two things a person needs later, and
 * nothing that would open the file.
 */
import { computed, ref } from "vue";
import {
  importDeepLink,
  isLocked,
  isSecondCopy,
  moveFilename,
  moveReceiptReducer,
  newMoveCode,
  type MoveReceipt,
  type MoveStep,
} from "../lib/move.js";
import { MOVE_RECEIPT_KEY, kvDelete, kvGet, kvSet } from "../lib/kv.js";
import { agent } from "./agent.js";

const step = ref<MoveStep>("explain");
const code = ref("");
const fileName = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const receipt = ref<MoveReceipt | null>(null);
const restoring = ref(false);

export const moveStep = computed(() => step.value);
export const moveCode = computed(() => code.value);
export const moveFileName = computed(() => fileName.value);
export const moveBusy = computed(() => busy.value);
export const moveError = computed(() => error.value);
export const moveReceipt = computed(() => receipt.value);
/** The shell paints the receipt instead of the agent exactly while this is true. */
export const movedAway = computed(() => isLocked(receipt.value));
/** An override happened: this browser and the Mac may both be live, and the screen says so. */
export const twoLiveCopies = computed(() => isSecondCopy(receipt.value));
/** The receipt pane has opened its Restore form. */
export const bringingBack = computed(() => restoring.value);
/** `zerozero://agent/import?name=…` — the file name only; see the note in lib/move.ts. */
export const moveDeepLink = computed(() => (fileName.value ? importDeepLink(fileName.value) : ""));

/** Read at boot, before the shell decides which pane to paint. */
export async function loadMoveReceipt(): Promise<MoveReceipt | null> {
  receipt.value = await kvGet<MoveReceipt>(MOVE_RECEIPT_KEY);
  return receipt.value;
}

async function persist(next: MoveReceipt | null): Promise<void> {
  receipt.value = next;
  if (next) await kvSet(MOVE_RECEIPT_KEY, next);
  else await kvDelete(MOVE_RECEIPT_KEY);
}

/** Back to step one with no secret in memory — what closing the panel means. */
export function resetMove(): void {
  step.value = "explain";
  code.value = "";
  fileName.value = "";
  error.value = null;
  busy.value = false;
}

export function toCodeStep(random?: Parameters<typeof newMoveCode>[0]): string {
  code.value = newMoveCode(random);
  step.value = "code";
  return code.value;
}

/**
 * Step 3. The code IS the bundle secret, and `exportBundleFile` is the same door Backup uses, so a
 * moved agent and a backed-up one are the same `.00agent` with the same `host: "browser"` — which is
 * what lets the Mac open either of them with the one document type it registered.
 *
 * The Blob URL is revoked on the next tick: it holds the whole encrypted bundle alive in memory for
 * as long as the document does.
 */
export async function downloadMove(at = new Date()): Promise<string | null> {
  const owned = agent.value;
  if (!owned || !code.value) return null;
  busy.value = true;
  error.value = null;
  try {
    const blob = await owned.exportBundleFile(code.value);
    const name = moveFilename(owned.profile.displayName, at);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    fileName.value = name;
    step.value = "open";
    return name;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    busy.value = false;
  }
}

/**
 * Step 4. A custom scheme has no feedback: the browser either hands it to 00, or asks first, or does
 * nothing at all when 00 is not installed. So this never claims success — it moves the panel on to
 * the step that asks the person what actually happened, and the fallback sentence stays on screen.
 */
export function openIn00(): void {
  if (!fileName.value) return;
  location.href = importDeepLink(fileName.value);
  step.value = "confirm";
}

/** Step 5. The person says the Mac has it; this browser stops being a residence. */
export async function confirmMoved(at = new Date()): Promise<void> {
  const owned = agent.value;
  if (!owned || !fileName.value) return;
  await persist(
    moveReceiptReducer(receipt.value, { type: "moved", profile: owned.profile, fileName: fileName.value, at }),
  );
  resetMove();
}

export function openBringBack(): void {
  restoring.value = true;
}

export function closeBringBack(): void {
  restoring.value = false;
}

/** Called by the Restore path on success — the Mac handed it back, so this browser is live again. */
export async function releaseAfterRestore(at = new Date()): Promise<void> {
  if (!receipt.value) return;
  await persist(moveReceiptReducer(receipt.value, { type: "brought-back", at }));
}

/** The person's call, taken with the risk named on the screen that offers it. */
export async function unlockAnyway(at = new Date()): Promise<void> {
  await persist(moveReceiptReducer(receipt.value, { type: "unlock-anyway", at }));
  restoring.value = false;
}

/** Drops the record entirely — offered once the lock is off and the note has been read. */
export async function forgetMoveReceipt(): Promise<void> {
  await persist(moveReceiptReducer(receipt.value, { type: "cleared" }));
}
