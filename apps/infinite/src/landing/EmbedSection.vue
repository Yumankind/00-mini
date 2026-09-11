<script setup lang="ts">
/**
 * `#embed` — the one line that puts this same widget on a website.
 *
 * The origin is read from the page rather than written down, so the snippet a person copies is the
 * snippet for the deployment they are actually looking at. The ref is THIS browser's agent's, minted
 * offline the first time this section is on screen (Bruno, 2026-09-11: the tag must be ready to paste,
 * keys and all) — and the link public key rides along in `data-site`, so the site can be registered
 * for extra power later without coming back here. Until the agent has booted the tag shows `ia_…`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import TablerIcon from "../components/TablerIcon.vue";
import { ready } from "../state/agent.js";
import { loadRegistry, readySnippet, registryReady } from "../state/registry.js";
import { EMBED_CAN, EMBED_CANNOT } from "./sections.js";

const origin = typeof location === "undefined" ? "https://0-0.chat" : location.origin;
// `<\/script>` so the string cannot close this block.
const snippet = computed(() => readySnippet.value || `<script async src="${origin}/e/ia_….js"><\/script>`);
const isReal = computed(() => !!readySnippet.value);

const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let asked = false;
async function mint(): Promise<void> {
  if (asked) return;
  asked = true;
  if (!registryReady.value) await loadRegistry();
}
onMounted(() => {
  // Minted when the section is in view, not at page load: a reader who never scrolls here never
  // mints a key they will not use. `ready` gates it behind the agent's own boot.
  if (typeof IntersectionObserver === "undefined" || !root.value) {
    void mint();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && ready.value) void mint();
  });
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

const copied = ref(false);
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(snippet.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* the block is selectable either way */
  }
}
</script>

<template>
  <section id="embed" ref="root" class="landing-section">
    <p class="landing-eyebrow">Put it on your website</p>
    <h2 class="landing-h2">One script tag, and your site has a guide.</h2>
    <p class="landing-lead">
      The same widget, on your own pages. It reads your site, answers from the page it found the
      answer on, opens that page and outlines the thing. No account, and nothing to host.
    </p>

    <div class="landing-code mt-7" data-reveal>
      <div class="landing-code-bar">
        <span class="font-mono text-[11px] landing-muted">{{ isReal ? "your tag — paste it as is" : "your page" }}</span>
        <button type="button" class="landing-copy" @click="copy">
          <TablerIcon :name="copied ? 'check' : 'copy'" :size="13" />
          {{ copied ? "copied" : "copy" }}
        </button>
      </div>
      <pre class="landing-pre"><code class="select-all">{{ snippet }}</code></pre>
    </div>
    <p v-if="isReal" class="landing-foot mt-3">
      This tag is yours: the ref was minted in this browser, and the <code>data-site</code> carries your
      agent's public link key, so the site can be registered for extra power later. Nothing private is
      in it.
    </p>

    <div class="mt-8 grid grid-cols-1 md:grid-cols-2 gap-3.5">
      <article class="landing-card" data-reveal>
        <h3 class="text-[13.5px] font-semibold">What it does on your site</h3>
        <ul class="mt-3 space-y-2">
          <li v-for="line in EMBED_CAN" :key="line" class="landing-tick">
            <TablerIcon name="check" :size="14" />{{ line }}
          </li>
        </ul>
      </article>
      <article class="landing-card" data-reveal>
        <h3 class="text-[13.5px] font-semibold">What it will not do</h3>
        <ul class="mt-3 space-y-2">
          <li v-for="line in EMBED_CANNOT" :key="line" class="landing-tick landing-tick-amber">
            <TablerIcon name="x" :size="14" />{{ line }}
          </li>
        </ul>
      </article>
    </div>

    <p class="landing-foot mt-6">
      Text on a page is data, never an instruction it obeys. The ref in the tag is public by design:
      on its own it grants nothing, and the private half never leaves your browser.
    </p>
  </section>
</template>
