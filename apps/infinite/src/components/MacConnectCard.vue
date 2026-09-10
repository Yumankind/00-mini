<script setup lang="ts">
/**
 * The 00 Mac and the 00 phone — §8.4 and §8.5 — as one card in Connections.
 *
 * TWO DOORS, DELIBERATELY IN ONE PLACE. They are opposite directions of the same protocol and the
 * same relay credential, and a person who has set one up has already done nine tenths of the other.
 * Splitting them would mean asking for the relay key twice and explaining the glance code twice.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule lives in `src/mac/`: what may be signed, what is refused
 * by name, why the glance code is compared rather than typed. This file asks, shows and calls.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { agent, profile } from "../state/agent.js";
import {
  admitPhone,
  chooseMac,
  chooseMacSession,
  closeMacSession,
  connectAsClient,
  loadMacSessions,
  loadRelayToken,
  macAnswering,
  macBusy,
  macChosen,
  macDev,
  macEngineGlance,
  macEngines,
  macEvents,
  macGlance,
  macNote,
  macPhones,
  macProblem,
  macRows,
  macSessionRows,
  macTargetSession,
  macTokenSet,
  mountMacFromOwned,
  refreshPhones,
  saveRelayToken,
  sendToMac,
  startAnswering,
  stopAnswering,
} from "../mac/state.js";
import { ed25519Available } from "../mac/wire.js";
import { RELAY_NOT_CONFIGURED_LINE, relayConfigured } from "../mac/config.js";

const open = ref(false);
const tokenField = ref("");
const draft = ref("");
const supported = ed25519Available();
/**
 * §12.1 has not named the production origin, and a build may point at none at all. Read once, at
 * setup: it is a build-time constant, so a computed would recompute a value that cannot change. The
 * card then says the same thing the live-transfer card says when its rooms are unbuilt — "not
 * connected yet" — instead of offering two doors whose every call is a network error (gap audit A1).
 */
const relayReady = relayConfigured();

/** The wiring call. Done here rather than in the boot so `runtime/bootstrap.ts` stays the file that
 *  constructs packages and nothing else; the line that belongs there is in the handoff note. */
watch(
  () => agent.value,
  (owned) => {
    if (!owned) return;
    mountMacFromOwned(owned);
    void loadRelayToken();
  },
  { immediate: true },
);

const chosen = computed(() => macChosen.value);

onMounted(() => void loadRelayToken());
onUnmounted(() => {
  /* The engine half deliberately keeps polling while the tab lives — see src/mac/answer.ts. */
});

async function send(): Promise<void> {
  const text = draft.value;
  draft.value = "";
  await sendToMac(text);
}
</script>

<template>
  <section>
    <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">00 on your Mac and phone</h2>

    <div v-if="!supported" class="panel px-3 py-3 flex items-start gap-2">
      <TablerIcon name="alert-triangle" :size="15" class="mt-0.5 shrink-0 text-[var(--color-amber)]" />
      <p class="text-[11px] leading-relaxed text-[var(--color-amber)]">
        This browser has no WebCrypto Ed25519, so it cannot sign a command to your Mac. There is no
        fallback on purpose — signing with anything else would be worse than saying so.
      </p>
    </div>

    <div v-else-if="!relayReady" class="panel px-3 py-3 flex items-start gap-2">
      <TablerIcon name="plug-connected" :size="15" class="mt-0.5 shrink-0 text-[var(--color-ink-dim)]" />
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-dim)]">{{ RELAY_NOT_CONFIGURED_LINE }}</p>
    </div>

    <div v-else class="panel px-3 py-3 space-y-3">
      <button type="button" class="w-full flex items-center gap-2 text-left" @click="open = !open">
        <TablerIcon name="plug-connected" :size="15" class="shrink-0" />
        <span class="text-[12px] flex-1">Drive your Mac's agent, or let your phone reach this one</span>
        <TablerIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" class="shrink-0" />
      </button>

      <div v-if="open" class="space-y-4">
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Both directions go through the 00 relay, which never sees a key and cannot read or write a
          command. Sessions are started by the person at the machine — this browser can only ask to be
          admitted.
        </p>

        <!-- The relay credential, sealed like every other key in this app. -->
        <div v-if="!macTokenSet" class="space-y-1.5">
          <label class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)]">Relay key</label>
          <input
            v-model="tokenField"
            type="password"
            autocomplete="off"
            placeholder="Your 00 Cloud account key"
            class="ia-input w-full h-8 text-[11px]"
          />
          <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="saveRelayToken(tokenField)">
            Seal it in the vault
          </button>
        </div>

        <template v-else>
          <!-- ── §8.4: this browser as a client ─────────────────────────────────────────────── -->
          <div class="space-y-2">
            <div class="text-[11px] font-semibold flex items-center gap-1.5">
              <TablerIcon name="device-laptop" :size="13" /> Drive the agent on your Mac
            </div>
            <button
              type="button"
              class="ia-btn w-full h-8 text-[11px]"
              :disabled="macBusy"
              @click="connectAsClient()"
            >
              {{ macDev ? "Refresh what this account can reach" : "Enrol this browser" }}
            </button>
            <div v-if="macDev" class="text-[10px] font-mono text-[var(--color-ink-dim)]">{{ macDev }}</div>
            <p v-if="macNote" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">{{ macNote }}</p>

            <ul v-if="macEngines.length" class="space-y-1">
              <li v-for="row in macEngines" :key="row.engineFp">
                <button
                  v-for="a in row.agents"
                  :key="a.agentId"
                  type="button"
                  class="ia-btn w-full h-8 text-[11px] flex items-center justify-between"
                  :class="chosen.engineFp === row.engineFp && chosen.agentId === a.agentId ? 'ring-1' : ''"
                  @click="chooseMac(row.engineFp, a.agentId)"
                >
                  <span class="truncate">{{ a.displayName || a.agentId }}</span>
                  <span class="text-[10px] text-[var(--color-ink-dim)] truncate">{{ row.label || row.engineFp }}</span>
                </button>
              </li>
            </ul>

            <div v-if="macGlance" class="panel px-2 py-2 space-y-1">
              <div class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)]">Compare with your Mac</div>
              <div class="font-mono text-[14px] tracking-widest">{{ macGlance }}</div>
              <p class="text-[10px] text-[var(--color-ink-dim)] leading-relaxed">
                Both screens work this out on their own; it is never sent. If the two differ, stop.
              </p>
            </div>

            <div v-if="chosen.agentId" class="space-y-2">
              <button type="button" class="ia-btn w-full h-8 text-[11px]" :disabled="macBusy" @click="loadMacSessions()">
                Its sessions
              </button>
              <select
                v-if="macSessionRows.length"
                class="ia-input w-full h-8 text-[11px]"
                :value="macTargetSession"
                @change="chooseMacSession(($event.target as HTMLSelectElement).value)"
              >
                <option value="">Whatever the Mac is on</option>
                <option v-for="s in macSessionRows" :key="s.id" :value="s.id">{{ s.title }}</option>
              </select>

              <div v-if="macRows.length" class="space-y-1.5 max-h-64 ia-scroll">
                <div
                  v-for="row in macRows"
                  :key="row.id"
                  class="text-[11px] leading-relaxed"
                  :class="row.who === 'you' ? 'text-[var(--color-ink-dim)]' : ''"
                >
                  <span class="font-pixel text-[9px] uppercase mr-1.5">{{ row.who === "you" ? "you" : "mac" }}</span>
                  {{ row.text }}
                </div>
              </div>

              <form class="flex gap-1.5" @submit.prevent="send()">
                <input v-model="draft" class="ia-input flex-1 h-8 text-[11px]" placeholder="Ask your Mac's agent" />
                <button type="submit" class="ia-btn h-8 px-3 text-[11px]" :disabled="macBusy || !draft.trim()">Send</button>
              </form>
              <button type="button" class="ia-btn w-full h-8 text-[11px]" :disabled="macBusy" @click="closeMacSession()">
                Close this session
              </button>
            </div>
          </div>

          <!-- ── §8.5: this browser as an engine ───────────────────────────────────────────── -->
          <div class="space-y-2 pt-2 border-t border-[var(--color-line)]">
            <div class="text-[11px] font-semibold flex items-center gap-1.5">
              <TablerIcon name="shield-check" :size="13" /> Let my phone reach {{ profile?.displayName ?? "this agent" }}
            </div>
            <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
              While this tab is open your phone can prompt this agent. Close the tab and nothing is
              lost — the relay holds what your phone sends and this browser answers it next time it
              opens.
            </p>
            <button
              v-if="!macAnswering"
              type="button"
              class="ia-btn w-full h-8 text-[11px]"
              :disabled="macBusy"
              @click="startAnswering()"
            >
              Turn it on
            </button>
            <template v-else>
              <button type="button" class="ia-btn w-full h-8 text-[11px]" :disabled="macBusy" @click="refreshPhones()">
                Refresh enrolled phones
              </button>
              <button
                v-for="p in macPhones"
                :key="p.dev"
                type="button"
                class="ia-btn w-full h-8 text-[11px] flex items-center justify-between"
                :disabled="macBusy"
                @click="admitPhone(p.dev)"
              >
                <span class="truncate">Admit {{ p.label || p.dev }}</span>
                <TablerIcon name="chevron-right" :size="13" />
              </button>
              <p v-if="!macPhones.length" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
                No phone is enrolled on this account yet — open 00 on the phone and sign in to the
                same account.
              </p>
              <div v-if="macEngineGlance" class="panel px-2 py-2 space-y-1">
                <div class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)]">Compare with your phone</div>
                <div class="font-mono text-[14px] tracking-widest">{{ macEngineGlance }}</div>
              </div>
              <ul v-if="macEvents.length" class="space-y-0.5">
                <li v-for="(e, i) in macEvents" :key="i" class="text-[10px] font-mono text-[var(--color-ink-dim)] truncate">
                  {{ e.type }}
                </li>
              </ul>
              <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="stopAnswering()">Turn it off</button>
            </template>
          </div>
        </template>

        <p v-if="macProblem" class="text-[11px] text-[var(--color-amber)] leading-relaxed">{{ macProblem }}</p>
      </div>
    </div>
  </section>
</template>
