<script setup lang="ts">
/**
 * THE 00 FACE — an 8×8 grid of pixels, lit in mint on near-black.
 *
 * Ported from `landing/components/PixelFace.vue` in the main checkout, which is the mark the whole
 * product signs with; the brand must be the same shape here as on the website, so the cell patterns
 * below are copied and not redrawn. What this copy adds is `thinking`: the face holds the "thinking"
 * expression for as long as a run is in flight, which is the one thing the app knows and the landing
 * page does not.
 *
 * It blinks on its own when `selfAnimate` is set, on a timer with some jitter so two faces on one
 * screen do not blink in lockstep, and it does not blink at all under `prefers-reduced-motion`.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    size?: number;
    /** Lit-pixel colour. Defaults to the accent, so it follows the theme. */
    color?: string;
    /** False → every pixel dark. */
    on?: boolean;
    /** Hold the "thinking" mouth — what the app shows while a run is in flight. */
    thinking?: boolean;
    /** Idle blink on a timer. Off by default: a face in a list should sit still. */
    selfAnimate?: boolean;
    glow?: boolean;
    offColor?: string;
  }>(),
  {
    size: 32,
    color: "var(--color-phosphor)",
    on: true,
    thinking: false,
    selfAnimate: false,
    glow: false,
    offColor: "rgba(255,255,255,0.10)",
  },
);

const IDLE_00 = ["........", "..#..#..", ".#.##.#.", "........", "........", ".#....#.", "..####..", "........"];
const BLINK = ["........", "........", ".##..##.", "........", "........", ".#....#.", "..####..", "........"];
const THINK = ["........", "..#..#..", ".#.##.#.", "........", "........", "...##...", "...##...", "........"];

const base = computed(() => (props.thinking ? THINK : IDLE_00));
const frame = ref<string[]>(base.value);
const grid = computed(() => frame.value.map((row) => row.padEnd(8, ".").split("").map((c) => c === "#")));

let timer: ReturnType<typeof setTimeout> | undefined;
function stop(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

function scheduleIdle(): void {
  stop();
  timer = setTimeout(
    () => {
      frame.value = BLINK;
      timer = setTimeout(() => {
        frame.value = base.value;
        scheduleIdle();
      }, 130);
    },
    2600 + Math.random() * 4200,
  );
}

function run(): void {
  stop();
  frame.value = base.value;
  const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // A thinking face does not blink: it is already saying something, and two animations on eight
  // pixels read as a glitch.
  if (props.selfAnimate && props.on && !props.thinking && !still) scheduleIdle();
}

onMounted(run);
watch(() => [props.thinking, props.selfAnimate, props.on], run);
onUnmounted(stop);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 8 8"
    class="pixel-face shrink-0"
    role="img"
    aria-label="00 Mini"
    :style="glow ? { filter: 'drop-shadow(0 0 10px color-mix(in srgb, var(--color-phosphor) 30%, transparent))' } : undefined"
  >
    <rect x="0" y="0" width="8" height="8" rx="1.6" fill="#08090b" />
    <template v-for="(row, r) in grid" :key="r">
      <rect
        v-for="(cell, c) in row"
        :key="c"
        :x="c + 0.1"
        :y="r + 0.1"
        width="0.8"
        height="0.8"
        rx="0.2"
        :fill="on && cell ? color : offColor"
        style="transition: fill 0.25s ease"
      />
    </template>
  </svg>
</template>
