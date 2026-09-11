<script setup lang="ts">
/**
 * Rendered markdown — the answers in the thread, and the editor's preview toggle.
 *
 * THE `v-html` IS DELIBERATE AND IT IS SAFE. `renderMarkdown` escapes every character of input
 * before it adds a single tag and only ever emits attributes it built itself, so the string handed
 * to `v-html` cannot contain markup that came from the model. That is the whole reason the renderer
 * is ours. Untrusted HTML that is meant to RUN goes to `PreviewPane` instead, in a sandboxed iframe.
 *
 * THE TWO THINGS THE RENDERER CANNOT DO ALONE, done here:
 *
 * 1. PICTURES OUT OF THE WORKSPACE. `![shot](workspace/shot.png)` is a path in a filesystem no URL
 *    can address, so the renderer emits the `<img>` with `data-md-src` and NO `src` — nothing is
 *    requested from the network — and this component reads the bytes through the agent's own
 *    `AgentFs` and fills in a blob URL. The URLs are revoked when the component goes away, because
 *    a thread that has rendered forty pictures would otherwise hold forty blobs for the session.
 * 2. THE COPY BUTTON in a fenced block. One delegated listener on the root rather than a listener
 *    per block: the HTML is replaced wholesale on every streamed delta, and per-node listeners would
 *    be attached and dropped dozens of times a second.
 *
 * WHILE A MESSAGE IS STREAMING the re-render is throttled to one animation frame. Vue would happily
 * re-parse the whole answer on every token; at sixty tokens a second on a phone that is the
 * difference between an answer that appears and an answer that stutters.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { renderMarkdown } from "../lib/markdown-lite.js";
import { mimeFor } from "../lib/preview-resolve.js";
import { agent } from "../state/agent.js";

const props = withDefaults(defineProps<{ text: string; streaming?: boolean; small?: boolean }>(), {
  streaming: false,
  small: false,
});

const root = ref<HTMLElement | null>(null);
const shown = ref(props.text);
const html = computed(() => renderMarkdown(shown.value));
const blobs: string[] = [];
const resolving = new Set<string>();
let frame: number | null = null;

watch(
  () => [props.text, props.streaming] as const,
  ([text, streaming]) => {
    if (!streaming) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      shown.value = text;
      return;
    }
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      shown.value = props.text;
    });
  },
);

/** Read the bytes an `<img data-md-src>` is waiting for, once per path, and hand it a blob URL. */
async function resolveImages(): Promise<void> {
  const owned = agent.value;
  const host = root.value;
  if (!owned || !host) return;
  for (const img of Array.from(host.querySelectorAll<HTMLImageElement>("img[data-md-src]"))) {
    const path = img.dataset.mdSrc ?? "";
    if (!path || img.getAttribute("src") || resolving.has(path)) continue;
    resolving.add(path);
    try {
      const bytes = await owned.fs.readFile(path);
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeFor(path) }));
      blobs.push(url);
      // Every img with this path, not just the one that asked: the same picture twice is one read.
      for (const twin of Array.from(host.querySelectorAll<HTMLImageElement>(`img[data-md-src="${CSS.escape(path)}"]`))) {
        twin.src = url;
      }
    } catch {
      // A path that is not there says so where the picture would have been, rather than silently
      // leaving a broken frame: the agent may have named a file it has not written yet.
      img.replaceWith(Object.assign(document.createElement("span"), { className: "md-missing", textContent: `${path} — not in the workspace` }));
    } finally {
      resolving.delete(path);
    }
  }
}

watch(html, () => void nextTick(resolveImages), { immediate: true });

async function onClick(event: MouseEvent): Promise<void> {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".md-copy");
  if (!button) return;
  const source = button.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(source);
    button.textContent = "Copied";
  } catch {
    // A browser that refuses the clipboard (no permission, no secure context) says so on the button
    // rather than doing nothing — the person can still select the block by hand.
    button.textContent = "Press ⌘C";
  }
  window.setTimeout(() => {
    button.textContent = "Copy";
  }, 1400);
}

onBeforeUnmount(() => {
  if (frame !== null) cancelAnimationFrame(frame);
  for (const url of blobs) URL.revokeObjectURL(url);
});
</script>

<template>
  <div ref="root" class="md-body" :class="small ? 'md-sm' : ''" @click="onClick" v-html="html" />
</template>
