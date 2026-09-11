<script setup lang="ts">
/** `#faq` — six short answers, open by default. A question worth asking is worth reading at a glance. */
import { FAQ } from "./sections.js";
</script>

<template>
  <section id="faq" class="landing-section">
    <p class="landing-eyebrow">Questions</p>
    <h2 class="landing-h2">Six things people ask.</h2>
    <div class="mt-8 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 max-w-4xl">
      <div v-for="item in FAQ" :key="item.q" data-reveal>
        <h3 class="text-[13.5px] font-semibold">{{ item.q }}</h3>
        <p class="mt-1.5 landing-muted text-[13px] leading-relaxed">{{ item.a }}</p>
      </div>
    </div>
  </section>
</template>
