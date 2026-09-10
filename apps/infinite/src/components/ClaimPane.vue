<script setup lang="ts">
/**
 * The claim, as a full pane — §5.4.
 *
 * WHY IT TAKES THE WHOLE SCREEN. This is the one moment in Phase 3 where a person grants something
 * irreversible: the signature they are about to make says *this agent is the agent of that website*,
 * and the app can never be claimed again. The link that brought them here was opened by a page on
 * SOMEBODY ELSE'S SITE (the admin flow at `?claim=…`), so the origin in it is a claim the link is
 * making, not a fact — which is exactly why the origin is the biggest thing on the screen and why
 * there is a Cancel beside the button rather than an auto-submit on mount.
 *
 * WHAT IS SIGNED is `appId‖origin‖nonce` and nothing else: not this window's origin, not a time, not
 * a body. The state module owns that string (`registry/signed.ts::claimMessage`), so this component
 * cannot get it subtly wrong.
 *
 * THE QUERY IS STRIPPED BY App.vue once it has been read, the way the Mac web UI strips
 * `installModel` and `import-bundle`: a query that survives its own answer re-opens this pane after
 * every Done, and a claim nonce is single-use, so the second visit would show a refusal for a claim
 * that had already worked.
 */
import { computed, ref } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { profile } from "../state/agent.js";
import {
  agentRef,
  linkKeyRefusal,
  registryBusy,
  registryError,
  runClaim,
  type ClaimRequest,
} from "../state/registry.js";

const props = defineProps<{ request: ClaimRequest }>();
const emit = defineEmits<{ (e: "done"): void; (e: "cancel"): void }>();

const claimed = ref(false);

/** The bare host, for the sentence; the full origin stays visible below it, scheme and all. */
const host = computed(() => {
  try {
    return new URL(props.request.origin).host;
  } catch {
    return props.request.origin;
  }
});

async function confirm(): Promise<void> {
  claimed.value = await runClaim(props.request);
}
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-8 space-y-5">
      <div class="flex items-center gap-2">
        <TablerIcon name="shield-check" :size="18" class="text-[var(--color-phosphor)]" />
        <h1 class="text-[15px] font-semibold">{{ claimed ? "Claimed" : "Is this your website?" }}</h1>
      </div>

      <template v-if="!claimed">
        <section class="panel px-4 py-4 space-y-3">
          <p class="text-[12px] leading-relaxed">
            A website asked to be answered by
            <strong>{{ profile?.displayName ?? "your agent" }}</strong>. Claiming it means this
            browser — and only this browser — can publish its knowledge, read the messages visitors
            send it, and reply.
          </p>
          <div class="panel px-3 py-3" style="background: var(--color-panel-2)">
            <div class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-1">
              The site
            </div>
            <div class="text-[15px] font-semibold break-all">{{ host }}</div>
            <div class="text-[11px] text-[var(--color-ink-dim)] font-mono break-all mt-1">
              {{ props.request.origin }}
            </div>
          </div>
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            If you do not recognise that address, close this. Nothing has happened yet, and a link
            can say anything.
          </p>
          <div class="text-[10px] text-[var(--color-ink-dim)] font-mono break-all">
            {{ props.request.appId }} · {{ agentRef ?? "…" }}
          </div>
        </section>

        <p v-if="linkKeyRefusal" class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          {{ linkKeyRefusal }}
        </p>

        <p v-if="registryError" class="text-[11px] text-[var(--color-amber)] leading-relaxed">
          {{ registryError.message }}
          <span class="opacity-60 font-mono">({{ registryError.code }})</span>
        </p>

        <div class="flex gap-2">
          <button
            type="button"
            class="ia-btn ia-btn-primary flex-1 h-9 text-[12px] flex items-center justify-center gap-1.5"
            :disabled="registryBusy || !!linkKeyRefusal"
            @click="confirm()"
          >
            <TablerIcon name="shield-lock" :size="14" />
            {{ registryBusy ? "Signing…" : "Yes, it is mine" }}
          </button>
          <button type="button" class="ia-btn h-9 px-4 text-[12px]" @click="emit('cancel')">Not mine</button>
        </div>
      </template>

      <template v-else>
        <section class="panel px-4 py-4 space-y-2">
          <div class="flex items-center gap-2 text-[12px] text-[var(--color-phosphor)]">
            <TablerIcon name="circle-check" :size="15" />
            {{ host }} is answered by your agent.
          </div>
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            Publishing its knowledge, its allowed addresses and the messages visitors send are all in
            <strong>Add to my website</strong>, under Connections.
          </p>
        </section>
        <button type="button" class="ia-btn ia-btn-primary w-full h-9 text-[12px]" @click="emit('done')">
          Open the website panel
        </button>
      </template>
    </div>
  </div>
</template>
