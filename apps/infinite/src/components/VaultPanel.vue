<script setup lang="ts">
/**
 * The vault, in Settings — §4.5.
 *
 * It shows three things and nothing else: how it is held, the NAMES it holds (never a value, not even
 * masked past four characters), and `Lock now`. The travel note is here rather than in the export flow
 * because it is a property of the vault, and someone deciding how to seal it should know before they
 * are standing in front of a download.
 */
import TablerIcon from "./TablerIcon.vue";
import { exportDefaultLine } from "../lib/vault-policy.js";
import { agent } from "../state/agent.js";
import {
  createVaultWith,
  lockNow,
  removeSecret,
  secretNames,
  vaultBusy,
  vaultError,
  vaultIdleLine,
  vaultKindLabel,
  vaultState,
  vaultTravelNote,
} from "../state/vault.js";
import { ref } from "vue";

const password = ref("");
const showCreate = ref(false);
</script>

<template>
  <section>
    <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Vault</h2>
    <div class="panel px-3 py-3 space-y-2.5">
      <div class="flex items-center gap-2">
        <TablerIcon
          :name="vaultState.unlocked ? 'lock-open' : 'lock'"
          :size="16"
          :class="vaultState.unlocked ? 'text-[var(--color-phosphor)]' : 'text-[var(--color-ink-dim)]'"
        />
        <div class="min-w-0 flex-1">
          <div class="text-[12px]">{{ vaultKindLabel }}</div>
          <div class="text-[11px] text-[var(--color-ink-dim)]">
            {{ vaultState.exists ? (vaultState.unlocked ? "Unlocked" : "Locked") : "Nothing sealed yet" }}
          </div>
        </div>
        <button
          v-if="vaultState.unlocked"
          type="button"
          class="ia-btn h-7 px-2.5 text-[11px] shrink-0"
          @click="lockNow()"
        >
          Lock now
        </button>
      </div>

      <p v-if="vaultIdleLine" class="text-[11px] text-[var(--color-amber)]">{{ vaultIdleLine }}</p>
      <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">{{ vaultTravelNote }}</p>
      <!-- The DEFAULT, said here because this is where a person decides how to seal a vault and not
           only when they are standing in front of a download (§4.5, gap audit A2). -->
      <p v-if="vaultState.exists" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
        {{ exportDefaultLine() }}
      </p>

      <div v-if="secretNames.length" class="space-y-1">
        <div
          v-for="name in secretNames"
          :key="name"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5"
          :style="{ background: 'color-mix(in srgb, var(--color-panel-2) 45%, transparent)' }"
        >
          <TablerIcon name="key" :size="13" class="text-[var(--color-ink-dim)] shrink-0" />
          <span class="text-[11px] font-mono truncate">{{ name }}</span>
          <span class="ml-auto text-[10px] text-[var(--color-ink-dim)] shrink-0">sealed</span>
          <button
            type="button"
            class="ia-btn w-6 h-6 flex items-center justify-center shrink-0"
            :disabled="!vaultState.unlocked"
            title="Forget this secret"
            @click="removeSecret(name)"
          >
            <TablerIcon name="trash" :size="12" />
          </button>
        </div>
        <p class="text-[10px] text-[var(--color-ink-dim)] leading-relaxed">
          Your agent sees these names and never the values; a tool resolves a value at the moment it
          uses it.
        </p>
      </div>

      <template v-if="!vaultState.exists">
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="showCreate = !showCreate">
          Create a vault
        </button>
        <div v-if="showCreate" class="space-y-2">
          <input v-model="password" type="password" class="ia-input text-[12px]" placeholder="Password (8+)" />
          <div class="flex gap-2">
            <button
              type="button"
              class="ia-btn ia-btn-primary flex-1 h-8 text-[11px]"
              :disabled="vaultBusy || password.length < 8"
              @click="createVaultWith('password', password).then(() => (password = ''))"
            >
              With a password
            </button>
            <button
              v-if="agent?.passkeyPossible()"
              type="button"
              class="ia-btn flex-1 h-8 text-[11px] flex items-center justify-center gap-1.5"
              :disabled="vaultBusy"
              @click="createVaultWith('passkey')"
            >
              <TablerIcon name="fingerprint" :size="13" /> With a passkey
            </button>
          </div>
        </div>
      </template>

      <p v-if="vaultError" class="text-[11px] text-[var(--color-red)]">{{ vaultError }}</p>
    </div>
  </section>
</template>
