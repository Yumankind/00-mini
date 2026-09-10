<script setup lang="ts">
/**
 * The preview pane — a workspace page, rendered, and now navigable.
 *
 * TWO ROADS, AND WHY THERE ARE TWO.
 *
 * **Live** (when this build has a preview host). The pane frames
 * `apps/infinite-preview-site` — a Worker whose entire purpose is to BE A DIFFERENT ORIGIN — with
 * `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`. That flag pair is forbidden
 * everywhere else in this app and is right here for exactly one reason: "same origin" means the same
 * as the FRAME'S origin, which is the preview host's, not ours. The frame therefore keeps an identity
 * (so it may register a service worker and be served by one — an opaque frame is never served, which
 * is the measured finding this whole feature exists to answer) and that identity has none of the
 * person's storage behind it. The app posts the folder of the page being previewed; the host's worker
 * serves it back with links, assets, `fetch`, forms and virtual ports all working, and every HTML page
 * it serves carries the inspector.
 *
 * **Snapshot** (the fallback, and what the pane did before). The page and its assets are inlined into
 * one document and handed to an opaque `srcdoc` frame. Links do not navigate and `fetch` has no origin
 * to reach — the pane says so — but it needs nothing deployed, so it is what a build with no
 * `VITE_PREVIEW_ORIGIN` gets, and what a preview host that fails to answer falls back to.
 *
 * THE INSPECTOR IS ON BOTH ROADS. An opaque frame cannot read this app, but it can still
 * `postMessage` its parent, so the snapshot document gets the same picker script inlined
 * (`withInspector` in `lib/pick.ts`) with this app's origin stamped in a meta — because an opaque
 * frame's own `location.origin` is the string `"null"` and it would otherwise have to post to `"*"`.
 * Clicking an element in either road puts a chip in the composer.
 *
 * THE AGENT STILL DOES NOT DRIVE THIS. There is no `preview` tool: the person opens a page from the
 * Files pane, and the person decides what to send. A tool that made a pane appear and picked its own
 * elements would be the agent taking the screen, which is a decision §4.3 has not been asked.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AgentEvent } from "@00/agent-runtime";
import TablerIcon from "./TablerIcon.vue";
import { buildPortPreview, buildPreview, type PreviewBuild } from "../power/preview.js";
import {
  PREVIEW_SANDBOX,
  buildFileSet,
  createPreviewHost,
  reReadFile,
  type PreviewHost,
} from "../power/preview-host.js";
import { isPreviewablePath } from "../lib/files-tree.js";
import {
  MSG_INSPECT,
  PREVIEW_NOT_CONFIGURED_LINE,
  PREVIEW_PROTOCOL,
  isPickMessage,
  newSiteId,
  previewOrigin,
  withInspector,
} from "../lib/pick.js";
import { agent } from "../state/agent.js";
import { selectedPath } from "../state/files.js";
import { ensurePortRuntime, livePorts, stopPort, urlForPort } from "../state/ports.js";
import { send } from "../state/conversation.js";
import {
  clearSelection,
  inspecting,
  liveAvailable,
  previewAddress,
  previewHost as hostState,
  previewNote,
  selection,
  selectionChip,
  setAddress,
  setHostState,
  setSelection,
  toggleInspecting,
} from "../state/preview.js";

const build = ref<PreviewBuild | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const path = computed(() => (selectedPath.value && isPreviewablePath(selectedPath.value) ? selectedPath.value : null));
/** Which port this pane is showing, or `null` for "show the selected file". */
const openPort = ref<number | null>(null);
const workerServing = ref(true);
const noteLines = ref<string[]>([]);

// ── The live road ────────────────────────────────────────────────────────────────────────────────

const origin = previewOrigin();
const liveFrame = ref<HTMLIFrameElement | null>(null);
const snapshotFrame = ref<HTMLIFrameElement | null>(null);
const siteId = ref(newSiteId());
let host: PreviewHost | null = null;
/** The folder currently posted to the host — what a `file_changed` is compared against. */
let postedRoot: string | null = null;

/** True while the pane is actually using the host. A failed handshake drops back to the snapshot. */
const live = computed(() => liveAvailable.value && hostState.value !== "failed");

const hostSrc = computed(() => (origin ? `${origin}/#o=${encodeURIComponent(location.origin)}` : ""));

function folderOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

function fileOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? file : file.slice(slash + 1);
}

// ── Painting ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The one entry point both roads share: show what is selected, whichever way this build can.
 *
 * A port is a NAVIGATION on the live road (the host's worker forwards `/p/<id>/<port>/…` back into
 * this tab's `handleVirtualRequest`, so the served page keeps its own links and requests) and a
 * fetch-and-inline on the snapshot road.
 */
async function render(): Promise<void> {
  const owned = agent.value;
  const target = path.value;
  const port = openPort.value;
  error.value = null;
  noteLines.value = [];
  if (port === null && (!owned || !target)) {
    build.value = null;
    return;
  }
  if (live.value && host && hostState.value === "live") {
    try {
      if (port !== null) {
        setAddress(host.portUrl(siteId.value, port));
        host.navigate(host.portUrl(siteId.value, port));
        postedRoot = null;
        return;
      }
      loading.value = true;
      const root = folderOf(target!);
      const set = await buildFileSet(owned!.fs, root, { entry: fileOf(target!) });
      if (set.plan.refusal) {
        // Too big to post is not a reason to show nothing: the snapshot road still works, and the
        // pane says which limit was hit rather than leaving a blank frame.
        noteLines.value = [set.plan.refusal];
        await renderSnapshot();
        return;
      }
      postedRoot = root;
      host.send(set.files, siteId.value, set.entry);
      setAddress(host.siteUrl(siteId.value, set.entry));
      if (set.plan.skipped.length) {
        noteLines.value = [`Left out: ${set.plan.skipped.slice(0, 6).map((s) => s.path).join(", ")}.`];
      }
      build.value = null;
      return;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return;
    } finally {
      loading.value = false;
    }
  }
  await renderSnapshot();
}

async function renderSnapshot(): Promise<void> {
  const owned = agent.value;
  const target = path.value;
  const port = openPort.value;
  build.value = null;
  loading.value = true;
  try {
    const made = port === null ? await buildPreview(owned!.fs, target!) : await buildPortPreview(port);
    // The picker goes in here rather than in `power/preview.ts` because it is a property of the PANE
    // — a document opened in a new tab has no parent to tell, and inlining a listener into it would
    // be a script the person did not ask for in a page they are about to look at on its own.
    build.value = {
      ...made,
      html: withInspector(made.html, { target: location.origin, source: port === null ? target : null }),
    };
    setAddress(port === null ? target : `/~/${port}/`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(path, () => {
  if (path.value) openPort.value = null;
  void render();
}, { immediate: true });

// ── The host's lifecycle ─────────────────────────────────────────────────────────────────────────

function attachHost(): void {
  const frame = liveFrame.value;
  if (!frame || !origin || host) return;
  setHostState("connecting");
  host = createPreviewHost(
    frame,
    origin,
    {
      onPick: (pick) => {
        setSelection(pick);
        if (pick.url) setAddress(pick.url);
      },
      onClear: () => clearSelection(),
      onNav: (nav) => setAddress(nav.url),
      onError: (message) => {
        setHostState("failed", `${message} — showing a snapshot instead.`);
        void render();
      },
    },
  );
  void host
    .ready()
    .then(() => {
      setHostState("live");
      host?.setInspect(inspecting.value);
      void render();
    })
    .catch((err: Error) => {
      // A host that never answered — or one that said out loud that it could not start — is a host
      // that is not there. Say which, and paint the snapshot. (`onError` above has usuallysaid it
      // first; setting the same state twice is cheaper than a race over which of the two wins.)
      if (hostState.value !== "failed") setHostState("failed", `${err.message} — showing a snapshot instead.`);
      void render();
    });
}

onMounted(() => {
  workerServing.value = ensurePortRuntime();
  if (liveAvailable.value) attachHost();
  else setHostState("off", PREVIEW_NOT_CONFIGURED_LINE);
  window.addEventListener("message", onSnapshotMessage);
  detachFiles = agent.value?.runtime.on(onFileChanged) ?? null;
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onSnapshotMessage);
  detachFiles?.();
  detachFiles = null;
  host?.destroy();
  host = null;
});

// ── The snapshot road's picks ────────────────────────────────────────────────────────────────────

/**
 * The snapshot frame is OPAQUE, so its messages arrive with `event.origin === "null"` and there is
 * nothing to compare an origin against. Identity of the source window is the check that means
 * something here: only the frame this component created can be `snapshotFrame.contentWindow`.
 */
function onSnapshotMessage(event: MessageEvent): void {
  const frame = snapshotFrame.value;
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data as { kind?: string } | null;
  if (!data) return;
  if (isPickMessage(data)) {
    setSelection(data);
    return;
  }
  if (data.kind === "00-pick-clear") clearSelection();
}

/** Snapshot mode has no host to relay through: the frame is told directly. */
function pushInspect(on: boolean): void {
  host?.setInspect(on);
  snapshotFrame.value?.contentWindow?.postMessage({ kind: MSG_INSPECT, v: PREVIEW_PROTOCOL, on }, "*");
}

function onInspectClick(): void {
  pushInspect(toggleInspecting());
}

// ── Keeping the live copy in step ────────────────────────────────────────────────────────────────

let detachFiles: (() => void) | null = null;

/**
 * The agent wrote a file; the preview follows. ONE file at a time rather than the whole folder,
 * because a re-post of twenty megabytes on every keystroke of an `edit` tool is a stutter the person
 * would blame on the page they are looking at.
 */
function onFileChanged(event: AgentEvent): void {
  if (event.type !== "file_changed" || !host || postedRoot === null) return;
  const owned = agent.value;
  if (!owned) return;
  void reReadFile(owned.fs, postedRoot, event.path).then((file) => {
    if (file) host?.update(file);
  });
}

// ── The ports half ────────────────────────────────────────────────────────────────────────────────

watch(livePorts, (list) => {
  if (openPort.value !== null && !list.some((entry) => entry.port === openPort.value)) {
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
  if (live.value && previewAddress.value?.startsWith("http")) {
    window.open(previewAddress.value, "_blank", "noopener,noreferrer");
    return;
  }
  if (!build.value) return;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(new Blob([build.value.html], { type: "text/html" }));
  window.open(lastUrl, "_blank", "noopener,noreferrer");
}

/** The pick, straight to the agent, with no words: "this one" is a whole message. */
async function sendSelection(): Promise<void> {
  await send("");
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-line)] shrink-0">
      <TablerIcon name="world" :size="13" class="text-[var(--color-ink-dim)] shrink-0" />
      <span class="text-[12px] font-mono truncate" :title="previewAddress ?? ''">
        {{ previewAddress ?? (openPort === null ? path ?? "no page selected" : `/~/${openPort}/`) }}
      </span>
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
          type="button"
          class="ia-btn h-7 px-2 text-[11px] flex items-center gap-1"
          :class="inspecting ? 'text-[var(--color-cyan)]' : ''"
          title="Inspect — click an element in the page to send it to your agent (Alt+click works either way)"
          @click="onInspectClick()"
        >
          <TablerIcon name="tools" :size="11" />
          Inspect
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
            live
              ? 'Open in a new tab — on the preview origin, which holds nothing but this folder'
              : 'Open in a new tab — a tab has no sandbox, so this page runs on this origin'
          "
          :disabled="!live && openPort === null && !build"
          @click="openPort !== null && !live ? openPortInTab(openPort) : openInTab()"
        >
          <TablerIcon name="external-link" :size="13" />
        </button>
      </div>
    </div>

    <!-- The pick, and the shortest road from it to the agent. The composer carries the same chip; this
         one is here because the person's eyes are on the page when they make the pick. -->
    <div
      v-if="selectionChip"
      class="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-line)] text-[11px] text-[var(--color-cyan)] shrink-0"
    >
      <span class="truncate font-mono">{{ selectionChip }}</span>
      <div class="ml-auto flex items-center gap-1 shrink-0">
        <button type="button" class="ia-btn h-6 px-2 text-[10px]" @click="sendSelection()">Send to agent</button>
        <button type="button" class="ia-btn w-6 h-6 flex items-center justify-center" title="Clear" @click="clearSelection()">
          <TablerIcon name="x" :size="11" />
        </button>
      </div>
    </div>

    <p
      v-if="!live && previewNote"
      class="px-3 py-1.5 text-[10px] text-[var(--color-amber)] border-b border-[var(--color-line)]"
    >
      {{ previewNote }}
    </p>

    <p
      v-if="!live && openPort !== null && !workerServing"
      class="px-3 py-1.5 text-[10px] text-[var(--color-red)] border-b border-[var(--color-line)]"
    >
      This browser has no service worker here, so <span class="font-mono">/~/{{ openPort }}/</span> cannot be
      served. The port is registered; open the app over https (or localhost) to reach it.
    </p>

    <p
      v-if="!live && openPort !== null"
      class="px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] border-b border-[var(--color-line)]"
    >
      A snapshot of <span class="font-mono">/~/{{ openPort }}/</span>, fetched and inlined: a served page cannot
      have its own origin inside this app, so links and live requests do not work here. Open it in a tab for the
      real thing — that page runs on this origin.
    </p>

    <p
      v-if="!live && build && (build.missing.length || build.external.length)"
      class="px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] border-b border-[var(--color-line)]"
    >
      <template v-if="build.missing.length">Not found: {{ build.missing.join(", ") }}. </template>
      <template v-if="build.external.length">
        Left as written (this preview inlines only what it can reach): {{ build.external.join(", ") }}.
      </template>
    </p>

    <p
      v-for="line in noteLines"
      :key="line"
      class="px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] border-b border-[var(--color-line)]"
    >
      {{ line }}
    </p>

    <div class="flex-1 min-h-0 relative">
      <!-- The live host. Kept MOUNTED once it is up, even while a build is in flight: re-creating the
           frame would tear down its service worker registration and its cache with it. -->
      <iframe
        v-if="liveAvailable && hostSrc"
        v-show="live"
        ref="liveFrame"
        :src="hostSrc"
        :sandbox="PREVIEW_SANDBOX"
        title="Preview"
        class="w-full h-full border-0 bg-white"
      />
      <template v-if="!live">
        <p v-if="!path && openPort === null" class="text-[12px] text-[var(--color-ink-dim)] p-4">
          Pick an <span class="font-mono">.html</span> file in the tree to see it rendered.
        </p>
        <p v-else-if="loading" class="text-[12px] text-[var(--color-ink-dim)] p-4 ia-pulse">Reading the page…</p>
        <p v-else-if="error" class="text-[12px] text-[var(--color-red)] p-4">{{ error }}</p>
        <iframe
          v-else-if="build"
          ref="snapshotFrame"
          :srcdoc="build.html"
          sandbox="allow-scripts"
          title="Preview"
          class="w-full h-full border-0 bg-white"
        />
      </template>
      <p
        v-else-if="loading"
        class="absolute left-0 top-0 px-3 py-1.5 text-[10px] text-[var(--color-ink-dim)] ia-pulse"
      >
        Posting the folder…
      </p>
    </div>
  </div>
</template>
