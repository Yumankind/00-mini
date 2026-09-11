<script setup lang="ts">
/** The slim header: the face, the name, and the two things a visitor can do. */
import { MINI_NAME, pixelFaceSvg } from "../mini/brand.js";
import { goTo } from "../mini/nav.js";

const logo = pixelFaceSvg({ size: 24 });
</script>

<template>
  <header class="landing-header">
    <a
      class="flex items-center gap-2.5 no-underline"
      href="#hero"
      :aria-label="MINI_NAME"
    >
      <span class="landing-logo" v-html="logo" />
      <span class="text-[13px] font-semibold tracking-tight">{{ MINI_NAME }}</span>
    </a>
    <nav class="ml-auto flex items-center gap-1.5">
      <a class="landing-ghost" href="#embed">Add to your site</a>
      <button type="button" class="landing-cta" @click="goTo('/app')">Open the app</button>
    </nav>
  </header>
</template>
