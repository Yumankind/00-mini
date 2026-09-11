<script setup lang="ts">
/**
 * 00 MINI — the full app: sidebar, thread, workspace.
 *
 * ONE LAYOUT, THREE WIDTHS. The same app is the mobile browser's, so there is no phone build and no
 * desktop build. The sidebar is a 260 px column on a desk, an icon rail when a person wants the
 * width back, and a drawer under 640 px; the workspace is a right-hand column on a desk and the
 * whole screen on a phone. Anything that needed two components to say would drift into two products.
 *
 * The order of screens is the order of §4: boot, then the vault if one exists (asked EVERY entry),
 * then the shell. The approvals modal sits above all three because a run can outlive a pane change,
 * and the palette sits above everything because ⌘K is the one key that always works.
 *
 * THIS COMPONENT DOES NOT OWN THE ROUTE. It is mounted for `/app` by the root component, and the
 * chevron in its header pushes `/` and tells the listeners (`lib/nav.ts`) — the landing page and the
 * floating widget are another surface of the same PWA, not another page load.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ApprovalsModal from "./components/ApprovalsModal.vue";
import BootScreen from "./components/BootScreen.vue";
import ClaimPane from "./components/ClaimPane.vue";
import CommandPalette from "./components/CommandPalette.vue";
import InstallNag from "./components/InstallNag.vue";
import MovedReceipt from "./components/MovedReceipt.vue";
import OfflineBanner from "./components/OfflineBanner.vue";
import PixelFace from "./components/PixelFace.vue";
import SettingsPane, { type SettingsTab } from "./components/SettingsPane.vue";
import Sidebar from "./components/Sidebar.vue";
import TablerIcon from "./components/TablerIcon.vue";
import ThreadPane from "./components/ThreadPane.vue";
import VaultGate from "./components/VaultGate.vue";
import WorkspacePanel from "./components/WorkspacePanel.vue";
import { goTo } from "./lib/nav.js";
import { boot, profile, ready } from "./state/agent.js";
import { refuseAll } from "./state/approvals.js";
import { busy, listen } from "./state/conversation.js";
import { refreshFiles, watchFileChanges } from "./state/files.js";
import { startInstallWatch, startTheme } from "./state/install.js";
import {
  centrePane,
  openWorkspace,
  powerPane,
  setPower,
  sidebarRail,
  startLayout,
  toggleWorkspace,
  viewportWidth,
  workspaceOpen,
} from "./state/layout.js";
import { loadMoveReceipt, movedAway, receiveRequested } from "./state/move.js";
import { startCompanionWatch } from "./state/companion.js";
import { startOffline } from "./state/offline.js";
import { claimRequestFromQuery, type ClaimRequest } from "./state/registry.js";
import { needsUnlock, refreshVault, startVaultClock, touchVault } from "./state/vault.js";

/**
 * Two screens: the conversation, and Settings — which holds Connections, the vault, move & backup
 * and the website as TABS (Bruno, 2026-09-11). Everything that used to be its own destination is a
 * tab now, and every road that led there (the palette, a claim link, a scanned QR, a card's button)
 * lands on the right tab through `openSettings`.
 */
type Pane = "chat" | "settings";
type Destination = "chat" | "settings" | "vault" | "move" | "website";

const pane = ref<Pane>("chat");
const settingsTab = ref<SettingsTab>("connections");

/** Where a destination name lands: the chat, or Settings on a tab. */
function showPane(target: Destination): void {
  if (target === "chat") {
    pane.value = "chat";
    return;
  }
  settingsTab.value = target === "settings" ? "connections" : target;
  pane.value = "settings";
}
/**
 * §5.4's one-time link: `/?claim=<appId>&nonce=…&origin=…`, opened by the admin flow ON THE SITE.
 * It takes the screen ahead of every pane, because it is a grant and not a destination.
 */
const claimRequest = ref<ClaimRequest | null>(null);
const drawer = ref(false);
const palette = ref(false);
const teardown: (() => void)[] = [];

/** Under `sm` the sidebar is a drawer and the workspace takes the whole screen. */
const phone = computed(() => viewportWidth.value < 640);
/** The thread hides only when the workspace has the screen to itself — which is a phone thing. */
const threadVisible = computed(() => !(phone.value && workspaceOpen.value));
const headline = computed(() => (pane.value === "settings" ? "Settings" : "00 Mini"));

const BOTTOM = [
  { id: "chat", label: "Chat", icon: "message-2" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "workspace", label: "Workspace", icon: "layout-columns" },
  { id: "more", label: "More", icon: "menu-2" },
] as const;

/** Which of the four is lit. Derived rather than stored: two truths about one screen is one too many. */
const bottomActive = computed(() => {
  if (drawer.value) return "more";
  if (workspaceOpen.value) return powerPane.value === "files" ? "files" : "workspace";
  return pane.value === "chat" ? "chat" : "more";
});

function bottom(id: (typeof BOTTOM)[number]["id"]): void {
  drawer.value = false;
  if (id === "more") {
    drawer.value = true;
    return;
  }
  if (id === "chat") {
    pane.value = "chat";
    setPower(false);
    return;
  }
  pane.value = "chat";
  // A bottom tab is a DESTINATION, not a switch: Workspace always lands on the workspace. Toggling
  // here closed it whenever it was already open (on Files, or remembered from the last visit), and a
  // tap on "Workspace" showed the chat — the bug Bruno hit on a phone, 2026-09-11.
  if (id === "files") openWorkspace("files");
  else openWorkspace(powerPane.value === "files" ? centrePane.value : powerPane.value);
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    palette.value = !palette.value;
    return;
  }
  if (event.key === "Escape") {
    // One key, every overlay: the palette first, then the drawer. The approvals modal is deliberately
    // NOT closed by Escape — a run is blocked on its answer (see ApprovalsModal.vue).
    if (palette.value) palette.value = false;
    else if (drawer.value) drawer.value = false;
  }
}

onMounted(async () => {
  startTheme();
  claimRequest.value = claimRequestFromQuery(location.search);
  if (claimRequest.value) {
    // STRIPPED ONCE READ, the way the Mac web UI strips `installModel` and `import-bundle`: a claim
    // nonce is single-use, so a query that survived its own answer would re-open the pane on the
    // next reload and show a refusal for a claim that had already worked.
    const clean = new URL(window.location.href);
    for (const key of ["claim", "nonce", "origin"]) clean.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", clean);
  }
  // §14's companion is watched for the life of the app, not for the life of the card: the Git pane's
  // remote buttons, the terminal's `git push` and the sidebar dot all read the same status, and a
  // watch that only ran while Connections was open would leave every one of them on a stale answer.
  teardown.push(startOffline(), startInstallWatch(), startVaultClock(), startLayout(), startCompanionWatch());
  // Before the agent, because a moved-away agent must never flash its shell on the way to its receipt.
  await loadMoveReceipt();
  // A scanned QR (`/?receive#code=…`, state/move.ts) lands on the receive screen with the code in the
  // field: the pane opens here, the one place that decides panes, not from the store.
  if (receiveRequested.value) showPane("move");
  await boot();
  await refreshVault();
  listen();
  // The tree must not lag behind the agent's own writes — in either shell.
  teardown.push(watchFileChanges());
  // A person's activity is what the idle lock measures, and a pane click is activity.
  const touch = (): void => touchVault();
  window.addEventListener("pointerdown", touch, { passive: true });
  window.addEventListener("keydown", touch);
  window.addEventListener("keydown", onKeydown);
  teardown.push(() => {
    window.removeEventListener("pointerdown", touch);
    window.removeEventListener("keydown", touch);
    window.removeEventListener("keydown", onKeydown);
  });
});

onBeforeUnmount(() => {
  // Every waiter gets an answer, or a run holds a promise nobody can resolve.
  refuseAll();
  for (const stop of teardown) stop();
});

watch(pane, (next) => {
  drawer.value = false;
  if (next === "settings") void refreshFiles();
});
watch(workspaceOpen, (open) => {
  if (open) void refreshFiles();
});
</script>

<template>
  <div class="h-full flex flex-col min-h-0" :style="{ background: 'var(--color-void)' }">
    <BootScreen v-if="!ready" />

    <!-- §7: one live residence. A receipt is not an agent, so it is shown before the vault is asked
         about — there is nothing here to unlock until the agent comes home. -->
    <MovedReceipt v-else-if="movedAway" />

    <VaultGate v-else-if="needsUnlock" />

    <template v-else>
      <div class="flex-1 flex min-h-0">
        <!-- The sidebar on a desk: 260 px, or the 56 px rail. -->
        <aside
          class="hidden sm:block shrink-0 transition-[width] duration-150"
          :style="{ width: sidebarRail ? '56px' : '260px' }"
        >
          <Sidebar :pane="pane" @go="showPane($event)" @palette="palette = true" />
        </aside>

        <!-- The phone's drawer: the same component, over the pane instead of beside it. -->
        <div v-if="drawer" class="fixed inset-0 z-50 sm:hidden flex">
          <div class="w-[17rem] h-full">
            <Sidebar :pane="pane" drawer @go="showPane($event)" @picked="drawer = false" @palette="palette = true" />
          </div>
          <button type="button" class="flex-1 h-full" style="background: rgba(0, 0, 0, 0.5)" @click="drawer = false" />
        </div>

        <main class="flex-1 min-w-0 min-h-0 flex flex-col">
          <header class="flex items-center gap-2 px-2.5 sm:px-4 h-12 border-b border-[var(--color-line)] shrink-0">
            <button
              type="button"
              class="ia-btn ia-btn-ghost w-8 h-8 sm:hidden"
              title="Menu"
              @click="drawer = !drawer"
            >
              <TablerIcon name="menu-2" :size="16" />
            </button>
            <PixelFace :size="18" :thinking="busy" class="sm:hidden" />

            <!-- Out of Settings in one press, from the header too — the phone has no sidebar to reach for. -->
            <button
              v-if="pane !== 'chat'"
              type="button"
              class="ia-btn ia-btn-ghost w-8 h-8 shrink-0"
              title="Back to the chat"
              @click="showPane('chat')"
            >
              <TablerIcon name="arrow-left" :size="16" />
            </button>
            <div class="min-w-0 flex items-center gap-2">
              <span class="text-[13px] font-semibold tracking-tight truncate">{{ headline }}</span>
              <span v-if="pane === 'chat'" class="hidden sm:inline text-[12px] text-[var(--color-ink-faint)] truncate">
                {{ profile?.displayName }}
              </span>
            </div>

            <div class="ml-auto flex items-center gap-1">
              <button
                type="button"
                class="ia-btn ia-btn-ghost h-8 px-2 text-[12px] gap-1.5 hidden sm:flex"
                title="Commands (⌘K)"
                @click="palette = true"
              >
                <TablerIcon name="command" :size="14" />
                <span class="text-[var(--color-ink-faint)]">K</span>
              </button>
              <button
                type="button"
                class="ia-btn ia-btn-ghost w-8 h-8 hidden sm:flex"
                :class="workspaceOpen ? 'ia-btn-on' : ''"
                :title="workspaceOpen ? 'Hide the workspace' : 'Show the workspace: files, editor, terminal, Git'"
                @click="toggleWorkspace()"
              >
                <TablerIcon name="layout-columns" :size="16" />
              </button>
              <!-- Back to the landing page, where 00 Mini is a widget over the scroll. -->
              <button type="button" class="ia-btn ia-btn-ghost w-8 h-8" title="Minimise to the page" @click="goTo('/')">
                <TablerIcon name="chevron-down" :size="16" />
              </button>
            </div>
          </header>

          <OfflineBanner />
          <InstallNag />

          <div class="flex-1 flex min-h-0">
            <!-- A claim link comes before everything in the body: it is a grant, not a destination. -->
            <ClaimPane
              v-if="claimRequest"
              class="flex-1 min-w-0"
              :request="claimRequest"
              @done="claimRequest = null; showPane('website')"
              @cancel="claimRequest = null"
            />

            <template v-else>
              <div v-if="threadVisible" class="flex-1 min-w-0 min-h-0">
                <ThreadPane v-if="pane === 'chat'" :compact="workspaceOpen && !phone" />
                <SettingsPane v-else v-model:tab="settingsTab" @close="showPane('chat')" />
              </div>

              <!-- The workspace: a column beside the thread on a desk, the whole screen on a phone. -->
              <div
                v-if="workspaceOpen"
                class="min-w-0 min-h-0"
                :class="
                  phone
                    ? 'flex-1'
                    : 'w-[clamp(320px,40%,560px)] shrink-0 border-l border-[var(--color-line)]'
                "
              >
                <WorkspacePanel />
              </div>
            </template>
          </div>
        </main>
      </div>

      <!-- The phone's four destinations, where a thumb is. -->
      <nav
        class="sm:hidden flex items-stretch border-t border-[var(--color-line)] shrink-0"
        :style="{ background: 'var(--color-panel)', paddingBottom: 'env(safe-area-inset-bottom)' }"
      >
        <button
          v-for="tab in BOTTOM"
          :key="tab.id"
          type="button"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px]"
          :class="bottomActive === tab.id ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]'"
          @click="bottom(tab.id)"
        >
          <TablerIcon :name="tab.icon" :size="18" />
          {{ tab.label }}
        </button>
      </nav>
    </template>

    <ApprovalsModal />
    <CommandPalette :open="palette" @close="palette = false" @go="showPane($event)" />
  </div>
</template>
