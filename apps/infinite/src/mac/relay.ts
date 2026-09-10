/**
 * The relay, as an interface with one implementation.
 *
 * WHY A SEAM AND NOT A DIRECT `fetch`. Both halves of this folder are almost entirely "what do we do
 * with a frame" — a rewritten payload, a forged signature, a retry, a busy runtime — and none of that
 * is about how a bearer token is found. The engine reached the same conclusion and for the same
 * reason (`__setRelayTransportForTests` in `apps/00d/src/mobile-connect-client.ts`); this is the same
 * seam, declared up front rather than bolted on.
 *
 * A REFUSAL IS ALWAYS A SHAPE, NEVER A THROW. Every route on the relay answers a named code on
 * failure (`result_not_ready`, `agent_not_opted_in`, `device_unknown`, `engine_unreachable`…), and
 * those names are the whole reason a person can be told what to go and fix. A transport that threw
 * would flatten all of them into "network error", so an unreachable relay is `{ ok: false, status: 0 }`
 * and the caller decides.
 *
 * A BUILD WITH NO RELAY IS ONE OF THOSE NAMES. `relayConfigured()` is false when this build has no
 * usable origin, and then nothing is fetched at all: a request against `""` would go to the PWA's own
 * host, 404, and read exactly like a sleeping Mac. `relay_not_configured` is the honest answer and it
 * is the one the card turns into "not connected yet" (gap audit A1).
 */
import { RELAY_NOT_CONFIGURED, RELAY_NOT_CONFIGURED_LINE, relayOrigin } from "./config.js";

export interface RelayResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

export type Relay = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<RelayResponse>;

export interface RelayOptions {
  /** The account credential the relay authenticates with. The phone sends the app's session JWT; a
   *  browser sends an Overblast key the person pasted, which is why it is read fresh on every call —
   *  a token that was unlocked from the vault mid-session must start working without a reload. */
  token: () => string | null;
  origin?: string;
  fetchImpl?: typeof fetch;
}

export function createRelay(opts: RelayOptions): Relay {
  const origin = opts.origin ?? relayOrigin();
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (method, path, body) => {
    if (!origin) {
      return { ok: false, status: 0, json: { error: RELAY_NOT_CONFIGURED_LINE, code: RELAY_NOT_CONFIGURED } };
    }
    const token = opts.token();
    if (!token) {
      return { ok: false, status: 401, json: { error: "No account credential for the relay.", code: "unauthorized" } };
    }
    let res: Response;
    try {
      res = await doFetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, status: 0, json: { error: err instanceof Error ? err.message : "unreachable", code: "unreachable" } };
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      /* not JSON — the status is the whole outcome */
    }
    return { ok: res.ok, status: res.status, json };
  };
}

/** The relay's named code for a refusal, or a sentence built from the status when it gave none. */
export function relayFailure(r: RelayResponse): { error: string; code?: string } {
  const code = typeof r.json.code === "string" ? r.json.code : undefined;
  const error =
    typeof r.json.error === "string" && r.json.error
      ? r.json.error
      : r.status === 0
        ? "The relay could not be reached."
        : `The relay refused this (${r.status}).`;
  return { error, ...(code ? { code } : {}) };
}
