<script setup lang="ts">
/**
 * The four peers of §6.1, as cards.
 *
 * Each card leads with what it NEEDS, because that is the decision the person is making. A remote card
 * offline is greyed with one line of why (§4.4) and its form is disabled rather than hidden — hiding
 * it would make the app look like it has fewer options than it does.
 *
 * Nothing here names a price, a plan or a tier: the house rule is that clients render what the
 * contract sends, and the contract for those is the worker's, not ours.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { BYOK_VENDORS, byokProblem, overblastTokenProblem, type BrainId } from "../lib/brains.js";
import type { ByokVendor } from "@00/agent-models";
import { agent } from "../state/agent.js";
import {
  cards,
  chooseBrain,
  connectionsError,
  registerSponsored,
  saveByok,
  saveOverblast,
  selectedBrain,
  startBrainPolling,
} from "../state/connections.js";
import { vaultState } from "../state/vault.js";

const ICONS: Record<BrainId, string> = {
  local: "cpu",
  sponsored: "sparkles",
  overblast: "cloud",
  byok: "key",
};

const TONE_CLASS = {
  ok: "text-[var(--color-phosphor)]",
  busy: "text-[var(--color-cyan)]",
  warn: "text-[var(--color-amber)]",
  off: "text-[var(--color-ink-dim)]",
} as const;

const openCard = ref<BrainId | null>(null);
const notice = ref<string | null>(null);
const failure = ref<string | null>(null);

// Sponsored (§6.2): the account is a passkey account on sponsoredtokens, and this app does not build
// a second sign-in for it. What it CAN do offline-of-that is register this browser as a device.
const appId = ref("");
// Overblast (§6.1 level 2).
const obBase = ref("");
const obModel = ref("");
const obToken = ref("");
// BYOK (§6.1 level 3).
const vendor = ref<ByokVendor>("openai");
const byokKey = ref("");
const byokBase = ref("");
const byokModel = ref("");

const locked = computed(() => !vaultState.value.unlocked);
let stopPolling: (() => void) | null = null;

onMounted(() => {
  const owned = agent.value;
  if (owned) {
    const s = owned.settings();
    appId.value = s.sponsored?.appId ?? "";
    obBase.value = s.overblast?.baseUrl ?? "";
    obModel.value = s.overblast?.model ?? "";
    if (s.byok) {
      vendor.value = s.byok.vendor;
      byokBase.value = s.byok.baseUrl ?? "";
      byokModel.value = s.byok.model;
    }
  }
  stopPolling = startBrainPolling();
});
onBeforeUnmount(() => stopPolling?.());

function toggle(id: BrainId): void {
  openCard.value = openCard.value === id ? null : id;
  notice.value = null;
  failure.value = null;
}

async function run(work: () => Promise<string | void>): Promise<void> {
  notice.value = null;
  failure.value = null;
  try {
    const message = await work();
    notice.value = typeof message === "string" ? message : "Saved.";
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
  }
}

const obProblem = computed(() => (obToken.value ? overblastTokenProblem(obToken.value) : null));
const keyProblem = computed(() =>
  byokKey.value ? byokProblem(vendor.value, byokKey.value, byokBase.value) : null,
);
</script>

<template>
  <section>
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">Brain</h2>
      <button
        type="button"
        class="text-[10px]"
        :class="selectedBrain === 'auto' ? 'text-[var(--color-phosphor)]' : 'text-[var(--color-ink-dim)]'"
        @click="chooseBrain('auto')"
      >
        Automatic
      </button>
    </div>

    <p v-if="connectionsError" class="text-[11px] text-[var(--color-red)] mb-2">{{ connectionsError }}</p>

    <div class="space-y-2">
      <div
        v-for="card in cards"
        :key="card.peer.id"
        class="panel overflow-hidden"
        :class="card.unreachable ? 'ia-unreachable' : ''"
        :style="
          card.selected
            ? { borderColor: 'color-mix(in srgb, var(--color-phosphor) 45%, transparent)' }
            : undefined
        "
      >
        <button type="button" class="w-full flex items-start gap-2.5 px-3 py-2.5 text-left" @click="toggle(card.peer.id)">
          <TablerIcon :name="ICONS[card.peer.id]" :size="17" class="mt-0.5 shrink-0" :class="TONE_CLASS[card.tone]" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[13px] font-medium">{{ card.peer.label }}</span>
              <TablerIcon v-if="card.selected" name="check" :size="12" class="text-[var(--color-phosphor)]" />
            </div>
            <div class="text-[11px]" :class="TONE_CLASS[card.tone]">{{ card.status }}</div>
            <div class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed mt-0.5">
              {{ card.unreachable ?? card.peer.needs }}
            </div>
          </div>
          <TablerIcon
            :name="openCard === card.peer.id ? 'chevron-down' : 'chevron-right'"
            :size="14"
            class="mt-1 shrink-0 text-[var(--color-ink-dim)]"
          />
        </button>

        <div v-if="openCard === card.peer.id" class="px-3 pb-3 space-y-2 border-t border-[var(--color-line)] pt-2.5">
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">{{ card.peer.blurb }}</p>

          <!-- Local: nothing to configure. The download is what it needs, and it starts on first use. -->
          <template v-if="card.peer.id === 'local'">
            <p v-if="card.tone === 'off'" class="text-[11px] text-[var(--color-amber)]">
              This browser has no WebGPU, so the local brain cannot run here. Everything else still works.
            </p>
            <button
              v-else
              type="button"
              class="ia-btn w-full h-8 text-[11px]"
              @click="run(() => chooseBrain('local').then(() => 'Local AI will answer.'))"
            >
              Use the local brain
            </button>
          </template>

          <!-- Sponsored: the passkey account lives on sponsoredtokens; this registers the browser. -->
          <template v-else-if="card.peer.id === 'sponsored'">
            <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
              Sign-in is a passkey account on sponsoredtokens — no email. This browser then registers as
              one device of your app, in a popup on their domain; the private half never leaves here.
            </p>
            <button type="button" class="ia-btn w-full h-8 text-[11px]" disabled>
              Sign in with a passkey — coming with the apps launch
            </button>
            <input v-model="appId" class="ia-input text-[12px]" placeholder="App id" :disabled="!!card.unreachable" />
            <button
              type="button"
              class="ia-btn ia-btn-primary w-full h-8 text-[11px]"
              :disabled="!appId.trim() || !!card.unreachable"
              @click="run(async () => `Registered this browser as device ${await registerSponsored(appId)}.`)"
            >
              Register this browser
            </button>
          </template>

          <!-- Overblast: an sk-obd device token, revocable per browser like a laptop. -->
          <template v-else-if="card.peer.id === 'overblast'">
            <input v-model="obBase" class="ia-input text-[12px]" placeholder="https://<worker>/ai/v1" :disabled="!!card.unreachable" />
            <input v-model="obModel" class="ia-input text-[12px]" placeholder="Model id" :disabled="!!card.unreachable" />
            <input
              v-model="obToken"
              type="password"
              class="ia-input text-[12px] font-mono"
              placeholder="sk-obd-…"
              :disabled="!!card.unreachable"
            />
            <p v-if="obProblem" class="text-[11px] text-[var(--color-amber)]">{{ obProblem }}</p>
            <p v-if="locked" class="text-[11px] text-[var(--color-amber)]">
              Unlock your vault first — the token is only ever stored sealed.
            </p>
            <button
              type="button"
              class="ia-btn ia-btn-primary w-full h-8 text-[11px]"
              :disabled="locked || !!obProblem || !obToken || !!card.unreachable"
              @click="run(() => saveOverblast(obBase, obModel, obToken).then(() => 'Token sealed in your vault.'))"
            >
              Save the token
            </button>
          </template>

          <!-- BYOK: the key is written to the vault or it is not stored at all. -->
          <template v-else>
            <select v-model="vendor" class="ia-input text-[12px]" :disabled="!!card.unreachable">
              <option v-for="v in BYOK_VENDORS" :key="v.id" :value="v.id">{{ v.label }}</option>
            </select>
            <input
              v-if="vendor === 'custom'"
              v-model="byokBase"
              class="ia-input text-[12px]"
              placeholder="https://… (OpenAI-compatible base)"
              :disabled="!!card.unreachable"
            />
            <input v-model="byokModel" class="ia-input text-[12px]" placeholder="Model id" :disabled="!!card.unreachable" />
            <input
              v-model="byokKey"
              type="password"
              class="ia-input text-[12px] font-mono"
              placeholder="API key"
              :disabled="!!card.unreachable"
            />
            <p v-if="keyProblem" class="text-[11px] text-[var(--color-amber)]">{{ keyProblem }}</p>
            <p v-if="locked" class="text-[11px] text-[var(--color-amber)]">
              Unlock your vault first — a key is only ever stored sealed.
            </p>
            <button
              type="button"
              class="ia-btn ia-btn-primary w-full h-8 text-[11px]"
              :disabled="locked || !!keyProblem || !byokKey || !!card.unreachable"
              @click="
                run(() =>
                  saveByok(vendor, byokKey, byokBase, byokModel).then(() => {
                    byokKey = '';
                    return 'Key sealed in your vault.';
                  }),
                )
              "
            >
              Seal the key
            </button>
          </template>

          <p v-if="notice" class="text-[11px] text-[var(--color-phosphor)]">{{ notice }}</p>
          <p v-if="failure" class="text-[11px] text-[var(--color-red)]">{{ failure }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
