/**
 * SUBSCRIBING THIS BROWSER FOR NOTIFICATIONS (§5.7) — and where the key comes from.
 *
 * `PushManager.subscribe()` takes an `applicationServerKey`: the PUBLIC half of a VAPID keypair. A
 * subscription is minted AGAINST that key, so a key introduced later invalidates every subscription
 * taken before it. That ordering is the whole reason the worker publishes the public half a round
 * ahead of the sender, on the app card (`GET /infinite/apps/:id` → `push.vapidPublicKey`): the rows
 * already in its table have to be usable on the day it can send.
 *
 * ── THE KEY'S TWO SOURCES, IN ORDER ────────────────────────────────────────────────────────────
 *
 * THE CARD FIRST, the build's `VITE_INFINITE_VAPID_PUBLIC_KEY` only when the card carries none. The
 * card is the registry this browser is actually talking to and it can change without a rebuild; the
 * env var is what a build pointed at a worker too old to answer the field still has. A key of the
 * WRONG registry is worse than no key at all — every subscription taken under it is unsendable — so
 * the one the registry itself named wins, and `null` on the card (an explicit "no key here") does
 * NOT fall through to the env var of a build that guessed.
 *
 * The key is passed IN rather than read out of a module variable, because the card arrives on the
 * wire and the panel is reactive: a function of its argument recomputes when the card does, and a
 * cached global would leave the button disabled a round behind the answer.
 *
 * ── WHAT IS STILL NOT ON ───────────────────────────────────────────────────────────────────────
 *
 * SENDING. `worker/src/infinite/push.ts` stores subscriptions and every one of its routes answers
 * `"sending": false`; the private half and the sender are a later round. So subscribing is real as
 * soon as a key exists — it takes a real permission and mints a real subscription — and the panel
 * says out loud that nothing will arrive yet, reading `sending` from the answer rather than from a
 * belief of its own.
 *
 * ── AND THE THING iOS MAKES US SAY ─────────────────────────────────────────────────────────────
 *
 * iOS delivers Web Push only to an INSTALLED PWA. A tab in Safari cannot subscribe at all, and the
 * refusal it gives is not obviously about that, so `pushRefusal()` names it.
 */

/** base64url → the `Uint8Array` `applicationServerKey` wants. Padding restored; `-_` translated. */
export function decodeVapidKey(base64Url: string): Uint8Array {
  const norm = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The build's own carrier, for a worker whose card has no `push` field at all. */
function envKey(): string | null {
  const raw = (import.meta.env?.VITE_INFINITE_VAPID_PUBLIC_KEY as string | undefined)?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * The key to subscribe against: the app card's, else the build's, else none.
 *
 * `fromCard` is `undefined` when no card has been read (or the worker is older than the field) and
 * `null` when the card explicitly says this host publishes no key — the first falls back, the second
 * does not.
 */
export function vapidPublicKey(fromCard?: string | null): string | null {
  if (fromCard === undefined) return envKey();
  const trimmed = fromCard?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function pushApiAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/** Both halves: a key to subscribe against, and a browser that can. */
export function pushPossible(fromCard?: string | null): boolean {
  return !!vapidPublicKey(fromCard) && pushApiAvailable();
}

/** The sentence to show when it is not possible — the two reasons are not the same problem. */
export function pushRefusal(fromCard?: string | null): string | null {
  if (!vapidPublicKey(fromCard)) {
    return "This registry publishes no notification key yet, so there is nothing to subscribe against. It comes with a later worker round.";
  }
  if (!pushApiAvailable()) {
    return "This browser has no Web Push. On iPhone, add this app to the Home Screen first — iOS delivers notifications only to an installed app.";
  }
  return null;
}

export type SubscribeResult =
  | { ok: true; subscription: unknown }
  | { ok: false; code: "no_key" | "unavailable" | "denied" | "failed"; message: string };

/**
 * Subscribe this browser. MUST be called from a click — `Notification.requestPermission` is
 * user-gesture-gated in every browser that matters, and a permission prompt a person did not ask for
 * is a permission prompt they deny.
 */
export async function subscribeThisBrowser(fromCard?: string | null): Promise<SubscribeResult> {
  const key = vapidPublicKey(fromCard);
  if (!key) return { ok: false, code: "no_key", message: pushRefusal(fromCard) ?? "No VAPID key." };
  if (!pushApiAvailable()) return { ok: false, code: "unavailable", message: pushRefusal(fromCard) ?? "No Web Push here." };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, code: "denied", message: "This browser was not given permission to show notifications." };
    }
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(key) as unknown as BufferSource,
    });
    // `toJSON()` is the shape the worker's `normaliseSubscription` validates: an https `endpoint`
    // and an opaque `keys` object it stores verbatim for the day it encrypts a payload under them.
    return { ok: true, subscription: sub.toJSON() };
  } catch (err) {
    return { ok: false, code: "failed", message: err instanceof Error ? err.message : "The subscription failed." };
  }
}
