<script setup lang="ts">
/**
 * THE THREADS — `listSessions()` / `loadSession()` from the contract, grouped by day and searchable.
 *
 * The grouping and the filtering are `state/sessions.ts`, pure and tested; this draws them. Three
 * headings (Today / Yesterday / Earlier) rather than one per date, because a list of a dozen threads
 * under a dozen headings is a list of headings.
 *
 * The search field appears once there is enough to search. A filter over four rows is furniture.
 */
import { computed, onMounted, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import {
  dayLabel,
  groupSessions,
  matchSessions,
  open,
  refreshSessions,
  sessions,
  sessionsError,
  sessionsLoading,
} from "../state/sessions.js";
import { currentSession } from "../state/conversation.js";

const emit = defineEmits<{ (e: "picked"): void }>();

const query = ref("");
const groups = computed(() => groupSessions(matchSessions(sessions.value, query.value)));
const searchable = computed(() => sessions.value.length > 4);

onMounted(() => void refreshSessions());

async function pick(id: string): Promise<void> {
  await open(id);
  emit("picked");
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div v-if="searchable" class="px-2.5 pb-2 shrink-0">
      <div class="relative">
        <TablerIcon
          name="search"
          :size="13"
          class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)] pointer-events-none"
        />
        <input
          v-model="query"
          type="search"
          class="ia-input h-8 py-0 pl-8 pr-2 text-[12px]"
          placeholder="Search threads"
          aria-label="Search threads"
        />
      </div>
    </div>

    <div class="flex-1 ia-scroll px-2 pb-2">
      <p v-if="sessionsError" class="text-[12px] text-[var(--color-red)] px-1.5 py-2">{{ sessionsError }}</p>
      <p v-else-if="sessionsLoading && !sessions.length" class="text-[12px] text-[var(--color-ink-faint)] px-1.5 py-2 ia-pulse">
        Reading…
      </p>
      <p v-else-if="!sessions.length" class="text-[12px] text-[var(--color-ink-faint)] px-1.5 py-2 leading-relaxed">
        No threads yet. Every conversation is written into the agent's own <code class="font-mono">sessions/</code>
        folder, so it travels with it.
      </p>
      <p v-else-if="!groups.length" class="text-[12px] text-[var(--color-ink-faint)] px-1.5 py-2">
        Nothing matches “{{ query }}”.
      </p>

      <div v-for="group in groups" :key="group.label" class="mb-3">
        <div class="ia-label px-1.5 py-1.5">{{ group.label }}</div>
        <button
          v-for="session in group.rows"
          :key="session.id"
          type="button"
          class="w-full text-left rounded-lg px-2 py-1.5 transition-colors"
          :class="
            currentSession === session.id
              ? 'bg-[var(--color-panel-2)] text-[var(--color-ink)]'
              : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-ink)]'
          "
          @click="pick(session.id)"
        >
          <div class="text-[13px] truncate">{{ session.title || "Untitled" }}</div>
          <div v-if="group.label === 'Earlier'" class="text-[11px] text-[var(--color-ink-faint)]">
            {{ dayLabel(session.updatedAt) }}
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
