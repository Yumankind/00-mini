<script setup lang="ts">
/**
 * THE FLOATING 00 MINI — one session, minimalist, over the landing page (DESIGN.md).
 *
 * IT IS THE SAME AGENT AS `/app`, NOT A DEMO OF ONE. The stores are singletons, so the thread
 * started here is the thread the full app opens when the expand button is pressed: nothing is
 * transferred, because nothing was ever separate. That is the whole argument for the landing page
 * living inside the PWA — the widget in the corner is the product, running.
 *
 * IT BRINGS ITS OWN STYLESHEET, IN ITS OWN SHADOW ROOT. Every class below comes from
 * `src/mini/mini-css.ts`, the SAME string the embed injects into its closed shadow root — and since
 * 2026-09-11 this widget renders inside a shadow root too (an open one, on a host element appended
 * to <body>, reached with <Teleport>). Before that it sat in the app's own document, where the
 * landing page's stylesheet and Tailwind's preflight reached it, so the widget here and the widget
 * on a customer's site could drift apart. In a shadow root neither `src/style.css` nor a host page's
 * CSS can touch it, which is the promise Bruno asked for ("make sure the css of a website doesn't
 * leak into the embedded agent") kept in both directions. The theme cannot be read from an ancestor
 * inside a shadow root, so it is written on the `.mini` element itself (`data-theme`).
 *
 * WHY NO ATTACH BUTTON YET. The composer's send path (`state/conversation.ts`) takes a string, and
 * nothing in the app can carry image parts into a run today. The class is in the stylesheet and the
 * button appears the day that path grows parts; a control that cannot work is worse than no control.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderMarkdown } from "../lib/markdown-lite.js";
import { toolRowLabel, toolRowState, type Row } from "../lib/conversation.js";
import { busy, composerError, rows, send, startNewSession, stop } from "../state/conversation.js";
import { chip, download, loadInFlight, openChip } from "../state/model-choice.js";
import { profile, ready } from "../state/agent.js";
import { needsUnlock } from "../state/vault.js";
import { themeChoice } from "../state/install.js";
import { MINI_CSS } from "../mini/mini-css.js";
import { MINI_NAME, idleBlink, idleDelayMs, pixelFaceSvg, type FaceFrame } from "../mini/brand.js";
import { goTo } from "../mini/nav.js";
import { splitLandingContext, withLandingContext } from "../mini/page-tools.js";

const props = withDefaults(defineProps<{ expandable?: boolean; pageContext?: boolean }>(), {
  expandable: true,
  /** The landing page tells its agent where it is standing; a widget elsewhere does not. */
  pageContext: true,
});

const OPEN_KEY = "00.mini.open";

/**
 * The shadow root the widget renders into, made synchronously so <Teleport> has a target at mount.
 * `null` where there is no document (a test in node), and the template then renders nothing.
 */
const shadow: ShadowRoot | null = (() => {
  if (typeof document === "undefined") return null;
  const host = document.createElement("div");
  host.setAttribute("data-mini-host", "");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = MINI_CSS;
  root.append(style);
  document.body.append(host);
  return root;
})();
/** The app's own theme, carried onto the root: `system` leaves it to prefers-color-scheme. */
const theme = computed(() => (themeChoice.value === "system" ? undefined : themeChoice.value));

const open = ref(false);
const draft = ref("");
const input = ref<HTMLTextAreaElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const frame = ref<FaceFrame>("idle");
/** The context line rides on the FIRST message of a thread and not on the ones after it. */
const told = ref(false);
let idleTimer: ReturnType<typeof setTimeout> | undefined;

const face = computed(() => pixelFaceSvg({ size: 26, frame: busy.value ? "think" : frame.value }));
const launcherFace = pixelFaceSvg({ size: 22 });

/** One line under the name: what is answering, or what it is waiting for. */
const subline = computed(() => {
  if (needsUnlock.value) return "Locked — unlock it in the app";
  if (!ready.value) return "Waking up…";
  const d = download.value;
  if (d) return d.percent === null ? d.text : `${d.text}`;
  return chip.value.text;
});

const canSend = computed(() => draft.value.trim().length > 0 && !busy.value && !needsUnlock.value);

function remember(value: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, value ? "1" : "0");
  } catch {
    /* a browser that will not remember a preference still shows the widget */
  }
}

function setOpen(next: boolean): void {
  open.value = next;
  remember(next);
  if (next) void nextTick(() => input.value?.focus());
}

function grow(): void {
  const el = input.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(120, el.scrollHeight)}px`;
}

async function submit(): Promise<void> {
  const text = draft.value.trim();
  if (!text || busy.value) return;
  draft.value = "";
  void nextTick(grow);
  const message = props.pageContext ? withLandingContext(text, told.value) : text;
  told.value = true;
  await send(message);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void submit();
}

function newThread(): void {
  startNewSession();
  told.value = false;
  draft.value = "";
  void nextTick(() => input.value?.focus());
}

function expand(): void {
  goTo("/app");
}

/** The same idle loop as the site's logo: mostly a blink, occasionally a thought. */
function scheduleIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const next = idleBlink();
    frame.value = next.frame;
    idleTimer = setTimeout(() => {
      frame.value = "idle";
      scheduleIdle();
    }, next.holdMs);
  }, idleDelayMs());
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === "Escape" && open.value) setOpen(false);
}

onMounted(() => {
  try {
    open.value = localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    open.value = false;
  }
  window.addEventListener("keydown", onEscape);
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) scheduleIdle();
});

onBeforeUnmount(() => {
  clearTimeout(idleTimer);
  window.removeEventListener("keydown", onEscape);
  shadow?.host.remove();
});

// A new row means something to read: the transcript follows it, as a chat window should.
watch(
  () => rows.value.length,
  () => void nextTick(() => {
    const el = bodyEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }),
);

function userRow(row: Row & { kind: "user" }): { context: string | null; message: string } {
  return splitLandingContext(row.text);
}
</script>

<template>
  <Teleport v-if="shadow" :to="shadow">
  <div class="mini" :data-theme="theme">
    <!-- The panel is BEFORE the launcher in the DOM: the stylesheet hides the launcher with a
         sibling selector, so there is no state to keep in two places. -->
    <div
      class="mini-panel"
      :data-open="open ? '1' : '0'"
      role="dialog"
      :aria-label="MINI_NAME"
      :aria-hidden="open ? 'false' : 'true'"
    >
      <div class="mini-header">
        <div class="mini-face" v-html="face" />
        <div class="mini-heading">
          <div class="mini-title">{{ MINI_NAME }}</div>
          <div class="mini-sub">{{ subline }}</div>
        </div>
        <div class="mini-actions">
          <button type="button" class="mini-icon" title="New thread" aria-label="New thread" @click="newThread">＋</button>
          <button
            v-if="props.expandable"
            type="button"
            class="mini-icon"
            title="Open the full app"
            aria-label="Open the full app"
            @click="expand"
          >
            ⤢
          </button>
          <button type="button" class="mini-icon" title="Close" aria-label="Close" @click="setOpen(false)">✕</button>
        </div>
      </div>

      <div ref="bodyEl" class="mini-body">
        <div v-if="needsUnlock" class="mini-ask">
          <p>This agent's vault is locked. It opens in the full app, with your passkey or your password.</p>
          <button type="button" class="yes" @click="expand">Unlock</button>
        </div>

        <div v-else-if="!rows.length" class="mini-row them">
          <div class="mini-md">
            <p>{{ profile?.displayName ? `${profile.displayName} is here.` : "It is already running." }} Ask it something — about this page, or about anything else.</p>
          </div>
        </div>

        <template v-for="row in rows" :key="row.id">
          <div v-if="row.kind === 'user'" class="mini-row me">
            <div v-if="userRow(row).context" class="mini-note">{{ userRow(row).context }}</div>
            {{ userRow(row).message }}
          </div>

          <div v-else-if="row.kind === 'agent'" class="mini-row them">
            <div class="mini-md" v-html="renderMarkdown(row.text)" />
          </div>

          <div v-else-if="row.kind === 'status'" class="mini-row status">
            <span>{{ row.text }}</span>
            <span v-if="row.percent !== null" class="mini-bar"><i :style="{ width: `${row.percent}%` }" /></span>
          </div>

          <div v-else-if="row.kind === 'tool'" class="mini-row tool" :data-state="toolRowState(row)">
            <span class="mini-dot" />
            <span>{{ toolRowLabel(row) }}</span>
          </div>

          <div v-else-if="row.kind === 'footer'" class="mini-row footer">{{ row.text }}</div>

          <div v-else class="mini-row error">
            {{ row.text }}
            <button v-if="row.openChip" type="button" @click="openChip()">Choose a brain</button>
          </div>
        </template>

        <div v-if="composerError" class="mini-row error">{{ composerError }}</div>
      </div>

      <form class="mini-composer" @submit.prevent="submit">
        <textarea
          ref="input"
          v-model="draft"
          class="mini-input"
          rows="1"
          :placeholder="needsUnlock ? 'Unlock the vault to talk' : 'Ask 00 Mini'"
          :disabled="needsUnlock"
          aria-label="Message"
          @input="grow"
          @keydown="onKeydown"
        />
        <button v-if="busy || loadInFlight" type="button" class="mini-stop" title="Stop" aria-label="Stop" @click="stop()">■</button>
        <button v-else type="submit" class="mini-send" title="Send" aria-label="Send" :disabled="!canSend">↑</button>
      </form>

      <div class="mini-footer">
        <span>on your device only</span>
        <button v-if="props.expandable" type="button" class="mini-sponsor" @click="expand">Open the full app →</button>
      </div>
    </div>

    <button type="button" class="mini-launcher" :aria-expanded="open ? 'true' : 'false'" @click="setOpen(true)">
      <span class="mini-face" v-html="launcherFace" />
      <span>{{ MINI_NAME }}</span>
    </button>
  </div>
  </Teleport>
</template>
