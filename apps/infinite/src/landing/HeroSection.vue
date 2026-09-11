<script setup lang="ts">
/**
 * `#hero` — the claim, and the proof standing next to it.
 *
 * The demo is not a video and not a screenshot: it is the widget in the bottom-right corner of this
 * very page, which is a live agent in this browser. So the hero points AT it rather than describing
 * it, and the second button is the same widget's expand.
 */
import { pixelFaceSvg } from "../mini/brand.js";
import { goTo } from "../mini/nav.js";

const face = pixelFaceSvg({ size: 64, radius: 1.2 });
</script>

<template>
  <section id="hero" class="landing-section pt-16 sm:pt-24">
    <div class="landing-face" v-html="face" />
    <h1 class="mt-7 text-[2rem] sm:text-[3.25rem] font-semibold tracking-tight leading-[1.08] max-w-3xl">
      An AI agent you<br />
      don't install.
    </h1>
    <p class="mt-5 text-[15px] sm:text-[17px] leading-relaxed max-w-2xl text-[var(--color-ink)]">
      A whole agent — files, a terminal, Git, a preview, its own memory — running inside this browser
      tab. Nothing to download, no account, and it keeps working when the network stops.
    </p>
    <div class="mt-8 flex flex-wrap items-center gap-3">
      <button type="button" class="landing-cta landing-cta-lg" @click="goTo('/app')">Open the app</button>
      <a class="landing-ghost landing-ghost-lg" href="#embed">Put it on your website</a>
    </div>
    <p class="landing-pointer mt-8">
      <span class="landing-dot" aria-hidden="true" />
      It's already running, bottom right — ask it something.
    </p>
  </section>
</template>
