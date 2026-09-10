<script setup lang="ts">
/**
 * The preview pane — a workspace page, rendered.
 *
 * WHY `sandbox="allow-scripts"` AND NOTHING ELSE. The page being rendered was written by the agent,
 * which reads the web; treating it as trusted would hand this app's OPFS, its IndexedDB vault and its
 * DOM to whatever the agent last copied off a site. With `allow-scripts` and WITHOUT
 * `allow-same-origin`, the frame gets an opaque origin: its script runs (a preview where nothing runs
 * is a screenshot, not a preview), and it can reach no storage of ours, no cookie, no parent
 * document. The two flags must never appear together — that combination is documented as equivalent
 * to removing the sandbox, and it would be exactly that here.
 *
 * WHY `srcdoc` RATHER THAN A URL. OPFS has no URL. See `lib/preview-resolve.ts`.
 *
 * THE AGENT DOES NOT DRIVE THIS. There is no `preview` tool this round: the person opens a page from
 * the Files pane. A tool that made a pane appear would be the agent taking the screen, which is a
 * decision §4.3 has not been asked.
 */
import { computed, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { buildPreview, type PreviewBuild } from "../power/preview.js";
import { isPreviewablePath } from "../lib/files-tree.js";
import { agent } from "../state/agent.js";
import { selectedPath } from "../state/files.js";

const build = ref<PreviewBuild | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const path = computed(() => (selectedPath.value && isPreviewablePath(selectedPath.value) ? selectedPath.value : null));

async function render(): Promise<void> {
  const owned = agent.value;
  const target = path.value;
  build.value = null;
  error.value = null;
  if (!owned || !target) return;
  loading.value = true;
  try {
    build.value = await buildPreview(owned.fs, target);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(path, () => void render(), { immediate: true });

/**
 * "Open in a new tab" is a Blob URL, revoked on the next click rather than immediately: a revoked
 * URL that the new tab has not yet fetched opens as a blank page, which looks like a broken button.
 */
let lastUrl: string | null = null;
function openInTab(): void {
  if (!build.value) return;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(new Blob([build.value.html], { type: "text/html" }));
  window.open(lastUrl, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-line)] shrink-0">
      <TablerIcon name="world" :size="13" class="text-[var(--color-ink-dim)] shrink-0" />
      <span class="text-[12px] font-mono truncate">{{ path ?? "no page selected" }}</span>
      <div class="ml-auto flex items-center gap-1 shrink-0">
        <button
          type="button"
          class="ia-btn w-7 h-7 flex items-center justify-center"
          title="Re-render"
          :disabled="!path"
          @click="render()"
        >
          <TablerIcon name="refresh" :size="13" />
        </button>
        <button
          type="button"
          class="ia-btn w-7 h-7 flex items-center justify-center"
          title="Open in a new tab"
          :disabled="!build"
          @click="openInTab()"
        >
          <TablerIcon name="external-link" :size="13" />
        </button>
      </div>
    </div>

    <p
      v-if="build && (build.missing.length || build.external.length)"
      class="px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] border-b border-[var(--color-line)]"
    >
      <template v-if="build.missing.length">Not found: {{ build.missing.join(", ") }}. </template>
      <template v-if="build.external.length">
        Left as written (this preview inlines only files in your workspace): {{ build.external.join(", ") }}.
      </template>
    </p>

    <div class="flex-1 min-h-0 relative">
      <p v-if="!path" class="text-[12px] text-[var(--color-ink-dim)] p-4">
        Pick an <span class="font-mono">.html</span> file in the tree to see it rendered.
      </p>
      <p v-else-if="loading" class="text-[12px] text-[var(--color-ink-dim)] p-4 ia-pulse">Reading the page…</p>
      <p v-else-if="error" class="text-[12px] text-[var(--color-red)] p-4">{{ error }}</p>
      <iframe
        v-else-if="build"
        :srcdoc="build.html"
        sandbox="allow-scripts"
        title="Preview"
        class="w-full h-full border-0 bg-white"
      />
    </div>
  </div>
</template>
