<script setup lang="ts">
/**
 * The locked receipt — §7's "the source keeps a locked receipt (name, avatar, when and where it
 * went)", painted instead of the shell.
 *
 * WHY THE AGENT IS STILL HERE AND STILL LOCKED. Deleting it would make a move whose far side quietly
 * failed into an agent nobody has; leaving it running would make two live copies, which is the merge
 * problem §7 exists to avoid. So the bytes stay in OPFS untouched and the SHELL declines to open
 * them. Both ways out are on this screen, and the second one names its own risk rather than hiding
 * behind a disabled button — it is the person's agent and the person's call.
 */
import { computed, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { receiptLine } from "../lib/move.js";
import { carriedLine } from "../lib/vault-policy.js";
import { isBundleFilename } from "../lib/backup.js";
import { backupBusy, backupError, importBackup } from "../state/backup.js";
import {
  bringingBack,
  closeBringBack,
  moveReceipt,
  openBringBack,
  unlockAnyway,
} from "../state/move.js";

const secret = ref("");
const chosen = ref<File | null>(null);
const confirmingUnlock = ref(false);

const receipt = computed(() => moveReceipt.value);
/**
 * §7.1's road leaves the same receipt with one more fact in it: the agent went over a live channel,
 * not as a file in Downloads. It matters on this screen and nowhere else — "moved to your Mac" and a
 * file name are the wrong sentence for an agent that walked to a phone in the next room, and "look
 * for the file" is advice that will not find anything.
 */
const wentLive = computed(() => receipt.value?.via === "live");
const line = computed(() =>
  !receipt.value
    ? ""
    : wentLive.value && receipt.value.releasedAt === null
      ? `Moved live on ${receipt.value.movedAt.slice(0, 10)}.`
      : receiptLine(receipt.value),
);
const looksWrong = computed(() => chosen.value !== null && !isBundleFilename(chosen.value.name));
/**
 * What the move did with the vault (§4.5, gap audit A2). Undefined on a receipt written before the
 * tick existed, and then nothing is said — inventing "your secrets stayed here" for a bundle that may
 * well have carried them is the one answer worse than silence.
 */
const secretsLine = computed(() =>
  receipt.value?.carried === undefined ? null : carriedLine(receipt.value.carried),
);

function pickFile(event: Event): void {
  chosen.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function doRestore(): Promise<void> {
  if (!chosen.value) return;
  // `importBackup` takes the lock off the receipt on success; the reload then boots into an agent.
  if (await importBackup(chosen.value, secret.value)) location.reload();
}
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-8 space-y-6">
      <div class="flex flex-col items-center text-center gap-3">
        <div class="text-4xl">{{ receipt?.emoji ?? "🟢" }}</div>
        <div>
          <div class="text-[16px] font-semibold">{{ receipt?.displayName ?? "Your agent" }}</div>
          <div class="text-[11px] font-mono text-[var(--color-ink-dim)]">{{ receipt?.agentId }}</div>
        </div>
        <div
          class="flex items-center gap-1.5 text-[12px] text-[var(--color-phosphor)] border border-[var(--color-line)] rounded-full px-3 py-1"
        >
          <TablerIcon name="device-laptop" :size="14" />
          {{ line }}
        </div>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed max-w-sm">
          {{ wentLive ? "It runs on the other device now." : "It runs on your Mac now." }} Its files
          are still here, untouched and asleep, so that only one copy is ever live.
        </p>
        <div v-if="receipt?.fileName" class="text-[11px] font-mono text-[var(--color-ink-dim)] break-all">
          <span v-if="wentLive">it travelled as </span>{{ receipt.fileName }}
        </div>
        <p v-if="secretsLine" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed max-w-sm">
          {{ secretsLine }}
        </p>
      </div>

      <section class="panel px-3 py-3 space-y-2">
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">Bring it back</h2>
        <template v-if="!bringingBack">
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            Export it from 00 on your Mac, then open the file here. This browser becomes its home
            again and the Mac's copy stops being the live one.
          </p>
          <p v-if="wentLive" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            Or move it back the way it came: on the device that has it choose <strong>Move live</strong>,
            and receive it here from Connections.
          </p>
          <button
            type="button"
            class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
            @click="openBringBack()"
          >
            <TablerIcon name="arrow-back-up" :size="13" />
            Bring it back
          </button>
        </template>
        <template v-else>
          <input type="file" accept=".00agent" class="ia-input text-[11px]" @change="pickFile" />
          <p v-if="looksWrong" class="text-[11px] text-[var(--color-amber)]">
            That is not a .00agent file — try the one 00 exported.
          </p>
          <input v-model="secret" type="password" class="ia-input text-[12px]" placeholder="Its code or passphrase" />
          <div class="flex gap-2">
            <button type="button" class="ia-btn flex-1 h-8 text-[11px]" @click="closeBringBack()">Cancel</button>
            <button
              type="button"
              class="ia-btn ia-btn-primary flex-1 h-8 text-[11px]"
              :disabled="!chosen || !secret || backupBusy"
              @click="doRestore()"
            >
              {{ backupBusy ? "Opening…" : "Open it here" }}
            </button>
          </div>
          <p v-if="backupError" class="text-[11px] text-[var(--color-red)] leading-relaxed">{{ backupError }}</p>
        </template>
      </section>

      <section class="panel px-3 py-3 space-y-2">
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">Unlock anyway</h2>
        <template v-if="!confirmingUnlock">
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            If the move did not work, or you want this copy back without the file, you can wake it
            where it is.
          </p>
          <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="confirmingUnlock = true">
            Unlock anyway
          </button>
        </template>
        <template v-else>
          <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">
            If your Mac is running it too, you will have two agents that both think they are the real
            one. Their memories, files and sessions drift apart from this moment, and nothing merges
            them back together. Do this only if the Mac's copy is gone or you will delete it.
          </p>
          <div class="flex gap-2">
            <button type="button" class="ia-btn flex-1 h-8 text-[11px]" @click="confirmingUnlock = false">
              Cancel
            </button>
            <button type="button" class="ia-btn ia-btn-danger flex-1 h-8 text-[11px]" @click="unlockAnyway()">
              I understand — unlock it
            </button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
