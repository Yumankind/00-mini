<script setup lang="ts">
/**
 * THE BRAIN CHIP IN THE COMPOSER — what will answer the next message, and how far its download got.
 *
 * WHY IT LIVES BESIDE THE TEXTAREA AND NOT IN A SETTINGS PANE. Choosing a brain is a decision about
 * the message being typed, not about the app: on the 00 Mac client the same decision is a chip in
 * the composer's own control row (packages/web-vue/src/components/ComposerCreditsChip.vue and the
 * model picker beside it), and this is that shape, with the one thing a browser adds — the model is
 * not somewhere else, it is two gigabytes that have to arrive here first. So the chip is also the
 * download: the bar is IN it, in bytes and percent, and the picker starts the download on the click
 * that chooses the row rather than leaving it for the next message.
 *
 * The panel opens through the store rather than a local ref, because the conversation's "no brain
 * can answer" row has a button that opens this exact panel from the other end of the pane.
 */
import { onBeforeUnmount, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import ModelPicker from "./ModelPicker.vue";
import { chip, chipOpen, closeChip, download, pendingNote, toggleChip } from "../state/model-choice.js";

const root = ref<HTMLElement | null>(null);

const TONE_CLASS = {
  ok: "text-[var(--color-phosphor)]",
  busy: "text-[var(--color-cyan)]",
  warn: "text-[var(--color-amber)]",
  off: "text-[var(--color-ink-dim)]",
} as const;
const DOT_CLASS = {
  ok: "bg-[var(--color-phosphor)]",
  busy: "bg-[var(--color-cyan)]",
  warn: "bg-[var(--color-amber)]",
  off: "bg-[var(--color-ink-dim)]",
} as const;

function onDocPointer(event: MouseEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) closeChip();
}
watch(chipOpen, (open) => {
  if (open) document.addEventListener("mousedown", onDocPointer);
  else document.removeEventListener("mousedown", onDocPointer);
});
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocPointer));
</script>

<template>
  <div ref="root" class="relative min-w-0">
    <button
      type="button"
      class="max-w-full h-7 flex items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:bg-[var(--color-panel-2)]"
      :class="TONE_CLASS[chip.tone]"
      :title="download?.text ?? pendingNote ?? `${chip.text} — click to choose the brain that answers next`"
      @click="toggleChip()"
    >
      <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="[DOT_CLASS[chip.tone], download ? 'ia-pulse' : '']"></span>
      <span class="truncate">{{ download ? download.text : chip.text }}</span>
      <TablerIcon name="chevron-down" :size="11" class="shrink-0 opacity-60" />
    </button>

    <!-- The bar, out of the TYPED progress of the 2026-09-10 contract revision. A host that sent no
         Content-Length gives bytes and no percent: the line above still moves, and no bar is drawn
         rather than one that guesses. -->
    <div v-if="download && download.percent !== null" class="h-[3px] mx-2 rounded-full bg-[var(--color-line)] overflow-hidden">
      <div class="h-full bg-[var(--color-cyan)] transition-[width] duration-500" :style="{ width: `${download.percent}%` }"></div>
    </div>

    <!-- Upwards, because the composer sits on the bottom edge of the screen. Capped and scrolling:
         four brains and seven model rows do not fit above a composer on a 375px phone. -->
    <div
      v-if="chipOpen"
      class="absolute bottom-full left-0 mb-2 z-30 w-[21rem] max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-auto ia-scroll ia-float p-3 ia-rise"
    >
      <ModelPicker section="all" />
    </div>
  </div>
</template>
