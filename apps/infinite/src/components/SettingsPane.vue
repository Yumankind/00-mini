<script setup lang="ts">
/**
 * SETTINGS — one door for everything that is not the conversation (Bruno, 2026-09-11: "move
 * Connections, Vault and Move & backup under a settings icon; from settings we should be able to
 * go back to the chat/workspace easily").
 *
 * The four screens keep their own components and their own state; this pane only puts a tab row
 * above them and a way back beside it. "Back to chat" is the FIRST control, on every tab, on every
 * width — a settings screen a person cannot leave in one press is a trap, and the phone has no
 * sidebar to fall back on.
 */
import TablerIcon from "./TablerIcon.vue";
import BackupPanel from "./BackupPanel.vue";
import ConnectionsPane from "./ConnectionsPane.vue";
import MovePanel from "./MovePanel.vue";
import VaultPanel from "./VaultPanel.vue";
import WebsitePanel from "./WebsitePanel.vue";

export type SettingsTab = "connections" | "vault" | "move" | "website";

const props = defineProps<{ tab: SettingsTab }>();
const emit = defineEmits<{ (e: "update:tab", tab: SettingsTab): void; (e: "close"): void }>();

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "connections", label: "Connections", icon: "plug-connected" },
  { id: "vault", label: "Vault", icon: "lock" },
  { id: "move", label: "Move & backup", icon: "device-laptop" },
  { id: "website", label: "Your website", icon: "world" },
];

function go(tab: SettingsTab): void {
  if (tab !== props.tab) emit("update:tab", tab);
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div
      class="shrink-0 flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-[var(--color-line)] overflow-x-auto ia-scroll"
      :style="{ background: 'var(--color-card)' }"
    >
      <button type="button" class="ia-btn ia-btn-ghost h-8 px-2 gap-1.5 text-[12.5px] shrink-0" title="Back to the chat" @click="emit('close')">
        <TablerIcon name="arrow-left" :size="15" />
        <span>Back to chat</span>
      </button>
      <span class="w-px h-5 bg-[var(--color-line)] shrink-0 mx-1" aria-hidden="true" />
      <nav class="flex items-center gap-1" aria-label="Settings sections">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="ia-btn ia-btn-ghost h-8 px-2.5 gap-1.5 text-[12.5px] shrink-0"
          :class="tab === t.id ? 'ia-btn-on' : ''"
          :aria-current="tab === t.id ? 'page' : undefined"
          @click="go(t.id)"
        >
          <TablerIcon :name="t.icon" :size="14" />
          <span>{{ t.label }}</span>
        </button>
      </nav>
    </div>

    <div class="flex-1 min-h-0">
      <ConnectionsPane v-if="tab === 'connections'" @move="go('move')" @website="go('website')" />
      <MovePanel v-else-if="tab === 'move'" @close="go('connections')" />
      <WebsitePanel v-else-if="tab === 'website'" @close="go('connections')" />
      <div v-else class="h-full ia-scroll">
        <div class="max-w-lg mx-auto px-4 py-6 space-y-6">
          <VaultPanel />
          <BackupPanel />
        </div>
      </div>
    </div>
  </div>
</template>
