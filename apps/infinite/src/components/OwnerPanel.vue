<script setup lang="ts">
/**
 * The owner's controls for a claimed app — origins, knowledge, messages, notifications, purse.
 *
 * FIVE SECTIONS, IN THE ORDER A PERSON MEETS THEM. Addresses first, because an origin that is not
 * allowed makes every other section moot; then the knowledge the agent publishes; then the messages
 * that come back; then notifications; then the purse link, which is last because it is the only one
 * that is about money and the only one that is optional in every sense.
 *
 * THE INBOX POLLS ONLY WHILE THIS PANE IS MOUNTED (`onMounted` / `onBeforeUnmount`). Draining marks
 * items DELIVERED at the worker — that is what the 200-item cap counts — so a background poll would
 * be quietly emptying a queue into a tab nobody is looking at. Every drained item is written into
 * the agent's own `escalations/` before it is shown, so what the worker has handed over is on disk
 * even if this tab closes a second later.
 *
 * EVERY REFUSAL IS PRINTED WITH ITS CODE. `stale_signature` means a clock, `not_claimed` means claim
 * first, `too_large` means delete a file, `dev_origin` means a localhost origin cannot be proved from
 * the internet: five different next moves, and a single "something went wrong" would hide all of them.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { pushPossible, pushRefusal } from "../registry/push.js";
import {
  isClaimed,
  openOwnerPanel,
  previewPublicBundle,
  publicBundlePreview,
  publishPublicBundle,
  registryApp,
  registryBusy,
  registryCard,
  registryError,
  registryInbox,
  registryNotice,
  registryOrigins,
  registryPush,
  removePush,
  replyToItem,
  saveLink,
  setOriginStatus,
  startInbox,
  stopInbox,
  subscribeBrowser,
  unpublishPublicBundle,
  verifyOrigin,
  pushIsSending,
  registryVapidKey,
} from "../state/registry.js";

const replyFor = ref<string | null>(null);
const replyText = ref("");
const stAppId = ref("");
const overblastCid = ref("");

const bundle = computed(() => publicBundlePreview.value);
// Both read the key off the app card, so the button turns real the moment a registry publishes one —
// no rebuild, no env var. The env var is only the fallback for a worker too old to answer the field.
const pushSentence = computed(() => pushRefusal(registryVapidKey.value));
const canSubscribe = computed(() => pushPossible(registryVapidKey.value));

onMounted(async () => {
  await openOwnerPanel();
  if (isClaimed.value) startInbox();
});

onBeforeUnmount(() => stopInbox());

async function send(mid: string): Promise<void> {
  if (await replyToItem(mid, replyText.value)) {
    replyText.value = "";
    replyFor.value = null;
  }
}

const originIcon = (status: string) =>
  status === "verified" ? "shield-check" : status === "blocked" ? "x" : status === "allowed" ? "circle-check" : "alert-triangle";
</script>

<template>
  <div class="space-y-6">
    <p v-if="registryNotice" class="panel px-3 py-2 text-[11px] text-[var(--color-phosphor)] leading-relaxed">
      {{ registryNotice }}
    </p>
    <p v-if="registryError" class="panel px-3 py-2 text-[11px] text-[var(--color-amber)] leading-relaxed">
      {{ registryError.message }}
      <span class="opacity-60 font-mono">({{ registryError.code }})</span>
    </p>

    <p v-if="!isClaimed" class="panel px-3 py-3 text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
      This app is <strong>{{ registryCard?.status ?? registryApp?.status }}</strong>. Claim it from
      the panel on the site itself — its admin flow opens this app with a one-time link — and the
      controls below start working.
    </p>

    <!-- ── §5.3 Addresses ────────────────────────────────────────────────────────────────────── -->
    <section v-if="isClaimed">
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Addresses</h2>
      <div class="panel px-3 py-3 space-y-3">
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Only these addresses may run your agent. Someone pasting your snippet on their own site
          lands here as <em>requested</em>, and stays there until you say otherwise.
        </p>
        <div v-if="registryOrigins.length === 0" class="text-[11px] text-[var(--color-ink-dim)]">
          Nothing listed yet.
        </div>
        <div v-for="row in registryOrigins" :key="row.origin" class="space-y-1.5">
          <div class="flex items-start gap-2">
            <TablerIcon :name="originIcon(row.status)" :size="13" class="mt-0.5 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="text-[11px] break-all">{{ row.origin }}</div>
              <div class="text-[10px] text-[var(--color-ink-dim)]">{{ row.status }} · added by {{ row.addedBy }}</div>
            </div>
          </div>
          <div class="flex gap-1.5">
            <button
              type="button"
              class="ia-btn h-7 px-2 text-[10px]"
              :disabled="registryBusy || row.status === 'allowed' || row.status === 'verified'"
              @click="setOriginStatus(row.origin, 'allowed')"
            >
              Allow
            </button>
            <button
              type="button"
              class="ia-btn h-7 px-2 text-[10px]"
              :disabled="registryBusy || row.status === 'blocked'"
              @click="setOriginStatus(row.origin, 'blocked')"
            >
              Block
            </button>
            <!-- `verified` is never set by hand: it is earned by the site file, and the worker
                 answers `bad_status` to anyone who types it. This button asks for the fetch. -->
            <button type="button" class="ia-btn h-7 px-2 text-[10px]" :disabled="registryBusy" @click="verifyOrigin(row.origin)">
              Verify
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ── §5.5 Knowledge ────────────────────────────────────────────────────────────────────── -->
    <section v-if="isClaimed">
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Published knowledge</h2>
      <div class="panel px-3 py-3 space-y-2">
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Everything in <code class="font-mono">workspace/public/</code> — your persona and whatever
          you put beside it — and nothing else. Never memory, never projects, never sessions.
        </p>
        <ul v-if="bundle && bundle.files.length" class="space-y-0.5">
          <li v-for="f in bundle.files" :key="f.path" class="text-[10px] font-mono flex justify-between gap-2">
            <span class="truncate">{{ f.path }}</span>
            <span class="text-[var(--color-ink-dim)] shrink-0">{{ f.bytes }} B</span>
          </li>
        </ul>
        <p v-else class="text-[11px] text-[var(--color-ink-dim)]">
          Nothing in <code class="font-mono">workspace/public/</code> yet.
        </p>
        <p v-if="bundle && !bundle.ok && bundle.code === 'too_large'" class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          That is {{ bundle.bytes }} bytes and the ceiling is {{ bundle.maxBytes }}. Remove something
          rather than trusting it to be trimmed — nothing here trims.
        </p>
        <div class="flex gap-1.5">
          <button type="button" class="ia-btn flex-1 h-8 text-[11px]" :disabled="registryBusy" @click="previewPublicBundle()">
            Re-read
          </button>
          <button
            type="button"
            class="ia-btn ia-btn-primary flex-1 h-8 text-[11px]"
            :disabled="registryBusy || !bundle?.ok"
            @click="publishPublicBundle()"
          >
            Publish
          </button>
          <button
            v-if="registryCard?.hasPublicBundle"
            type="button"
            class="ia-btn h-8 px-2 text-[11px]"
            :disabled="registryBusy"
            @click="unpublishPublicBundle()"
          >
            <TablerIcon name="trash" :size="13" />
          </button>
        </div>
      </div>
    </section>

    <!-- ── §5.6 Messages ─────────────────────────────────────────────────────────────────────── -->
    <section v-if="isClaimed">
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Messages</h2>
      <div class="panel px-3 py-3 space-y-3">
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          What visitors sent your agent. Each one is filed in your agent's
          <code class="font-mono">escalations/</code> folder as it arrives, so it is yours even if
          this tab closes.
        </p>
        <div v-if="registryInbox.length === 0" class="text-[11px] text-[var(--color-ink-dim)]">Nothing waiting.</div>
        <div v-for="item in registryInbox" :key="item.mid" class="panel px-3 py-2 space-y-1.5" style="background: var(--color-panel-2)">
          <div class="flex items-center gap-2 text-[10px] text-[var(--color-ink-dim)]">
            <span class="uppercase tracking-wide font-pixel">{{ item.kind }}</span>
            <span>{{ item.createdAt }}</span>
          </div>
          <div class="text-[11px] leading-relaxed whitespace-pre-wrap">{{ item.text }}</div>
          <div v-if="item.contact" class="text-[10px] text-[var(--color-ink-dim)] break-all">{{ item.contact }}</div>
          <div v-if="item.reply" class="text-[11px] text-[var(--color-phosphor)] leading-relaxed whitespace-pre-wrap">
            {{ item.reply }}
          </div>
          <template v-else>
            <button v-if="replyFor !== item.mid" type="button" class="ia-btn h-7 px-2 text-[10px]" @click="replyFor = item.mid">
              Reply
            </button>
            <div v-else class="space-y-1.5">
              <textarea
                v-model="replyText"
                rows="3"
                maxlength="4000"
                class="w-full text-[11px] px-2 py-1.5 bg-transparent border border-[var(--color-line)] rounded"
                placeholder="Your answer"
              />
              <!-- One reply per message, by the worker's rule: a second thought is a second item,
                   because the first may already have been read. -->
              <div class="flex gap-1.5">
                <button
                  type="button"
                  class="ia-btn ia-btn-primary h-7 px-2 text-[10px]"
                  :disabled="registryBusy || !replyText.trim()"
                  @click="send(item.mid)"
                >
                  Send
                </button>
                <button type="button" class="ia-btn h-7 px-2 text-[10px]" @click="replyFor = null">Cancel</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ── §5.7 Notifications ────────────────────────────────────────────────────────────────── -->
    <section v-if="isClaimed">
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Notifications</h2>
      <div class="panel px-3 py-3 space-y-2">
        <p v-if="pushSentence" class="text-[11px] text-[var(--color-amber)] leading-relaxed">{{ pushSentence }}</p>
        <!-- The key exists, so subscribing is real: a permission prompt and a subscription minted
             against that key. Sending is not — the routes still answer `sending: false`, and this
             sentence is that answer rather than a guess. -->
        <p v-else-if="!pushIsSending" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          Subscribing stores this browser against your registry's notification key. Nothing is sent
          yet: the worker keeps subscriptions this round and gains a sender in the next.
        </p>
        <div v-for="row in registryPush" :key="row.endpoint" class="flex items-start gap-2">
          <div class="min-w-0 flex-1 text-[10px] font-mono break-all text-[var(--color-ink-dim)]">{{ row.endpoint }}</div>
          <button type="button" class="ia-btn h-7 px-2 text-[10px]" :disabled="registryBusy" @click="removePush(row.endpoint)">
            Forget
          </button>
        </div>
        <button
          type="button"
          class="ia-btn w-full h-8 text-[11px]"
          :disabled="registryBusy || !canSubscribe"
          @click="subscribeBrowser()"
        >
          Notify this browser
        </button>
      </div>
    </section>

    <!-- ── §9.4 The purse link ───────────────────────────────────────────────────────────────── -->
    <section v-if="isClaimed">
      <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">Purse</h2>
      <div class="panel px-3 py-3 space-y-2">
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          A stronger brain and a bigger mailbox are paid for somewhere else. These two fields are the
          only link between here and there; nothing checks them, and a wrong one costs only a broken
          card.
        </p>
        <input
          v-model="stAppId"
          type="text"
          maxlength="64"
          placeholder="sponsoredtokens app id"
          class="w-full text-[11px] px-2 py-1.5 bg-transparent border border-[var(--color-line)] rounded font-mono"
        />
        <input
          v-model="overblastCid"
          type="text"
          maxlength="64"
          placeholder="Overblast workspace id"
          class="w-full text-[11px] px-2 py-1.5 bg-transparent border border-[var(--color-line)] rounded font-mono"
        />
        <button
          type="button"
          class="ia-btn w-full h-8 text-[11px]"
          :disabled="registryBusy"
          @click="saveLink(stAppId, overblastCid)"
        >
          Save
        </button>
      </div>
    </section>
  </div>
</template>
