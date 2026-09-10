<script setup lang="ts">
/**
 * Connections and Settings, one pane — §6.1 as cards, §4.5's vault, §3.3's storage and backup.
 *
 * The last block is the honesty block: whatever is standing in for a real implementation is named
 * here, from the same list the runtime bootstrap fills. An empty list is the good case and is shown as
 * such, because a person cannot tell the difference between "nothing is stubbed" and "the app forgot
 * to say".
 */
import BackupPanel from "./BackupPanel.vue";
import BrainCards from "./BrainCards.vue";
import TablerIcon from "./TablerIcon.vue";
import VaultPanel from "./VaultPanel.vue";
import { profile, stubs } from "../state/agent.js";
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-5 space-y-6">
      <div class="flex items-center gap-3">
        <div class="text-2xl">{{ profile?.emoji ?? "🟢" }}</div>
        <div class="min-w-0">
          <div class="text-[14px] font-semibold truncate">{{ profile?.displayName ?? "Your agent" }}</div>
          <div class="text-[11px] text-[var(--color-ink-dim)] font-mono truncate">{{ profile?.id }}</div>
        </div>
      </div>

      <BrainCards />
      <VaultPanel />
      <BackupPanel />

      <section>
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">What is real</h2>
        <div class="panel px-3 py-3">
          <div v-if="stubs.length === 0" class="flex items-center gap-2 text-[11px] text-[var(--color-phosphor)]">
            <TablerIcon name="circle-check" :size="14" />
            Everything on this screen is the real implementation.
          </div>
          <ul v-else class="space-y-1.5">
            <li v-for="stub in stubs" :key="stub" class="flex items-start gap-2 text-[11px] text-[var(--color-amber)]">
              <TablerIcon name="alert-triangle" :size="13" class="mt-0.5 shrink-0" />
              <span class="leading-relaxed">{{ stub }}</span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>
