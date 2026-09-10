<script setup lang="ts">
/**
 * The conversation, and the composer under it.
 *
 * The tool rows are the 00 web UI's: a 10px mono line with the `tools` glyph, ink-dim, one line per
 * tool no matter how many times it ran (SessionThread.vue does the same). They expand on click,
 * because "read ×7" is the right default and "what did it actually read" is the right follow-up.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import ModelChip from "./ModelChip.vue";
import { toolRowLabel, toolRowState, type Row } from "../lib/conversation.js";
import { answeredByLine } from "../lib/model-chip.js";
import { busy, composerError, rows, send, stop } from "../state/conversation.js";
import { clearSelection, selection, selectionChip } from "../state/preview.js";
import { SELECTION_NOTE, selectionBlock } from "../power/inspector-context.js";
import { openChip, primeBrains } from "../state/model-choice.js";
import { profile } from "../state/agent.js";

const draft = ref("");
const expanded = ref<Set<string>>(new Set());
const scroller = ref<HTMLElement | null>(null);

const empty = computed(() => rows.value.length === 0);

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function toolTone(row: Row & { kind: "tool" }): string {
  const state = toolRowState(row);
  if (state === "failed") return "text-[var(--color-red)]";
  if (state === "running") return "text-[var(--color-ink-dim)] ia-pulse";
  return "text-[var(--color-ink-dim)]";
}

/**
 * A message can be nothing but a selection. Clicking an element in the preview and pressing send
 * without typing is a real thing a person does — "this one" — and the agent can ask what about it.
 */
async function submit(): Promise<void> {
  const text = draft.value;
  if (busy.value) return;
  if (!text.trim() && !selection.value) return;
  draft.value = "";
  await send(text);
}

/** Enter sends, Shift+Enter is a newline — the composer rule everywhere else in 00. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

// The chip names the brain that answers next, so it needs readiness before the first message —
// asked once here, at the speed of four cache lookups, and never on a timer from this pane.
onMounted(() => void primeBrains());

watch(
  () => rows.value.length,
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div ref="scroller" class="flex-1 ia-scroll px-4 sm:px-6 py-5">
      <div v-if="empty" class="h-full flex flex-col items-center justify-center text-center gap-2 px-6">
        <div class="text-3xl">{{ profile?.emoji ?? "🟢" }}</div>
        <div class="text-[15px] font-semibold">{{ profile?.displayName ?? "Your agent" }}</div>
        <p class="text-[12px] text-[var(--color-ink-dim)] max-w-xs leading-relaxed">
          It has a workspace, files and a memory, all in this browser. Ask it something, or tell it who
          you are so it can fill in its own identity files.
        </p>
      </div>

      <div v-else class="max-w-2xl mx-auto space-y-3">
        <template v-for="row in rows" :key="row.id">
          <div v-if="row.kind === 'user'" class="flex justify-end">
            <div
              class="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] whitespace-pre-wrap break-words"
              :style="{ background: 'color-mix(in srgb, var(--color-panel-2) 80%, transparent)' }"
            >
              {{ row.text }}
            </div>
          </div>

          <div v-else-if="row.kind === 'agent'">
            <div class="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
              {{ row.text
              }}<span
                v-if="row.streaming"
                class="inline-block w-[7px] h-[14px] align-[-2px] ml-0.5 bg-[var(--color-phosphor)] ia-pulse"
              />
            </div>
            <!-- B20: which brain wrote this, from `model_started`. Under the answer, quiet, and
                 never fed back to the model — it is the reader's receipt, not context. -->
            <div v-if="row.by" class="mt-0.5 text-[10px] font-mono text-[var(--color-ink-dim)]">
              {{ answeredByLine(row.by) }}
            </div>
          </div>

          <!-- A6: the wait, made visible. It is replaced by the answer rather than pushed above it. -->
          <div v-else-if="row.kind === 'status'" class="space-y-1">
            <div class="flex items-center gap-1.5 text-[11px] text-[var(--color-cyan)]">
              <TablerIcon name="download" :size="12" class="shrink-0 ia-pulse" />
              <span class="truncate">{{ row.text }}</span>
            </div>
            <div v-if="row.percent !== null" class="h-1 rounded-full bg-[var(--color-line)] overflow-hidden max-w-xs">
              <div class="h-full bg-[var(--color-cyan)] transition-[width] duration-500" :style="{ width: `${row.percent}%` }"></div>
            </div>
          </div>

          <div v-else-if="row.kind === 'tool'">
            <button
              type="button"
              class="flex items-center gap-1.5 text-[10px] font-mono"
              :class="toolTone(row)"
              @click="toggle(row.id)"
            >
              <TablerIcon name="tools" :size="10" />
              <span class="truncate">{{ toolRowLabel(row) }}</span>
              <span v-if="row.ms > 0" class="opacity-60">{{ row.ms }}ms</span>
              <TablerIcon :name="expanded.has(row.id) ? 'chevron-down' : 'chevron-right'" :size="10" />
            </button>
            <pre
              v-if="expanded.has(row.id) && row.detail"
              class="mt-1 ml-4 text-[10px] font-mono text-[var(--color-ink-dim)] whitespace-pre-wrap break-words max-h-56 ia-scroll rounded-lg p-2"
              :style="{ background: 'color-mix(in srgb, var(--color-panel-2) 45%, transparent)' }"
              >{{ row.detail }}</pre
            >
          </div>

          <!-- The sponsor line of §6.2: shown under the answer, never fed back to the model. -->
          <div v-else-if="row.kind === 'footer'" class="text-[10px] text-[var(--color-ink-dim)] italic">
            {{ row.text }}
          </div>

          <div v-else class="flex items-start gap-2 text-[12px] text-[var(--color-red)]">
            <TablerIcon name="alert-triangle" :size="14" class="mt-0.5 shrink-0" />
            <div class="min-w-0">
              <p>{{ row.text }}</p>
              <!-- The one error a person can fix from here: the chip is two lines below. -->
              <button
                v-if="row.openChip"
                type="button"
                class="ia-btn mt-1.5 h-7 px-2.5 text-[11px]"
                @click="openChip()"
              >
                Choose a brain
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div class="border-t border-[var(--color-line)] px-3 sm:px-6 py-3">
      <p v-if="composerError" class="text-[11px] text-[var(--color-red)] mb-2 max-w-2xl mx-auto">
        {{ composerError }}
      </p>
      <!-- The composer's control row, the 00 shape: what will answer, where the message is written. -->
      <div class="max-w-2xl mx-auto flex items-center gap-2 mb-1.5 min-w-0">
        <ModelChip />
        <!-- What was picked in the preview pane, and the ✕ that un-picks it. The whole block that
             will be sent is the tooltip, so nothing travels that the person has not been shown. -->
        <div
          v-if="selectionChip"
          class="min-w-0 h-7 flex items-center gap-1 rounded-lg px-2 text-[11px] text-[var(--color-cyan)] bg-[var(--color-panel-2)]"
          :title="`${SELECTION_NOTE}\n\n${selection ? selectionBlock(selection) : ''}`"
        >
          <!-- The preview pane's own glyph: this chip is a thing that came from that pane. A real
               pointer icon would be better and is not in TablerIcon.vue's set — the house rule is
               that path data is copied from @tabler/icons, never typed, so adding one is its own
               change rather than a guess made here. -->
          <TablerIcon name="world" :size="11" class="shrink-0" />
          <span class="truncate">{{ selectionChip }}</span>
          <button
            type="button"
            class="shrink-0 opacity-70 hover:opacity-100"
            title="Do not send this element"
            @click="clearSelection()"
          >
            <TablerIcon name="x" :size="11" />
          </button>
        </div>
      </div>
      <div class="max-w-2xl mx-auto flex items-end gap-2">
        <textarea
          v-model="draft"
          rows="1"
          class="ia-input resize-none max-h-40 text-[13px]"
          :style="{ minHeight: '38px' }"
          placeholder="Ask your agent…"
          @keydown="onKeydown"
        />
        <button
          v-if="busy"
          type="button"
          class="ia-btn ia-btn-danger h-[38px] px-3 flex items-center gap-1.5 text-[12px] shrink-0"
          @click="stop()"
        >
          <TablerIcon name="player-stop" :size="15" />
          <span class="hidden sm:inline">Stop</span>
        </button>
        <button
          v-else
          type="button"
          class="ia-btn ia-btn-primary h-[38px] px-3 flex items-center gap-1.5 text-[12px] shrink-0"
          :disabled="!draft.trim() && !selection"
          @click="submit()"
        >
          <TablerIcon name="send" :size="15" />
          <span class="hidden sm:inline">Send</span>
        </button>
      </div>
      <p class="max-w-2xl mx-auto mt-1.5 text-[10px] text-[var(--color-ink-dim)]">
        Enter sends · Shift + Enter for a new line
      </p>
    </div>
  </div>
</template>
