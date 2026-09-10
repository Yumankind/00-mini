<script setup lang="ts">
/**
 * The Files pane: the agent's own folder, as a tree, with a file manager on top of it.
 *
 * The tree is recursive markup rather than a flattened list because the indent IS the information —
 * `workspace/projects/<name>/` is a rule of the platform, and a flat list hides it.
 *
 * WHY THE PROMPTS ARE INLINE ROWS AND NOT `window.prompt`. A modal prompt cannot say what is wrong
 * with the name while it is being typed, cannot be styled, and on an installed PWA on iOS it is a
 * system sheet that takes the whole screen for one field. The row below the toolbar does all three.
 * Deleting is the one thing that asks twice, in the same row, because it is the one thing that
 * cannot be undone from here.
 *
 * `treeOnly` is what the IDE layout passes: the same component, without the viewer half, because the
 * centre pane owns that there (state/layout.ts).
 */
import { computed, onMounted, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import FileTreeNode from "./FileTreeNode.vue";
import EditorPane from "./EditorPane.vue";
import { baseName, isPreviewablePath } from "../lib/files-tree.js";
import {
  activeDir,
  closeFile,
  createFile,
  createFolder,
  deletePath,
  fileTree,
  filesError,
  filesLoading,
  focusedPath,
  readBytes,
  refreshFiles,
  renamePath,
  selectedPath,
  uploadInto,
} from "../state/files.js";
import { showCentre } from "../state/layout.js";

withDefaults(defineProps<{ treeOnly?: boolean }>(), { treeOnly: false });

type Prompting = "file" | "folder" | "rename" | "delete" | null;

const prompting = ref<Prompting>(null);
const draftName = ref("");
const dropping = ref(false);
const uploader = ref<HTMLInputElement | null>(null);

const here = computed(() => activeDir.value);
const target = computed(() => focusedPath.value);

// The simple shell walks the folder when its Files tab is picked; in the IDE layout the pane is just
// THERE from the first paint, so it asks for its own walk. `refreshFiles` is idempotent enough that
// doing both is one extra pass and never a wrong tree.
onMounted(() => void refreshFiles());

function ask(kind: Exclude<Prompting, null>): void {
  prompting.value = kind;
  draftName.value = kind === "rename" ? baseName(target.value) : "";
}

async function confirmPrompt(): Promise<void> {
  const kind = prompting.value;
  const name = draftName.value;
  if (!kind) return;
  if (kind === "file") await createFile(here.value, name);
  else if (kind === "folder") await createFolder(here.value, name);
  else if (kind === "rename") await renamePath(target.value, name);
  else if (kind === "delete") await deletePath(target.value);
  prompting.value = null;
  draftName.value = "";
}

async function onFiles(list: FileList | null): Promise<void> {
  if (!list?.length) return;
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const file of Array.from(list)) files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  await uploadInto(here.value, files);
  if (uploader.value) uploader.value.value = "";
}

async function onDrop(event: DragEvent): Promise<void> {
  dropping.value = false;
  await onFiles(event.dataTransfer?.files ?? null);
}

/**
 * Download is a Blob and an anchor click — there is no other way to hand a browser's own storage
 * back to the person, and the alternative (a service-worker URL) would be a second door into OPFS.
 */
async function download(): Promise<void> {
  const path = target.value;
  const bytes = await readBytes(path);
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = baseName(path);
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="h-full flex min-h-0">
    <div
      class="flex flex-col min-h-0 border-r border-[var(--color-line)]"
      :class="[treeOnly ? 'w-full' : selectedPath ? 'hidden sm:flex w-full sm:w-72 shrink-0' : 'flex w-full sm:w-72 shrink-0']"
    >
      <div class="flex items-center justify-between px-3 py-2 border-b border-[var(--color-line)] shrink-0">
        <span class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">Files</span>
        <div class="flex items-center gap-0.5">
          <button type="button" class="ia-btn w-6 h-6 flex items-center justify-center" title="New file" @click="ask('file')">
            <TablerIcon name="plus" :size="12" />
          </button>
          <button type="button" class="ia-btn w-6 h-6 flex items-center justify-center" title="New folder" @click="ask('folder')">
            <TablerIcon name="folder" :size="12" />
          </button>
          <button
            type="button"
            class="ia-btn w-6 h-6 flex items-center justify-center"
            title="Rename"
            :disabled="target === 'workspace'"
            @click="ask('rename')"
          >
            <TablerIcon name="tools" :size="12" />
          </button>
          <button
            type="button"
            class="ia-btn w-6 h-6 flex items-center justify-center"
            title="Delete"
            :disabled="target === 'workspace'"
            @click="ask('delete')"
          >
            <TablerIcon name="trash" :size="12" />
          </button>
          <button type="button" class="ia-btn w-6 h-6 flex items-center justify-center" title="Upload" @click="uploader?.click()">
            <TablerIcon name="upload" :size="12" />
          </button>
          <button
            type="button"
            class="ia-btn w-6 h-6 flex items-center justify-center"
            title="Download"
            :disabled="!selectedPath"
            @click="download()"
          >
            <TablerIcon name="download" :size="12" />
          </button>
          <button type="button" class="ia-btn w-6 h-6 flex items-center justify-center" title="Reload" @click="refreshFiles()">
            <TablerIcon name="refresh" :size="12" />
          </button>
        </div>
      </div>

      <input ref="uploader" type="file" multiple class="hidden" @change="onFiles(($event.target as HTMLInputElement).files)" />

      <div v-if="prompting" class="px-3 py-2 border-b border-[var(--color-line)] shrink-0">
        <p v-if="prompting === 'delete'" class="text-[11px] text-[var(--color-red)] mb-1.5">
          Delete <span class="font-mono">{{ target }}</span> and everything under it? This cannot be undone from here.
        </p>
        <p v-else class="text-[10px] text-[var(--color-ink-dim)] mb-1.5">
          {{ prompting === "rename" ? "Rename" : `New ${prompting} in` }}
          <span class="font-mono">{{ prompting === "rename" ? target : here }}</span>
        </p>
        <form class="flex items-center gap-1.5" @submit.prevent="confirmPrompt()">
          <input
            v-if="prompting !== 'delete'"
            v-model="draftName"
            class="ia-input h-7 py-0 text-[11px] font-mono"
            autofocus
            placeholder="name"
          />
          <button
            type="submit"
            class="ia-btn h-7 px-2.5 text-[11px] shrink-0"
            :class="prompting === 'delete' ? 'ia-btn-danger' : 'ia-btn-primary'"
          >
            {{ prompting === "delete" ? "Delete" : "OK" }}
          </button>
          <button type="button" class="ia-btn h-7 px-2.5 text-[11px] shrink-0" @click="prompting = null">Cancel</button>
        </form>
      </div>

      <div
        class="flex-1 ia-scroll py-1.5"
        :class="dropping ? 'bg-[color-mix(in_srgb,var(--color-phosphor)_10%,transparent)]' : ''"
        @dragover.prevent="dropping = true"
        @dragleave="dropping = false"
        @drop.prevent="onDrop"
      >
        <p v-if="filesLoading" class="text-[11px] text-[var(--color-ink-dim)] px-3 py-2 ia-pulse">Walking the folder…</p>
        <p v-else-if="filesError" class="text-[11px] text-[var(--color-red)] px-3 py-2">{{ filesError }}</p>
        <FileTreeNode v-for="node in fileTree" :key="node.path" :node="node" :depth="0" />
        <p v-if="dropping" class="text-[11px] text-[var(--color-phosphor)] px-3 py-2">Drop into {{ here }}</p>
      </div>
    </div>

    <!-- The simple shell keeps the viewer beside the tree; the IDE layout owns the centre itself. -->
    <div v-if="!treeOnly" class="flex-1 flex flex-col min-h-0" :class="selectedPath ? 'flex' : 'hidden sm:flex'">
      <div v-if="selectedPath" class="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-line)] sm:hidden">
        <button type="button" class="ia-btn w-7 h-7 flex items-center justify-center" @click="closeFile()">
          <TablerIcon name="arrow-left" :size="14" />
        </button>
        <span class="text-[12px] font-mono truncate">{{ selectedPath }}</span>
        <button
          v-if="isPreviewablePath(selectedPath)"
          type="button"
          class="ia-btn h-7 px-2 text-[10px] ml-auto shrink-0"
          @click="showCentre('preview')"
        >
          Preview
        </button>
      </div>
      <EditorPane class="flex-1 min-h-0" />
    </div>
  </div>
</template>
