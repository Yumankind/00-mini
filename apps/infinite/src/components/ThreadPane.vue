<script setup lang="ts">
/**
 * THE THREAD — the conversation, and the composer under it.
 *
 * The column is capped at 44rem and centred whatever the pane is wide, because a line of prose that
 * runs the width of a 27-inch display is a line nobody finishes. A person's message is a soft bubble
 * on the right; the agent's is rendered markdown at full width with no bubble at all, which is what
 * makes a long answer with code in it readable — a bubble around a code block is a box in a box.
 *
 * THE SCROLL FOLLOWS THE ANSWER, UNTIL IT DOES NOT. Sticking to the bottom is right while a person
 * is watching an answer arrive and wrong the moment they scroll up to re-read something: the pin is
 * dropped as soon as they leave the bottom and picked up again when they come back, and a button
 * appears meanwhile rather than yanking the view.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import ActivityCard from "./ActivityCard.vue";
import Composer from "./Composer.vue";
import MarkdownBlock from "./MarkdownBlock.vue";
import PixelFace from "./PixelFace.vue";
import TablerIcon from "./TablerIcon.vue";
import { foldActivity } from "../lib/activity.js";
import { answeredByLine } from "../lib/model-chip.js";
import { busy, rows } from "../state/conversation.js";
import { openChip, primeBrains } from "../state/model-choice.js";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

/** Four openings that are true of this agent: a workspace, a terminal, a preview and a memory. */
const SUGGESTIONS = [
  "Make a small web page and show me the preview",
  "What is in your workspace right now?",
  "Run `ls -l` and tell me what you see",
  "Write down what I should know about you",
];

const scroller = ref<HTMLElement | null>(null);
const composer = ref<InstanceType<typeof Composer> | null>(null);
const pinned = ref(true);

const view = computed(() => foldActivity(rows.value));
const empty = computed(() => rows.value.length === 0);

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function toBottom(): void {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  pinned.value = true;
}

function suggest(text: string): void {
  composer.value?.fill(text);
}

// The chip names the brain that answers next, so it needs readiness before the first message —
// asked once here, at the speed of four cache lookups, and never on a timer from this pane.
onMounted(() => void primeBrains());

watch(
  // The LENGTH of the last row's text as well as the row count: an answer streaming into one bubble
  // grows the page without adding a row, and a thread that only followed row counts would sit still
  // while the answer ran off the bottom.
  () => [rows.value.length, rows.value[rows.value.length - 1]?.kind === "agent" ? rows.value[rows.value.length - 1] : null],
  async () => {
    if (!pinned.value) return;
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
  { deep: true },
);
</script>

<template>
  <div class="h-full flex flex-col min-h-0 relative">
    <div ref="scroller" class="flex-1 ia-scroll px-4 sm:px-6 py-6" @scroll.passive="onScroll">
      <!-- Nothing said yet: the face, the question, and four ways to start. -->
      <div v-if="empty" class="h-full flex flex-col items-center justify-center text-center gap-5 px-2">
        <PixelFace :size="56" self-animate glow />
        <div>
          <h1 class="text-[22px] font-semibold tracking-tight">What are we building?</h1>
          <p class="mt-1.5 text-[13px] text-[var(--color-ink-dim)] max-w-sm mx-auto leading-relaxed">
            00 Mini has a workspace, a terminal, Git and a memory — all of it inside this browser.
          </p>
        </div>
        <div class="flex flex-wrap justify-center gap-2 max-w-xl">
          <button
            v-for="text in SUGGESTIONS"
            :key="text"
            type="button"
            class="ia-btn h-8 px-3 text-[12px] rounded-full text-[var(--color-ink-dim)]"
            @click="suggest(text)"
          >
            {{ text }}
          </button>
        </div>
      </div>

      <div v-else class="max-w-[44rem] mx-auto space-y-5">
        <template v-for="row in view" :key="row.id">
          <!-- A person's turn: right-aligned, soft, and carrying its pictures. -->
          <div v-if="row.kind === 'user'" class="flex justify-end">
            <div class="max-w-[85%] min-w-0">
              <div v-if="row.images?.length" class="flex flex-wrap gap-2 justify-end mb-1.5">
                <img
                  v-for="picture in row.images"
                  :key="picture.path"
                  :src="picture.url"
                  :alt="picture.path"
                  :title="picture.path"
                  class="w-24 h-24 object-cover rounded-xl border border-[var(--color-line)]"
                />
              </div>
              <div
                class="rounded-2xl rounded-br-md px-3.5 py-2.5 text-[14px] whitespace-pre-wrap break-words"
                :style="{ background: 'var(--color-panel)' }"
              >
                {{ row.text }}
              </div>
            </div>
          </div>

          <!-- The agent's turn: no bubble, rendered markdown, the receipt under it. -->
          <div v-else-if="row.kind === 'agent'" class="min-w-0">
            <MarkdownBlock :text="row.text" :streaming="row.streaming" :small="compact" />
            <span
              v-if="row.streaming"
              class="inline-block w-[7px] h-[15px] align-[-2px] bg-[var(--color-phosphor)] ia-pulse"
            />
            <!-- B20: which brain wrote this, from `model_started`. Under the answer, quiet, and
                 never fed back to the model — it is the reader's receipt, not context. -->
            <div v-if="row.by" class="mt-1.5 text-[11px] font-mono text-[var(--color-ink-faint)]">
              {{ answeredByLine(row.by) }}
            </div>
          </div>

          <!-- A6: the wait, made visible. It is replaced by the answer rather than pushed above it. -->
          <div v-else-if="row.kind === 'status'" class="space-y-1.5">
            <div class="flex items-center gap-2 text-[12px] text-[var(--color-cyan)]">
              <TablerIcon name="download" :size="13" class="shrink-0 ia-pulse" />
              <span class="truncate">{{ row.text }}</span>
            </div>
            <div v-if="row.percent !== null" class="h-1 rounded-full bg-[var(--color-line)] overflow-hidden max-w-xs">
              <div
                class="h-full bg-[var(--color-cyan)] transition-[width] duration-500"
                :style="{ width: `${row.percent}%` }"
              />
            </div>
          </div>

          <!-- Everything the agent DID between two sentences, folded into one card. -->
          <ActivityCard v-else-if="row.kind === 'activity'" :row="row" />

          <!-- The sponsor line of §6.2: shown under the answer, never fed back to the model. -->
          <div v-else-if="row.kind === 'footer'" class="text-[11px] text-[var(--color-ink-faint)] italic">
            {{ row.text }}
          </div>

          <div
            v-else
            class="flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px]"
            :style="{
              background: 'color-mix(in srgb, var(--color-red) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-red) 30%, transparent)',
            }"
          >
            <TablerIcon name="alert-triangle" :size="15" class="mt-0.5 shrink-0 text-[var(--color-red)]" />
            <div class="min-w-0">
              <p class="text-[var(--color-red)] leading-relaxed">{{ row.text }}</p>
              <!-- The one error a person can fix from here: the chip is two lines below. -->
              <button v-if="row.openChip" type="button" class="ia-btn mt-2 h-7 px-2.5 text-[12px]" @click="openChip()">
                Choose a brain
              </button>
            </div>
          </div>
        </template>

        <div v-if="busy && view[view.length - 1]?.kind !== 'agent'" class="flex items-center gap-2 text-[12px] text-[var(--color-ink-faint)]">
          <PixelFace :size="16" thinking />
          <span class="ia-pulse">Thinking…</span>
        </div>
      </div>
    </div>

    <!-- Left the bottom while an answer is arriving: come back, without the view being yanked. -->
    <button
      v-if="!pinned && !empty"
      type="button"
      class="ia-btn absolute left-1/2 -translate-x-1/2 bottom-[7.5rem] w-8 h-8 rounded-full z-10"
      :style="{ background: 'var(--color-panel)', boxShadow: 'var(--shadow-float)' }"
      title="Jump to the newest message"
      @click="toBottom()"
    >
      <TablerIcon name="arrow-down" :size="15" />
    </button>

    <div class="shrink-0 px-4 sm:px-6 pb-4 pt-2" :style="{ background: 'var(--color-void)' }">
      <div class="max-w-[44rem] mx-auto">
        <Composer ref="composer" :compact="compact" />
      </div>
    </div>
  </div>
</template>
