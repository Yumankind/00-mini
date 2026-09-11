<script setup lang="ts">
/**
 * THE LEFT SIDEBAR — who is answering, what has been said, and every door out of the thread.
 *
 * 260 px on a desk, 56 px as an icon rail when a person wants the width back, and the phone's drawer
 * is this same component over the thread instead of beside it. The choice is remembered
 * (`state/layout.ts`), because a person who narrowed it once meant it.
 *
 * THE FOUR WORKSPACE BUTTONS OPEN THE PANEL ON A TAB rather than replacing the thread: files, Git,
 * the terminal and the preview are things you look at WHILE talking to the agent, and a shell that
 * makes you leave the conversation to see a file is a shell that gets left.
 */
import { computed } from "vue";
import PixelFace from "./PixelFace.vue";
import SessionsList from "./SessionsList.vue";
import TablerIcon from "./TablerIcon.vue";
import { profile } from "../state/agent.js";
import { companionPaired } from "../state/companion.js";
import { busy, startNewSession } from "../state/conversation.js";
import { canInstall, nextTheme, promptInstall, applyTheme, themeChoice } from "../state/install.js";
import { openWorkspace, powerPane, sidebarRail, toggleSidebarRail, workspaceOpen } from "../state/layout.js";
import { lockNow, vaultState } from "../state/vault.js";

const props = withDefaults(defineProps<{ pane: string; drawer?: boolean }>(), { drawer: false });

const emit = defineEmits<{
  (e: "go", pane: "chat" | "settings" | "vault" | "move"): void;
  (e: "picked"): void;
  (e: "palette"): void;
}>();

/** A drawer is never a rail: it has the whole screen's width and no reason to hide its own words. */
const rail = computed(() => sidebarRail.value && !props.drawer);

const WORKSPACE = [
  { id: "files", label: "Files", icon: "folder" },
  { id: "git", label: "Git", icon: "history" },
  { id: "terminal", label: "Terminal", icon: "terminal-2" },
  { id: "preview", label: "Preview", icon: "world" },
] as const;

const DESTINATIONS = [
  { id: "settings", label: "Connections", icon: "plug-connected" },
  { id: "vault", label: "Vault", icon: "lock" },
  { id: "move", label: "Move & backup", icon: "device-laptop" },
] as const;

const themeIcon = computed(() =>
  themeChoice.value === "light" ? "sun" : themeChoice.value === "dark" ? "moon" : "device-desktop",
);

function fresh(): void {
  startNewSession();
  emit("go", "chat");
  emit("picked");
}

function workspace(id: (typeof WORKSPACE)[number]["id"]): void {
  openWorkspace(id);
  emit("go", "chat");
  emit("picked");
}
</script>

<template>
  <div
    class="h-full flex flex-col min-h-0 border-r border-[var(--color-line)]"
    :style="{ background: 'var(--color-panel)' }"
  >
    <!-- Who this is. The face thinks while a run is in flight, which is the only animation here. -->
    <div class="flex items-center gap-2.5 px-3 h-14 shrink-0" :class="rail ? 'justify-center px-0' : ''">
      <PixelFace :size="26" :thinking="busy" self-animate />
      <div v-if="!rail" class="min-w-0 flex-1">
        <div class="text-[13px] font-semibold tracking-tight leading-tight">00 Mini</div>
        <div class="text-[11px] text-[var(--color-ink-faint)] truncate">
          {{ profile?.displayName ?? "Your agent" }}
        </div>
      </div>
      <button
        v-if="!drawer"
        type="button"
        class="ia-btn ia-btn-ghost w-7 h-7 shrink-0"
        :class="rail ? 'hidden' : ''"
        title="Collapse the sidebar"
        @click="toggleSidebarRail()"
      >
        <TablerIcon name="layout-sidebar-left-collapse" :size="15" />
      </button>
    </div>

    <div class="px-2.5 pb-2.5 shrink-0" :class="rail ? 'px-2' : ''">
      <button
        type="button"
        class="ia-btn w-full h-9 text-[13px] gap-2 text-[var(--color-ink)]"
        :title="rail ? 'New thread' : undefined"
        @click="fresh()"
      >
        <TablerIcon name="message-plus" :size="15" />
        <span v-if="!rail">New thread</span>
      </button>
    </div>

    <!-- The threads. On the rail they are hidden entirely: a list of one-word titles cut to 40 px is
         noise, and the palette (⌘K) is the way back to a thread from here. -->
    <div v-if="!rail" class="flex-1 min-h-0">
      <SessionsList @picked="emit('picked')" />
    </div>
    <div v-else class="flex-1 min-h-0 flex flex-col items-center pt-1">
      <button type="button" class="ia-btn ia-btn-ghost w-9 h-9" title="Find a thread (⌘K)" @click="emit('palette')">
        <TablerIcon name="search" :size="16" />
      </button>
    </div>

    <!-- Everywhere else. -->
    <div class="shrink-0 border-t border-[var(--color-line)] p-2 space-y-0.5">
      <div v-if="!rail" class="ia-label px-1.5 pt-1 pb-1.5">Workspace</div>
      <div :class="rail ? 'flex flex-col items-center gap-1' : 'grid grid-cols-2 gap-1'">
        <button
          v-for="item in WORKSPACE"
          :key="item.id"
          type="button"
          class="ia-btn ia-btn-ghost h-9 gap-2 text-[12px]"
          :class="[
            workspaceOpen && powerPane === item.id ? 'ia-btn-on' : '',
            rail ? 'w-9' : 'justify-start px-2',
          ]"
          :title="item.label"
          @click="workspace(item.id)"
        >
          <TablerIcon :name="item.icon" :size="15" />
          <span v-if="!rail" class="truncate">{{ item.label }}</span>
        </button>
      </div>

      <button
        v-for="item in DESTINATIONS"
        :key="item.id"
        type="button"
        class="ia-btn ia-btn-ghost w-full h-9 gap-2 text-[12.5px]"
        :class="[pane === item.id ? 'ia-btn-on' : '', rail ? 'justify-center' : 'justify-start px-2']"
        :title="item.label"
        @click="emit('go', item.id); emit('picked')"
      >
        <TablerIcon :name="item.icon" :size="15" />
        <span v-if="!rail">{{ item.label }}</span>
        <!-- §14: one dot when this computer's 00 is connected. It is on Connections because that is
             where it is turned on and off, and it is a dot because the state is binary. -->
        <span
          v-if="item.id === 'settings' && companionPaired"
          class="w-1.5 h-1.5 rounded-full bg-[var(--color-phosphor)] shrink-0"
          :class="rail ? '' : 'ml-auto'"
          title="00 on this computer is connected"
        />
      </button>

      <div class="flex items-center gap-1 pt-1" :class="rail ? 'flex-col' : ''">
        <button
          type="button"
          class="ia-btn ia-btn-ghost w-9 h-9"
          :title="`Theme: ${themeChoice}`"
          @click="applyTheme(nextTheme(themeChoice))"
        >
          <TablerIcon :name="themeIcon" :size="15" />
        </button>
        <button
          v-if="vaultState.unlocked"
          type="button"
          class="ia-btn ia-btn-ghost w-9 h-9 text-[var(--color-phosphor)]"
          title="Lock the vault now"
          @click="lockNow()"
        >
          <TablerIcon name="lock-open" :size="15" />
        </button>
        <button
          v-if="canInstall"
          type="button"
          class="ia-btn ia-btn-ghost h-9 px-2 text-[11px] gap-1.5"
          title="Install 00 Mini"
          @click="promptInstall()"
        >
          <TablerIcon name="download" :size="15" />
          <span v-if="!rail">Install</span>
        </button>
        <button
          v-if="rail && !drawer"
          type="button"
          class="ia-btn ia-btn-ghost w-9 h-9"
          title="Expand the sidebar"
          @click="toggleSidebarRail()"
        >
          <TablerIcon name="layout-sidebar-left-expand" :size="15" />
        </button>
      </div>
    </div>
  </div>
</template>
