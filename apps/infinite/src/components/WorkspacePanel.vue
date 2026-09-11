<script setup lang="ts">
/**
 * THE WORKSPACE — files, editor, preview, Git and the terminal, beside the thread.
 *
 * WHY ONE COMPONENT AT EVERY WIDTH. The panes are identical whether this is a column on a desk or
 * the whole screen on a phone; only the box around it changes, and that box is `App.vue`'s. Two
 * components would mean two places to add the next pane and two places to forget it — the plan's
 * rule is that there is no phone build and no desktop build (§1).
 *
 * THE TREE HANDS OFF TO THE EDITOR. Opening a file in the Files tab moves to the Editor tab, because
 * a panel this narrow cannot show both and a person who clicked a file meant "show me the file".
 */
import { watch } from "vue";
import EditorPane from "./EditorPane.vue";
import FilesPane from "./FilesPane.vue";
import GitPane from "./GitPane.vue";
import PreviewPane from "./PreviewPane.vue";
import TablerIcon from "./TablerIcon.vue";
import TerminalPane from "./TerminalPane.vue";
import { WORKSPACE_PANES, powerPane, setPower, showPane } from "../state/layout.js";
import { selectedPath } from "../state/files.js";

withDefaults(defineProps<{ closable?: boolean }>(), { closable: true });

watch(selectedPath, (path) => {
  if (path && powerPane.value === "files") showPane("editor");
});
</script>

<template>
  <section class="h-full flex flex-col min-h-0" :style="{ background: 'var(--color-void)' }">
    <!-- The tabs scroll; the close button does not. On a 375 px screen the strip is wider than the
         pane, and a Close that scrolled away with it would be a door you have to go looking for. -->
    <div class="flex items-center gap-1 pl-2 pr-1 h-11 border-b border-[var(--color-line)] shrink-0">
      <div class="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto ia-scroll">
        <button
          v-for="tab in WORKSPACE_PANES"
          :key="tab.id"
          type="button"
          class="ia-btn ia-btn-ghost h-7 px-2.5 text-[12px] gap-1.5 shrink-0"
          :class="powerPane === tab.id ? 'ia-btn-on' : ''"
          @click="showPane(tab.id)"
        >
          <TablerIcon :name="tab.id === 'terminal' ? 'terminal-2' : tab.icon" :size="13" />
          {{ tab.label }}
        </button>
      </div>
      <button
        v-if="closable"
        type="button"
        class="ia-btn ia-btn-ghost w-7 h-7 shrink-0"
        title="Close the workspace"
        @click="setPower(false)"
      >
        <TablerIcon name="x" :size="14" />
      </button>
    </div>

    <div class="flex-1 min-h-0">
      <FilesPane v-if="powerPane === 'files'" tree-only />
      <EditorPane v-else-if="powerPane === 'editor'" />
      <PreviewPane v-else-if="powerPane === 'preview'" />
      <GitPane v-else-if="powerPane === 'git'" />
      <TerminalPane v-else-if="powerPane === 'terminal'" />
    </div>
  </section>
</template>
