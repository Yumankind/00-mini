/**
 * THE OWNER'S HALF OF THE REGISTRY WIRE — every call this browser makes to `/infinite/apps/*`.
 *
 * ── WHAT IS NOT HERE, AND WHY ──────────────────────────────────────────────────────────────────
 *
 * `POST /apps/register` is missing on purpose. Registration is THE SITE'S call, made by the loader
 * in a visitor's browser on the site's own origin, because the worker reads the origin from the
 * request's `Origin` header and never from a body (§5.3). If this app registered, every app in the
 * registry would claim to live at the product origin, and the whole allow-list would be one entry
 * long and wrong. The owner's first act is therefore the CLAIM (§5.4), which is why `claim()` is the
 * first function below and why it is the only unauthenticated one: the signature IS the credential.
 *
 * Device registration and the visitor's poll are missing for the same kind of reason — they belong
 * to the embed, on the visitor's side, with a P-256 key of their own.
 *
 * ── EVERY REFUSAL IS A VALUE, NEVER A THROW ────────────────────────────────────────────────────
 *
 * The worker names each refusal (`bad_signature`, `stale_signature`, `not_claimed`, `too_large`,
 * `already_replied`, `inbox_full`, …) and the person's next move is different for every one of them:
 * a stale signature means fix the clock, `not_claimed` means claim first, `too_large` means delete a
 * file. A thrown `Error` flattens all of that into a red box, so nothing here throws across the UI
 * boundary — `{ ok: false, code, message, status }` comes back and the panel decides what to say.
 * An unreachable host and a placeholder base get the same treatment (`unreachable`,
 * `not_configured`), because "the worker is not deployed yet" is the commonest case of all while the
 * flag is dark and it is not an exception.
 *
 * ── THE BASE IS `infiniteApiBase()`, THE ONE THE ROOMS USE ─────────────────────────────────────
 *
 * `transfer/config.ts` already owns that constant, its `.invalid` placeholder and its
 * `VITE_INFINITE_API_BASE` override, and the registry lives behind the same `INFINITE_ENABLED` flag
 * in the same worker module. A second constant would be a second thing to point at a deployment.
 */
import { infiniteApiBase, roomsConfigured } from "../transfer/config.js";
import { claimMessage, signedHeaders } from "./signed.js";

// ── Results ─────────────────────────────────────────────────────────────────────────────────────

export interface Refusal {
  ok: false;
  /** The worker's own code, or `unreachable` / `not_configured` / `bad_response` from this side. */
  code: string;
  message: string;
  /** 0 when the request never reached a server. */
  status: number;
  retryAfter?: number;
  maxBytes?: number;
  /** `ref_registered` carries the app that already holds the ref. */
  appId?: string;
}

export type RegistryResult<T> = { ok: true; value: T } | Refusal;

export function isRefusal<T>(result: RegistryResult<T>): result is Refusal {
  return result.ok === false;
}

// ── The wire's shapes, as the worker sends them ─────────────────────────────────────────────────

export type AppStatus = "dev" | "unclaimed" | "claimed" | "killed";
export type OriginStatus = "allowed" | "requested" | "verified" | "blocked" | "unknown";
/** What an owner may SET. `verified` is earned by the site file and answers `bad_status` if typed. */
export type SettableOriginStatus = "allowed" | "requested" | "blocked";

export interface AppCard {
  appId: string;
  ref: string;
  status: AppStatus;
  hasPublicBundle: boolean;
  /** Null when the caller sent neither `Origin` nor `Referer` — which a `fetch` from a page never does. */
  origin: { origin: string; status: OriginStatus } | null;
  /**
   * The `applicationServerKey` a browser must pass to `PushManager.subscribe()` (§5.7).
   *
   * A FIELD RATHER THAN AN OMISSION, on the worker's side: `vapidPublicKey: null` is "this host sets
   * no key", and it is what every host answers today. ABSENT is a different fact — a worker older
   * than the field — so it is optional here and `push.ts` falls back to the build's env var for it.
   */
  push?: { vapidPublicKey: string | null } | null;
}

export interface OriginRow {
  origin: string;
  status: Exclude<OriginStatus, "unknown">;
  addedBy: "registration" | "claim" | "owner" | "visitor";
  addedAt: string;
  verifiedAt: string | null;
}

export interface ClaimAnswer {
  status: AppStatus;
  claimedAt: string | null;
  originVerified: boolean;
}

export type VerifyAnswer = { verified: true; origin: string } | { verified: false; reason: string };

export interface InboxItem {
  mid: string;
  deviceId: string;
  kind: "message" | "lead" | "task";
  text: string;
  contact: string | null;
  createdAt: string;
  drainedAt: string | null;
  repliedAt: string | null;
  reply: string | null;
}

export interface InboxPage {
  items: InboxItem[];
  /** The `createdAt` of the last item — hand it back as `since` on the next drain. */
  cursor: string | null;
}

export interface PushRow {
  appId: string;
  endpoint: string;
  createdAt: string;
}

/** `sending: false` is the worker saying that storing a subscription is all that happens this round. */
export interface PushList {
  subscriptions: PushRow[];
  sending: boolean;
}

export interface LinkAnswer {
  appId: string;
  stAppId: string | null;
  overblastCid: string | null;
}

// ── The client ──────────────────────────────────────────────────────────────────────────────────

export interface RegistryClientOptions {
  appId: string;
  /** Signs the canonical string with the agent's link key. See `link-key.ts`. */
  sign(message: string): Promise<string>;
  fetchImpl?: typeof fetch;
  /** Overridden only by a test; production always answers `infiniteApiBase()`. */
  base?: string;
  now?: () => number;
  /** A fixed nonce, for a test that pins a canonical string. */
  nonce?: string;
}

type Body = { json: unknown } | { bytes: Uint8Array; contentType: string } | undefined;

const NOT_CONFIGURED: Refusal = {
  ok: false,
  code: "not_configured",
  message: "This build is not pointed at the registry yet. Set VITE_INFINITE_API_BASE when it is deployed.",
  status: 0,
};

function refusalFrom(status: number, payload: unknown, retryAfterHeader: string | null): Refusal {
  const body = (payload ?? {}) as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : status === 404 ? "not_found" : "bad_response";
  const message = typeof body.error === "string" ? body.error : `The registry answered ${status}.`;
  const retryAfter =
    typeof body.retryAfter === "number"
      ? body.retryAfter
      : retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : undefined;
  return {
    ok: false,
    code,
    message,
    status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(typeof body.maxBytes === "number" ? { maxBytes: body.maxBytes } : {}),
    ...(typeof body.appId === "string" ? { appId: body.appId } : {}),
  };
}

export interface RegistryClient {
  readonly appId: string;
  /** The app id is the client's; `origin` is the app's REGISTRATION origin, `nonce` its claimNonce. */
  claim(input: { ref: string; origin: string; nonce: string }): Promise<RegistryResult<ClaimAnswer>>;
  getApp(): Promise<RegistryResult<AppCard>>;
  listOrigins(): Promise<RegistryResult<OriginRow[]>>;
  setOrigin(origin: string, status: SettableOriginStatus): Promise<RegistryResult<OriginRow[]>>;
  verifyOrigin(origin: string): Promise<RegistryResult<VerifyAnswer>>;
  putPublicBundle(bytes: Uint8Array, contentType?: string): Promise<RegistryResult<{ etag: string | null }>>;
  deletePublicBundle(): Promise<RegistryResult<Record<string, never>>>;
  drainInbox(opts?: { since?: string | null; includeDrained?: boolean }): Promise<RegistryResult<InboxPage>>;
  reply(mid: string, reply: string): Promise<RegistryResult<{ mid: string; repliedAt: string }>>;
  subscribePush(subscription: unknown): Promise<RegistryResult<{ endpoint: string; replaced: boolean; sending: boolean }>>;
  listPush(): Promise<RegistryResult<PushList>>;
  deletePush(endpoint: string): Promise<RegistryResult<Record<string, never>>>;
  link(input: { stAppId?: string | null; overblastCid?: string | null }): Promise<RegistryResult<LinkAnswer>>;
}

export function createRegistryClient(opts: RegistryClientOptions): RegistryClient {
  const base = (opts.base ?? infiniteApiBase()).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const configured = opts.base !== undefined || roomsConfigured();

  /**
   * One request. `signed` is what decides whether the four headers are built at all — the claim is
   * the only route here that is not owner-signed, and it must not carry them: `readSignedHeaders`
   * would see a partial set and refuse before the claim was ever read.
   */
  async function call<T>(input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | undefined>;
    body?: Body;
    signed: boolean;
    read: (res: Response) => Promise<T>;
  }): Promise<RegistryResult<T>> {
    if (!configured) return NOT_CONFIGURED;
    const url = new URL(`${base}${input.path}`);
    for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    let payload: string | Uint8Array | undefined;
    const headers: Record<string, string> = {};
    if (input.body && "json" in input.body) {
      payload = JSON.stringify(input.body.json);
      headers["Content-Type"] = "application/json";
    } else if (input.body && "bytes" in input.body) {
      payload = input.body.bytes;
      headers["Content-Type"] = input.body.contentType;
    }

    if (input.signed) {
      try {
        Object.assign(
          headers,
          await signedHeaders({
            appId: opts.appId,
            method: input.method,
            // The full URL, query included: the worker rebuilds PATH as pathname + search.
            url: url.toString(),
            ...(payload === undefined ? {} : { body: payload }),
            sign: opts.sign,
            ...(opts.now ? { now: opts.now } : {}),
            ...(opts.nonce ? { nonce: opts.nonce } : {}),
          }),
        );
      } catch (err) {
        // A browser with no Ed25519, or a key this browser no longer holds. Either way there is
        // nothing to send, and saying which is the difference between "use another browser" and
        // "this agent's registry identity is gone".
        return {
          ok: false,
          code: err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "cannot_sign",
          message: err instanceof Error ? err.message : "This browser could not sign the request.",
          status: 0,
        };
      }
    }

    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: input.method,
        headers,
        ...(payload === undefined
          ? {}
          : { body: typeof payload === "string" ? payload : (payload as unknown as BodyInit) }),
      });
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: err instanceof Error ? err.message : "The registry could not be reached.",
        status: 0,
      };
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* a 502 from a proxy is HTML; the status is what matters */
      }
      return refusalFrom(res.status, body, res.headers.get("Retry-After"));
    }
    try {
      return { ok: true, value: await input.read(res) };
    } catch (err) {
      return {
        ok: false,
        code: "bad_response",
        message: err instanceof Error ? err.message : "The registry's answer could not be read.",
        status: res.status,
      };
    }
  }

  const json = <T>(res: Response) => res.json() as Promise<T>;
  const nothing = async (): Promise<Record<string, never>> => ({});

  return {
    appId: opts.appId,

    /**
     * §5.4. UNAUTHENTICATED, and it must stay that way: the four signed headers would be read as a
     * partial set and refused before the claim was ever looked at. The credential is `sig` itself.
     *
     * The signature is built HERE rather than taken as an argument, so no caller can sign the wrong
     * string. `claimMessage` is the worker's `` `${app.id}${origin}${nonce}` ``, and the claimNonce
     * never appears in the body — the worker reads it from KV and compares.
     */
    async claim(input) {
      let sig: string;
      try {
        sig = await opts.sign(claimMessage(opts.appId, input.origin, input.nonce));
      } catch (err) {
        return {
          ok: false,
          code: err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "cannot_sign",
          message: err instanceof Error ? err.message : "This browser could not sign the claim.",
          status: 0,
        };
      }
      return call<ClaimAnswer>({
        method: "POST",
        path: `/apps/${opts.appId}/claim`,
        body: { json: { ref: input.ref, sig } },
        signed: false,
        read: json,
      });
    },

    getApp: () =>
      call<AppCard>({ method: "GET", path: `/apps/${opts.appId}`, signed: false, read: json }),

    listOrigins: () =>
      call<{ origins: OriginRow[] }>({
        method: "GET",
        path: `/apps/${opts.appId}/origins`,
        signed: true,
        read: json,
      }).then((r) => (r.ok ? { ok: true as const, value: r.value.origins } : r)),

    setOrigin: (origin, status) =>
      call<{ origins: OriginRow[] }>({
        method: "POST",
        path: `/apps/${opts.appId}/origins`,
        body: { json: { origin, status } },
        signed: true,
        read: json,
      }).then((r) => (r.ok ? { ok: true as const, value: r.value.origins } : r)),

    verifyOrigin: (origin) =>
      call<VerifyAnswer>({
        method: "POST",
        path: `/apps/${opts.appId}/origins/verify`,
        body: { json: { origin } },
        signed: true,
        read: json,
      }),

    /** §5.5. The ETag is read from the header: a 204 has no body to put it in. */
    putPublicBundle: (bytes, contentType = "application/json") =>
      call<{ etag: string | null }>({
        method: "PUT",
        path: `/apps/${opts.appId}/public-bundle`,
        body: { bytes, contentType },
        signed: true,
        read: async (res) => ({ etag: res.headers.get("ETag") }),
      }),

    deletePublicBundle: () =>
      call<Record<string, never>>({
        method: "DELETE",
        path: `/apps/${opts.appId}/public-bundle`,
        signed: true,
        read: nothing,
      }),

    /**
     * §5.6. `since` is a `createdAt` this client already holds, and the drain MARKS ITEMS DELIVERED
     * as it goes — which is what the 200-item cap counts. `includeDrained=1` reads them again until
     * retention takes them at seven days, which is how a reload does not lose a lead.
     */
    drainInbox: (o = {}) =>
      call<InboxPage>({
        method: "GET",
        path: `/apps/${opts.appId}/inbox`,
        query: {
          ...(o.since ? { since: o.since } : {}),
          ...(o.includeDrained ? { includeDrained: "1" } : {}),
        },
        signed: true,
        read: json,
      }),

    reply: (mid, reply) =>
      call<{ mid: string; repliedAt: string }>({
        method: "POST",
        path: `/apps/${opts.appId}/inbox/${mid}/reply`,
        body: { json: { reply } },
        signed: true,
        read: json,
      }),

    subscribePush: (subscription) =>
      call<{ endpoint: string; replaced: boolean; sending: boolean }>({
        method: "POST",
        path: `/apps/${opts.appId}/push-subscriptions`,
        body: { json: { subscription } },
        signed: true,
        read: json,
      }),

    listPush: () =>
      call<PushList>({ method: "GET", path: `/apps/${opts.appId}/push-subscriptions`, signed: true, read: json }),

    // The DELETE carries a body, and the body is signed like any other: the endpoint is the name of
    // the thing being forgotten and a signature that did not cover it would forget the wrong browser.
    deletePush: (endpoint) =>
      call<Record<string, never>>({
        method: "DELETE",
        path: `/apps/${opts.appId}/push-subscriptions`,
        body: { json: { endpoint } },
        signed: true,
        read: nothing,
      }),

    /** §9.4's one link across hosts: a column the owner fills. Nothing validates it, deliberately. */
    link: (input) =>
      call<LinkAnswer>({
        method: "POST",
        path: `/apps/${opts.appId}/link`,
        body: {
          json: {
            stAppId: input.stAppId ?? null,
            overblastCid: input.overblastCid ?? null,
          },
        },
        signed: true,
        read: json,
      }),
  };
}
