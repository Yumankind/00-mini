/**
 * Move to my Mac, as state — docs/HANDOFF-infinite-agent.md §7.
 *
 * WHY THE STEPS ARE STATE AND NOT A WIZARD COMPONENT'S LOCALS. Half of this flow happens OUTSIDE the
 * tab: a file lands in Downloads, an OS prompt asks whether to open 00, an app the browser cannot see
 * either imports the agent or does not. The person comes back to this tab to say what happened, and
 * they may come back to it after a reload. So the step, the code and the file name live here, where
 * the shell can paint them from wherever the person left off, and the RECEIPT lives in IndexedDB
 * beside the connection settings, because §7's one-live-residence rule has to outlive a refresh or it
 * is not a rule.
 *
 * THE CODE IS NEVER LOGGED, NEVER PUT IN A URL AND NEVER PERSISTED. It is the bundle key. It exists
 * in this module's memory for as long as the flow is open and dies with the tab; the receipt that
 * survives carries the file name and the date, which are the two things a person needs later, and
 * nothing that would open the file.
 */
import { computed, ref } from "vue";
import {
  MOVE_CODE_RE,
  importDeepLink,
  isLocked,
  isSecondCopy,
  moveFilename,
  moveReceiptReducer,
  newMoveCode,
  type MoveReceipt,
  type MoveStep,
} from "../lib/move.js";
import { MOVE_RECEIPT_KEY, kvDelete, kvGet, kvSet } from "../lib/kv.js";
import { arrivedLine } from "../lib/vault-policy.js";
import { agent } from "./agent.js";
import type { OwnedAgent } from "../runtime/bootstrap.js";
import {
  mountTransfer,
  roomsConfigured,
  type ReceivePhase,
  type SendPhase,
  type TransferDeps,
} from "../transfer/index.js";

const step = ref<MoveStep>("explain");
const code = ref("");
const fileName = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const receipt = ref<LiveMoveReceipt | null>(null);
const restoring = ref(false);
/**
 * §4.5's *carry my secrets*, for BOTH roads (gap audit A2).
 *
 * One flag, not two, because it is one decision the person makes about one move — and because the two
 * roads share `transferDeps` below, so a second flag would be a second thing to forget. It is memory
 * only and `resetMove()` clears it: a tick left standing from a move a week ago must not put a vault
 * into a file somebody exports without looking.
 */
const carry = ref(false);
/** What the last received bundle actually brought, read off the files written on this side. */
const arrivedVault = ref<boolean | null>(null);

/**
 * §7 has two roads and one receipt. `via` says which road the agent left by — the file (the default,
 * and what a receipt written before this field existed means) or the live channel of §7.1. It is
 * additive on purpose: `moveReceiptReducer` in lib/move.ts spreads the state it is given, so a field
 * it has never heard of survives "brought back" and "unlock anyway" untouched, and every existing
 * reader keeps working.
 */
export type MoveVia = "file" | "live";
/**
 * `carried` is §4.5's tick as it was answered for THIS move (gap audit A2), additive for the same
 * reason `via` is: a receipt written before the field existed simply does not say, and the screen
 * then says nothing rather than guessing. It matters after the fact — "did my API keys leave this
 * browser" is a question a person asks the day after, not during the flow.
 */
export type LiveMoveReceipt = MoveReceipt & { via?: MoveVia; carried?: boolean };

export const moveStep = computed(() => step.value);
export const moveCode = computed(() => code.value);
export const moveFileName = computed(() => fileName.value);
export const moveBusy = computed(() => busy.value);
export const moveError = computed(() => error.value);
export const moveReceipt = computed(() => receipt.value);
/** The tick's current position; the panels bind it through `setCarrySecrets`. */
export const carrySecrets = computed(() => carry.value);
/** One line about the vault an incoming bundle did or did not bring; null until one has landed. */
export const arrivedVaultLine = computed(() => (arrivedVault.value === null ? null : arrivedLine(arrivedVault.value)));
/** The shell paints the receipt instead of the agent exactly while this is true. */
export const movedAway = computed(() => isLocked(receipt.value));
/** An override happened: this browser and the Mac may both be live, and the screen says so. */
export const twoLiveCopies = computed(() => isSecondCopy(receipt.value));
/** The receipt pane has opened its Restore form. */
export const bringingBack = computed(() => restoring.value);
/** `zerozero://agent/import?name=…` — the file name only; see the note in lib/move.ts. */
export const moveDeepLink = computed(() => (fileName.value ? importDeepLink(fileName.value) : ""));

/** Read at boot, before the shell decides which pane to paint. */
export async function loadMoveReceipt(): Promise<MoveReceipt | null> {
  // The QR road, read and erased in the same breath — see `receiveFromLocation`. It is here because
  // App.vue already awaits this on boot, before anything is painted, which is the only moment where
  // "the URL said receive" can still decide which screen a person lands on.
  receiveFromLocation();
  receipt.value = await kvGet<LiveMoveReceipt>(MOVE_RECEIPT_KEY);
  return receipt.value;
}

async function persist(next: LiveMoveReceipt | null): Promise<void> {
  receipt.value = next;
  if (next) await kvSet(MOVE_RECEIPT_KEY, next);
  else await kvDelete(MOVE_RECEIPT_KEY);
}

/** Back to step one with no secret in memory — what closing the panel means. */
export function resetMove(): void {
  step.value = "explain";
  code.value = "";
  fileName.value = "";
  error.value = null;
  busy.value = false;
  carry.value = false;
}

/** The tick, from either road's screen. Refused outright unless the vault can travel at all (§4.5). */
export function setCarrySecrets(on: boolean, allowed = true): void {
  carry.value = on && allowed;
}

export function toCodeStep(random?: Parameters<typeof newMoveCode>[0]): string {
  code.value = newMoveCode(random);
  step.value = "code";
  return code.value;
}

/**
 * Step 3. The code IS the bundle secret, and `exportBundleFile` is the same door Backup uses, so a
 * moved agent and a backed-up one are the same `.00agent` with the same `host: "browser"` — which is
 * what lets the Mac open either of them with the one document type it registered.
 *
 * The Blob URL is revoked on the next tick: it holds the whole encrypted bundle alive in memory for
 * as long as the document does.
 */
export async function downloadMove(at = new Date()): Promise<string | null> {
  const owned = agent.value;
  if (!owned || !code.value) return null;
  busy.value = true;
  error.value = null;
  try {
    const blob = await owned.exportBundleFile(code.value, { carrySecrets: carry.value });
    const name = moveFilename(owned.profile.displayName, at);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    fileName.value = name;
    step.value = "open";
    return name;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    busy.value = false;
  }
}

/**
 * Step 4. A custom scheme has no feedback: the browser either hands it to 00, or asks first, or does
 * nothing at all when 00 is not installed. So this never claims success — it moves the panel on to
 * the step that asks the person what actually happened, and the fallback sentence stays on screen.
 */
export function openIn00(): void {
  if (!fileName.value) return;
  location.href = importDeepLink(fileName.value);
  step.value = "confirm";
}

/** Step 5. The person says the Mac has it; this browser stops being a residence. */
export async function confirmMoved(at = new Date()): Promise<void> {
  const owned = agent.value;
  if (!owned || !fileName.value) return;
  const moved = moveReceiptReducer(receipt.value, {
    type: "moved",
    profile: owned.profile,
    fileName: fileName.value,
    at,
  });
  await persist(moved ? { ...moved, via: "file", carried: carry.value } : null);
  resetMove();
}

export function openBringBack(): void {
  restoring.value = true;
}

export function closeBringBack(): void {
  restoring.value = false;
}

/** Called by the Restore path on success — the Mac handed it back, so this browser is live again. */
export async function releaseAfterRestore(at = new Date()): Promise<void> {
  if (!receipt.value) return;
  await persist(moveReceiptReducer(receipt.value, { type: "brought-back", at }));
}

/** The person's call, taken with the risk named on the screen that offers it. */
export async function unlockAnyway(at = new Date()): Promise<void> {
  await persist(moveReceiptReducer(receipt.value, { type: "unlock-anyway", at }));
  restoring.value = false;
}

/** Drops the record entirely — offered once the lock is off and the note has been read. */
export async function forgetMoveReceipt(): Promise<void> {
  await persist(moveReceiptReducer(receipt.value, { type: "cleared" }));
}

// ── The live road (§7.1): a room, a code, a confirmation, and bytes over a DataChannel ────────────
//
// WHY IT SHARES THIS STORE WITH THE FILE ROAD. There is one rule to keep — one live residence — and
// one receipt that keeps it. Two stores would mean two places that can write that receipt, and the
// day they disagree is the day a person has two live agents. So the file road and the live road are
// two sets of refs and ONE `persist`.
//
// THE CODE AND THE CONFIRMATION ARE MEMORY ONLY. Neither is written to IndexedDB, put in a URL or
// logged; both are cleared by `resetLive()`, which is what closing the panel calls.

/** Where the live send is. `idle` means the second road has not been taken this session. */
export type LivePhase = "idle" | SendPhase | ReceivePhase | "failed";

const liveRole = ref<"send" | "receive" | null>(null);
const livePhaseRef = ref<LivePhase>("idle");
const liveCodeRef = ref("");
const liveConfirmRef = ref("");
const liveSent = ref(0);
const liveTotal = ref(0);
const liveErrorRef = ref<string | null>(null);
const liveIncomingRef = ref<{ name: string; bytes: number } | null>(null);
const replaceAsk = ref<((allowed: boolean) => void) | null>(null);
let cancelRequested = false;

export const liveRoad = computed(() => liveRole.value);
export const livePhase = computed(() => livePhaseRef.value);
/** The six words, on the sending device only, and only while the flow is open. */
export const liveCode = computed(() => liveCodeRef.value);
/** The four characters both screens compare. Empty until the peer is on the channel. */
export const liveConfirmation = computed(() => liveConfirmRef.value);
export const liveError = computed(() => liveErrorRef.value);
export const liveIncoming = computed(() => liveIncomingRef.value);
/** 0..100, or null when there is nothing to draw yet. */
export const liveProgress = computed(() =>
  liveTotal.value > 0 ? Math.min(100, Math.round((liveSent.value / liveTotal.value) * 100)) : null,
);
export const liveBusy = computed(
  () => liveRole.value !== null && livePhaseRef.value !== "done" && livePhaseRef.value !== "failed",
);
/** The far side is asking to replace the agent that is already here; the screen shows the question. */
export const liveNeedsReplace = computed(() => replaceAsk.value !== null);
/** False while `VITE_INFINITE_API_BASE` is still the placeholder — the card says so instead of hanging. */
export const liveAvailable = computed(() => roomsConfigured());

export function resetLive(): void {
  liveRole.value = null;
  arrivedVault.value = null;
  livePhaseRef.value = "idle";
  liveCodeRef.value = "";
  liveConfirmRef.value = "";
  liveSent.value = 0;
  liveTotal.value = 0;
  liveErrorRef.value = null;
  liveIncomingRef.value = null;
  replaceAsk.value?.(false);
  replaceAsk.value = null;
  cancelRequested = false;
}

/** The person pressed Cancel: the send loop stops at the next chunk and the far side is told. */
export function cancelLive(): void {
  cancelRequested = true;
}

/** The answer to "replace the agent that is already in this browser?", from the screen. */
export function answerReplace(allowed: boolean): void {
  const ask = replaceAsk.value;
  replaceAsk.value = null;
  ask?.(allowed);
}

/**
 * `overrides` on the two entry points below is the ONE seam: the room service and the WebRTC channel
 * are parameters, so the whole live road can be driven in a node test against a fake room and a pair
 * of arrays. The panel passes nothing and gets the real ones.
 *
 * The two operations a transfer needs, taken from the booted agent — see the note in
 * `transfer/index.ts` about why this is injected rather than imported.
 */
function transferDeps(owned: OwnedAgent): TransferDeps {
  return {
    exportBundle: async (secret) =>
      new Uint8Array(await (await owned.exportBundleFile(secret, { carrySecrets: carry.value })).arrayBuffer()),
    importBundle: async (bytes, secret) => {
      const landed = await owned.importBundleFile(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }),
        secret,
      );
      // Reported, not assumed: the sending device chose whether its vault came, and this side is the
      // only one that can say what actually arrived.
      arrivedVault.value = landed.vaultTravelled;
      return landed;
    },
    profile: () => owned.profile,
    // The PWA scaffolds an agent on first visit (§4.1), so there is always one here and replacing it
    // is always a decision.
    hasAgent: () => true,
    confirmReplace: () =>
      new Promise<boolean>((resolve) => {
        replaceAsk.value = resolve;
      }),
  };
}

function failLive(err: unknown): false {
  liveErrorRef.value = err instanceof Error ? err.message : String(err);
  livePhaseRef.value = "failed";
  return false;
}

/**
 * Move live. Resolves `true` only when the far side acknowledged the import — and only then is the
 * receipt written, which is the whole of §7's rule as control flow.
 */
export async function startLiveMove(overrides: Partial<TransferDeps> = {}): Promise<boolean> {
  const owned = agent.value;
  if (!owned) return false;
  resetLive();
  liveRole.value = "send";
  livePhaseRef.value = "opening";
  try {
    const result = await mountTransfer({ ...transferDeps(owned), ...overrides }).send({
      cancelled: () => cancelRequested,
      hooks: {
        onCode: (code) => (liveCodeRef.value = code),
        onConfirmation: (fp) => (liveConfirmRef.value = fp),
        onPhase: (phase) => (livePhaseRef.value = phase),
        onProgress: (sent, total) => {
          liveSent.value = sent;
          liveTotal.value = total;
        },
      },
    });
    const moved = moveReceiptReducer(receipt.value, {
      type: "moved",
      profile: owned.profile,
      fileName: result.fileName,
      at: result.movedAt,
    });
    await persist(moved ? { ...moved, via: "live", carried: carry.value } : null);
    // The code dies with the flow; the receipt keeps the name and the date, and nothing that opens
    // the bundle.
    liveCodeRef.value = "";
    livePhaseRef.value = "done";
    return true;
  } catch (err) {
    return failLive(err);
  }
}

/** Receive live: the person typed the code they are reading off the other device. */
export async function startLiveReceive(code: string, overrides: Partial<TransferDeps> = {}): Promise<boolean> {
  const owned = agent.value;
  if (!owned) return false;
  resetLive();
  liveRole.value = "receive";
  livePhaseRef.value = "joining";
  try {
    await mountTransfer({ ...transferDeps(owned), ...overrides }).receive(code, {
      onConfirmation: (fp) => (liveConfirmRef.value = fp),
      onPhase: (phase) => (livePhaseRef.value = phase),
      onIncoming: (hello) => (liveIncomingRef.value = { name: hello.name, bytes: hello.bytes }),
      onProgress: (received, total) => {
        liveSent.value = received;
        liveTotal.value = total;
      },
    });
    // The agent that just landed is not the one this tab booted: everything downstream of the
    // filesystem — runtime, sessions, vault — was built from the old tree. A reload is the honest
    // way to open the new one, and it is the caller's to do (`location.reload()` in the panel).
    livePhaseRef.value = "done";
    return true;
  } catch (err) {
    return failLive(err);
  }
}

/**
 * Connections has one card for the second road, and App.vue owns the pane switch — so "open the Move
 * pane ON the receiving road" is one bit of state rather than a prop threaded through a component
 * this work does not touch.
 */
const wantsReceive = ref(false);
export const receiveWanted = computed(() => wantsReceive.value);
export function askForReceive(): void {
  wantsReceive.value = true;
}

// ── The QR road (§7, "bring it with you") ────────────────────────────────────────────────────────
//
// THE CODE RIDES IN THE FRAGMENT, AND THAT IS A DELIBERATE EXCEPTION. lib/move.ts says the code is
// never in a URL, and the reason it gives is the right one: a URL is written to history, to the
// app-switch log, to the OS's "open this?" prompt and to every server it is sent to. A FRAGMENT is
// the one part of a URL that is never sent to a server — it is not in the request line, it is not in
// a referer, and a Worker serving this page cannot see it even if it wanted to. So the QR code a
// phone scans carries `#code=…`, the app reads it once, and `history.replaceState` takes it out of
// the URL and out of the history entry before anything else runs. What remains true is the older
// rule's substance: the code never reaches a server, and it never survives being read.
//
// Recorded for the owner in docs/HANDOFF-infinite-agent.md, "For the owner's review", item 22.

const prefilled = ref<string | null>(null);
const requestedByLink = ref(false);

/** The six words a scanned link brought, until the receive screen has taken them. */
export const prefilledCode = computed(() => prefilled.value);
/**
 * A LINK ASKED FOR THE RECEIVE SCREEN. The shell must read this at boot and open the Move pane —
 * `receiveWanted` alone cannot do it, because the only reader of that flag is MovePanel's own
 * `onMounted`, and MovePanel is not mounted until the pane is already open (see the note in
 * docs/HANDOFF-infinite-agent.md, "For the owner's review", item 22).
 */
export const receiveRequested = computed(() => requestedByLink.value);

/**
 * `https://…/?receive#code=six-words` → the code, and the same URL with BOTH halves gone. Pure, so
 * the parsing and the stripping are a test rather than a thing that only happens in a browser.
 *
 * A malformed code is thrown away and the link is still stripped: something that was shaped like a
 * secret must not be left sitting in the address bar because it turned out not to be one.
 */
export function parseReceiveLink(href: string): { receive: boolean; code: string | null; url: string } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { receive: false, code: null, url: href };
  }
  if (!url.searchParams.has("receive")) return { receive: false, code: null, url: href };

  const hash = url.hash.replace(/^#/, "");
  const match = /(?:^|&)code=([^&]*)/.exec(hash);
  let code: string | null = null;
  if (match) {
    let raw = match[1];
    try {
      raw = decodeURIComponent(raw.replace(/\+/g, " "));
    } catch {
      // A fragment that is not valid percent-encoding is not a code; it is still stripped below.
    }
    const candidate = raw.trim().toLowerCase();
    code = MOVE_CODE_RE.test(candidate) ? candidate : null;
  }
  url.searchParams.delete("receive");
  url.hash = "";
  return { receive: true, code, url: url.toString() };
}

/**
 * Read the link this tab was opened with, then erase it. Called by `loadMoveReceipt` at boot, so no
 * component has to own it and the URL is clean before the first frame.
 */
export function receiveFromLocation(): string | null {
  if (typeof location === "undefined" || typeof history === "undefined") return null;
  const { receive, code, url } = parseReceiveLink(location.href);
  if (!receive) return null;
  // FIRST, always: the strip must not wait on anything that could throw between here and there.
  if (url !== location.href) history.replaceState(history.state, "", url);
  prefilled.value = code;
  requestedByLink.value = true;
  wantsReceive.value = true;
  return code;
}

/** The receive screen has opened and taken what the link brought; nothing of it is kept. */
export function clearReceiveWanted(): void {
  wantsReceive.value = false;
  requestedByLink.value = false;
  prefilled.value = null;
}
