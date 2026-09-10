<script setup lang="ts">
/**
 * The sessions list — `listSessions()` and `loadSession()`, nothing more.
 *
 * It doubles as the phone's drawer, which is why it carries its own "New" button rather than leaving
 * it to a toolbar: on a narrow screen this pane IS the navigation between conversations.
 */
import { onMounted } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { dayLabel, open, refreshSessions, sessions, sessionsError, sessionsLoading } from "../state/sessions.js";
import { currentSession, startNewSession } from "../state/conversation.js";

const emit = defineEmits<{ (e: "picked"): void }>();

onMounted(() => void refreshSessions());

async function pick(id: string): Promise<void> {
  await open(id);
  emit("picked");
}

function fresh(): void {
  startNewSession();
  emit("picked");
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-line)]">
      <span class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">Sessions</span>
      <div class="flex items-center gap-1">
        <button type="button" class="ia-btn w-7 h-7 flex items-center justify-center" title="Reload" @click="refreshSessions()">
          <TablerIcon name="refresh" :size="14" />
        </button>
        <button type="button" class="ia-btn w-7 h-7 flex items-center justify-center" title="New session" @click="fresh()">
          <TablerIcon name="plus" :size="14" />
        </button>
      </div>
    </div>

    <div class="flex-1 ia-scroll p-2">
      <p v-if="sessionsError" class="text-[11px] text-[var(--color-red)] px-1 py-2">{{ sessionsError }}</p>
      <p v-else-if="sessionsLoading" class="text-[11px] text-[var(--color-ink-dim)] px-1 py-2 ia-pulse">Reading…</p>
      <p v-else-if="sessions.length === 0" class="text-[11px] text-[var(--color-ink-dim)] px-1 py-2 leading-relaxed">
        No sessions yet. Every conversation is written to the agent's own <code>sessions/</code> folder, so
        it travels with it.
      </p>

      <button
        v-for="session in sessions"
        :key="session.id"
        type="button"
        class="w-full text-left rounded-lg px-2.5 py-2 mb-1 transition-colors"
        :class="
          currentSession === session.id
            ? 'bg-[color-mix(in_srgb,var(--color-phosphor)_12%,transparent)] text-[var(--color-ink)]'
            : 'hover:bg-[color-mix(in_srgb,var(--color-panel-2)_70%,transparent)]'
        "
        @click="pick(session.id)"
      >
        <div class="text-[12px] truncate">{{ session.title || "Untitled" }}</div>
        <div class="text-[10px] text-[var(--color-ink-dim)]">{{ dayLabel(session.updatedAt) }}</div>
      </button>
    </div>
  </div>
</template>
