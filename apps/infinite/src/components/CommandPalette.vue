<script setup lang="ts">
/**
 * ⌘K — every door in the app, reachable without finding it.
 *
 * It holds the commands the sidebar holds AND the workspace's files, because the two questions a
 * person asks a palette are "do the thing" and "open that file", and answering only the first is
 * how a palette becomes a menu with extra steps. The matching is `lib/palette.ts` (subsequence, so
 * `idx` finds `index.html`); this is the list, the keys and the actions.
 *
 * Escape closes it, as Escape closes every overlay in this app.
 */
import { computed, nextTick, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { rankItems, stepIndex, type PaletteItem } from "../lib/palette.js";
import { filesUnder } from "../lib/files-tree.js";
import { fileTree, openFile } from "../state/files.js";
import { startNewSession } from "../state/conversation.js";
import { openChip } from "../state/model-choice.js";
import { applyTheme, nextTheme, themeChoice } from "../state/install.js";
import { openWorkspace, setPower, workspaceOpen } from "../state/layout.js";
import { lockNow, vaultState } from "../state/vault.js";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "go", pane: "chat" | "settings" | "vault" | "move"): void;
}>();

const query = ref("");
const cursor = ref(0);
const field = ref<HTMLInputElement | null>(null);

interface Command extends PaletteItem {
  run: () => void;
}

const commands = computed<Command[]>(() => {
  const list: Command[] = [
    {
      id: "new",
      label: "New thread",
      section: "Thread",
      icon: "message-plus",
      run: () => {
        startNewSession();
        emit("go", "chat");
      },
    },
    {
      id: "model",
      label: "Choose the brain that answers",
      section: "Thread",
      icon: "brain",
      run: () => {
        emit("go", "chat");
        void nextTick(() => openChip());
      },
    },
    {
      id: "workspace",
      label: workspaceOpen.value ? "Hide the workspace" : "Show the workspace",
      section: "Workspace",
      icon: "layout-columns",
      run: () => setPower(!workspaceOpen.value),
    },
    { id: "files", label: "Open Files", section: "Workspace", icon: "folder", run: () => openWorkspace("files") },
    { id: "git", label: "Open Git", section: "Workspace", icon: "history", run: () => openWorkspace("git") },
    { id: "terminal", label: "Open the terminal", section: "Workspace", icon: "terminal-2", run: () => openWorkspace("terminal") },
    { id: "preview", label: "Open the preview", section: "Workspace", icon: "world", run: () => openWorkspace("preview") },
    {
      id: "theme",
      label: `Theme: ${themeChoice.value} → ${nextTheme(themeChoice.value)}`,
      section: "App",
      icon: "sun",
      run: () => applyTheme(nextTheme(themeChoice.value)),
    },
    { id: "connections", label: "Connections", section: "App", icon: "plug-connected", run: () => emit("go", "settings") },
    { id: "vault", label: "Vault", section: "App", icon: "lock", run: () => emit("go", "vault") },
    { id: "move", label: "Move & backup", section: "App", icon: "device-laptop", run: () => emit("go", "move") },
  ];
  if (vaultState.value.unlocked) {
    list.push({ id: "lock", label: "Lock the vault now", section: "App", icon: "lock", run: () => void lockNow() });
  }
  return list;
});

/** Files are only worth listing once something has been typed: the whole tree is not a menu. */
const files = computed<Command[]>(() => {
  if (!query.value.trim()) return [];
  return fileTree.value
    .flatMap((node) => filesUnder(node))
    .slice(0, 400)
    .map((path) => ({
      id: `file:${path}`,
      label: path,
      section: "File",
      icon: "file-text",
      run: () => {
        void openFile(path);
        openWorkspace("editor");
        emit("go", "chat");
      },
    }));
});

const results = computed(() => rankItems<Command>([...commands.value, ...files.value], query.value).slice(0, 40));

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    query.value = "";
    cursor.value = 0;
    await nextTick();
    field.value?.focus();
  },
);
watch(results, () => {
  cursor.value = 0;
});

function choose(item: Command | undefined): void {
  if (!item) return;
  emit("close");
  item.run();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
    event.preventDefault();
    cursor.value = stepIndex(cursor.value, 1, results.value.length);
    return;
  }
  if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
    event.preventDefault();
    cursor.value = stepIndex(cursor.value, -1, results.value.length);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    choose(results.value[cursor.value]);
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
    style="background: rgba(0, 0, 0, 0.45)"
    @click.self="emit('close')"
  >
    <div class="ia-float w-full max-w-lg overflow-hidden ia-rise" role="dialog" aria-label="Commands">
      <div class="flex items-center gap-2 px-3.5 h-12 border-b border-[var(--color-line)]">
        <TablerIcon name="search" :size="15" class="text-[var(--color-ink-faint)] shrink-0" />
        <input
          ref="field"
          v-model="query"
          type="text"
          class="flex-1 bg-transparent border-0 outline-none text-[14px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] min-w-0"
          placeholder="Search commands and files…"
          @keydown="onKeydown"
        />
        <kbd class="text-[10px] text-[var(--color-ink-faint)] border border-[var(--color-line)] rounded px-1.5 py-0.5">esc</kbd>
      </div>

      <div class="max-h-[52vh] ia-scroll py-1.5">
        <p v-if="!results.length" class="px-3.5 py-4 text-[12.5px] text-[var(--color-ink-faint)]">
          Nothing matches “{{ query }}”.
        </p>
        <button
          v-for="(item, index) in results"
          :key="item.id"
          type="button"
          class="w-full flex items-center gap-2.5 px-3.5 py-2 text-left transition-colors"
          :class="index === cursor ? 'bg-[var(--color-panel-2)]' : 'hover:bg-[var(--color-panel)]'"
          @mousemove="cursor = index"
          @click="choose(item)"
        >
          <TablerIcon :name="item.icon ?? 'chevron-right'" :size="14" class="shrink-0 text-[var(--color-ink-faint)]" />
          <span class="text-[13px] truncate" :class="item.section === 'File' ? 'font-mono text-[12px]' : ''">
            {{ item.label }}
          </span>
          <span class="ml-auto text-[11px] text-[var(--color-ink-faint)] shrink-0">{{ item.section }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
