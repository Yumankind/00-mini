/**
 * WHERE THE ROOM SERVICE IS. One constant, on purpose.
 *
 * §7.1's rooms (`POST /infinite/rooms`) and the SFU credentials they mint are being built in the
 * OTHER repo (moltworker, `worker/src/infinite/`, behind `INFINITE_ENABLED` — §9.4) and are NOT
 * DEPLOYED as this is written. Everything in `src/transfer/` is coded against the shape the plan
 * writes down and tested against a fake room service; the day the worker answers, the only thing
 * that changes in this app is the string below (or the environment that overrides it).
 *
 * ⚠️ PLACEHOLDER — the host is deliberately an unroutable `.invalid` name so that a build shipped
 * before the worker exists FAILS AT THE FETCH with an obvious host, rather than quietly reaching
 * some other origin. Replace it, or set `VITE_INFINITE_API_BASE`, when §9.4 lands.
 */
const PLACEHOLDER_BASE = "https://infinite-rooms.invalid/infinite";

function fromEnv(): string {
  const raw = (import.meta.env?.VITE_INFINITE_API_BASE as string | undefined)?.trim();
  return raw && raw.length > 0 ? raw : PLACEHOLDER_BASE;
}

/** No trailing slash, ever: every path in room-client.ts is written as `${BASE}/rooms…`. */
export function infiniteApiBase(): string {
  return fromEnv().replace(/\/+$/, "");
}

/** True while the app is pointed at the placeholder — the UI says "not connected yet" rather than
 *  showing a person a spinner that can never end. */
export function roomsConfigured(): boolean {
  return !infiniteApiBase().includes(".invalid");
}
