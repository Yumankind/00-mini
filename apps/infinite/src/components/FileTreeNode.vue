<script setup lang="ts">
/** One row of the tree, recursive. Split out because a component cannot render itself inline. */
import TablerIcon from "./TablerIcon.vue";
import type { TreeNode } from "../lib/files-tree.js";
import { formatSize } from "../lib/files-tree.js";
import { openFile, openFolders, selectedPath, toggleFolder } from "../state/files.js";

defineProps<{ node: TreeNode; depth: number }>();
</script>

<template>
  <div>
    <button
      type="button"
      class="w-full flex items-center gap-1.5 px-2 py-1 text-left rounded-md hover:bg-[color-mix(in_srgb,var(--color-panel-2)_70%,transparent)]"
      :class="selectedPath === node.path ? 'bg-[color-mix(in_srgb,var(--color-phosphor)_12%,transparent)]' : ''"
      :style="{ paddingLeft: `${8 + depth * 12}px` }"
      @click="node.kind === 'dir' ? toggleFolder(node.path) : openFile(node.path)"
    >
      <TablerIcon
        v-if="node.kind === 'dir'"
        :name="openFolders.has(node.path) ? 'chevron-down' : 'chevron-right'"
        :size="12"
        class="text-[var(--color-ink-dim)] shrink-0"
      />
      <TablerIcon
        :name="node.kind === 'dir' ? (openFolders.has(node.path) ? 'folder-open' : 'folder') : 'file'"
        :size="13"
        class="shrink-0"
        :class="node.kind === 'dir' ? 'text-[var(--color-phosphor-dim)]' : 'text-[var(--color-ink-dim)]'"
      />
      <span class="text-[12px] truncate">{{ node.name }}</span>
      <span class="ml-auto text-[10px] text-[var(--color-ink-dim)] shrink-0 pl-2">{{ formatSize(node.size) }}</span>
    </button>
    <template v-if="node.kind === 'dir' && openFolders.has(node.path)">
      <FileTreeNode v-for="child in node.children ?? []" :key="child.path" :node="child" :depth="depth + 1" />
    </template>
  </div>
</template>
