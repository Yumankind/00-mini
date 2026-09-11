<script setup lang="ts">
/**
 * Move — §7's two roads, one panel.
 *
 * WHY ONE STEP AT A TIME AND NOT A FORM. On the FILE road (§7.2) steps 3 and 4 leave the browser: a
 * file lands in Downloads, an OS prompt asks whether to open 00, and neither answers back. A form
 * would show five controls of which four are guesses about what has already happened; a sequence
 * shows the one thing to do now and then asks. The code is shown LARGE because the person types it
 * on the other machine — it is read off this screen, not copied through a clipboard both devices
 * share.
 *
 * WHY THE LIVE ROAD (§7.1) IS BESIDE IT AND NOT INSTEAD OF IT. The live road needs both devices
 * online and a room service that answers; the file road needs neither and works on a plane. So the
 * first screen is a choice between them, in the person's terms ("both devices here, now" versus "a
 * file I carry"), and the file road below is untouched.
 *
 * THE LIVE SCREEN SHOWS TWO DIFFERENT SECRETS AND THEY ARE NOT INTERCHANGEABLE. The six words are
 * what the other device TYPES; the four characters are what both screens SHOW so the person can see
 * that the device that joined is the one in front of them. Neither is ever copied to a clipboard by
 * this panel and neither is logged.
 */
import { computed, onMounted, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import QrCode from "./QrCode.vue";
import {
  answerReplace,
  arrivedVaultLine,
  cancelLive,
  carrySecrets,
  clearReceiveWanted,
  confirmMoved,
  downloadMove,
  liveAvailable,
  liveBusy,
  liveCode,
  liveConfirmation,
  liveError,
  liveIncoming,
  liveNeedsReplace,
  livePhase,
  liveProgress,
  moveBusy,
  moveCode,
  moveDeepLink,
  moveError,
  moveFileName,
  moveStep,
  openIn00,
  prefilledCode,
  receiveWanted,
  resetLive,
  resetMove,
  setCarrySecrets,
  startLiveMove,
  startLiveReceive,
  toCodeStep,
} from "../state/move.js";
import { isMoveCode } from "../lib/move.js";
import { carriedLine } from "../lib/vault-policy.js";
import { vaultCarryOffer } from "../state/vault.js";
import { profile } from "../state/agent.js";

const emit = defineEmits<{ (e: "close"): void }>();

/** Which road this panel is on. `choose` is the first screen; the other three are the roads. */
const road = ref<"choose" | "file" | "live" | "receive">("choose");
const copied = ref(false);
const copiedLink = ref(false);
const typedCode = ref("");
const words = computed(() => moveCode.value.split("-").filter(Boolean));
const liveWords = computed(() => liveCode.value.split("-").filter(Boolean));
const typedLooksRight = computed(() => isMoveCode(typedCode.value.trim().toLowerCase()));
/**
 * §4.5's tick, asked ONCE on the first screen because it is a property of the move and not of the
 * road it takes (gap audit A2). The store refuses it outright when the vault cannot travel, so a
 * passkey vault cannot be ticked into a bundle by a stale checkbox.
 */
const carryOffer = computed(() => vaultCarryOffer.value);
function tickCarry(event: Event): void {
  setCarrySecrets((event.target as HTMLInputElement).checked, carryOffer.value.offered);
}
const liveDone = computed(() => livePhase.value === "done");

/**
 * THE LINK A PHONE SCANS, and the one place in this app where the code is in a URL.
 *
 * It is in the FRAGMENT, which is the half of a URL that never reaches a server — not in the request,
 * not in a referer, not in this Worker's logs — and `receiveFromLocation` in state/move.ts takes it
 * out of the address bar and out of the history entry the moment the other device reads it. The
 * sentence under the code says exactly that, because a person handed a QR code with their own secret
 * in it deserves to know where it goes.
 */
const receiveLink = computed(() =>
  words.value.length && typeof location !== "undefined"
    ? `${location.origin}/?receive#code=${encodeURIComponent(words.value.join("-"))}`
    : "",
);

async function copyLink(): Promise<void> {
  if (!receiveLink.value) return;
  try {
    await navigator.clipboard.writeText(receiveLink.value);
    copiedLink.value = true;
    setTimeout(() => (copiedLink.value = false), 2000);
  } catch {
    copiedLink.value = false;
  }
}

// Connections' "Receive an agent" card opens this pane already on the receiving road — and so does a
// scanned QR link, which also arrives with the six words already in hand (state/move.ts).
onMounted(() => {
  if (receiveWanted.value) {
    road.value = "receive";
    if (prefilledCode.value) typedCode.value = prefilledCode.value;
    // Read before cleared, in that order: the store keeps nothing once the screen has it.
    clearReceiveWanted();
  }
});

const PHASE_LINES: Record<string, string> = {
  opening: "Opening a room…",
  packing: "Packing your agent…",
  waiting: "Waiting for the other device…",
  sending: "Sending…",
  landing: "Checking and importing on the other device…",
  joining: "Finding the room…",
  receiving: "Receiving…",
  importing: "Importing…",
  done: "Done.",
};
const phaseLine = computed(() => PHASE_LINES[livePhase.value] ?? "");

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(moveCode.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // A browser that refuses the clipboard has not broken anything: the code is on the screen, in
    // six words, which is the way it is meant to travel.
    copied.value = false;
  }
}

function close(): void {
  resetMove();
  resetLive();
  emit("close");
}

async function finish(): Promise<void> {
  await confirmMoved();
  emit("close");
}

function chooseFile(): void {
  road.value = "file";
  toCodeStep();
}

async function moveLive(): Promise<void> {
  road.value = "live";
  // The receipt is written inside the store, and only on the far side's ack — see state/move.ts.
  await startLiveMove();
}

async function receiveLive(): Promise<void> {
  if (!typedLooksRight.value) return;
  if (await startLiveReceive(typedCode.value)) {
    // The agent that landed is not the one this tab booted: everything downstream of the filesystem
    // was built from the old tree, so the honest way to open the new one is to boot again.
    location.reload();
  }
}
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-5 space-y-5">
      <div class="flex items-center gap-2">
        <button type="button" class="ia-btn w-8 h-8 flex items-center justify-center" title="Back" @click="close()">
          <TablerIcon name="arrow-left" :size="15" />
        </button>
        <h1 class="text-[14px] font-semibold flex items-center gap-2">
          <TablerIcon :name="road === 'receive' ? 'download' : 'device-laptop'" :size="16" class="text-[var(--color-phosphor)]" />
          {{ road === "receive" ? "Receive an agent" : "Move your agent" }}
        </h1>
      </div>

      <!-- 0. The two roads of §7, in the person's terms rather than the protocol's. -->
      <section v-if="road === 'choose'" class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          Your agent lives in one place at a time. Moving it makes the other device its home, and
          this browser keeps a receipt instead of a running agent.
        </p>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Everything comes with it — files, memory, sessions, standing answers — encrypted end to
          end. You can bring it back here whenever you like.
        </p>
        <label v-if="carryOffer.offered" class="flex items-start gap-2 text-[11px] leading-relaxed">
          <input type="checkbox" class="mt-0.5 shrink-0" :checked="carrySecrets" @change="tickCarry" />
          <span>
            {{ carryOffer.label }}
            <span class="block text-[10px] text-[var(--color-ink-dim)]">
              They travel sealed as they are — the same password opens them on the other device.
            </span>
          </span>
        </label>
        <p v-else-if="carryOffer.reason" class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          {{ carryOffer.reason }}
        </p>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-auto py-2 text-[11px] flex items-start gap-2 text-left"
          :disabled="!liveAvailable"
          @click="moveLive()"
        >
          <TablerIcon name="world" :size="14" class="mt-0.5 shrink-0" />
          <span>
            Move live
            <span class="block text-[10px] opacity-70 leading-relaxed">
              Both devices open, right now. Six words to type, four characters to compare.
            </span>
          </span>
        </button>
        <p v-if="!liveAvailable" class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          Live transfer needs the transfer rooms, which this build is not pointed at yet. The file
          below works with no server at all.
        </p>
        <button
          type="button"
          class="ia-btn w-full h-auto py-2 text-[11px] flex items-start gap-2 text-left"
          @click="chooseFile()"
        >
          <TablerIcon name="file" :size="14" class="mt-0.5 shrink-0" />
          <span>
            Move as a file
            <span class="block text-[10px] opacity-70 leading-relaxed">
              One encrypted <code>.00agent</code> you carry — AirDrop, a share sheet, a USB stick.
              Works offline.
            </span>
          </span>
        </button>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="road = 'receive'">
          I want to RECEIVE an agent instead
        </button>
      </section>

      <!-- ── The live road (§7.1) ─────────────────────────────────────────────────────────────── -->
      <section v-else-if="road === 'live'" class="panel px-3 py-3 space-y-3">
        <template v-if="liveCode && !liveDone">
          <p class="text-[12px] leading-relaxed">
            On the other device choose <strong>Receive</strong> and type these six words.
          </p>
          <div class="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-4">
            <div class="flex flex-wrap items-baseline justify-center gap-x-1 gap-y-1">
              <template v-for="(word, i) in liveWords" :key="`live-${i}-${word}`">
                <span class="font-mono text-[16px] sm:text-[18px] text-[var(--color-phosphor)] tracking-tight">
                  {{ word }}
                </span>
                <span v-if="i < liveWords.length - 1" class="font-mono text-[15px] text-[var(--color-ink-dim)]">-</span>
              </template>
            </div>
          </div>
        </template>

        <!-- The confirmation appears the moment the far side is on the channel, and not before:
             there is nothing to compare with until somebody is there to compare. -->
        <div v-if="liveConfirmation" class="rounded-[10px] border border-[var(--color-line)] px-3 py-3 text-center space-y-1">
          <div class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">
            Both screens should show
          </div>
          <div class="font-mono text-[22px] tracking-[0.3em] text-[var(--color-phosphor)]">{{ liveConfirmation }}</div>
          <div class="text-[10px] text-[var(--color-ink-dim)] leading-relaxed">
            If the other device shows something else, stop — that is not your device.
          </div>
        </div>

        <p v-if="phaseLine" class="text-[11px] text-[var(--color-ink-dim)]">{{ phaseLine }}</p>
        <div v-if="liveProgress !== null" class="h-1.5 rounded-full bg-[var(--color-panel-2)] overflow-hidden">
          <div class="h-full bg-[var(--color-phosphor)]" :style="{ width: `${liveProgress}%` }" />
        </div>

        <template v-if="liveDone">
          <div class="flex items-start gap-2">
            <TablerIcon name="circle-check" :size="16" class="mt-0.5 shrink-0 text-[var(--color-phosphor)]" />
            <p class="text-[12px] leading-relaxed">
              {{ profile?.displayName ?? "Your agent" }} is on the other device now. This browser
              keeps the receipt.
            </p>
          </div>
          <button type="button" class="ia-btn ia-btn-primary w-full h-9 text-[11px]" @click="emit('close')">Done</button>
        </template>
        <button v-else-if="liveBusy" type="button" class="ia-btn w-full h-8 text-[11px]" @click="cancelLive()">
          Cancel
        </button>
        <button v-else type="button" class="ia-btn w-full h-8 text-[11px]" @click="road = 'choose'">
          Try another way
        </button>
      </section>

      <!-- ── Receiving (§7.1, the other end) ──────────────────────────────────────────────────── -->
      <section v-else-if="road === 'receive'" class="panel px-3 py-3 space-y-3">
        <template v-if="livePhase === 'idle'">
          <p class="text-[12px] leading-relaxed">
            On the device that has the agent choose <strong>Move live</strong>, then type its six
            words here.
          </p>
          <input
            v-model="typedCode"
            type="text"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="ia-input text-[13px] font-mono"
            placeholder="six-words-with-dashes-between-them"
            @keydown.enter.prevent="receiveLive()"
          />
          <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">
            The agent that arrives replaces the one in this browser. You will be asked again before
            anything is written.
          </p>
          <button
            type="button"
            class="ia-btn ia-btn-primary w-full h-9 text-[11px]"
            :disabled="!typedLooksRight || !liveAvailable"
            @click="receiveLive()"
          >
            Receive
          </button>
          <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="road = 'choose'">Back</button>
        </template>

        <template v-else>
          <div v-if="liveConfirmation" class="rounded-[10px] border border-[var(--color-line)] px-3 py-3 text-center space-y-1">
            <div class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel">
              Both screens should show
            </div>
            <div class="font-mono text-[22px] tracking-[0.3em] text-[var(--color-phosphor)]">{{ liveConfirmation }}</div>
          </div>
          <p v-if="arrivedVaultLine" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            {{ arrivedVaultLine }}
          </p>
          <p v-if="liveIncoming" class="text-[11px] font-mono text-[var(--color-ink-dim)] break-all">
            {{ liveIncoming.name }} · {{ Math.max(1, Math.round(liveIncoming.bytes / 1024)) }} KB
          </p>
          <p v-if="phaseLine" class="text-[11px] text-[var(--color-ink-dim)]">{{ phaseLine }}</p>
          <div v-if="liveProgress !== null" class="h-1.5 rounded-full bg-[var(--color-panel-2)] overflow-hidden">
            <div class="h-full bg-[var(--color-phosphor)]" :style="{ width: `${liveProgress}%` }" />
          </div>

          <!-- The destructive question, asked with the bytes already here and proven. -->
          <template v-if="liveNeedsReplace">
            <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">
              Importing this agent overwrites the one in this browser — its memory, its files and its
              sessions become the ones in the bundle.
            </p>
            <div class="flex gap-2">
              <button type="button" class="ia-btn flex-1 h-8 text-[11px]" @click="answerReplace(false)">Cancel</button>
              <button type="button" class="ia-btn ia-btn-danger flex-1 h-8 text-[11px]" @click="answerReplace(true)">
                Replace it
              </button>
            </div>
          </template>
          <button v-else-if="!liveBusy" type="button" class="ia-btn w-full h-8 text-[11px]" @click="road = 'choose'">
            Back
          </button>
        </template>
      </section>

      <!-- ── The file road (§7.2), unchanged ──────────────────────────────────────────────────── -->
      <!-- 2. The code. Large, spaced, and the only place it ever appears. -->
      <section v-else-if="moveStep === 'code'" class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          These six words lock the file, and you will type them on your Mac. Keep this screen open.
        </p>
        <div class="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-4">
          <!-- The dashes are their own items so the spacing around them is symmetric when the six
               words wrap onto two lines at 375 px; inline they would hug the word before them. -->
          <div class="flex flex-wrap items-baseline justify-center gap-x-1 gap-y-1">
            <template v-for="(word, i) in words" :key="`${i}-${word}`">
              <span class="font-mono text-[16px] sm:text-[18px] text-[var(--color-phosphor)] tracking-tight">
                {{ word }}
              </span>
              <span v-if="i < words.length - 1" class="font-mono text-[15px] text-[var(--color-ink-dim)]">-</span>
            </template>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="ia-btn flex-1 h-8 text-[11px] flex items-center justify-center gap-1.5"
            @click="copyCode()"
          >
            <TablerIcon :name="copied ? 'check' : 'copy'" :size="13" />
            {{ copied ? "Copied" : "Copy" }}
          </button>
          <button type="button" class="ia-btn h-8 px-2.5 text-[11px]" title="New code" @click="toCodeStep()">
            <TablerIcon name="refresh" :size="13" />
          </button>
        </div>
        <p class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          Nobody can recover these words — not your Mac, not us. Without them the file is noise.
        </p>

        <!-- The QR road (§7, "bring it with you"). The link's FRAGMENT carries the code, which is
             the one part of a URL a server never sees; the app strips it the moment it reads it. -->
        <div v-if="receiveLink" class="rounded-[10px] border border-[var(--color-line)] px-3 py-3 space-y-2">
          <div class="text-[11px] font-medium">Or scan on your phone</div>
          <div class="flex justify-center">
            <QrCode :text="receiveLink" :size="148" />
          </div>
          <p class="text-[10px] text-[var(--color-ink-dim)] leading-relaxed">
            The code rides in the part of the link that never leaves your phone; the app forgets it
            the moment it reads it.
          </p>
          <button
            type="button"
            class="ia-btn w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
            @click="copyLink()"
          >
            <TablerIcon :name="copiedLink ? 'check' : 'copy'" :size="13" />
            {{ copiedLink ? "Link copied" : "Copy link" }}
          </button>
        </div>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">{{ carriedLine(carrySecrets) }}</p>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          :disabled="moveBusy"
          @click="downloadMove()"
        >
          <TablerIcon name="download" :size="13" />
          {{ moveBusy ? "Packing…" : "Download the file" }}
        </button>
      </section>

      <!-- 3 → 4. The file is in Downloads; hand it to 00. -->
      <section v-else-if="moveStep === 'open'" class="panel px-3 py-3 space-y-3">
        <div class="flex items-start gap-2">
          <TablerIcon name="circle-check" :size="16" class="mt-0.5 shrink-0 text-[var(--color-phosphor)]" />
          <div class="min-w-0">
            <div class="text-[12px]">Saved to your downloads.</div>
            <div class="text-[11px] font-mono text-[var(--color-ink-dim)] break-all">{{ moveFileName }}</div>
          </div>
        </div>
        <a
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          :href="moveDeepLink"
          @click.prevent="openIn00()"
        >
          <TablerIcon name="external-link" :size="13" />
          Open in 00
        </a>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Your browser may ask whether to open 00 — or double-click the downloaded file.
        </p>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="openIn00()">
          I have it open on my Mac
        </button>
      </section>

      <!-- 5. The only step this browser can be sure of is the one the person confirms. -->
      <section v-else class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          Type the six words in 00 on your Mac to unlock the file. Once
          {{ profile?.displayName ?? "your agent" }} is running there, tell this browser — it will
          stop being a second home.
        </p>
        <div class="text-[11px] font-mono text-[var(--color-ink-dim)] break-all">{{ moveFileName }}</div>
        <button
          type="button"
          class="ia-btn ia-btn-primary w-full h-9 text-[11px] flex items-center justify-center gap-1.5"
          @click="finish()"
        >
          <TablerIcon name="check" :size="13" />
          I imported it on my Mac
        </button>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="close()">Not yet — keep it here</button>
      </section>

      <p v-if="moveError" class="text-[11px] text-[var(--color-red)] leading-relaxed">{{ moveError }}</p>
      <p v-if="liveError" class="text-[11px] text-[var(--color-red)] leading-relaxed">{{ liveError }}</p>
    </div>
  </div>
</template>
