<script setup lang="ts">
/**
 * Connections and Settings, one pane — §6.1 as cards, §4.5's vault, §3.3's storage and backup.
 *
 * The last block is the honesty block: whatever is standing in for a real implementation is named
 * here, from the same list the runtime bootstrap fills. An empty list is the good case and is shown as
 * such, because a person cannot tell the difference between "nothing is stubbed" and "the app forgot
 * to say".
 */
import BackupPanel from "./BackupPanel.vue";
import BrainCards from "./BrainCards.vue";
import MacConnectCard from "./MacConnectCard.vue";
import TablerIcon from "./TablerIcon.vue";
import VaultPanel from "./VaultPanel.vue";
import { profile, stubs } from "../state/agent.js";
import { askForReceive, forgetMoveReceipt, moveReceipt, twoLiveCopies } from "../state/move.js";
import { receiptLine } from "../lib/move.js";

// The Move flow is a pane of its own (App.vue owns the switch); this pane is one of its two doors.
// `website` is §5's door, and a pane for the same reason Move is one: the snippet, the claim and the
// owner's controls are a trip, not a card.
defineEmits<{ (e: "move"): void; (e: "website"): void }>();
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-5 space-y-6">
      <div class="flex items-center gap-3">
        <div class="text-2xl">{{ profile?.emoji ?? "🟢" }}</div>
        <div class="min-w-0">
          <div class="text-[14px] font-semibold truncate">{{ profile?.displayName ?? "Your agent" }}</div>
          <div class="text-[11px] text-[var(--color-ink-dim)] font-mono truncate">{{ profile?.id }}</div>
        </div>
      </div>

      <!-- §7's second live copy, when the person chose one: never hidden, and easy to end. -->
      <div v-if="twoLiveCopies && moveReceipt" class="panel px-3 py-3 space-y-2">
        <div class="flex items-start gap-2">
          <TablerIcon name="alert-triangle" :size="15" class="mt-0.5 shrink-0 text-[var(--color-amber)]" />
          <div class="min-w-0 text-[11px] leading-relaxed text-[var(--color-amber)]">
            {{ receiptLine(moveReceipt) }} Two copies of an agent drift apart and nothing merges them.
          </div>
        </div>
        <button type="button" class="ia-btn w-full h-8 text-[11px]" @click="forgetMoveReceipt()">
          The Mac's copy is gone — forget this
        </button>
      </div>

      <BrainCards />
      <VaultPanel />

      <section>
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">This machine</h2>
        <div class="panel px-3 py-3 space-y-2">
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            Your agent lives in one place at a time. Move it to 00 on your Mac and this browser keeps
            a receipt — you can bring it back whenever you like.
          </p>
          <button
            type="button"
            class="ia-btn w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
            @click="$emit('move')"
          >
            <TablerIcon name="device-laptop" :size="13" />
            Move to my Mac
          </button>
          <!-- §7.1's other end. It is a door of its own and not a step of the move, because the
               person who needs it is holding a code from ANOTHER device and has nothing to send. -->
          <button
            type="button"
            class="ia-btn w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
            @click="askForReceive(); $emit('move')"
          >
            <TablerIcon name="download" :size="13" />
            Receive an agent
          </button>
        </div>
      </section>

      <section>
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Your website</h2>
        <div class="panel px-3 py-3 space-y-2">
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            One line of HTML puts your agent on your site as a guide for visitors — no account, and
            nothing of ours running until you ask for it.
          </p>
          <button
            type="button"
            class="ia-btn w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
            @click="$emit('website')"
          >
            <TablerIcon name="world" :size="13" />
            Add to my website
          </button>
        </div>
      </section>

      <MacConnectCard />

      <BackupPanel />

      <section>
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">What is real</h2>
        <div class="panel px-3 py-3">
          <div v-if="stubs.length === 0" class="flex items-center gap-2 text-[11px] text-[var(--color-phosphor)]">
            <TablerIcon name="circle-check" :size="14" />
            Everything on this screen is the real implementation.
          </div>
          <ul v-else class="space-y-1.5">
            <li v-for="stub in stubs" :key="stub" class="flex items-start gap-2 text-[11px] text-[var(--color-amber)]">
              <TablerIcon name="alert-triangle" :size="13" class="mt-0.5 shrink-0" />
              <span class="leading-relaxed">{{ stub }}</span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>
