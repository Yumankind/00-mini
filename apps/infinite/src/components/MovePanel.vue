<script setup lang="ts">
/**
 * Move to my Mac — §7's five steps, one screen each.
 *
 * WHY ONE STEP AT A TIME AND NOT A FORM. Steps 3 and 4 leave the browser: a file lands in Downloads,
 * an OS prompt asks whether to open 00, and neither answers back. A form would show five controls of
 * which four are guesses about what has already happened; a sequence shows the one thing to do now
 * and then asks. The code is shown LARGE because the person types it on the other machine — it is
 * read off this screen, not copied through a clipboard both devices share.
 */
import { computed, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import {
  confirmMoved,
  downloadMove,
  moveBusy,
  moveCode,
  moveDeepLink,
  moveError,
  moveFileName,
  moveStep,
  openIn00,
  resetMove,
  toCodeStep,
} from "../state/move.js";
import { profile } from "../state/agent.js";

const emit = defineEmits<{ (e: "close"): void }>();

const copied = ref(false);
const words = computed(() => moveCode.value.split("-").filter(Boolean));

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(moveCode.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // A browser that refuses the clipboard has not broken anything: the code is on the screen, in
    // six words, which is the way it is meant to travel.
    copied.value = false;
  }
}

function close(): void {
  resetMove();
  emit("close");
}

async function finish(): Promise<void> {
  await confirmMoved();
  emit("close");
}
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-5 space-y-5">
      <div class="flex items-center gap-2">
        <button type="button" class="ia-btn w-8 h-8 flex items-center justify-center" title="Back" @click="close()">
          <TablerIcon name="arrow-left" :size="15" />
        </button>
        <h1 class="text-[14px] font-semibold flex items-center gap-2">
          <TablerIcon name="device-laptop" :size="16" class="text-[var(--color-phosphor)]" />
          Move to my Mac
        </h1>
      </div>

      <!-- 1. What a move is. Two lines, because the rule is short and the consequence is the point. -->
      <section v-if="moveStep === 'explain'" class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          Your agent lives in one place at a time. Moving it to your Mac makes the Mac its home, and
          this browser keeps a receipt instead of a running agent.
        </p>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Everything comes with it — files, memory, sessions, standing answers — as one encrypted
          file. You can bring it back here whenever you like.
        </p>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          @click="toCodeStep()"
        >
          Start the move
          <TablerIcon name="chevron-right" :size="13" />
        </button>
      </section>

      <!-- 2. The code. Large, spaced, and the only place it ever appears. -->
      <section v-else-if="moveStep === 'code'" class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          These six words lock the file, and you will type them on your Mac. Keep this screen open.
        </p>
        <div class="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-4">
          <!-- The dashes are their own items so the spacing around them is symmetric when the six
               words wrap onto two lines at 375 px; inline they would hug the word before them. -->
          <div class="flex flex-wrap items-baseline justify-center gap-x-1 gap-y-1">
            <template v-for="(word, i) in words" :key="`${i}-${word}`">
              <span class="font-mono text-[16px] sm:text-[18px] text-[var(--color-phosphor)] tracking-tight">
                {{ word }}
              </span>
              <span v-if="i < words.length - 1" class="font-mono text-[15px] text-[var(--color-ink-dim)]">-</span>
            </template>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="ia-btn flex-1 h-8 text-[11px] flex items-center justify-center gap-1.5"
            @click="copyCode()"
          >
            <TablerIcon :name="copied ? 'check' : 'copy'" :size="13" />
            {{ copied ? "Copied" : "Copy" }}
          </button>
          <button type="button" class="ia-btn h-8 px-2.5 text-[11px]" title="New code" @click="toCodeStep()">
            <TablerIcon name="refresh" :size="13" />
          </button>
        </div>
        <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          Nobody can recover these words — not your Mac, not us. Without them the file is noise.
        </p>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          :disabled="moveBusy"
          @click="downloadMove()"
        >
          <TablerIcon name="download" :size="13" />
          {{ moveBusy ? "Packing…" : "Download the file" }}
        </button>
      </section>

      <!-- 3 → 4. The file is in Downloads; hand it to 00. -->
      <section v-else-if="moveStep === 'open'" class="panel px-3 py-3 space-y-3">
        <div class="flex items-start gap-2">
          <TablerIcon name="circle-check" :size="16" class="mt-0.5 shrink-0 text-[var(--color-phosphor)]" />
          <div class="min-w-0">
            <div class="text-[12px]">Saved to your downloads.</div>
            <div class="text-[11px] font-mono text-[var(--color-ink-dim)] break-all">{{ moveFileName }}</div>
          </div>
        </div>
        <a
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          :href="moveDeepLink"
          @click.prevent="openIn00()"
        >
          <TablerIcon name="external-link" :size="13" />
          Open in 00
        </a>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Your browser may ask whether to open 00 — or double-click the downloaded file.
        </p>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="openIn00()">
          I have it open on my Mac
        </button>
      </section>

      <!-- 5. The only step this browser can be sure of is the one the person confirms. -->
      <section v-else class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          Type the six words in 00 on your Mac to unlock the file. Once
          {{ profile?.displayName ?? "your agent" }} is running there, tell this browser — it will
          stop being a second home.
        </p>
        <div class="text-[11px] font-mono text-[var(--color-ink-dim)] break-all">{{ moveFileName }}</div>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          @click="finish()"
        >
          <TablerIcon name="check" :size="13" />
          I imported it on my Mac
        </button>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="close()">Not yet — keep it here</button>
      </section>

      <p v-if="moveError" class="text-[11px] text-[var(--color-red)] leading-relaxed">{{ moveError }}</p>
    </div>
  </div>
</template>
