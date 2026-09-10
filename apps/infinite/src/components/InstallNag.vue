<script setup lang="ts">
/**
 * The install nag, ONCE — §3.3.
 *
 * It leads with the reason rather than the ask, because "add to home screen" means nothing and
 * "Safari clears storage for sites you have not opened in seven days" means everything. Dismissing it
 * is remembered; Backup is offered in Settings either way, and needs no permission from anyone.
 */
import TablerIcon from "./TablerIcon.vue";
import { canInstall, dismissNag, installReason, promptInstall, showInstallNag } from "../state/install.js";
</script>

<template>
  <div
    v-if="showInstallNag"
    class="flex items-start gap-2.5 px-3 sm:px-4 py-2.5 border-b border-[var(--color-line)]"
    :style="{ background: 'color-mix(in srgb, var(--color-phosphor) 8%, transparent)' }"
  >
    <TablerIcon name="device-desktop" :size="15" class="mt-0.5 shrink-0 text-[var(--color-phosphor)]" />
    <div class="min-w-0 flex-1">
      <div class="text-[12px] font-medium">Keep this agent</div>
      <div class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
        {{ installReason || "Installed, your agent survives a browser clean-up. Either way, keep a backup file." }}
      </div>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      <button v-if="canInstall" type="button" class="ia-btn ia-btn-primary h-7 px-2.5 text-[11px]" @click="promptInstall()">
        Install
      </button>
      <button type="button" class="ia-btn w-7 h-7 flex items-center justify-center" title="Not now" @click="dismissNag()">
        <TablerIcon name="x" :size="13" />
      </button>
    </div>
  </div>
</template>
