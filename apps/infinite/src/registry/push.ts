/**
 * SUBSCRIBING THIS BROWSER FOR NOTIFICATIONS (§5.7) — and the reason the button is off.
 *
 * `PushManager.subscribe()` takes an `applicationServerKey`: the PUBLIC half of a VAPID keypair. A
 * subscription is minted AGAINST that key, so a key introduced later invalidates every subscription
 * taken before it — which is why the order has to be key first, subscribe second, and why this file
 * refuses rather than subscribing to nothing.
 *
 * The worker does not publish one. `worker/src/infinite/push.ts` stores subscriptions and every one
 * of its routes answers `"sending": false`, and says so in its own header: sending needs a VAPID
 * keypair, which is a new secret and a deployment decision. So `vapidPublicKey()` answers null
 * today, `pushPossible()` is false, and the panel says *notifications come with a later worker
 * round* instead of showing a control that would produce a subscription nobody can send to.
 *
 * `VITE_INFINITE_VAPID_PUBLIC_KEY` is the one carrier this app will read when that round lands — the
 * same shape `VITE_INFINITE_API_BASE` has, set at build time beside it. If the worker later serves
 * the key on a route instead, this is the one function to change.
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

/** The build's VAPID public key, or null while the worker has none. */
export function vapidPublicKey(): string | null {
  const raw = (import.meta.env?.VITE_INFINITE_VAPID_PUBLIC_KEY as string | undefined)?.trim();
  return raw && raw.length > 0 ? raw : null;
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
export function pushPossible(): boolean {
  return !!vapidPublicKey() && pushApiAvailable();
}

/** The sentence to show when it is not possible — the two reasons are not the same problem. */
export function pushRefusal(): string | null {
  if (!vapidPublicKey()) {
    return "Notifications come with a later worker round: it has nowhere to send from yet, so there is nothing to subscribe to.";
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
export async function subscribeThisBrowser(): Promise<SubscribeResult> {
  const key = vapidPublicKey();
  if (!key) return { ok: false, code: "no_key", message: pushRefusal() ?? "No VAPID key." };
  if (!pushApiAvailable()) return { ok: false, code: "unavailable", message: pushRefusal() ?? "No Web Push here." };
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
