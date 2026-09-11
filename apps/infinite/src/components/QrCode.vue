<script setup lang="ts">
/**
 * A QR code, drawn inline — src/lib/qr.ts.
 *
 * WHY `v-html` IS SAFE HERE, which is the only question this component raises. The string it inserts
 * is built by `qrSvg` and contains NONE of the text it encodes: the encoder turns the text into a
 * grid of booleans and the grid into one `<path>` of `M… h1v1h-1z` commands. There is no place in the
 * output for a character of the input to appear, so there is nothing for a hostile string to escape
 * from — and the alternative (a `<path>` bound with `:d`) would be the same markup with a Vue
 * render function in the middle of it.
 *
 * WHY IT IS AN `<svg>` AND NOT A `<canvas>`. `fill="currentColor"`, so the code is ink in light mode
 * and paper-coloured ink in dark mode with no prop and no watcher, and it stays sharp at any size on
 * any display. A canvas is a bitmap that would need redrawing for both.
 *
 * WHEN THE TEXT IS TOO LONG for a version 10 symbol the encoder throws, and this renders nothing
 * rather than tearing down the panel it is sitting in: a missing QR code is a smaller failure than a
 * blank Move screen, and the six words beside it are the road that always works.
 */
import { computed } from "vue";
import { qrSvg } from "../lib/qr.js";

const props = withDefaults(defineProps<{ text: string; size?: number }>(), { size: 148 });

const svg = computed(() => {
  if (!props.text) return "";
  try {
    return qrSvg(props.text, { size: props.size, fg: "currentColor", quiet: 2 });
  } catch {
    return "";
  }
});
</script>

<template>
  <!-- The white plate is not decoration: a scanner needs a light quiet zone around the code, and in
       dark mode the panel behind it is near-black. The code itself is `currentColor`, so the wrapper
       sets the ink to near-black for both themes and the plate under it to white. -->
  <div
    v-if="svg"
    class="inline-flex items-center justify-center rounded-[10px] bg-white p-2 text-[#111113]"
    :style="{ width: `${size + 16}px`, height: `${size + 16}px` }"
    v-html="svg"
  />
</template>
