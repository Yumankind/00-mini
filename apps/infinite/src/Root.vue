<script setup lang="ts">
/**
 * WHICH OF THE TWO SCREENS THIS URL IS — the whole of the app's routing (`src/mini/nav.ts`).
 *
 * `/` is the landing page with the agent floating over it; `/app` — and every deep link the app
 * already answers (`?claim=`, `?receive`, `#receive`) — is the app full screen. There is no router:
 * two screens do not pay for one, and `popstate` is the only event either of them needs.
 *
 * WHY THE AGENT BOOTS ON THE LANDING TOO. The widget in the corner is not a picture of the product,
 * it is the product: it has to be a live agent before anybody clicks anything, or the landing page's
 * first claim is false. So when `App.vue` is NOT mounted, this file does the minimum `App.vue` does
 * on mount — theme, offline, the move receipt, the agent, the vault, the event bus, readiness — and
 * hands it back the moment the app takes over, because two owners of the same window listeners is
 * one owner too many.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import App from "./App.vue";
import LandingPage from "./landing/LandingPage.vue";
import MiniWidget from "./components/MiniWidget.vue";
import { boot } from "./state/agent.js";
import { listen } from "./state/conversation.js";
import { startTheme } from "./state/install.js";
import { primeBrains } from "./state/model-choice.js";
import { loadMoveReceipt } from "./state/move.js";
import { startOffline } from "./state/offline.js";
import { refreshVault } from "./state/vault.js";
import { currentUrl, isAppUrl } from "./mini/nav.js";

const url = ref(currentUrl());
const isApp = computed(() => isAppUrl(url.value));

let landingStops: (() => void)[] = [];
let landingLive = false;

/** Everything the landing's own agent needs, and nothing `App.vue` would start a second time. */
async function startLanding(): Promise<void> {
  if (landingLive) return;
  landingLive = true;
  landingStops.push(startOffline());
  // Before the agent, for the same reason as in App.vue: a moved-away agent must not boot here.
  await loadMoveReceipt();
  await boot();
  await refreshVault();
  listen();
  void primeBrains();
}

function stopLanding(): void {
  for (const stop of landingStops) stop();
  landingStops = [];
  landingLive = false;
}

function onPopState(): void {
  url.value = currentUrl();
}

onMounted(() => {
  // The theme is the document's, not a screen's: it is applied once, whichever screen this is.
  startTheme();
  window.addEventListener("popstate", onPopState);
  if (!isApp.value) void startLanding();
});

onBeforeUnmount(() => {
  window.removeEventListener("popstate", onPopState);
  stopLanding();
});

watch(isApp, (app) => {
  if (app) stopLanding();
  else void startLanding();
  // A screen change is a new page as far as a reader is concerned.
  window.scrollTo({ top: 0 });
});
</script>

<template>
  <App v-if="isApp" />
  <template v-else>
    <LandingPage />
    <MiniWidget />
  </template>
</template>
