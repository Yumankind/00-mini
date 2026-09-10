/**
 * Where the relay lives, and nothing else.
 *
 * ONE CONSTANT, because the relay origin is the single fact both halves of this folder need. The
 * engine derives its own from the signed-in account's `overblastBaseUrl()` and takes the ORIGIN of it
 * (`/api/engines/…` sits at the worker root, not under `/v1` — getting that wrong sent every publish
 * and poll to a 404 for a day). A browser has no account registry to derive it from, so it is written
 * here once, and it is written as THE SAME ORIGIN the engine derives.
 *
 * WHERE THE VALUE COMES FROM, exactly: `apps/00d/src/overblast-client.ts` has
 * `DEFAULT_BASE = "https://brain.deployd.network/v1"`, and `relayFor()` in
 * `apps/00d/src/mobile-connect-client.ts` calls `new URL(overblastBaseUrl()).origin` — so the Mac and
 * the phone both speak to `https://brain.deployd.network`. Until 2026-09-10 this file said
 * `https://api.overblast.com`, a host that does not resolve: both directions of §8.4/§8.5 failed as a
 * bare network error with nothing on screen to explain it (gap audit A1). Changing the engine's
 * default means changing this line, and nothing else in this app.
 */

/** The origin the engine derives, written down. Overridden by `VITE_RELAY_ORIGIN` (see `.env.example`). */
export const RELAY_ORIGIN = "https://brain.deployd.network";

/**
 * `VITE_RELAY_ORIGIN`, or nothing. An EMPTY value counts as unset, because an empty line in a `.env`
 * file and a missing one are the same intention and only one of them is a typo.
 */
export function envRelayOrigin(): string | undefined {
  const raw = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RELAY_ORIGIN;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The origin every relay call is made against, or `""` when this build has none.
 *
 * WHY IT NO LONGER THROWS. It used to throw on an unusable `VITE_RELAY_ORIGIN`, which turned a typo
 * in an environment file into a card that could not render at all — the throw happened while the
 * module that builds the relay was being constructed. An empty string instead is a value the caller
 * can SHOW, which is the whole point of `relayConfigured()` below and the same shape `roomsConfigured()`
 * in `src/transfer/config.ts` gives the live-transfer road.
 *
 * `off` is spelled out because a build may deliberately want no relay (the same word
 * `VITE_LITERT_MODEL_BASE` uses for "run without this"), and a deliberate absence should not read as
 * a mistake.
 */
export function relayOrigin(raw: string = envRelayOrigin() ?? RELAY_ORIGIN): string {
  if (raw === "off") return "";
  try {
    const { origin, hostname } = new URL(raw);
    // `.invalid` is reserved by RFC 2606 and is what the transfer config uses for "the worker does not
    // exist yet". Treated here the same way, so a placeholder never becomes a network error either.
    if (hostname.endsWith(".invalid")) return "";
    return origin;
  } catch {
    return "";
  }
}

/**
 * True while there is a real origin to talk to — the card says "not connected yet" when it is false.
 *
 * The argument is a TEST SEAM and nothing else: `import.meta.env` is baked at build time and cannot
 * be moved from a node test, so the value comes in rather than being reached for. Every caller in the
 * app passes nothing.
 */
export function relayConfigured(raw?: string): boolean {
  return relayOrigin(raw ?? envRelayOrigin() ?? RELAY_ORIGIN) !== "";
}

/** The refusal code `relay.ts` answers with, rather than attempting a fetch against nothing. */
export const RELAY_NOT_CONFIGURED = "relay_not_configured";

/** The one line the card shows in place of the two doors. Written here so both halves say it once. */
export const RELAY_NOT_CONFIGURED_LINE =
  "Not connected yet — this build has no relay origin, so your Mac and your phone cannot be reached from here. Set VITE_RELAY_ORIGIN and rebuild.";

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
