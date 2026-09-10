/**
 * WHERE THE REGISTRY IS — the second, and last, host this embed is allowed to name.
 *
 * `local-ai.ts` holds the model mirror and says why one fact about the world is written down once.
 * This is the other one: the Infinite registry of §9.4, which lives in the OTHER repo (moltworker,
 * `worker/src/infinite/`, behind `INFINITE_ENABLED`) and is NOT DEPLOYED as this is written. Every
 * route in `client.ts` is a path under the base below and nothing else may name a host, which is
 * what `test/embed/local-ai.test.ts`'s one-host grep now checks for two files instead of one.
 *
 * ⚠️ PLACEHOLDER, and deliberately unroutable. The semantics are `apps/infinite/src/transfer/
 * config.ts`'s, to the letter, because it is the same worker: a build shipped before the registry
 * exists must FAIL AT THE FETCH with an obvious host rather than quietly reach some other origin,
 * and the panel must be able to ask "am I pointed at a real one?" and say *not connected yet*
 * instead of showing a person a spinner that can never end.
 *
 * Set `VITE_INFINITE_API_BASE` at build time to the deployed base (`https://…/infinite`).
 */

/** The unroutable stand-in. `.invalid` is reserved by RFC 2606 and resolves nowhere, ever. */
export const INFINITE_API_PLACEHOLDER = "https://infinite-registry.invalid/infinite";

function fromEnv(): string {
  const raw = (import.meta.env?.VITE_INFINITE_API_BASE as string | undefined)?.trim();
  return raw && raw.length > 0 ? raw : INFINITE_API_PLACEHOLDER;
}

/** No trailing slash, ever: every path in `client.ts` is written as `${base}/apps…`. */
export function infiniteApiBase(): string {
  return fromEnv().replace(/\/+$/, "");
}

/**
 * True when this build points at a real registry.
 *
 * The whole of Phase 3 in the embed is gated on it: with no registry there is no app, no device and
 * no inbox, so `send_to_owner` says so in a sentence and level 0 carries on exactly as before.
 */
export function registryConfigured(): boolean {
  return !infiniteApiBase().includes(".invalid");
}
