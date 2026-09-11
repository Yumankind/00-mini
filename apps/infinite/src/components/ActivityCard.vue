<script setup lang="ts">
/**
 * One run of tool calls, as one line a person can read — and the detail behind it when they want it.
 *
 * The naming is `lib/activity.ts`, which is pure and tested; this only draws it. Closed by default,
 * because "Read 3 files" is the right answer to "what is it doing" and the arguments are the right
 * answer to the follow-up, and showing both at once is how a thread turns into a log file.
 */
import { ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { formatMs, type ActivityRow } from "../lib/activity.js";
import { toolRowLabel } from "../lib/conversation.js";

defineProps<{ row: ActivityRow }>();
const open = ref(false);
</script>

<template>
  <div
    class="rounded-xl border overflow-hidden transition-colors"
    :class="
      row.state === 'failed'
        ? 'border-[color-mix(in_srgb,var(--color-red)_40%,transparent)]'
        : 'border-[var(--color-line)]'
    "
    :style="{ background: 'var(--color-card)' }"
  >
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-panel)] transition-colors"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="w-1.5 h-1.5 rounded-full shrink-0"
        :class="[
          row.state === 'failed'
            ? 'bg-[var(--color-red)]'
            : row.state === 'running'
              ? 'bg-[var(--color-cyan)] ia-pulse'
              : 'bg-[var(--color-ink-faint)]',
        ]"
      />
      <span class="text-[12.5px] truncate" :class="row.state === 'failed' ? 'text-[var(--color-red)]' : 'text-[var(--color-ink-dim)]'">
        {{ row.label }}<span v-if="row.state === 'failed'"> · failed</span>
      </span>
      <span v-if="row.ms > 0" class="text-[11px] text-[var(--color-ink-faint)] shrink-0 tabular-nums">
        {{ formatMs(row.ms) }}
      </span>
      <TablerIcon
        :name="open ? 'chevron-down' : 'chevron-right'"
        :size="13"
        class="ml-auto shrink-0 text-[var(--color-ink-faint)]"
      />
    </button>

    <div v-if="open" class="border-t border-[var(--color-line)] px-3 py-2 space-y-2">
      <div v-for="tool in row.tools" :key="tool.id" class="min-w-0">
        <div class="flex items-center gap-2 text-[11px] font-mono">
          <TablerIcon name="tools" :size="11" class="shrink-0 text-[var(--color-ink-faint)]" />
          <span :class="tool.failed > 0 ? 'text-[var(--color-red)]' : 'text-[var(--color-ink-dim)]'">
            {{ toolRowLabel(tool) }}
          </span>
          <span v-if="tool.ms > 0" class="text-[var(--color-ink-faint)] tabular-nums">{{ formatMs(tool.ms) }}</span>
        </div>
        <pre
          v-if="tool.detail"
          class="mt-1 text-[11px] font-mono leading-[1.5] text-[var(--color-ink-dim)] whitespace-pre-wrap break-words max-h-56 ia-scroll rounded-lg px-2.5 py-2"
          :style="{ background: 'var(--color-panel)' }"
          >{{ tool.detail }}</pre
        >
      </div>
    </div>
  </div>
</template>
