/**
 * WHAT IS SELECTED IN THE PREVIEW, AND WHETHER THE PANE IS PICKING.
 *
 * WHY A STORE AND NOT A REF INSIDE `PreviewPane.vue`. The pick is made in one pane and spent in
 * another: the person clicks a button in the preview, and the chip that says so appears in the
 * COMPOSER, at the other end of the power layout, where the ✕ that cancels it also lives. Two panes
 * that never see each other's props need a third place to look, and this is it. It is the same shape
 * `state/ports.ts` has for the same reason.
 *
 * WHY THE SELECTION IS TAKEN, NOT READ. `send()` calls `takeSelection()`, which returns the pick and
 * clears it in one step. A selection that survived the message it was attached to would silently ride
 * along on the next one — the person would have to remember to cancel something they had already
 * spent, and the first they would know about it is an answer about the wrong button.
 */
import { computed, ref } from "vue";
import { chipTextFor, previewHostConfigured, type PickedElement } from "../lib/pick.js";

export type HostState = "off" | "connecting" | "live" | "failed";

const pick = ref<PickedElement | null>(null);
const inspect = ref(false);
const host = ref<HostState>("off");
const hostNote = ref<string | null>(null);
const address = ref<string | null>(null);

/** The pick the next message will carry, or `null`. */
export const selection = computed(() => pick.value);
/** `Selected: <button.buy> 'Add to cart' · index.html`, or `null` when nothing is picked. */
export const selectionChip = computed(() => (pick.value ? chipTextFor(pick.value) : null));
/** Whether a click in the preview picks rather than presses. Alt+click picks either way. */
export const inspecting = computed(() => inspect.value);
export const previewHost = computed(() => host.value);
export const previewNote = computed(() => hostNote.value);
/** The address line under the pane's toolbar: where the live frame actually is. */
export const previewAddress = computed(() => address.value);

/** False when this build has no `VITE_PREVIEW_ORIGIN` — the pane then stays on the snapshot road. */
export const liveAvailable = computed(() => previewHostConfigured());

export function setSelection(next: PickedElement): void {
  pick.value = next;
}

export function clearSelection(): void {
  pick.value = null;
}

/** Read it and spend it — see the header. */
export function takeSelection(): PickedElement | null {
  const current = pick.value;
  pick.value = null;
  return current;
}

export function setInspecting(on: boolean): void {
  inspect.value = on;
}

export function toggleInspecting(): boolean {
  inspect.value = !inspect.value;
  return inspect.value;
}

export function setHostState(state: HostState, note: string | null = null): void {
  host.value = state;
  hostNote.value = note;
}

export function setAddress(url: string | null): void {
  address.value = url;
}

/** Test seam, and what a Restore calls: a new agent means nothing that was picked still exists. */
export function resetPreviewState(): void {
  pick.value = null;
  inspect.value = false;
  host.value = "off";
  hostNote.value = null;
  address.value = null;
}
