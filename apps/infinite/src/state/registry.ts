/**
 * The registry as state — §5.1's ref, §5.4's claim, and everything an owner does to a claimed app.
 *
 * WHY A STORE AND NOT THREE COMPONENTS' LOCALS, for the same reason `state/move.ts` is one: half of
 * this flow happens somewhere else. The ref is pasted into a website in another tab, on another
 * machine, possibly by another person; the registration happens in a stranger's browser; the claim
 * arrives back here as a query string minutes or days later. So what this browser knows — its ref,
 * its link key's public half, which app the ref became, whether it is claimed — lives here, is read
 * from IndexedDB on open, and survives every reload in between.
 *
 * THE POLL IS A PANE'S LIFETIME, NOT THE APP'S. `startInbox()` drains once and then every 60 s, and
 * `stopInbox()` is called when the pane closes. A background drain would be worse than useless: the
 * drain MARKS ITEMS DELIVERED at the worker, and delivering a lead to a tab nobody is looking at is
 * how a lead is lost.
 */
import { computed, ref, shallowRef } from "vue";
import { agent } from "./agent.js";
import {
  createRegistryClient,
  type AppCard,
  type InboxItem,
  type OriginRow,
  type PushRow,
  type Refusal,
  type RegistryClient,
  type RegistryResult,
  type SettableOriginStatus,
} from "../registry/client.js";
import { fileEscalation, recordReply } from "../registry/escalations.js";
import { LinkKeyUnavailable, linkIdentity, linkKeyPossible, signWithLinkKey } from "../registry/link-key.js";
import { buildPublicBundle, PUBLIC_BUNDLE_CONTENT_TYPE, type BuildResult } from "../registry/public-bundle.js";
import { subscribeThisBrowser } from "../registry/push.js";
import { embedSnippet, ownRef, readAppMemo, writeAppMemo, type RegistryAppMemo } from "../registry/ref.js";

// ── What this browser knows about itself ────────────────────────────────────────────────────────

const refValue = ref<string | null>(null);
const linkPub = ref<string | null>(null);
const memo = ref<RegistryAppMemo | null>(null);
const card = shallowRef<AppCard | null>(null);
const origins = ref<OriginRow[]>([]);
const inboxItems = ref<InboxItem[]>([]);
const pushRows = ref<PushRow[]>([]);
const pushSending = ref(false);
const busy = ref(false);
const failure = ref<Refusal | null>(null);
const notice = ref<string | null>(null);
const cursor = ref<string | null>(null);
const keyRefused = ref<string | null>(null);
const loaded = ref(false);

export const agentRef = computed(() => refValue.value);
export const linkPublicKey = computed(() => linkPub.value);
export const registryApp = computed(() => memo.value);
export const registryCard = computed(() => card.value);
export const registryOrigins = computed(() => origins.value);
export const registryInbox = computed(() => inboxItems.value);
export const registryPush = computed(() => pushRows.value);
export const pushIsSending = computed(() => pushSending.value);
export const registryBusy = computed(() => busy.value);
export const registryError = computed(() => failure.value);
export const registryNotice = computed(() => notice.value);
export const linkKeyRefusal = computed(() => keyRefused.value);
export const registryReady = computed(() => loaded.value);
export const isClaimed = computed(() => memo.value?.status === "claimed");

/** The `<script>` tag a site owner pastes, on THIS app's origin (§9.1: the site Worker serves `/e/<ref>.js`). */
export const snippet = computed(() =>
  refValue.value ? embedSnippet(refValue.value, typeof location === "undefined" ? "" : location.origin) : "",
);

function clearBanner(): void {
  failure.value = null;
  notice.value = null;
}

/**
 * Every action funnels its answer through here, so one refusal shape reaches every screen.
 *
 * AWAITED, deliberately: several of the `onOk` bodies write to the agent's filesystem or to
 * IndexedDB, and a caller that reported success before those finished would let a pane close on a
 * claim that was never remembered.
 */
async function absorb<T>(result: RegistryResult<T>, onOk?: (value: T) => void | Promise<void>): Promise<boolean> {
  if (result.ok) {
    failure.value = null;
    await onOk?.(result.value);
    return true;
  }
  failure.value = result;
  return false;
}

function client(): RegistryClient | null {
  const appId = memo.value?.appId;
  if (!appId) return null;
  return createRegistryClient({ appId, sign: (message) => signWithLinkKey(message) });
}

/**
 * Read what this origin holds and mint what it does not: the ref (offline, no server call) and the
 * link keypair. Called when the website pane opens, never during boot — an agent that is never put
 * on a website should not mint a key it will never use.
 */
export async function loadRegistry(): Promise<void> {
  clearBanner();
  refValue.value = await ownRef();
  memo.value = await readAppMemo();
  if (!linkKeyPossible()) {
    keyRefused.value = new LinkKeyUnavailable().message;
    loaded.value = true;
    return;
  }
  try {
    linkPub.value = (await linkIdentity()).publicKeyB64u;
    keyRefused.value = null;
  } catch (err) {
    keyRefused.value = err instanceof Error ? err.message : "This browser could not hold a link key.";
  }
  loaded.value = true;
  if (memo.value) await refreshCard();
}

/** The public card — status, whether a bundle is published, and how this origin stands. */
export async function refreshCard(): Promise<void> {
  const api = client();
  if (!api) return;
  const result = await api.getApp();
  await absorb(result, (value) => {
    card.value = value;
    if (memo.value && value.status !== memo.value.status) {
      memo.value = { ...memo.value, status: value.status };
      void writeAppMemo(memo.value);
    }
  });
}

// ── §5.4 The claim ──────────────────────────────────────────────────────────────────────────────

export interface ClaimRequest {
  appId: string;
  nonce: string;
  /** The site being claimed, as the admin flow named it. */
  origin: string;
}

/**
 * `/?claim=<appId>&nonce=<nonce>&origin=<origin>` — the link the site's admin flow opens (§5.4).
 *
 * All three halves are required and none is guessed: the signature is over `appId‖origin‖nonce` and
 * a missing field would produce a signature the worker refuses with no clue as to why. The origin is
 * parsed rather than trusted as a string, so a link carrying `javascript:` or a bare word is dropped
 * here rather than shown to a person as the site they are about to hand an agent to.
 */
export function claimRequestFromQuery(search: string): ClaimRequest | null {
  const params = new URLSearchParams(search);
  const appId = params.get("claim");
  const nonce = params.get("nonce");
  const rawOrigin = params.get("origin");
  if (!appId || !nonce || !rawOrigin) return null;
  let origin: string;
  try {
    const u = new URL(rawOrigin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Lower-cased and stripped to scheme://host[:port], exactly as `normaliseOrigin` stores it —
    // the signature must be over the string the worker holds, not the one the link happened to spell.
    origin = u.origin.toLowerCase();
  } catch {
    return null;
  }
  return { appId, nonce, origin };
}

/** Sign `appId‖origin‖nonce` and post it. On success this browser remembers the app it now owns. */
export async function runClaim(request: ClaimRequest): Promise<boolean> {
  clearBanner();
  busy.value = true;
  try {
    const api = createRegistryClient({ appId: request.appId, sign: (m) => signWithLinkKey(m) });
    const ref = refValue.value ?? (await ownRef());
    const result = await api.claim({ ref, origin: request.origin, nonce: request.nonce });
    return await absorb(result, async (value) => {
      memo.value = {
        appId: request.appId,
        status: value.status,
        origin: request.origin,
        claimedAt: value.claimedAt,
      };
      await writeAppMemo(memo.value);
      notice.value = value.originVerified
        ? "Claimed, and the site file proved the domain."
        : "Claimed. The domain is not proved yet — add the site file and press Verify.";
      await refreshCard();
    });
  } finally {
    busy.value = false;
  }
}

// ── §5.3 Origins ────────────────────────────────────────────────────────────────────────────────

export async function refreshOrigins(): Promise<void> {
  const api = client();
  if (!api) return;
  busy.value = true;
  try {
    await absorb(await api.listOrigins(), (rows) => {
      origins.value = rows;
    });
  } finally {
    busy.value = false;
  }
}

export async function setOriginStatus(origin: string, status: SettableOriginStatus): Promise<void> {
  const api = client();
  if (!api) return;
  clearBanner();
  busy.value = true;
  try {
    await absorb(await api.setOrigin(origin, status), (rows) => {
      origins.value = rows;
    });
  } finally {
    busy.value = false;
  }
}

/** The domain proof on demand: the worker fetches `/.well-known/infinite-agent.json` and writes the verdict. */
export async function verifyOrigin(origin: string): Promise<void> {
  const api = client();
  if (!api) return;
  clearBanner();
  busy.value = true;
  try {
    const done = await absorb(await api.verifyOrigin(origin), (answer) => {
      notice.value = answer.verified
        ? `${origin} is verified.`
        : `${origin} could not be verified: ${answer.reason}.`;
    });
    if (done) await refreshOrigins();
  } finally {
    busy.value = false;
  }
}

// ── §5.5 Publish knowledge ──────────────────────────────────────────────────────────────────────

const bundlePreview = ref<BuildResult | null>(null);
export const publicBundlePreview = computed(() => bundlePreview.value);

/** Build without sending, so the pane can show what would travel — and what is over the cap. */
export async function previewPublicBundle(): Promise<BuildResult | null> {
  const owned = agent.value;
  const ref = refValue.value;
  if (!owned || !ref) return null;
  bundlePreview.value = await buildPublicBundle(owned.fs, { ref });
  return bundlePreview.value;
}

export async function publishPublicBundle(): Promise<boolean> {
  const api = client();
  const built = (await previewPublicBundle()) ?? null;
  if (!api || !built) return false;
  clearBanner();
  if (!built.ok) {
    // Refused BY NAME and by size, never trimmed to fit: a bundle silently short of its last file is
    // a persona missing its last paragraph and nobody told the owner.
    failure.value =
      built.code === "too_large"
        ? {
            ok: false,
            code: "too_large",
            status: 0,
            maxBytes: built.maxBytes,
            message: `That is ${built.bytes} bytes and the ceiling is ${built.maxBytes}. Remove something from workspace/public/.`,
          }
        : {
            ok: false,
            code: "empty",
            status: 0,
            message: "There is nothing in workspace/public/ to publish. PERSONA.md is the usual first file.",
          };
    return false;
  }
  busy.value = true;
  try {
    const done = await absorb(await api.putPublicBundle(built.bytes, PUBLIC_BUNDLE_CONTENT_TYPE), () => {
      notice.value = `Published ${built.files.length} file${built.files.length === 1 ? "" : "s"}.`;
    });
    if (done) await refreshCard();
    return done;
  } finally {
    busy.value = false;
  }
}

export async function unpublishPublicBundle(): Promise<void> {
  const api = client();
  if (!api) return;
  clearBanner();
  busy.value = true;
  try {
    const done = await absorb(await api.deletePublicBundle(), () => {
      notice.value = "Unpublished.";
    });
    if (done) await refreshCard();
  } finally {
    busy.value = false;
  }
}

// ── §5.6 The inbox ──────────────────────────────────────────────────────────────────────────────

let poll: ReturnType<typeof setInterval> | null = null;

/**
 * One drain. Every item is filed into the agent's `escalations/` BEFORE it is shown, because the
 * worker has already marked it delivered by the time this promise resolves: if the tab closes
 * between the answer and the write, the item is gone from the queue and must still be on disk.
 */
export async function drainInbox(): Promise<void> {
  const api = client();
  const owned = agent.value;
  if (!api) return;
  await absorb(await api.drainInbox({ since: cursor.value }), async (page) => {
    for (const item of page.items) {
      if (owned) await fileEscalation(owned.fs, owned.profile.id, item);
    }
    if (page.items.length) {
      const known = new Set(inboxItems.value.map((i) => i.mid));
      inboxItems.value = [...page.items.filter((i) => !known.has(i.mid)), ...inboxItems.value];
    }
    cursor.value = page.cursor ?? cursor.value;
  });
}

/** Drain now, then every 60 s while the pane is open. */
export function startInbox(intervalMs = 60_000): void {
  stopInbox();
  void drainInbox();
  poll = setInterval(() => void drainInbox(), intervalMs);
}

export function stopInbox(): void {
  if (poll !== null) clearInterval(poll);
  poll = null;
}

export async function replyToItem(mid: string, reply: string): Promise<boolean> {
  const api = client();
  if (!api || !reply.trim()) return false;
  clearBanner();
  busy.value = true;
  try {
    return await absorb(await api.reply(mid, reply), async (answer) => {
      inboxItems.value = inboxItems.value.map((i) =>
        i.mid === mid ? { ...i, reply, repliedAt: answer.repliedAt } : i,
      );
      const owned = agent.value;
      if (owned) await recordReply(owned.fs, mid, reply, answer.repliedAt);
    });
  } finally {
    busy.value = false;
  }
}

// ── §5.7 Push ───────────────────────────────────────────────────────────────────────────────────

export async function refreshPush(): Promise<void> {
  const api = client();
  if (!api) return;
  await absorb(await api.listPush(), (list) => {
    pushRows.value = list.subscriptions;
    pushSending.value = list.sending;
  });
}

export async function subscribeBrowser(): Promise<boolean> {
  const api = client();
  if (!api) return false;
  clearBanner();
  const made = await subscribeThisBrowser();
  if (!made.ok) {
    failure.value = { ok: false, code: made.code, message: made.message, status: 0 };
    return false;
  }
  busy.value = true;
  try {
    const done = await absorb(await api.subscribePush(made.subscription), (answer) => {
      notice.value = answer.sending
        ? "This browser will be notified."
        : "Stored. The worker does not send notifications yet, so nothing will arrive until it does.";
    });
    if (done) await refreshPush();
    return done;
  } finally {
    busy.value = false;
  }
}

export async function removePush(endpoint: string): Promise<void> {
  const api = client();
  if (!api) return;
  clearBanner();
  busy.value = true;
  try {
    const done = await absorb(await api.deletePush(endpoint), () => {
      notice.value = "Forgotten.";
    });
    if (done) await refreshPush();
  } finally {
    busy.value = false;
  }
}

// ── §9.4 The purse link ─────────────────────────────────────────────────────────────────────────

export async function saveLink(stAppId: string, overblastCid: string): Promise<boolean> {
  const api = client();
  if (!api) return false;
  clearBanner();
  busy.value = true;
  try {
    return await absorb(await api.link({ stAppId: stAppId.trim() || null, overblastCid: overblastCid.trim() || null }), () => {
      notice.value = "Saved.";
    });
  } finally {
    busy.value = false;
  }
}

/** Everything a pane needs when it opens, once. */
export async function openOwnerPanel(): Promise<void> {
  if (!memo.value) return;
  await Promise.all([refreshCard(), refreshOrigins(), refreshPush()]);
  await previewPublicBundle();
}

/** For a test, and for the day a person clears the browser: forget what this origin remembered. */
export function resetRegistryState(): void {
  refValue.value = null;
  linkPub.value = null;
  memo.value = null;
  card.value = null;
  origins.value = [];
  inboxItems.value = [];
  pushRows.value = [];
  bundlePreview.value = null;
  cursor.value = null;
  failure.value = null;
  notice.value = null;
  keyRefused.value = null;
  loaded.value = false;
  stopInbox();
}
