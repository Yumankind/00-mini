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
import ModelPicker from "./ModelPicker.vue";
import {
  loadLocalRows,
  localChoice,
  localRows,
  localRowsLoaded,
  syncLocalBrain,
  unloadLocal,
} from "../state/local-models.js";
import { downloadPercent, progressLine } from "../lib/readiness.js";
import { vaultState } from "../state/vault.js";

const ICONS: Record<BrainId, string> = {
  local: "cpu",
  sponsored: "sparkles",
  overblast: "cloud",
  byok: "key",
  remote: "device-laptop",
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
  // The phone's one-line note (§12.6) is drawn from the bootstrap's answer, which is copied rather
  // than computed — so it is read once here, before anything is opened.
  syncLocalBrain();
  stopPolling = startBrainPolling();
});
onBeforeUnmount(() => stopPolling?.());

function toggle(id: BrainId): void {
  openCard.value = openCard.value === id ? null : id;
  notice.value = null;
  failure.value = null;
  // The mirror's catalogue is fetched when the card is OPENED, never at boot: a first paint must not
  // wait on a bucket, and a person who never opens Connections never asks it for anything.
  if (openCard.value === "local" && !localRowsLoaded.value) void loadLocalRows();
}

const localCard = computed(() => cards.value.find((c) => c.peer.id === "local") ?? null);
/** The download bar's percentage, out of the TYPED progress the 2026-09-10 revision added. */
const downloadBar = computed(() => {
  const readiness = localCard.value?.handle?.readiness;
  return readiness ? downloadPercent(readiness) : null;
});
const downloadBytes = computed(() => {
  const readiness = localCard.value?.handle?.readiness;
  return readiness ? progressLine(readiness) : null;
});
/** The row the consent line is about: the chosen one, once the catalogue knows it. */
const chosenRow = computed(() => localRows.value.find((r) => r.selected) ?? null);

/**
 * WHICH MODEL THIS CARD IS ABOUT (gap audit A6: "the Local AI card does not name the model it
 * loaded"). The choice is the remembered one, which the catalogue may later dress with a better
 * label; before either exists it is the provider's own default, and saying so is more honest than
 * naming a row nobody picked.
 */
const loadedName = computed(
  () => localChoice.value?.label ?? localChoice.value?.id ?? chosenRow.value?.row.label ?? "The default local model",
);
const loadedState = computed(() => {
  const readiness = localCard.value?.handle?.readiness;
  if (!readiness) return "is the model this browser would use.";
  if (readiness.ready) return "is loaded in this browser and answering.";
  if (readiness.reason === "download") return "is not on this device yet — it downloads with your next message.";
  if (readiness.reason === "unsupported") return "cannot run here.";
  return "is not ready.";
});

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

          <!-- Local: WHICH model, from the mirror (§12.7). A phone gets no picker at all (§12.6). -->
          <template v-if="card.peer.id === 'local'">
            <p v-if="card.tone === 'off'" class="text-[11px] text-[var(--color-amber)]">
              This browser has no WebGPU, so the local brain cannot run here. Everything else still works.
            </p>
            <template v-else>
              <!-- The download bar, from the TYPED progress of the contract revision: bytes when the
                   host said how many there are, and nothing invented when it did not. -->
              <div v-if="downloadBar !== null" class="space-y-1">
                <div class="h-1 rounded-full bg-[var(--color-line)] overflow-hidden">
                  <div class="h-full bg-[var(--color-cyan)]" :style="{ width: `${downloadBar}%` }"></div>
                </div>
                <p class="text-[11px] text-[var(--color-ink-dim)]">{{ downloadBytes ?? `${downloadBar}%` }}</p>
              </div>

              <!-- A6: the card NAMES the model it loaded. "Local AI · ready" said nothing about
                   which two gigabytes are ready, and the person chose them. -->
              <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
                <span class="text-[var(--color-ink)]">{{ loadedName }}</span>
                {{ loadedState }}
              </p>

              <!-- The composer's picker, mounted here: one list, one set of words, one download. -->
              <ModelPicker section="local" />

              <!-- The consent line, about the row that is actually chosen rather than about models
                   in general. The fallback's own licence is named too: the router may reach it. -->
              <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
                <template v-if="chosenRow">
                  {{ chosenRow.row.label }} is published under the
                  <a class="underline" :href="chosenRow.licenseUrl" target="_blank" rel="noopener">{{ chosenRow.licenseName }}</a>
                  <template v-if="chosenRow.useRestrictionsUrl">
                    and its
                    <a class="underline" :href="chosenRow.useRestrictionsUrl" target="_blank" rel="noopener">Prohibited Use Policy</a>
                  </template>
                  <template v-if="chosenRow.termsCopyUrl">
                    (<a class="underline" :href="chosenRow.termsCopyUrl" target="_blank" rel="noopener">copy</a>)</template
                  >. Downloading it accepts them.
                </template>
                <template v-else>
                  Local models run under their publishers' licences, named on each row before it downloads.
                </template>
                The fallback model is Llama 3.2, under the
                <a class="underline" href="https://www.llama.com/llama3_2/license/" target="_blank" rel="noopener">Llama 3.2 Community License</a>.
              </p>

              <button
                type="button"
                class="ia-btn w-full h-8 text-[11px]"
                @click="run(() => chooseBrain('local').then(() => 'Local AI will answer.'))"
              >
                Use the local brain
              </button>
              <button
                type="button"
                class="ia-btn w-full h-8 text-[11px]"
                :disabled="card.tone !== 'ok'"
                @click="run(unloadLocal)"
              >
                Unload — give the GPU back
              </button>
            </template>
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

          <!-- The Mac (§8.4): nothing to set up HERE by design. The session is opened at the Mac by
               the person sitting in front of it, so this card explains and points; the two doors and
               the "Use as a brain" button live on the Mac card below. -->
          <template v-else-if="card.peer.id === 'remote'">
            <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
              The subscription is used on your Mac, by the app you signed in there. This browser only
              asks its agent a question and shows the answer — and it can only ask a Mac that admitted
              it, on the "00 on your Mac and phone" card below.
            </p>
            <button
              type="button"
              class="ia-btn w-full h-8 text-[11px]"
              :disabled="!card.handle?.provider || !!card.unreachable"
              @click="run(() => chooseBrain('remote').then(() => 'Your Mac answers the next message.'))"
            >
              Answer with my Mac
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
