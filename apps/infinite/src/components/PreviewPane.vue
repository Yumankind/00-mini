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
 * AND A SERVED PORT GOES THROUGH THE SAME DOOR, FOR A REASON THAT WAS MEASURED. When a script calls
 * `server.listen(3000)` or `serve ./public` puts a folder on a port, the page can be fetched at
 * `/~/3000/` — but it may not be POINTED AT there. In Chrome 152, against this app's own production
 * build, a frame with `sandbox="allow-scripts allow-forms"` and no `allow-same-origin` is opaque and
 * its navigation never reaches the service worker at all (the page bridge saw zero requests for it);
 * the same frame WITHOUT the sandbox was served, reported this app's origin, and could read
 * `localStorage` and OPFS. Opaque and unserved, or served and holding the vault: those are the two a
 * browser offers on one origin, and neither is a preview.
 *
 * So this pane fetches the served page ITSELF — the app's own tab is controlled, so `/~/3000/…`
 * answers there — inlines its assets with the very same functions a workspace file gets, and hands
 * the result to the very same opaque `srcdoc` iframe (`buildPortPreview` in `power/preview.ts`
 * carries the evidence; `power/virtual-ports.ts` carries the whole sandbox write-up). It is a
 * snapshot, and the pane says so. "Open in a new tab" is the full-fidelity road and has no sandbox
 * at all — a top-level document served from our origin IS our origin — which is why it is a button
 * a person presses and not what this pane does by itself.
 *
 * THE AGENT DOES NOT DRIVE THIS. There is no `preview` tool this round: the person opens a page from
 * the Files pane. A tool that made a pane appear would be the agent taking the screen, which is a
 * decision §4.3 has not been asked.
 */
import { computed, onMounted, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { buildPortPreview, buildPreview, type PreviewBuild } from "../power/preview.js";
import { isPreviewablePath } from "../lib/files-tree.js";
import { agent } from "../state/agent.js";
import { selectedPath } from "../state/files.js";
import { ensurePortRuntime, livePorts, stopPort, urlForPort } from "../state/ports.js";

const build = ref<PreviewBuild | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const path = computed(() => (selectedPath.value && isPreviewablePath(selectedPath.value) ? selectedPath.value : null));
/** Which port this pane is showing, or `null` for "show the selected file". */
const openPort = ref<number | null>(null);
const workerServing = ref(true);

async function render(): Promise<void> {
  const owned = agent.value;
  const target = path.value;
  const port = openPort.value;
  build.value = null;
  error.value = null;
  if (port === null && (!owned || !target)) return;
  loading.value = true;
  try {
    build.value = port === null ? await buildPreview(owned!.fs, target!) : await buildPortPreview(port);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(path, () => {
  // Picking a file in the tree leaves a port view; a person clicking a page means that page.
  if (path.value) openPort.value = null;
  void render();
}, { immediate: true });

// ── The ports half ────────────────────────────────────────────────────────────────────────────────

onMounted(() => {
  workerServing.value = ensurePortRuntime();
});

watch(livePorts, (live) => {
  // A port that was killed cannot go on being shown; fall back to the file preview.
  if (openPort.value !== null && !live.some((entry) => entry.port === openPort.value)) {
    openPort.value = null;
    void render();
  }
});

function show(port: number): void {
  openPort.value = port;
  void render();
}

function openPortInTab(port: number): void {
  window.open(urlForPort(port), "_blank", "noopener,noreferrer");
}

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
      <span v-if="openPort === null" class="text-[12px] font-mono truncate">{{ path ?? "no page selected" }}</span>
      <span v-else class="text-[12px] font-mono truncate">/~/{{ openPort }}/</span>
      <div class="ml-auto flex items-center gap-1 shrink-0">
        <button
          v-for="entry in livePorts"
          :key="entry.port"
          type="button"
          class="ia-btn h-7 px-2 text-[11px] font-mono flex items-center gap-1"
          :class="openPort === entry.port ? 'text-[var(--color-phosphor)]' : ''"
          :title="`${entry.kind === 'folder' ? 'Serving' : 'Listening'}: ${entry.label}`"
          @click="show(entry.port)"
        >
          <TablerIcon name="server-2" :size="11" />
          :{{ entry.port }}
        </button>
        <button
          v-if="openPort !== null"
          type="button"
          class="ia-btn w-7 h-7 flex items-center justify-center"
          title="Stop this port"
          @click="stopPort(openPort)"
        >
          <TablerIcon name="player-stop" :size="13" />
        </button>
        <button
          type="button"
          class="ia-btn w-7 h-7 flex items-center justify-center"
          title="Reload"
          :disabled="openPort === null && !path"
          @click="render()"
        >
          <TablerIcon name="refresh" :size="13" />
        </button>
        <button
          type="button"
          class="ia-btn w-7 h-7 flex items-center justify-center"
          :title="
            openPort === null
              ? 'Open in a new tab'
              : 'Open in a new tab — a tab has no sandbox, so this page runs on this origin'
          "
          :disabled="openPort === null && !build"
          @click="openPort === null ? openInTab() : openPortInTab(openPort)"
        >
          <TablerIcon name="external-link" :size="13" />
        </button>
      </div>
    </div>

    <p
      v-if="openPort !== null && !workerServing"
      class="px-3 py-1.5 text-[10px] text-[var(--color-red)] border-b border-[var(--color-line)]"
    >
      This browser has no service worker here, so <span class="font-mono">/~/{{ openPort }}/</span> cannot be
      served. The port is registered; open the app over https (or localhost) to reach it.
    </p>

    <p
      v-if="openPort !== null"
      class="px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] border-b border-[var(--color-line)]"
    >
      A snapshot of <span class="font-mono">/~/{{ openPort }}/</span>, fetched and inlined: a served page cannot
      have its own origin inside this app, so links and live requests do not work here. Open it in a tab for the
      real thing — that page runs on this origin.
    </p>

    <p
      v-if="build && (build.missing.length || build.external.length)"
      class="px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] border-b border-[var(--color-line)]"
    >
      <template v-if="build.missing.length">Not found: {{ build.missing.join(", ") }}. </template>
      <template v-if="build.external.length">
        Left as written (this preview inlines only what it can reach): {{ build.external.join(", ") }}.
      </template>
    </p>

    <div class="flex-1 min-h-0 relative">
      <p v-if="!path && openPort === null" class="text-[12px] text-[var(--color-ink-dim)] p-4">
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
