<script setup lang="ts">
/** The last line: who made it, and the two documents that bind it. */
import { MINI_NAME, pixelFaceSvg } from "../mini/brand.js";
import { PRIVACY_URL, TERMS_URL } from "./sections.js";
import { goTo } from "../mini/nav.js";

const mark = pixelFaceSvg({ size: 18 });
const year = new Date().getFullYear();
</script>

<template>
  <footer class="landing-footer">
    <div class="landing-inner flex flex-wrap items-center gap-x-5 gap-y-3">
      <span class="flex items-center gap-2">
        <span class="landing-logo" v-html="mark" />
        <span class="text-[12px] font-medium">{{ MINI_NAME }}</span>
      </span>
      <a class="landing-link" href="https://0-0.chat" target="_blank" rel="noopener noreferrer">0-0.chat</a>
      <a class="landing-link" :href="TERMS_URL" target="_blank" rel="noopener noreferrer">Terms</a>
      <a class="landing-link" :href="PRIVACY_URL" target="_blank" rel="noopener noreferrer">Privacy</a>
      <button type="button" class="landing-link ml-auto" @click="goTo('/app')">Open the app →</button>
      <span class="landing-foot w-full">© {{ year }} 00 · an agent that runs where you are.</span>
    </div>
  </footer>
</template>
