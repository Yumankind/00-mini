/**
 * THE TWO DECISIONS A PUSH MAKES, taken out of the service worker so they can be tested.
 *
 * WHY THEY ARE NOT IN `public/sw.js`. A service worker cannot be imported by a node test: it runs in
 * a global with `self`, `caches` and `clients` and no module graph a test can reach, and vitest here
 * is deliberately a node environment (vitest.config.ts). But the two things that can actually be
 * WRONG about a notification are pure: what a payload turns into, and where a click goes. So they
 * live here, are tested here, and the build inlines this module into `dist/sw.js` (the `__PUSH_LIB__`
 * marker and the plugin in vite.config.ts). The worker keeps only the parts a test could not check
 * anyway — `showNotification`, `matchAll`, `focus`, `openWindow`.
 *
 * ── THE PAYLOAD IS THE WORKER'S, VERBATIM ──────────────────────────────────────────────────────
 *
 * `worker/src/infinite/push-send.ts` in moltworker sends exactly
 * `{ kind: 'inbox' | 'digest', appId, count, title, body, url }`, RFC 8291-sealed, with `title`
 * clamped to 120 characters and `body` to 200, and `url` RELATIVE (`/?app=<id>`) because a
 * subscription only exists for the origin whose service worker took it — the worker deliberately does
 * not know the product origin (§12.1 is still open). Everything here reads that shape defensively all
 * the same: a push whose payload is empty, unparseable or from an older sender must still show a
 * notification, because a browser that is handed a push and shows nothing has its subscription
 * REVOKED (`userVisibleOnly: true` is a promise, and Chrome enforces it).
 *
 * ── WHY A TAG, AND WHY IT IS PER APP ───────────────────────────────────────────────────────────
 *
 * The sender coalesces by count ("3 new messages on shop.example"), so the second notification
 * REPLACES the first rather than stacking beside it: same `tag`, and the tag is per app so two sites
 * a person operates never overwrite each other. `renotify` is off — a replacement is an update, not a
 * new event, and buzzing a phone again for the same inbox is how notifications get turned off.
 */

/** The worker's shape. Every field optional here: this is what arrives, not what we wish arrived. */
export interface PushPayload {
  kind?: string;
  appId?: string;
  count?: number;
  title?: string;
  body?: string;
  url?: string;
}

export interface PushNotificationOptions {
  body: string;
  tag: string;
  icon: string;
  badge: string;
  renotify: boolean;
  data: { url: string; kind: string; appId: string };
}

export interface PushNotificationPlan {
  title: string;
  options: PushNotificationOptions;
}

/** The fallback title. Deliberately vague: an unreadable payload is not a licence to invent a number. */
export const PUSH_FALLBACK_TITLE = "Your agent has something new";
export const PUSH_FALLBACK_BODY = "Open it to see.";
/** Where a click goes when the payload named nowhere. The shell is one page; `/` is always right. */
export const PUSH_DEFAULT_PATH = "/";

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/**
 * Parse what `event.data.text()` gave us. Never throws: a push that arrives with no payload at all
 * (an empty push is legal, and Safari sends one when a payload cannot be decrypted) is `{}`, and the
 * fallbacks above carry it.
 */
export function readPushPayload(raw: string | null | undefined): PushPayload {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PushPayload) : {};
  } catch {
    return {};
  }
}

/** DECISION ONE: a payload becomes exactly one notification. */
export function notificationFor(raw: string | null | undefined): PushNotificationPlan {
  const payload = readPushPayload(raw);
  const appId = text(payload.appId, "");
  const kind = text(payload.kind, "inbox");
  return {
    title: text(payload.title, PUSH_FALLBACK_TITLE),
    options: {
      body: text(payload.body, PUSH_FALLBACK_BODY),
      // One live notification per app per kind — see the header. With no appId (an older or broken
      // sender) the tag is still stable, so two unreadable pushes do not stack either.
      tag: `infinite-${kind}-${appId || "unknown"}`,
      icon: "/icon.svg",
      badge: "/icon.svg",
      renotify: false,
      data: { url: text(payload.url, PUSH_DEFAULT_PATH), kind, appId },
    },
  };
}

/**
 * DECISION TWO, first half: where a click goes, as an ABSOLUTE url on this origin.
 *
 * The sender's `url` is relative by design, so it is resolved against the worker's own origin. An
 * absolute one that points ANYWHERE ELSE is dropped back to `/`: the payload is encrypted end to end
 * and cannot normally be tampered with, but a notification is a click the person did not choose the
 * destination of, and "opens a stranger's site" is not a failure mode worth leaving open for the sake
 * of a field nobody sends.
 */
export function clickTarget(data: unknown, origin: string): string {
  const raw = data && typeof data === "object" ? (data as { url?: unknown }).url : undefined;
  const wanted = typeof raw === "string" && raw.trim().length > 0 ? raw : PUSH_DEFAULT_PATH;
  try {
    const resolved = new URL(wanted, origin);
    return resolved.origin === new URL(origin).origin ? resolved.href : new URL(PUSH_DEFAULT_PATH, origin).href;
  } catch {
    return new URL(PUSH_DEFAULT_PATH, origin).href;
  }
}

/**
 * DECISION TWO, second half: which open window to focus, if any.
 *
 * An exact url match first — the person may have several tabs and one of them is already looking at
 * this app. Failing that ANY tab on this origin, because the shell is a single page and routing it is
 * cheaper than a second window of the same app. `-1` means open a new one.
 */
export function clientToFocus(clientUrls: readonly string[], target: string): number {
  const exact = clientUrls.indexOf(target);
  if (exact >= 0) return exact;
  let sameOrigin = -1;
  try {
    const wanted = new URL(target).origin;
    clientUrls.forEach((url, i) => {
      if (sameOrigin >= 0) return;
      try {
        if (new URL(url).origin === wanted) sameOrigin = i;
      } catch {
        /* a client with an unparseable url is not one to focus */
      }
    });
  } catch {
    return -1;
  }
  return sameOrigin;
}
