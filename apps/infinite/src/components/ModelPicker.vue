<script setup lang="ts">
/**
 * THE PICKER BEHIND THE COMPOSER'S CHIP — every brain that can answer, in one list.
 *
 * WHY ONE COMPONENT FOR TWO PLACES. The Local AI card in Connections and the chip in the composer
 * are asking the same question ("which model runs in this browser") and were answering it with two
 * lists that could drift. `section="local"` renders only the mirror's rows, which is what the card
 * needs; `section="all"` adds the class control, `Automatic`, and the configured cloud brains, which
 * is what the composer needs. One markup, one set of words, one download.
 *
 * The shape is the 00 web UI's anchored panel (packages/web-vue/src/components/ThinkingPicker.vue,
 * ComposerCreditsChip.vue): a bordered surface over the void, rows that are buttons, the current one
 * marked rather than styled into a different kind of thing. It is capped in height and scrolls,
 * because seven model rows and four brains do not fit above a composer on a 375px screen.
 */
import { computed } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { BRAIN_CLASSES, type BrainPreference } from "../lib/model-chip.js";
import { cards, selectedBrain } from "../state/connections.js";
import {
  localAvailable,
  localCatalogSource,
  localPicker,
  localRows,
  localRowsBusy,
  localRowsError,
  loadLocalRows,
} from "../state/local-models.js";
import {
  autoLine,
  brainPreference,
  chooseCloudBrain,
  pendingNote,
  pickLocalRow,
  preloadBusy,
  preloadError,
  setBrainPreference,
  useAutomatic,
} from "../state/model-choice.js";

const props = withDefaults(defineProps<{ section?: "all" | "local" }>(), { section: "all" });

const ICONS: Record<string, string> = { local: "cpu", sponsored: "sparkles", overblast: "cloud", byok: "key", remote: "device-laptop" };
const TONE_CLASS = {
  ok: "text-[var(--color-phosphor)]",
  busy: "text-[var(--color-cyan)]",
  warn: "text-[var(--color-amber)]",
  off: "text-[var(--color-ink-dim)]",
} as const;

const showAll = computed(() => props.section === "all");
const isAuto = computed(() => selectedBrain.value === "auto");

function choose(id: string): void {
  void chooseCloudBrain(id);
}
</script>

<template>
  <div class="text-[12px]">
    <!-- B20: which CLASS the next turns ask for. Not a cap — the run still answers on what is
         ready, and the line under the answer says which class actually did. -->
    <template v-if="showAll">
      <div class="flex items-center justify-between mb-1.5">
        <span class="ia-label font-pixel">next turns</span>
      </div>
      <div class="flex rounded-lg border border-[var(--color-line)] overflow-hidden mb-2">
        <button
          v-for="option in BRAIN_CLASSES"
          :key="option.id"
          type="button"
          class="flex-1 h-7 text-[11px] transition-colors"
          :class="
            brainPreference === option.id
              ? 'bg-[color-mix(in_srgb,var(--color-phosphor)_14%,transparent)] text-[var(--color-phosphor)]'
              : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-2)]'
          "
          :title="option.hint"
          @click="setBrainPreference(option.id as BrainPreference)"
        >
          {{ option.label }}
        </button>
      </div>

      <div class="ia-label font-pixel mb-1.5">brain</div>

      <button
        type="button"
        class="w-full text-left px-2.5 py-2 rounded-lg border mb-1.5"
        :class="isAuto ? 'border-[var(--color-phosphor)] bg-[color-mix(in_srgb,var(--color-phosphor)_8%,transparent)]' : 'border-[var(--color-line)] hover:bg-[var(--color-panel-2)]'"
        @click="useAutomatic()"
      >
        <div class="flex items-center gap-1.5">
          <TablerIcon name="brain" :size="14" class="shrink-0 text-[var(--color-ink-dim)]" />
          <span class="font-medium">Automatic</span>
          <TablerIcon v-if="isAuto" name="check" :size="12" class="text-[var(--color-phosphor)]" />
        </div>
        <div class="text-[11px] text-[var(--color-ink-dim)] mt-0.5">{{ autoLine }}</div>
      </button>

      <button
        v-for="card in cards"
        :key="card.peer.id"
        type="button"
        class="w-full text-left px-2.5 py-2 rounded-lg border mb-1.5"
        :class="[
          card.selected && !isAuto
            ? 'border-[var(--color-phosphor)] bg-[color-mix(in_srgb,var(--color-phosphor)_8%,transparent)]'
            : 'border-[var(--color-line)] hover:bg-[var(--color-panel-2)]',
          card.unreachable ? 'opacity-60' : '',
        ]"
        @click="choose(card.handle?.id ?? card.peer.id)"
      >
        <div class="flex items-center gap-1.5">
          <TablerIcon :name="ICONS[card.peer.id]" :size="14" class="shrink-0" :class="TONE_CLASS[card.tone]" />
          <span class="font-medium truncate">{{ card.peer.label }}</span>
          <TablerIcon v-if="card.selected && !isAuto" name="check" :size="12" class="text-[var(--color-phosphor)]" />
        </div>
        <div class="text-[11px] mt-0.5" :class="TONE_CLASS[card.tone]">
          {{ card.unreachable ?? card.status }}
        </div>
      </button>
    </template>

    <!-- LOCAL: the mirror's rows. The same list, the same licence lines and the same choice as the
         Local AI card — §12.7's picker, mounted twice. -->
    <div class="flex items-center justify-between mt-2 mb-1.5">
      <span class="ia-label font-pixel">local models</span>
      <button
        type="button"
        class="text-[10px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
        :disabled="localRowsBusy"
        @click="loadLocalRows(true)"
      >
        {{ localRowsBusy ? "checking…" : "refresh" }}
      </button>
    </div>

    <p v-if="!localAvailable" class="text-[11px] text-[var(--color-amber)]">
      This deployment serves no model weights, so the local brain is web-llm's Llama 3.2 only.
    </p>
    <p v-else-if="!localPicker" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
      On a phone your agent uses one small model, chosen to fit the memory a phone has. Bigger models
      are offered on a computer.
    </p>
    <template v-else>
      <p v-if="localRowsError" class="text-[11px] text-[var(--color-red)]">{{ localRowsError }}</p>
      <p v-else-if="localCatalogSource === 'offline'" class="text-[11px] text-[var(--color-amber)]">
        The model list could not be reached, so these are the ones this app was built knowing.
      </p>
      <p v-else-if="localRowsBusy && !localRows.length" class="text-[11px] text-[var(--color-ink-dim)]">
        Asking the mirror what it serves…
      </p>

      <div class="space-y-1.5">
        <button
          v-for="entry in localRows"
          :key="entry.row.id"
          type="button"
          class="w-full text-left px-2.5 py-2 rounded-lg border"
          :class="
            entry.selected
              ? 'border-[var(--color-phosphor)] bg-[color-mix(in_srgb,var(--color-phosphor)_8%,transparent)]'
              : 'border-[var(--color-line)] hover:bg-[var(--color-panel-2)]'
          "
          @click="pickLocalRow(entry.row)"
        >
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[12px] font-medium">{{ entry.row.label }}</span>
            <TablerIcon v-if="entry.selected" name="check" :size="12" class="text-[var(--color-phosphor)]" />
            <span class="text-[11px] text-[var(--color-ink-dim)]">{{ entry.size }}</span>
            <span v-if="entry.vision" class="text-[10px] px-1 rounded bg-[var(--color-line)]">vision</span>
            <span v-if="entry.downloaded" class="text-[10px] text-[var(--color-phosphor)]">on this device</span>
          </div>
          <div class="text-[11px] text-[var(--color-ink-dim)] mt-0.5">
            <!-- Gemma §3.1: the licence and its use restrictions are named BEFORE the download,
                 per row, because the rows do not all carry the same terms. -->
            <a class="underline" :href="entry.licenseUrl" target="_blank" rel="noopener" @click.stop>{{ entry.licenseName }}</a>
            <template v-if="entry.useRestrictionsUrl">
              ·
              <a class="underline" :href="entry.useRestrictionsUrl" target="_blank" rel="noopener" @click.stop>use restrictions</a>
            </template>
            <template v-if="entry.termsCopyUrl">
              ·
              <a class="underline" :href="entry.termsCopyUrl" target="_blank" rel="noopener" @click.stop>copy</a>
            </template>
            <span v-if="entry.estimated"> · size estimated</span>
          </div>
        </button>
      </div>
      <p v-if="pendingNote" class="text-[11px] text-[var(--color-ink-dim)] mt-1.5">{{ pendingNote }}.</p>
      <p v-if="preloadBusy" class="text-[11px] text-[var(--color-cyan)] mt-1.5">
        Downloading — you can keep typing; the answer waits for it.
      </p>
      <p v-if="preloadError" class="text-[11px] text-[var(--color-red)] mt-1.5">{{ preloadError }}</p>
    </template>
  </div>
</template>
