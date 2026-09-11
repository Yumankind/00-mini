<script setup lang="ts">
/** `#code` — everything a coding agent has, and every line of it is a thing that shipped. */
import TablerIcon from "../components/TablerIcon.vue";
import { CODE_POINTS } from "./sections.js";
</script>

<template>
  <section id="code" class="landing-section">
    <p class="landing-eyebrow">Everything a coding agent has</p>
    <h2 class="landing-h2">A computer for your AI, inside the tab.</h2>
    <p class="landing-lead">
      Not a chat box with a code theme. A filesystem, a shell, a package manager and a dev server,
      all running in the browser you already have — on your files, not on a machine somewhere.
    </p>

    <div class="mt-9 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
      <article v-for="point in CODE_POINTS" :key="point.title" class="landing-card" data-reveal>
        <TablerIcon :name="point.icon" :size="18" class="text-[var(--color-phosphor)]" />
        <h3 class="mt-3 text-[13.5px] font-semibold">{{ point.title }}</h3>
        <p class="mt-1.5 landing-muted text-[13px] leading-relaxed">{{ point.body }}</p>
      </article>
    </div>

    <p class="landing-foot mt-6">
      The terminal is a shell built into the page, not a remote one; <code>node</code> runs in a
      worker beside it, and <code>npm install</code> writes into the tab's own storage.
    </p>
  </section>
</template>
