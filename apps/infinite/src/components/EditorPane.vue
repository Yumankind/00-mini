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
import TablerIcon from "./TablerIcon.vue";
import { renderMarkdown } from "../lib/markdown-lite.js";
import { indent } from "../power/editor.js";
import { gutter } from "../power/editor.js";
import {
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
  saveOpenFile,
  selectedPath,
  setEditorText,
  toggleMarkdownPreview,
} from "../state/files.js";
import { isPreviewablePath } from "../lib/files-tree.js";
import { showCentre } from "../state/layout.js";

const area = ref<HTMLTextAreaElement | null>(null);
const numbers = computed(() => gutter(editorText.value));
const rendered = computed(() => renderMarkdown(editorText.value));
const savedFlash = ref(false);

watch(selectedPath, () => {
  savedFlash.value = false;
});

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
    <div v-if="!selectedPath" class="flex-1 flex items-center justify-center">
      <p class="text-[12px] text-[var(--color-ink-dim)]">Pick a file in the tree.</p>
    </div>

    <template v-else>
      <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-line)] shrink-0">
        <TablerIcon name="file-text" :size="13" class="text-[var(--color-ink-dim)] shrink-0" />
        <span class="text-[12px] font-mono truncate">{{ selectedPath }}</span>
        <span v-if="editorDirty" class="text-[10px] text-[var(--color-amber)] shrink-0">● unsaved</span>
        <span v-else-if="savedFlash" class="text-[10px] text-[var(--color-phosphor)] shrink-0">saved</span>
        <span v-else-if="!editorEditable" class="text-[10px] text-[var(--color-ink-dim)] shrink-0">read-only</span>

        <div class="ml-auto flex items-center gap-1 shrink-0">
          <button
            v-if="editorMarkdown"
            type="button"
            class="ia-btn h-7 px-2 text-[10px] flex items-center gap-1"
            :class="editorPreviewing ? 'ia-btn-primary' : ''"
            title="Rendered markdown"
            @click="toggleMarkdownPreview()"
          >
            <TablerIcon name="world" :size="12" />
            Rendered
          </button>
          <button
            v-if="selectedPath && isPreviewablePath(selectedPath)"
            type="button"
            class="ia-btn h-7 px-2 text-[10px] flex items-center gap-1"
            title="Open in the preview pane"
            @click="showCentre('preview')"
          >
            <TablerIcon name="world" :size="12" />
            Preview
          </button>
          <button
            v-if="editorEditable"
            type="button"
            class="ia-btn h-7 px-2 text-[10px] flex items-center gap-1"
            :class="editorDirty ? 'ia-btn-primary' : ''"
            :disabled="!editorDirty || editorSaving"
            title="Save (⌘S)"
            @click="save(editorStale)"
          >
            <TablerIcon name="check" :size="12" />
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

      <!-- Rendered markdown. -->
      <div v-if="editorPreviewing" class="flex-1 ia-scroll p-4 md-body text-[13px]" v-html="rendered" />

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

<style scoped>
/* The rendered-markdown body. Scoped so nothing here leaks into the shell's own type. */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3) {
  font-weight: 600;
  margin: 1.2em 0 0.5em;
  line-height: 1.25;
}
.md-body :deep(h1) {
  font-size: 1.5em;
}
.md-body :deep(h2) {
  font-size: 1.25em;
}
.md-body :deep(h3) {
  font-size: 1.08em;
}
.md-body :deep(p),
.md-body :deep(ul),
.md-body :deep(ol),
.md-body :deep(blockquote),
.md-body :deep(table) {
  margin: 0.7em 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  padding-left: 1.4em;
}
.md-body :deep(ul) {
  list-style: disc;
}
.md-body :deep(ol) {
  list-style: decimal;
}
.md-body :deep(a) {
  color: var(--color-cyan);
  text-decoration: underline;
}
.md-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: color-mix(in srgb, var(--color-panel-2) 70%, transparent);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.md-body :deep(pre.md-code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: color-mix(in srgb, var(--color-panel-2) 60%, transparent);
  border: 1px solid var(--color-line);
  border-radius: 10px;
  padding: 0.8em 1em;
  overflow-x: auto;
}
.md-body :deep(pre.md-code code) {
  background: none;
  padding: 0;
}
.md-body :deep(blockquote) {
  border-left: 2px solid var(--color-line);
  padding-left: 0.9em;
  color: var(--color-ink-dim);
}
.md-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--color-line);
  margin: 1.4em 0;
}
.md-body :deep(table) {
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--color-line);
  padding: 0.35em 0.7em;
  text-align: left;
}
.md-body :deep(img) {
  max-width: 100%;
}
</style>
