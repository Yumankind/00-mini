<script setup lang="ts">
/**
 * "THIS COMPUTER" — §14's card, above the Mac card in Connections.
 *
 * FOUR STATES, FOUR DIFFERENT THINGS TO DO, and the card shows exactly one of them:
 *   · a phone renders NOTHING (`companionHidden`): there is no `00d` to find, and a card that says
 *     "not running" on a device that cannot run it is noise pretending to be information.
 *   · unreachable → the one-liner to paste, with Copy, and the sentence that says which of the two
 *     things went wrong (nothing installed, nothing running, or Safari's mixed-content rule, which
 *     no install fixes and which therefore gets its own note and no command).
 *   · found → the six words. Nothing else: the person is standing at a terminal that just printed
 *     them.
 *   · paired → the engine's name, what the grant is worth as chips, and Disconnect.
 *
 * NOTHING HERE DECIDES ANYTHING. The states, the polling, the signing and the pairing all live in
 * `src/state/companion.ts` and `src/companion/`; this file asks, shows and calls.
 */
import { computed, onMounted, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { profile } from "../state/agent.js";
import {
  companionBusy,
  companionDeviceFp,
  companionHidden,
  companionName,
  companionProblem,
  companionScopes,
  companionStatus,
  connect,
  disconnect,
  probeCompanionNow,
} from "../state/companion.js";
import { SAFARI_LOCALHOST_REASON } from "../companion/probe.js";

/** The one line §14.1 asks a person to paste. Installs nothing that is already there. */
const INSTALL_LINE = "curl -fsSL https://0-0.chat/install.sh | bash && 00d companion";

const code = ref("");
const copied = ref(false);

// The WATCH belongs to the app (App.vue), because the Git pane and the terminal read the same
// status and a card that owned the timer would leave them stale the moment it was closed. What the
// card owns is one fresh ask on open: someone who just ran `00d companion` in a terminal should not
// wait out the poll to see it.
onMounted(() => {
  void probeCompanionNow();
});

const status = computed(() => companionStatus.value);
const safari = computed(() => companionProblem.value === SAFARI_LOCALHOST_REASON);
/** Six words, as the engine mints them. Checked here only so the button is not pressed on nothing. */
const codeReady = computed(() => code.value.trim().split(/[\s-]+/).filter(Boolean).length >= 3);

async function copyLine(): Promise<void> {
  try {
    await navigator.clipboard.writeText(INSTALL_LINE);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* a browser that refuses the clipboard still shows the line to select by hand */
  }
}

async function submit(): Promise<void> {
  const entered = code.value;
  if (!codeReady.value) return;
  const ok = await connect(entered, { agentId: profile.value?.id ?? "" });
  if (ok) code.value = "";
}
</script>

<template>
  <section v-if="!companionHidden">
    <h2 class="ia-label font-pixel mb-2">This computer</h2>

    <!-- Paired: what it is, what it is worth, and how to end it. -->
    <div v-if="status === 'paired'" class="panel px-3 py-3 space-y-2">
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-[var(--color-phosphor)] shrink-0" />
        <span class="text-[12px] font-semibold truncate">{{ companionName }}</span>
        <span class="text-[10px] text-[var(--color-ink-faint)] font-mono ml-auto truncate">
          {{ companionDeviceFp.slice(0, 8) }}
        </span>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap">
        <span
          v-for="scope in companionScopes"
          :key="scope"
          class="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[var(--color-panel-2)] text-[var(--color-ink-dim)]"
        >
          {{ scope }}
        </span>
        <span v-if="!companionScopes.length" class="text-[10px] text-[var(--color-ink-dim)]">no scopes granted</span>
      </div>
      <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
        Git can reach github and friends through this computer, and the agent can read a URL from
        this network. Nothing else: it cannot run a command or open a folder here.
      </p>
      <button type="button" class="ia-btn w-full h-8 text-[11px]" :disabled="companionBusy" @click="disconnect()">
        Disconnect
      </button>
    </div>

    <!-- Found, not paired: the six words from the terminal. -->
    <div v-else-if="status === 'found'" class="panel px-3 py-3 space-y-2">
      <div class="flex items-center gap-2">
        <TablerIcon name="plug-connected" :size="15" class="shrink-0 text-[var(--color-phosphor)]" />
        <span class="text-[12px] truncate">{{ companionName }} is running here.</span>
      </div>
      <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
        Type <span class="font-mono">00d companion</span> in a terminal and enter the six words it
        prints. They work once, for two minutes.
      </p>
      <form class="flex gap-1.5" @submit.prevent="submit()">
        <input
          v-model="code"
          class="ia-input flex-1 h-8 text-[11px] font-mono"
          placeholder="amber-lantern-quiet-fox-river-stone"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit" class="ia-btn h-8 px-3 text-[11px]" :disabled="companionBusy || !codeReady">
          Connect
        </button>
      </form>
      <p v-if="companionProblem" class="text-[11px] text-[var(--color-amber)] leading-relaxed">
        {{ companionProblem }}
      </p>
    </div>

    <!-- Probing, or never asked. -->
    <div v-else-if="status === 'probing' || status === 'idle'" class="panel px-3 py-3 flex items-center gap-2">
      <TablerIcon name="plug-connected" :size="15" class="shrink-0 text-[var(--color-ink-faint)]" />
      <span class="text-[11px] text-[var(--color-ink-dim)] ia-pulse">Looking for 00 on this computer…</span>
    </div>

    <!-- Unreachable: the one-liner, or Safari's own note. -->
    <div v-else class="panel px-3 py-3 space-y-2">
      <div class="flex items-start gap-2">
        <TablerIcon name="plug-connected" :size="15" class="mt-0.5 shrink-0 text-[var(--color-ink-faint)]" />
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Run 00 on this computer and your agent gets Git (clone, push, pull) and can read a URL from
          your own network. Nothing is installed in this browser.
        </p>
      </div>

      <template v-if="safari">
        <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">{{ companionProblem }}</p>
      </template>
      <template v-else>
        <!-- The button is UNDER the line, not floating over it: the command is long enough to wrap in
             a 512 px column, and a Copy button on top of the wrapped text hides the end of it. -->
        <pre
          class="ia-input text-[10.5px] font-mono leading-relaxed whitespace-pre-wrap break-all px-2 py-2"
        >{{ INSTALL_LINE }}</pre>
        <button type="button" class="ia-btn w-full h-7 text-[10px]" @click="copyLine()">
          {{ copied ? "Copied" : "Copy this line" }}
        </button>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Already installed? Run <span class="font-mono">00d companion</span>.
        </p>
        <p v-if="companionProblem" class="text-[10px] text-[var(--color-ink-faint)] leading-relaxed">
          {{ companionProblem }}
        </p>
      </template>
    </div>
  </section>
</template>
