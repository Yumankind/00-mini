<script setup lang="ts">
/**
 * The unlock prompt — asked EVERY time the person enters (§4.5), and the create flow behind it.
 *
 * The passkey option is offered only where the browser will actually do it, and the fall back to a
 * password is one click, never a dead end: an authenticator that refuses PRF is common, and a person
 * who cannot get past this screen has lost their agent.
 */
import { computed, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { passwordProblem } from "../lib/vault-policy.js";
import { agent } from "../state/agent.js";
import { createVaultWith, unlock, vaultBusy, vaultError, vaultState, vaultUnlockPrompt } from "../state/vault.js";

const password = ref("");
const confirm = ref("");
const mode = ref<"password" | "passkey">("password");

const creating = computed(() => !vaultState.value.exists);
const passkeyOffered = computed(() => agent.value?.passkeyPossible() ?? false);
const problem = computed(() => {
  if (!creating.value || mode.value === "passkey") return null;
  return passwordProblem(password.value) ?? (password.value === confirm.value ? null : "The two do not match.");
});

async function submit(): Promise<void> {
  if (creating.value) {
    if (mode.value === "passkey") {
      await createVaultWith("passkey");
      return;
    }
    if (problem.value) return;
    await createVaultWith("password", password.value);
    password.value = "";
    confirm.value = "";
    return;
  }
  const ok = await unlock(vaultState.value.kind === "passkey" ? undefined : password.value);
  if (ok) password.value = "";
}
</script>

<template>
  <div class="h-full flex items-center justify-center px-6">
    <div class="w-full max-w-sm">
      <div class="flex items-center gap-2.5 mb-1">
        <TablerIcon name="lock" :size="18" class="text-[var(--color-phosphor)]" />
        <h1 class="text-[15px] font-semibold">
          {{ creating ? "Seal your keys" : vaultUnlockPrompt }}
        </h1>
      </div>
      <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed mb-5">
        <template v-if="creating">
          Keys, tokens and sign-ins are stored only under something you hold — never under something
          this browser holds for you. Nothing about it is stored, so there is no way to recover it.
        </template>
        <template v-else>
          Your vault is asked for every time you come back. Nothing about the password is stored.
        </template>
      </p>

      <div v-if="creating && passkeyOffered" class="flex gap-1 mb-3">
        <button
          type="button"
          class="ia-btn flex-1 h-8 text-[11px] flex items-center justify-center gap-1.5"
          :class="mode === 'password' ? 'ia-btn-on' : ''"
          @click="mode = 'password'"
        >
          <TablerIcon name="key" :size="13" /> Password
        </button>
        <button
          type="button"
          class="ia-btn flex-1 h-8 text-[11px] flex items-center justify-center gap-1.5"
          :class="mode === 'passkey' ? 'ia-btn-on' : ''"
          @click="mode = 'passkey'"
        >
          <TablerIcon name="fingerprint" :size="13" /> Passkey
        </button>
      </div>

      <form class="space-y-2" @submit.prevent="submit()">
        <template v-if="!(creating && mode === 'passkey') && vaultState.kind !== 'passkey'">
          <input
            v-model="password"
            type="password"
            class="ia-input text-[13px]"
            autocomplete="current-password"
            placeholder="Password"
          />
          <input
            v-if="creating"
            v-model="confirm"
            type="password"
            class="ia-input text-[13px]"
            autocomplete="new-password"
            placeholder="Again"
          />
        </template>
        <p v-else class="text-[11px] text-[var(--color-ink-dim)]">
          Your face or fingerprint, on this device. A passkey-held vault cannot travel — that is what
          makes it device-bound.
        </p>

        <p v-if="problem" class="text-[11px] text-[var(--color-amber)]">{{ problem }}</p>
        <p v-if="vaultError" class="text-[11px] text-[var(--color-red)]">{{ vaultError }}</p>

        <button type="submit" class="ia-btn ia-btn-primary w-full h-9 text-[12px]" :disabled="vaultBusy || !!problem">
          {{ vaultBusy ? "Working…" : creating ? "Create the vault" : "Unlock" }}
        </button>
      </form>

      <p v-if="creating" class="mt-4 text-[10px] text-[var(--color-ink-dim)] leading-relaxed">
        You can skip this and come back to it in Settings — the local brain, your files and your
        sessions need no vault at all.
      </p>
    </div>
  </div>
</template>
