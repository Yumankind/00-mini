<script setup lang="ts">
/**
 * The terminal — a `<pre>`, an `<input>`, and no xterm.
 *
 * WHY NO XTERM. xterm.js is ~250 KB and exists to emulate a VT: cursor addressing, colours, alternate
 * screens, resizing a PTY. `BuiltinShell` has no PTY, emits no escape codes and never repaints — it
 * answers a command with two strings. Rendering those in a scrollback of plain rows costs nothing,
 * keeps the 00 type and colour tokens (an xterm theme would be a second palette to keep in step),
 * and stays selectable and screen-readable. The day something here needs a cursor is the day it
 * needs a real shell too, and that day the answer is the Mac.
 *
 * The agent's own `bash` calls appear in the same scrollback, marked — see state/terminal.ts.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import {
  abortCommand,
  clearTerminal,
  greet,
  historyStep,
  runCommand,
  terminalBusy,
  terminalCwd,
  terminalRows,
  watchAgentCommands,
} from "../state/terminal.js";

const line = ref("");
const scroller = ref<HTMLElement | null>(null);
const field = ref<HTMLInputElement | null>(null);
let stopWatching: (() => void) | null = null;

onMounted(() => {
  greet();
  stopWatching = watchAgentCommands();
  void toBottom();
});
onBeforeUnmount(() => stopWatching?.());

async function toBottom(): Promise<void> {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(terminalRows, () => void toBottom());

async function submit(): Promise<void> {
  const text = line.value;
  line.value = "";
  await runCommand(text);
  await toBottom();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    line.value = historyStep(-1);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    line.value = historyStep(1);
    return;
  }
  if (event.key === "c" && event.ctrlKey) {
    event.preventDefault();
    abortCommand();
  }
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0" @click="field?.focus()">
    <div class="flex items-center gap-2 px-3 h-11 border-b border-[var(--color-line)] shrink-0">
      <TablerIcon name="terminal-2" :size="14" class="text-[var(--color-phosphor)]" />
      <span class="ia-label font-pixel">browser shell</span>
      <span class="text-[10px] font-mono text-[var(--color-ink-dim)] truncate">{{ terminalCwd }}</span>
      <div class="ml-auto flex items-center gap-1">
        <button
          v-if="terminalBusy"
          type="button"
          class="ia-btn h-6 px-2 text-[10px] flex items-center gap-1"
          title="Stop (Ctrl+C)"
          @click.stop="abortCommand()"
        >
          <TablerIcon name="player-stop" :size="12" />
          Stop
        </button>
        <button type="button" class="ia-btn ia-btn-ghost w-7 h-7" title="Clear" @click.stop="clearTerminal()">
          <TablerIcon name="x" :size="12" />
        </button>
      </div>
    </div>

    <div ref="scroller" class="flex-1 ia-scroll px-3 py-2 font-mono text-[12px] leading-[1.55]">
      <template v-for="(row, i) in terminalRows" :key="i">
        <div v-if="row.kind === 'input'" class="flex gap-1.5">
          <span class="text-[var(--color-phosphor)] shrink-0">{{ row.cwd }} $</span>
          <span class="whitespace-pre-wrap break-all">{{ row.text }}</span>
        </div>
        <pre v-else-if="row.kind === 'stdout'" class="whitespace-pre-wrap break-all">{{ row.text }}</pre>
        <pre v-else-if="row.kind === 'stderr'" class="whitespace-pre-wrap break-all text-[var(--color-red)]">{{ row.text }}</pre>
        <div v-else-if="row.kind === 'exit'" class="text-[10px] text-[var(--color-ink-dim)]">exit {{ row.code }}</div>
        <div v-else-if="row.kind === 'agent'" class="flex gap-1.5 items-baseline">
          <span class="text-[10px] px-1 rounded bg-[color-mix(in_srgb,var(--color-cyan)_18%,transparent)] text-[var(--color-cyan)] shrink-0">
            agent
          </span>
          <span class="whitespace-pre-wrap break-all">{{ row.text }}</span>
          <span v-if="row.code !== undefined" class="text-[10px] text-[var(--color-ink-dim)] shrink-0">
            exit {{ row.code }}
          </span>
        </div>
        <div v-else class="text-[11px] text-[var(--color-ink-dim)] whitespace-pre-wrap">{{ row.text }}</div>
      </template>
      <div v-if="terminalBusy" class="text-[11px] text-[var(--color-ink-dim)] ia-pulse">running…</div>
    </div>

    <form class="flex items-center gap-1.5 px-3 py-2 border-t border-[var(--color-line)] shrink-0" @submit.prevent="submit()">
      <span class="font-mono text-[12px] text-[var(--color-phosphor)] shrink-0">{{ terminalCwd }} $</span>
      <input
        ref="field"
        v-model="line"
        type="text"
        class="flex-1 bg-transparent border-0 outline-none font-mono text-[12px] text-[var(--color-ink)] min-w-0"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        :disabled="terminalBusy"
        placeholder="ls -l"
        @keydown="onKey"
      />
    </form>
  </div>
</template>
