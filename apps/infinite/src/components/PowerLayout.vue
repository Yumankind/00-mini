<script setup lang="ts">
/**
 * The power shell's body — §1's IDE layout on a desk, the same panes as tabs on a phone.
 *
 * WHY ONE COMPONENT FOR BOTH. The panes are identical in the two arrangements; only the boxes around
 * them change. Two components would mean two places to add the next pane and two places to forget it,
 * and the split would land exactly where the plan says it must not: "there is no phone build and no
 * desktop build". The rule that chooses is `layoutMode` in state/layout.ts, which is a pure function
 * of width and the flag, and is the thing under test.
 *
 * The centre is EDITOR OR PREVIEW, never both: they are two readings of one file, and a person
 * switching between them wants the same column, not a narrower one.
 */
import { computed } from "vue";
import TablerIcon from "./TablerIcon.vue";
import ConversationPane from "./ConversationPane.vue";
import EditorPane from "./EditorPane.vue";
import FilesPane from "./FilesPane.vue";
import GitPane from "./GitPane.vue";
import PreviewPane from "./PreviewPane.vue";
import TerminalPane from "./TerminalPane.vue";
import {
  POWER_PANES,
  centrePane,
  mode,
  powerPane,
  showCentre,
  showPane,
  terminalVisible,
  toggleTerminal,
} from "../state/layout.js";

const ide = computed(() => mode.value === "ide");
</script>

<template>
  <!-- ≥ 1024 px: files / centre / chat, terminal below. -->
  <div v-if="ide" class="flex-1 flex flex-col min-h-0">
    <div class="flex-1 flex min-h-0">
      <aside class="w-64 shrink-0 min-h-0">
        <FilesPane tree-only />
      </aside>

      <section class="flex-1 min-w-0 flex flex-col min-h-0 border-r border-[var(--color-line)]">
        <div class="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-line)] shrink-0">
          <button
            type="button"
            class="ia-btn h-6 px-2 text-[10px] flex items-center gap-1"
            :class="centrePane === 'editor' ? 'ia-btn-primary' : ''"
            @click="showCentre('editor')"
          >
            <TablerIcon name="file-text" :size="11" />
            Editor
          </button>
          <button
            type="button"
            class="ia-btn h-6 px-2 text-[10px] flex items-center gap-1"
            :class="centrePane === 'preview' ? 'ia-btn-primary' : ''"
            @click="showCentre('preview')"
          >
            <TablerIcon name="world" :size="11" />
            Preview
          </button>
          <button
            type="button"
            class="ia-btn h-6 px-2 text-[10px] flex items-center gap-1"
            :class="powerPane === 'git' ? 'ia-btn-primary' : ''"
            @click="showPane(powerPane === 'git' ? centrePane : 'git')"
          >
            <TablerIcon name="history" :size="11" />
            Git
          </button>
          <button
            type="button"
            class="ia-btn h-6 px-2 text-[10px] flex items-center gap-1 ml-auto"
            :title="terminalVisible ? 'Hide the terminal' : 'Show the terminal'"
            @click="toggleTerminal()"
          >
            <TablerIcon :name="terminalVisible ? 'chevron-down' : 'chevron-right'" :size="11" />
            Terminal
          </button>
        </div>
        <div class="flex-1 min-h-0">
          <GitPane v-if="powerPane === 'git'" />
          <PreviewPane v-else-if="centrePane === 'preview'" />
          <EditorPane v-else />
        </div>
      </section>

      <aside class="w-[360px] xl:w-[420px] shrink-0 min-h-0 flex flex-col">
        <ConversationPane class="flex-1 min-h-0" />
      </aside>
    </div>

    <div v-if="terminalVisible" class="h-64 shrink-0 border-t border-[var(--color-line)]">
      <TerminalPane />
    </div>
  </div>

  <!-- < 1024 px: the same panes, one at a time. -->
  <div v-else class="flex-1 flex flex-col min-h-0">
    <nav class="flex items-stretch gap-1 px-2 py-1.5 border-b border-[var(--color-line)] shrink-0 overflow-x-auto">
      <button
        v-for="tab in POWER_PANES"
        :key="tab.id"
        type="button"
        class="ia-btn h-7 px-2.5 text-[10px] flex items-center gap-1 shrink-0"
        :class="powerPane === tab.id ? 'ia-btn-primary' : ''"
        @click="showPane(tab.id)"
      >
        <TablerIcon :name="tab.icon" :size="12" />
        {{ tab.label }}
      </button>
    </nav>
    <div class="flex-1 min-h-0">
      <FilesPane v-if="powerPane === 'files'" tree-only />
      <EditorPane v-else-if="powerPane === 'editor'" />
      <PreviewPane v-else-if="powerPane === 'preview'" />
      <GitPane v-else-if="powerPane === 'git'" />
      <TerminalPane v-else-if="powerPane === 'terminal'" />
      <ConversationPane v-else />
    </div>
  </div>
</template>
