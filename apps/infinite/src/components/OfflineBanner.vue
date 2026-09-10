<script setup lang="ts">
/**
 * §4.4's header line, and the one sentence under it that says what still works.
 *
 * It appears only when offline, and it does not offer a retry: `navigator.onLine` flips on its own,
 * and a button that pretends to reconnect the network is a lie in a banner.
 */
import { offlineCapabilities } from "../lib/offline.js";
import TablerIcon from "./TablerIcon.vue";
import { netHeadline, online } from "../state/offline.js";
</script>

<template>
  <div
    v-if="!online"
    class="flex items-start gap-2 px-3 sm:px-4 py-2 text-[11px] border-b border-[var(--color-line)]"
    :style="{ background: 'color-mix(in srgb, var(--color-amber) 10%, transparent)' }"
  >
    <TablerIcon name="wifi-off" :size="14" class="mt-0.5 shrink-0 text-[var(--color-amber)]" />
    <div class="min-w-0">
      <div class="text-[var(--color-amber)] font-medium">{{ netHeadline }}</div>
      <div class="text-[var(--color-ink-dim)] leading-relaxed">{{ offlineCapabilities() }}</div>
    </div>
  </div>
</template>
