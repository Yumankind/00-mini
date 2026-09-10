<script setup lang="ts">
/**
 * The Files pane: the agent's own folder, as a tree, with a read-only viewer.
 *
 * The tree is recursive markup rather than a flattened list because the indent IS the information —
 * `workspace/projects/<name>/` is a rule of the platform, and a flat list hides it. The viewer is
 * read-only on purpose (see state/files.ts for why).
 */
import { onMounted } from "vue";
import TablerIcon from "./TablerIcon.vue";
import FileTreeNode from "./FileTreeNode.vue";
import { closeFile, fileText, fileTree, filesError, filesLoading, refreshFiles, selectedPath } from "../state/files.js";
</script>

<template>
  <div class="h-full flex min-h-0">
    <div class="w-full sm:w-72 shrink-0 flex flex-col min-h-0 border-r border-[var(--color-line)]" :class="selectedPath ? 'hidden sm:flex' : 'flex'">
      <div class="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-line)]">
        <span class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">Files</span>
        <button type="button" class="ia-btn w-7 h-7 flex items-center justify-center" title="Reload" @click="refreshFiles()">
          <TablerIcon name="refresh" :size="14" />
        </button>
      </div>
      <div class="flex-1 ia-scroll py-1.5">
        <p v-if="filesLoading" class="text-[11px] text-[var(--color-ink-dim)] px-3 py-2 ia-pulse">Walking the folder…</p>
        <p v-else-if="filesError" class="text-[11px] text-[var(--color-red)] px-3 py-2">{{ filesError }}</p>
        <FileTreeNode v-for="node in fileTree" :key="node.path" :node="node" :depth="0" />
      </div>
    </div>

    <div class="flex-1 flex flex-col min-h-0" :class="selectedPath ? 'flex' : 'hidden sm:flex'">
      <div v-if="selectedPath" class="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--color-line)]">
        <button type="button" class="ia-btn w-7 h-7 flex items-center justify-center sm:hidden" @click="closeFile()">
          <TablerIcon name="arrow-left" :size="14" />
        </button>
        <TablerIcon name="file-text" :size="14" class="text-[var(--color-ink-dim)] shrink-0" />
        <span class="text-[12px] font-mono truncate">{{ selectedPath }}</span>
        <span class="ml-auto text-[10px] text-[var(--color-ink-dim)] shrink-0">read-only</span>
      </div>
      <div class="flex-1 ia-scroll">
        <pre
          v-if="fileText !== null"
          class="text-[12px] font-mono leading-relaxed p-4 whitespace-pre-wrap break-words"
          >{{ fileText }}</pre
        >
        <p v-else-if="selectedPath && filesError" class="text-[12px] text-[var(--color-ink-dim)] p-4">{{ filesError }}</p>
        <p v-else class="text-[12px] text-[var(--color-ink-dim)] p-4">Pick a file.</p>
      </div>
    </div>
  </div>
</template>
