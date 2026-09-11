<script setup lang="ts">
/**
 * The editor — a textarea with a gutter, and the three rules that make one usable (see
 * `power/editor.ts` for why it is a textarea at all).
 *
 * THE `v-html` IS DELIBERATE AND IT IS SAFE HERE. `renderMarkdown` escapes every character of input
 * before it adds a single tag and only ever emits attributes it built itself, so the string handed
 * to `v-html` cannot contain markup that came from the file. That is the whole reason the renderer
 * is ours: a dependency would be a promise about somebody else's escaping. Untrusted HTML that is
 * meant to RUN goes to PreviewPane instead, inside a sandboxed iframe — never here.
 */
import { computed, ref, watch } from "vue";
import MarkdownBlock from "./MarkdownBlock.vue";
import TablerIcon from "./TablerIcon.vue";
import { indent } from "../power/editor.js";
import { gutter } from "../power/editor.js";
import {
  closeFile,
  editorDirty,
  editorEditable,
  editorMarkdown,
  editorPreviewing,
  editorSaving,
  editorStale,
  editorText,
  fileText,
  filesError,
  reloadFromDisk,
  openFile,
  saveOpenFile,
  selectedPath,
  setEditorText,
  toggleMarkdownPreview,
} from "../state/files.js";
import { baseName, isPreviewablePath } from "../lib/files-tree.js";
import { showCentre } from "../state/layout.js";

const area = ref<HTMLTextAreaElement | null>(null);
const numbers = computed(() => gutter(editorText.value));
const savedFlash = ref(false);

/**
 * THE TAB STRIP. `state/files.ts` owns ONE open file, which is the right model for the store — a
 * second open file is not a second edit, it is a second thing to look at. So the strip is the
 * editor's own memory of what has been looked at in this session: six paths, newest last, and
 * clicking one re-opens it through the same `openFile` the tree calls. Nothing new is persisted.
 */
const MAX_TABS = 6;
const tabs = ref<string[]>([]);

watch(
  selectedPath,
  (path) => {
    savedFlash.value = false;
    if (!path) return;
    tabs.value = [...tabs.value.filter((p) => p !== path), path].slice(-MAX_TABS);
  },
  // IMMEDIATE, because this pane is mounted BY a file being opened: the workspace panel switches to
  // the Editor tab when the tree opens something, so the first path is already set by the time the
  // watcher exists and a lazy watch would show a strip with nothing in it.
  { immediate: true },
);

function closeTab(path: string): void {
  const rest = tabs.value.filter((p) => p !== path);
  tabs.value = rest;
  if (selectedPath.value !== path) return;
  const next = rest[rest.length - 1];
  if (next) void openFile(next);
  else closeFile();
}

async function save(force = false): Promise<void> {
  const done = await saveOpenFile(force);
  if (!done) return;
  savedFlash.value = true;
  window.setTimeout(() => {
    savedFlash.value = false;
  }, 1200);
}

function onKeydown(event: KeyboardEvent): void {
  const el = area.value;
  if (!el) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save(editorStale.value);
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const next = indent(
      { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd },
      event.shiftKey,
    );
    setEditorText(next.value);
    // The DOM has to be told where the caret went, and it has to be told after Vue writes the value.
    window.requestAnimationFrame(() => {
      el.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }
}

function onScroll(): void {
  const el = area.value;
  const rail = el?.previousElementSibling as HTMLElement | null;
  if (el && rail) rail.scrollTop = el.scrollTop;
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div v-if="!selectedPath" class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <TablerIcon name="file-text" :size="22" class="text-[var(--color-ink-faint)]" />
      <p class="text-[13px] text-[var(--color-ink-dim)]">No file open</p>
      <p class="text-[12px] text-[var(--color-ink-faint)] max-w-[16rem] leading-relaxed">
        Pick one in Files, or ask 00 Mini to write one.
      </p>
    </div>

    <template v-else>
      <!-- The tab strip: what has been opened in this session, current one lit. -->
      <div class="flex items-stretch border-b border-[var(--color-line)] shrink-0 overflow-x-auto" :style="{ background: 'var(--color-panel)' }">
        <div
          v-for="path in tabs"
          :key="path"
          class="group flex items-center gap-1.5 pl-3 pr-2 h-9 border-r border-[var(--color-line)] shrink-0 cursor-pointer transition-colors"
          :class="
            path === selectedPath
              ? 'text-[var(--color-ink)]'
              : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]'
          "
          :style="path === selectedPath ? { background: 'var(--color-void)' } : undefined"
          :title="path"
          @click="openFile(path)"
        >
          <span class="text-[12px] font-mono max-w-[12rem] truncate">{{ baseName(path) }}</span>
          <span
            v-if="path === selectedPath && editorDirty"
            class="w-1.5 h-1.5 rounded-full bg-[var(--color-amber)] shrink-0"
            title="Unsaved"
          />
          <button
            type="button"
            class="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-70 hover:!opacity-100 shrink-0"
            title="Close"
            @click.stop="closeTab(path)"
          >
            <TablerIcon name="x" :size="11" />
          </button>
        </div>
      </div>

      <div class="flex items-center gap-2 px-3 h-9 border-b border-[var(--color-line)] shrink-0">
        <span class="text-[11px] font-mono text-[var(--color-ink-faint)] truncate">{{ selectedPath }}</span>
        <span v-if="savedFlash" class="text-[11px] text-[var(--color-phosphor)] shrink-0">saved</span>
        <span v-else-if="!editorEditable" class="text-[11px] text-[var(--color-ink-faint)] shrink-0">read-only</span>

        <div class="ml-auto flex items-center gap-1 shrink-0">
          <button
            v-if="editorMarkdown"
            type="button"
            class="ia-btn ia-btn-ghost h-7 px-2 text-[11px] gap-1"
            :class="editorPreviewing ? 'ia-btn-on' : ''"
            title="Rendered markdown"
            @click="toggleMarkdownPreview()"
          >
            <TablerIcon name="world" :size="12" />
            Rendered
          </button>
          <button
            v-if="selectedPath && isPreviewablePath(selectedPath)"
            type="button"
            class="ia-btn ia-btn-ghost h-7 px-2 text-[11px] gap-1"
            title="Open in the preview pane"
            @click="showCentre('preview')"
          >
            <TablerIcon name="world" :size="12" />
            Preview
          </button>
          <button
            v-if="editorEditable"
            type="button"
            class="ia-btn h-7 px-2.5 text-[11px] gap-1"
            :class="editorDirty ? 'ia-btn-primary' : ''"
            :disabled="!editorDirty || editorSaving"
            title="Save (⌘S)"
            @click="save(editorStale)"
          >
            <TablerIcon name="device-floppy" :size="12" />
            Save
          </button>
        </div>
      </div>

      <div
        v-if="editorStale"
        class="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-[var(--color-line)]"
        style="background: color-mix(in srgb, var(--color-amber) 12%, transparent)"
      >
        <TablerIcon name="alert-triangle" :size="13" class="text-[var(--color-amber)] shrink-0" />
        <span class="text-[var(--color-amber)]">Your agent changed this file.</span>
        <button type="button" class="ia-btn h-6 px-2 text-[10px] ml-auto shrink-0" @click="reloadFromDisk()">
          Reload from disk
        </button>
      </div>

      <p v-if="filesError" class="px-3 py-1.5 text-[11px] text-[var(--color-red)] border-b border-[var(--color-line)]">
        {{ filesError }}
      </p>

      <!-- Rendered markdown, through the same component the thread uses: one look, one escaping
           rule, one copy button. -->
      <div v-if="editorPreviewing" class="flex-1 ia-scroll p-5">
        <MarkdownBlock class="max-w-[44rem] mx-auto" :text="editorText" small />
      </div>

      <!-- The editor proper: gutter and textarea share one scroll position. -->
      <div v-else-if="editorEditable" class="flex-1 flex min-h-0">
        <pre
          class="shrink-0 overflow-hidden text-right select-none px-2 py-3 font-mono text-[12px] leading-[1.55] text-[var(--color-ink-dim)] border-r border-[var(--color-line)]"
          style="background: color-mix(in srgb, var(--color-panel-2) 30%, transparent)"
          >{{ numbers }}</pre
        >
        <textarea
          ref="area"
          :value="editorText"
          class="flex-1 min-w-0 resize-none bg-transparent border-0 outline-none px-3 py-3 font-mono text-[12px] leading-[1.55] text-[var(--color-ink)] ia-scroll"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          @input="setEditorText(($event.target as HTMLTextAreaElement).value)"
          @keydown="onKeydown"
          @scroll="onScroll"
        />
      </div>

      <!-- Too big, or not text: the viewer, which says so rather than pretending to edit. -->
      <div v-else class="flex-1 ia-scroll">
        <pre v-if="fileText !== null" class="text-[12px] font-mono leading-relaxed p-4 whitespace-pre-wrap break-words">{{ fileText }}</pre>
        <p v-else class="text-[12px] text-[var(--color-ink-dim)] p-4">Nothing this pane can render.</p>
      </div>
    </template>
  </div>
</template>
