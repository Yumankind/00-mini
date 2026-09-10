<script setup lang="ts">
/**
 * Backup and Restore — §3.3 and §7.2 — plus the storage verdict the browser actually gave.
 *
 * The verdict is printed rather than summarised into a reassuring sentence, because a refused
 * `persist()` is the whole reason this panel exists. Restore REPLACES the agent in this browser, so
 * it asks once, in a sentence naming what is about to be lost, and only then accepts the file.
 */
import { computed, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { persistLine, persistTone } from "../lib/durability.js";
import { formatSize } from "../lib/files-tree.js";
import { isBundleFilename } from "../lib/backup.js";
import { agent, checkPersistence, persistence } from "../state/agent.js";
import {
  backupBusy,
  backupError,
  backupNote,
  exportBackup,
  importBackup,
  validateNewPassphrase,
} from "../state/backup.js";

const pass = ref("");
const again = ref("");
const restorePass = ref("");
const chosen = ref<File | null>(null);
const confirming = ref(false);

const problem = computed(() => (pass.value || again.value ? validateNewPassphrase(pass.value, again.value) : null));
const report = computed(() => persistence.value);

function pickFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  chosen.value = file && isBundleFilename(file.name) ? file : file;
  confirming.value = false;
}

async function doExport(): Promise<void> {
  if (problem.value) return;
  if (await exportBackup(pass.value)) {
    pass.value = "";
    again.value = "";
  }
}

async function doRestore(): Promise<void> {
  if (!chosen.value) return;
  const id = await importBackup(chosen.value, restorePass.value);
  if (id) location.reload();
}
</script>

<template>
  <section class="space-y-4">
    <div>
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Storage</h2>
      <div class="panel px-3 py-3 space-y-2">
        <div class="flex items-start gap-2">
          <TablerIcon
            :name="report && persistTone(report) === 'ok' ? 'shield-check' : 'alert-triangle'"
            :size="16"
            class="mt-0.5 shrink-0"
            :class="report && persistTone(report) === 'ok' ? 'text-[var(--color-phosphor)]' : 'text-[var(--color-amber)]'"
          />
          <div class="min-w-0">
            <div class="text-[12px] leading-relaxed">
              {{ report ? persistLine(report) : "This browser has not been asked yet." }}
            </div>
            <div v-if="report?.usage !== undefined" class="text-[11px] text-[var(--color-ink-dim)]">
              {{ formatSize(report.usage) }} used{{ report.quota ? ` of about ${formatSize(report.quota)}` : "" }}
            </div>
          </div>
        </div>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="checkPersistence()">Ask again</button>
      </div>
    </div>

    <div>
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Backup</h2>
      <div class="panel px-3 py-3 space-y-2">
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          One encrypted file with your whole agent in it: files, memory, sessions, standing answers.
          The passphrase you type here is the only key — nobody can recover it, including us.
        </p>
        <input v-model="pass" type="password" class="ia-input text-[12px]" placeholder="Passphrase" />
        <input v-model="again" type="password" class="ia-input text-[12px]" placeholder="Again" />
        <p v-if="problem" class="text-[11px] text-[var(--color-amber)]">{{ problem }}</p>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
          :disabled="backupBusy || !pass || !!problem"
          @click="doExport()"
        >
          <TablerIcon name="download" :size="13" />
          Download {{ agent ? ".00agent" : "" }}
        </button>
      </div>
    </div>

    <div>
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Restore</h2>
      <div class="panel px-3 py-3 space-y-2">
        <input type="file" accept=".00agent" class="ia-input text-[11px]" @change="pickFile" />
        <input v-model="restorePass" type="password" class="ia-input text-[12px]" placeholder="Its passphrase" />
        <template v-if="!confirming">
          <button
            type="button"
            class="ia-btn w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
            :disabled="!chosen || !restorePass"
            @click="confirming = true"
          >
            <TablerIcon name="upload" :size="13" />
            Restore into this browser
          </button>
        </template>
        <template v-else>
          <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">
            This replaces the agent living in this browser — {{ agent?.profile.displayName }} and
            everything it has done here. There is no undo.
          </p>
          <div class="flex gap-2">
            <button type="button" class="ia-btn flex-1 h-8 text-[11px]" @click="confirming = false">Cancel</button>
            <button
              type="button"
              class="ia-btn ia-btn-danger flex-1 h-8 text-[11px]"
              :disabled="backupBusy"
              @click="doRestore()"
            >
              Replace it
            </button>
          </div>
        </template>
      </div>
    </div>

    <p v-if="backupNote" class="text-[11px] text-[var(--color-phosphor)] leading-relaxed">{{ backupNote }}</p>
    <p v-if="backupError" class="text-[11px] text-[var(--color-red)] leading-relaxed">{{ backupError }}</p>
  </section>
</template>
