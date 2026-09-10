<script setup lang="ts">
/**
 * "Add to my website" — the snippet, and everything that follows from it (§5.1–5.7).
 *
 * WHAT A PERSON DOES HERE, IN ORDER: copy one line into their site; the site registers the ref by
 * itself the first time somebody opens the panel there (§5.3, and it is the SITE'S call, never
 * ours); the site's admin flow sends them back here to claim (§5.4); after that this pane grows the
 * owner's controls. So the snippet is at the top, always, and the owner panel appears below it when
 * there is something to own — one destination rather than a pane that changes name.
 *
 * THE SNIPPET IS THE PRODUCT ORIGIN'S, not a hard-coded host: `location.origin` is where this app is
 * served from, and §9.1 puts the loader at `/e/<ref>.js` on that same static site. A constant here
 * would hand a developer running locally a snippet pointing at production.
 *
 * THE REF IS SHOWN AS A PUBLIC THING, deliberately, because it is one: it is in the page source of
 * every site running the embed and it grants nothing. What must never appear on this screen is the
 * link key's private half, which cannot appear because it cannot be read (see `registry/link-key.ts`).
 */
import { onMounted, ref } from "vue";
import OwnerPanel from "./OwnerPanel.vue";
import TablerIcon from "./TablerIcon.vue";
import {
  agentRef,
  isClaimed,
  linkKeyRefusal,
  linkPublicKey,
  loadRegistry,
  registryApp,
  registryCard,
  registryReady,
  snippet,
} from "../state/registry.js";

const emit = defineEmits<{ (e: "close"): void }>();
const copied = ref(false);
const copiedKey = ref(false);

// The public half of the link key, for the site's setup step 5: only THIS browser holds the private
// half, so the site cannot learn the key any other way, and registering with a made-up one would
// create an app its owner could never claim (§5.3). The private half is never shown; it cannot be.
async function copyKey(): Promise<void> {
  if (!linkPublicKey.value) return;
  try {
    await navigator.clipboard.writeText(linkPublicKey.value);
    copiedKey.value = true;
    setTimeout(() => (copiedKey.value = false), 2000);
  } catch {
    // Same as the snippet: the key is on screen in a selectable field.
  }
}

onMounted(() => void loadRegistry());

async function copySnippet(): Promise<void> {
  try {
    await navigator.clipboard.writeText(snippet.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // A clipboard a browser will not give is not an error worth a banner: the snippet is on screen
    // in a selectable field, which is what a person falls back to anyway.
  }
}
</script>

<template>
  <div class="h-full ia-scroll">
    <div class="max-w-lg mx-auto px-3 sm:px-5 py-5 space-y-6">
      <div class="flex items-center gap-2">
        <button type="button" class="ia-btn w-8 h-8 flex items-center justify-center" title="Back" @click="emit('close')">
          <TablerIcon name="arrow-left" :size="15" />
        </button>
        <h1 class="text-[14px] font-semibold flex items-center gap-2">
          <TablerIcon name="world" :size="16" class="text-[var(--color-phosphor)]" />
          Add to my website
        </h1>
      </div>

      <section class="panel px-3 py-3 space-y-3">
        <p class="text-[12px] leading-relaxed">
          Paste this once, anywhere in your site's HTML. Visitors get a guide to your site that knows
          its pages and can point at things — with no account and nothing of ours running.
        </p>

        <div class="panel px-3 py-2" style="background: var(--color-panel-2)">
          <code class="text-[10px] font-mono break-all leading-relaxed select-all">{{ snippet || "…" }}</code>
        </div>

        <button
          type="button"
          class="ia-btn w-full h-8 text-[11px] flex items-center justify-center gap-1.5"
          :disabled="!agentRef"
          @click="copySnippet()"
        >
          <TablerIcon :name="copied ? 'circle-check' : 'copy'" :size="13" />
          {{ copied ? "Copied" : "Copy the snippet" }}
        </button>

        <!-- The two carriers of §5.1, one line each. The choice is real and a person makes it once. -->
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          <strong class="text-[var(--color-ink)]">A file on your site</strong> —
          <code class="font-mono">/.well-known/infinite-agent.json</code> holds the settings, the
          snippet stays this one line, and the file also proves the domain is yours.
        </p>
        <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
          <strong class="text-[var(--color-ink)]">Or in the snippet</strong> — a
          <code class="font-mono">data-site</code> attribute carries the same settings for hosts where
          you can paste a script but cannot add a file; changing one means pasting again.
        </p>

        <div v-if="agentRef" class="text-[10px] text-[var(--color-ink-dim)] font-mono break-all pt-1">
          {{ agentRef }}
        </div>

        <!-- The site's setup asks for this in its "Register" step; nothing else can supply it. -->
        <div v-if="linkPublicKey" class="space-y-1.5 pt-1">
          <p class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            <strong class="text-[var(--color-ink)]">Your agent's key</strong> — the site's setup asks
            for it when you register; it proves the site is yours to claim from here. It is the public
            half only.
          </p>
          <div class="panel px-3 py-2 flex items-center gap-2" style="background: var(--color-panel-2)">
            <code class="text-[10px] font-mono break-all leading-relaxed select-all flex-1">{{ linkPublicKey }}</code>
            <button type="button" class="ia-btn h-7 px-2 text-[11px] flex items-center gap-1 shrink-0" @click="copyKey()">
              <TablerIcon :name="copiedKey ? 'circle-check' : 'copy'" :size="12" />
              {{ copiedKey ? "Copied" : "Copy" }}
            </button>
          </div>
        </div>
      </section>

      <p v-if="linkKeyRefusal" class="panel px-3 py-3 text-[11px] text-[var(--color-amber)] leading-relaxed">
        {{ linkKeyRefusal }} The snippet above still works — the site guide needs nothing of ours. What
        needs the key is claiming the site, publishing knowledge and reading messages.
      </p>

      <!-- What this ref has become out there. Only the worker knows, and only once a claim exists —
           before that this browser has never spoken to it, which is the point of §5.3. -->
      <section>
        <h2 class="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)] font-pixel mb-2">
          Websites running this agent
        </h2>
        <div class="panel px-3 py-3 space-y-2">
          <template v-if="registryApp">
            <div class="flex items-start gap-2">
              <TablerIcon
                :name="isClaimed ? 'circle-check' : 'alert-triangle'"
                :size="14"
                class="mt-0.5 shrink-0"
                :class="isClaimed ? 'text-[var(--color-phosphor)]' : 'text-[var(--color-amber)]'"
              />
              <div class="min-w-0 text-[11px] leading-relaxed">
                <div class="font-medium break-all">{{ registryApp.origin ?? "an unnamed origin" }}</div>
                <div class="text-[var(--color-ink-dim)]">
                  {{ registryCard?.status ?? registryApp.status }}<span
                    v-if="registryCard?.hasPublicBundle"
                  >
                    · knowledge published</span
                  >
                </div>
                <div class="text-[var(--color-ink-dim)] font-mono break-all">{{ registryApp.appId }}</div>
              </div>
            </div>
          </template>
          <p v-else-if="registryReady" class="text-[11px] text-[var(--color-ink-dim)] leading-relaxed">
            None yet. A site registers itself the first time somebody opens the panel there, and its
            admin flow sends you back here to claim it.
          </p>
          <p v-else class="text-[11px] text-[var(--color-ink-dim)]">Looking…</p>
        </div>
      </section>

      <OwnerPanel v-if="registryApp" />
    </div>
  </div>
</template>
