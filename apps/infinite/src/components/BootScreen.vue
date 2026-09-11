<script setup lang="ts">
/**
 * The first visit, §4.1 — and the honest part of it: the four lines are what is actually happening,
 * in the order the plan promises, and the last one is the local brain's own `readiness()` rather than
 * a spinner that means nothing. The sentence under them is the promise itself, because this is the
 * one screen where it can be checked: nothing here talks to a server except the app shell.
 */
import { computed } from "vue";
import PixelFace from "./PixelFace.vue";
import TablerIcon from "./TablerIcon.vue";
import { stepLine } from "../lib/boot-steps.js";
import { bootError, bootSteps, progress } from "../state/agent.js";

const pct = computed(() => Math.round(progress.value * 100));
</script>

<template>
  <div class="h-full flex items-center justify-center px-6">
    <div class="w-full max-w-sm">
      <div class="flex items-center gap-3 mb-8">
        <PixelFace :size="44" self-animate glow />
        <div>
          <div class="text-[16px] font-semibold tracking-tight">00 Mini</div>
          <div class="text-[12px] text-[var(--color-ink-dim)]">An AI agent you do not install.</div>
        </div>
      </div>

      <ul class="space-y-2.5 mb-6">
        <li v-for="step in bootSteps" :key="step.id" class="flex items-center gap-2.5 text-[13px]">
          <span class="w-4 h-4 flex items-center justify-center shrink-0">
            <TablerIcon
              v-if="step.state === 'done'"
              name="circle-check"
              :size="15"
              class="text-[var(--color-phosphor)]"
            />
            <TablerIcon
              v-else-if="step.state === 'failed'"
              name="alert-triangle"
              :size="15"
              class="text-[var(--color-amber)]"
            />
            <span
              v-else-if="step.state === 'active'"
              class="w-2 h-2 rounded-full bg-[var(--color-phosphor)] ia-pulse"
            />
            <span v-else class="w-2 h-2 rounded-full bg-[var(--color-line)]" />
          </span>
          <span :class="step.state === 'pending' ? 'text-[var(--color-ink-dim)]' : 'text-[var(--color-ink)]'">
            {{ stepLine(step) }}
          </span>
        </li>
      </ul>

      <div class="h-[3px] rounded-full bg-[var(--color-line)] overflow-hidden mb-4">
        <div
          class="h-full bg-[var(--color-phosphor)] transition-[width] duration-300"
          :style="{ width: `${pct}%` }"
        />
      </div>

      <p v-if="bootError" class="text-[12px] text-[var(--color-red)] leading-relaxed">
        {{ bootError }}
      </p>
      <p v-else class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
        Nothing here reaches a server except this page and, if you ask for it, the model weights. Your
        agent, its files and its memory stay in this browser.
      </p>
    </div>
  </div>
</template>
