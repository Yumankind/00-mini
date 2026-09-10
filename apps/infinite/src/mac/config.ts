/**
 * Where the relay lives, and nothing else.
 *
 * ONE CONSTANT, because the relay origin is the single fact both halves of this folder need and the
 * single fact that will change when the worker gets its real hostname. The engine derives its own
 * from the signed-in account's `overblastBaseUrl()` and takes the ORIGIN of it (`/api/engines/…` sits
 * at the worker root, not under `/v1` — getting that wrong sent every publish and poll to a 404 for a
 * day). A browser has no account registry to derive it from, so it is written here once.
 */

/**
 * PLACEHOLDER — decision §12.1 has not named the production origin yet.
 *
 * It is deliberately a real, reachable-looking origin rather than an empty string: an empty base
 * produces same-origin requests against the PWA's own host, which 404 and read exactly like a
 * sleeping Mac. A wrong host at least fails as a network error the card can name.
 */
export const RELAY_ORIGIN = "https://api.overblast.com";

/** Read at build time when it is set, so a dev build can point at a local worker without an edit. */
export function relayOrigin(): string {
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RELAY_ORIGIN;
  const raw = (fromEnv ?? RELAY_ORIGIN).trim();
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`mobile connect: VITE_RELAY_ORIGIN is not a usable absolute URL (got "${raw}")`);
  }
}

/**
 * How often the browser-as-engine asks the relay what queued. The engine's own number
 * (`MOBILE_POLL_MS`), on purpose: a phone that has learned to expect an answer within fifteen seconds
 * from a Mac should not learn a different rhythm from a browser.
 */
export const MAC_POLL_MS = 15_000;

/** How often the client asks for an answer it is waiting on, and how long it waits before saying so.
 *  The Flutter app polls every 2 s for up to 5 minutes; a turn on a Mac can genuinely take minutes. */
export const RESULT_POLL_MS = 2_000;
export const RESULT_TIMEOUT_MS = 5 * 60_000;

/** The relay's own cap (`MAX_PAYLOAD_BYTES` in the worker). Checked before sending so an oversized
 *  prompt is refused here, by name, instead of as an opaque 413. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
