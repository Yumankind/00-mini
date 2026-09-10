<script setup lang="ts">
/**
 * The simple shell — §1's "conversation, files, approvals, connections. What the phone shows today."
 *
 * ONE LAYOUT, TWO WIDTHS. The same app is the mobile browser's, so there is no phone build and no
 * desktop build: the sessions list is a left rail above `sm` and a drawer below it, and the tabs are
 * a top row above `sm` and a bottom bar below — where a thumb is. Anything that needed two components
 * to say would drift into two products.
 *
 * The order of screens is the order of §4: boot, then the vault if one exists (asked EVERY entry),
 * then the shell. The approvals modal sits above all three because a run can outlive a pane change.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ApprovalsModal from "./components/ApprovalsModal.vue";
import BootScreen from "./components/BootScreen.vue";
import ConnectionsPane from "./components/ConnectionsPane.vue";
import ConversationPane from "./components/ConversationPane.vue";
import FilesPane from "./components/FilesPane.vue";
import InstallNag from "./components/InstallNag.vue";
import OfflineBanner from "./components/OfflineBanner.vue";
import SessionsList from "./components/SessionsList.vue";
import TablerIcon from "./components/TablerIcon.vue";
import VaultGate from "./components/VaultGate.vue";
import { agent, boot, profile, ready } from "./state/agent.js";
import { refuseAll } from "./state/approvals.js";
import { listen } from "./state/conversation.js";
import { refreshFiles } from "./state/files.js";
import { nextTheme, startInstallWatch, startTheme, applyTheme, themeChoice } from "./state/install.js";
import { startOffline } from "./state/offline.js";
import { lockNow, needsUnlock, refreshVault, startVaultClock, touchVault, vaultState } from "./state/vault.js";

type Pane = "chat" | "files" | "settings";

const pane = ref<Pane>("chat");
const drawer = ref(false);
const teardown: (() => void)[] = [];

const TABS: { id: Pane; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "message-2" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "settings", label: "Connections", icon: "plug-connected" },
];

const themeIcon = computed(() =>
  themeChoice.value === "light" ? "sun" : themeChoice.value === "dark" ? "moon" : "device-desktop",
);

onMounted(async () => {
  startTheme();
  teardown.push(startOffline(), startInstallWatch(), startVaultClock());
  await boot();
  await refreshVault();
  listen();
  // A person's activity is what the idle lock measures, and a pane click is activity.
  const touch = () => touchVault();
  window.addEventListener("pointerdown", touch, { passive: true });
  window.addEventListener("keydown", touch);
  teardown.push(() => {
    window.removeEventListener("pointerdown", touch);
    window.removeEventListener("keydown", touch);
  });
});

onBeforeUnmount(() => {
  // Every waiter gets an answer, or a run holds a promise nobody can resolve.
  refuseAll();
  for (const stop of teardown) stop();
});

watch(pane, (next) => {
  drawer.value = false;
  if (next === "files") void refreshFiles();
});
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <BootScreen v-if="!ready" />

    <VaultGate v-else-if="needsUnlock" />

    <template v-else>
      <header class="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-[var(--color-line)] shrink-0">
        <button
          type="button"
          class="ia-btn w-8 h-8 flex items-center justify-center sm:hidden"
          title="Sessions"
          @click="drawer = !drawer"
        >
          <TablerIcon name="history" :size="15" />
        </button>

        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[15px]">{{ profile?.emoji }}</span>
          <span class="text-[13px] font-medium truncate">{{ profile?.displayName }}</span>
        </div>

        <nav class="hidden sm:flex items-center gap-1 ml-4">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="ia-btn h-8 px-2.5 text-[11px] flex items-center gap-1.5"
            :class="pane === tab.id ? 'ia-btn-primary' : ''"
            @click="pane = tab.id"
          >
            <TablerIcon :name="tab.icon" :size="14" />
            {{ tab.label }}
          </button>
        </nav>

        <div class="ml-auto flex items-center gap-1">
          <button
            v-if="vaultState.unlocked"
            type="button"
            class="ia-btn w-8 h-8 flex items-center justify-center"
            title="Lock now"
            @click="lockNow()"
          >
            <TablerIcon name="lock-open" :size="15" class="text-[var(--color-phosphor)]" />
          </button>
          <button
            type="button"
            class="ia-btn w-8 h-8 flex items-center justify-center"
            :title="`Theme: ${themeChoice}`"
            @click="applyTheme(nextTheme(themeChoice))"
          >
            <TablerIcon :name="themeIcon" :size="15" />
          </button>
        </div>
      </header>

      <OfflineBanner />
      <InstallNag />

      <div class="flex-1 flex min-h-0">
        <aside class="hidden sm:flex w-56 shrink-0 border-r border-[var(--color-line)]">
          <SessionsList class="w-full" />
        </aside>

        <!-- The phone's drawer: the same component, over the pane instead of beside it. -->
        <div v-if="drawer" class="fixed inset-0 z-40 sm:hidden flex">
          <div class="w-64 h-full bg-[var(--color-void)] border-r border-[var(--color-line)]">
            <SessionsList @picked="drawer = false" />
          </div>
          <button type="button" class="flex-1 h-full" style="background: rgba(0, 0, 0, 0.5)" @click="drawer = false" />
        </div>

        <main class="flex-1 min-w-0 min-h-0">
          <ConversationPane v-if="pane === 'chat'" />
          <FilesPane v-else-if="pane === 'files'" />
          <ConnectionsPane v-else />
        </main>
      </div>

      <nav
        class="sm:hidden flex items-stretch border-t border-[var(--color-line)] shrink-0"
        style="padding-bottom: env(safe-area-inset-bottom)"
      >
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px]"
          :class="pane === tab.id ? 'text-[var(--color-phosphor)]' : 'text-[var(--color-ink-dim)]'"
          @click="pane = tab.id"
        >
          <TablerIcon :name="tab.icon" :size="18" />
          {{ tab.label }}
        </button>
      </nav>
    </template>

    <ApprovalsModal />
  </div>
</template>
