<script setup lang="ts">
/**
 * THE COMPOSER — one rounded card: what you are about to say, what will answer it, and what is
 * attached to it.
 *
 * The shape is the 00 Mac client's (packages/web-vue/src/components/SessionThread.vue and the chip
 * beside it): the textarea is the card, and the controls live INSIDE its bottom edge rather than in
 * a toolbar above it — a person's eye is on the words they are typing and every control they may
 * want is on the same object.
 *
 * PICTURES COME IN THREE WAYS because a person has three habits: the button, ⌘V over the field, and
 * a file dropped anywhere on the card. All three land in the same list, shrunk to 1568px on the
 * longest side (lib/attachments.ts says why), thumbnailed here and again in the sent row.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import ModelChip from "./ModelChip.vue";
import TablerIcon from "./TablerIcon.vue";
import { imageFilesOf, readAttachment, type Attachment } from "../lib/attachments.js";
import { SELECTION_NOTE, selectionBlock } from "../power/inspector-context.js";
import { busy, composerError, send, stop } from "../state/conversation.js";
import { visionNoteLine } from "../state/model-choice.js";
import { clearSelection, selection, selectionChip } from "../state/preview.js";

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const draft = ref("");
const pictures = ref<Attachment[]>([]);
const attachError = ref<string | null>(null);
const dropping = ref(false);
const field = ref<HTMLTextAreaElement | null>(null);
const picker = ref<HTMLInputElement | null>(null);

const canSend = computed(() => Boolean(draft.value.trim() || selection.value || pictures.value.length));

/** Grow with the text and stop at a third of the screen, after which the field scrolls. */
function resize(): void {
  const el = field.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, props.compact ? 140 : 220)}px`;
}
watch(draft, () => void nextTick(resize));

async function attach(files: File[]): Promise<void> {
  attachError.value = null;
  for (const file of files) {
    try {
      pictures.value = [...pictures.value, await readAttachment(file)];
    } catch (err) {
      attachError.value = err instanceof Error ? err.message : String(err);
    }
  }
}

function drop(picture: Attachment): void {
  URL.revokeObjectURL(picture.url);
  pictures.value = pictures.value.filter((p) => p.id !== picture.id);
}

function onPaste(event: ClipboardEvent): void {
  const files = imageFilesOf(event.clipboardData?.items ?? null);
  if (!files.length) return;
  // Only when there IS a picture: a pasted paragraph must still land in the textarea.
  event.preventDefault();
  void attach(files);
}

function onDrop(event: DragEvent): void {
  dropping.value = false;
  const files = imageFilesOf(event.dataTransfer?.files ?? null);
  if (files.length) void attach(files);
}

/**
 * A message can be nothing but a picture, or nothing but a selection: "this one" is a real thing to
 * say, and the agent can ask what about it.
 */
async function submit(): Promise<void> {
  if (busy.value || !canSend.value) return;
  const text = draft.value;
  const attachments = pictures.value;
  draft.value = "";
  pictures.value = [];
  await nextTick(resize);
  await send(text, attachments);
  // The blob URLs stay alive: the sent row draws the same thumbnails, and they are released when
  // the thread is replaced (a new session, or a reload).
}

/** Enter sends, Shift+Enter is a newline — the composer rule everywhere else in 00. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

defineExpose({ focus: () => field.value?.focus(), fill: (text: string) => {
  draft.value = text;
  void nextTick(() => {
    resize();
    field.value?.focus();
  });
} });

onBeforeUnmount(() => {
  for (const picture of pictures.value) URL.revokeObjectURL(picture.url);
});
</script>

<template>
  <div class="w-full">
    <p v-if="composerError" class="mb-2 text-[12px] text-[var(--color-red)]">{{ composerError }}</p>
    <p v-if="attachError" class="mb-2 text-[12px] text-[var(--color-amber)]">{{ attachError }}</p>

    <div
      class="relative border transition-colors focus-within:border-[color-mix(in_srgb,var(--color-phosphor)_45%,transparent)]"
      :class="dropping ? 'border-[var(--color-phosphor)]' : 'border-[var(--color-line)]'"
      :style="{
        background: 'var(--color-card)',
        borderRadius: 'var(--radius-composer)',
        boxShadow: 'var(--shadow-card)',
      }"
      @dragover.prevent="dropping = true"
      @dragleave="dropping = false"
      @drop.prevent="onDrop"
    >
      <!-- What is attached, before it is sent: a strip of thumbnails with an ✕ on each. -->
      <div v-if="pictures.length" class="flex flex-wrap gap-2 px-3 pt-3">
        <div v-for="picture in pictures" :key="picture.id" class="relative">
          <img
            :src="picture.url"
            :alt="picture.name"
            class="w-16 h-16 object-cover rounded-lg border border-[var(--color-line)]"
          />
          <button
            type="button"
            class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center border border-[var(--color-line)]"
            :style="{ background: 'var(--color-panel)' }"
            title="Do not send this picture"
            @click="drop(picture)"
          >
            <TablerIcon name="x" :size="11" />
          </button>
        </div>
      </div>

      <textarea
        ref="field"
        v-model="draft"
        rows="1"
        class="w-full resize-none bg-transparent border-0 outline-none px-4 pt-3.5 pb-1 text-[14px] leading-[1.55] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] ia-scroll"
        :placeholder="busy ? 'Your agent is working…' : 'Ask 00 Mini anything'"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <div class="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1 min-w-0">
        <input
          ref="picker"
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          @change="attach(imageFilesOf(($event.target as HTMLInputElement).files)); (($event.target as HTMLInputElement).value = '')"
        />
        <button
          type="button"
          class="ia-btn ia-btn-ghost w-8 h-8 rounded-full shrink-0"
          title="Attach a picture"
          @click="picker?.click()"
        >
          <TablerIcon name="paperclip" :size="15" />
        </button>

        <ModelChip />

        <!-- What was picked in the preview pane, and the ✕ that un-picks it. The whole block that
             will be sent is the tooltip, so nothing travels that the person has not been shown. -->
        <div
          v-if="selectionChip"
          class="min-w-0 h-7 flex items-center gap-1 rounded-lg px-2 text-[11px] text-[var(--color-cyan)]"
          :style="{ background: 'color-mix(in srgb, var(--color-cyan) 12%, transparent)' }"
          :title="`${SELECTION_NOTE}\n\n${selection ? selectionBlock(selection) : ''}`"
        >
          <TablerIcon name="world" :size="11" class="shrink-0" />
          <span class="truncate">{{ selectionChip }}</span>
          <button type="button" class="shrink-0 opacity-70 hover:opacity-100" title="Do not send this element" @click="clearSelection()">
            <TablerIcon name="x" :size="11" />
          </button>
        </div>

        <div class="ml-auto shrink-0">
          <button
            v-if="busy"
            type="button"
            class="ia-btn ia-btn-danger w-9 h-9 rounded-full"
            title="Stop"
            @click="stop()"
          >
            <TablerIcon name="player-stop" :size="15" />
          </button>
          <button
            v-else
            type="button"
            class="ia-btn ia-btn-primary w-9 h-9 rounded-full"
            :disabled="!canSend"
            title="Send"
            @click="submit()"
          >
            <TablerIcon name="arrow-up" :size="16" />
          </button>
        </div>
      </div>

      <div
        v-if="dropping"
        class="absolute inset-0 flex items-center justify-center text-[12px] text-[var(--color-phosphor)] pointer-events-none"
        :style="{ background: 'color-mix(in srgb, var(--color-phosphor) 10%, transparent)', borderRadius: 'var(--radius-composer)' }"
      >
        Drop a picture to attach it
      </div>
    </div>

    <p v-if="pictures.length && visionNoteLine" class="mt-1.5 text-[11px] text-[var(--color-amber)]">
      {{ visionNoteLine }}
    </p>
    <p v-else-if="!compact" class="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
      Enter sends · Shift + Enter for a new line · ⌘K for commands
    </p>
  </div>
</template>
