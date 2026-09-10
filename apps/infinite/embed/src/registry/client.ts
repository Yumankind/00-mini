/**
 * THE REGISTRY, AS THE VISITOR'S BROWSER TALKS TO IT (§5.3–§5.6) — and NOT ONE BYTE BEFORE IT IS
 * REACHED FOR.
 *
 * That is the whole design rule of this file, and it comes straight out of §9.1: the loader and the
 * embed at level 0 need no backend at all, so nothing here runs on load. There are exactly three
 * doors, and each is a person doing something:
 *
 *   · the first `send_to_owner` — a visitor is trying to reach the owner (§5.6);
 *   · the admin flow's Register — the owner is at step 5 of their own setup (§5.3, §5.4);
 *   · the stronger-brain card — somebody asked for a brain the site has to pay for (§6.2).
 *
 * Until one of those happens this module is unreferenced code, the site has made no call to us, and
 * a website owner who reads their network tab sees their own origin and nothing else.
 *
 * ── EVERY REFUSAL IS TYPED ─────────────────────────────────────────────────────────────────────
 *
 * No exception escapes, no `null` stands in for six different reasons, and the worker's own `code`
 * is carried through with its sentence. The panel shows the sentence; the code is what the tests
 * and the branches read. A code this build has never heard of arrives as `unexpected` WITH the
 * server's own words, because a registry that grew a refusal is not a client that should crash.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
 *
 * It never spends and it never signs a claim. §6.2's paid brain is a DIRECT call from this browser
 * to `sponsoredtokens.com/api/v1/*` under that host's device flow, challenge and all — §9.2 is
 * explicit that there is no `infinite/…/ai/v1` rewrite, and there is none here. The claim (§5.4) is
 * an ed25519 signature under the owner's link key, which is in the owner's OTHER browser tab: all
 * this file does is build the link that sends them there.
 */

import type { Store } from "../index/store.js";
import { infiniteApiBase } from "./api-base.js";
import { EMPTY_BUNDLE, parsePublicBundle, type PublicBundle } from "./bundle.js";
import { devicePublicJwk, ensureDeviceKey, signedHeaders } from "./device.js";
import {
  createRegistryState,
  type AppStatus,
  type OriginStanding,
  type RegistryState,
  type RegistryStateStore,
} from "./state.js";

/** Every refusal this client can answer with: its own, and the worker's, in one union. */
export type RefusalCode =
  // this build, before any call is made
  | "not_connected"
  | "no_link_pub"
  | "not_registered"
  | "no_claim_nonce"
  | "dev_mode"
  | "network"
  | "bad_response"
  | "bundle_unreadable"
  | "no_bundle"
  // §5.3 register
  | "origin_required"
  | "bad_request"
  | "bad_ref"
  | "bad_link_pub"
  | "ref_registered"
  | "ip_limited"
  // §5.6 devices
  | "origin_not_allowed"
  | "bad_public_key"
  | "app_not_available"
  | "device_limited"
  // §5.6 inbox
  | "bad_kind"
  | "text_required"
  | "text_too_long"
  | "contact_too_long"
  | "inbox_full"
  | "rate_limited"
  // the signature, per the worker's `devices.ts`
  | "signature_required"
  | "signature_headers_incomplete"
  | "app_mismatch"
  | "stale_signature"
  | "unknown_device"
  | "device_blocked"
  | "bad_signature"
  | "replayed_signature"
  // the shapes every route can answer with
  | "not_found"
  | "unexpected";

export interface Refusal {
  ok: false;
  code: RefusalCode;
  /** A sentence for a person. The worker's own where there is one, ours where there is not. */
  message: string;
  /** `ip_limited`, `device_limited`, `rate_limited` — seconds. */
  retryAfter?: number;
  /** `ref_registered` carries the app that already holds this ref. */
  appId?: string;
  /** The server's `code` when it is one this build does not know. */
  serverCode?: string;
}

const KNOWN_CODES = new Set<string>([
  "origin_required", "bad_request", "bad_ref", "bad_link_pub", "ref_registered", "ip_limited",
  "origin_not_allowed", "bad_public_key", "app_not_available", "device_limited",
  "bad_kind", "text_required", "text_too_long", "contact_too_long", "inbox_full", "rate_limited",
  "signature_required", "signature_headers_incomplete", "app_mismatch", "stale_signature",
  "unknown_device", "device_blocked", "bad_signature", "replayed_signature",
]);

const refuse = (code: RefusalCode, message: string, extra: Partial<Refusal> = {}): Refusal => ({
  ok: false,
  code,
  message,
  ...extra,
});

// ── What each call answers with ─────────────────────────────────────────────────────────────────

export interface RegisteredApp {
  ok: true;
  appId: string;
  status: AppStatus;
  /** Only the browser that registered holds one (§5.4); a browser that merely learned the id has null. */
  claimNonce: string | null;
  originStanding: OriginStanding;
  /** True when THIS call created the app, false when it was already there. */
  fresh: boolean;
}

export interface AppCard {
  ok: true;
  appId: string;
  ref: string;
  status: AppStatus;
  hasPublicBundle: boolean;
  originStanding: OriginStanding;
}

export interface RegisteredDevice {
  ok: true;
  deviceId: string;
  caps: { inbox: boolean; poll: boolean; maxTextLength: number; postsPerHour: number };
}

export interface PostedItem {
  ok: true;
  mid: string;
  createdAt: string;
}

/** One item of this device's own conversation with the owner, and the owner's reply if it came. */
export interface VisitorMessage {
  mid: string;
  kind: string;
  text: string;
  createdAt: string;
  reply: string | null;
  repliedAt: string | null;
}

export interface Messages {
  ok: true;
  messages: VisitorMessage[];
}

export interface LoadedBundle {
  ok: true;
  bundle: PublicBundle;
  etag: string | null;
  /** True when the worker answered 304 and this is the copy already in IndexedDB. */
  cached: boolean;
}

export type RegisterResult = RegisteredApp | Refusal;
export type AppCardResult = AppCard | Refusal;
export type DeviceResult = RegisteredDevice | Refusal;
export type InboxResult = PostedItem | Refusal;
export type MessagesResult = Messages | Refusal;
export type BundleResult = LoadedBundle | Refusal;

export interface InboxInput {
  kind: "message" | "lead" | "task";
  text: string;
  contact?: string;
}

export interface ClientOptions {
  origin: string;
  ref: string;
  store: Store;
  fetchImpl: typeof fetch;
  /**
   * The owner's ed25519 link public key, base64url, as it reached this page through one of §5.1's
   * carriers. Registration is refused without it — see `register` for why that is the only honest
   * answer this client can give.
   */
  linkPub: () => string | null;
  base?: string;
  nowMs?: () => number;
}

export interface RegistryClient {
  configured(): boolean;
  /** The state as last read or written, with no round trip. */
  state(): RegistryState;
  /** Read the persisted record. No network, ever — the loader calls this at level 0. */
  load(): Promise<RegistryState>;
  register(): Promise<RegisterResult>;
  getApp(appId: string): Promise<AppCardResult>;
  registerDevice(): Promise<DeviceResult>;
  postInbox(input: InboxInput): Promise<InboxResult>;
  pollMessages(since?: string | null): Promise<MessagesResult>;
  getPublicBundle(): Promise<BundleResult>;
  /** The bundle already in IndexedDB, or null. No network — this is what carrier 1 reads on load. */
  cachedBundle(): Promise<CachedBundle | null>;
  /** `<product origin>/?claim=<appId>&nonce=…&origin=…`, or null when this browser cannot claim. */
  claimUrl(productOrigin: string): string | null;
}

export interface CachedBundle {
  etag: string | null;
  siteFile: unknown | null;
  files: Record<string, string>;
  at: number;
}

const bundleKey = (origin: string, ref: string): string => `registry:bundle:${origin}:${ref}`;

interface Answer {
  status: number;
  body: Record<string, unknown>;
  retryAfter: number | undefined;
}

export function createRegistryClient(opts: ClientOptions): RegistryClient {
  const base = (opts.base ?? infiniteApiBase()).replace(/\/+$/, "");
  const now = opts.nowMs ?? Date.now;
  const state: RegistryStateStore = createRegistryState({ store: opts.store, origin: opts.origin, ref: opts.ref });
  /** Set once a conditional GET has been refused by CORS preflight — see `getPublicBundle`. */
  let conditionalGetWorks = true;

  const notConnected = (): Refusal =>
    refuse(
      "not_connected",
      "This agent is not connected to a registry yet, so there is nothing to register with and no inbox to send to.",
    );

  /**
   * One call, with the worker's refusal shapes read once.
   *
   * A network error is `network` and never an exception: this code runs on somebody else's page,
   * and a registry that is down, blocked by an extension or simply not deployed must degrade to
   * level 0 rather than throw inside their site.
   */
  const call = async (
    method: string,
    path: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<Answer | Refusal> => {
    let res: Response;
    try {
      res = await opts.fetchImpl(`${base}${path}`, {
        method,
        mode: "cors",
        // NEVER credentials: the worker answers `Access-Control-Allow-Origin: <origin>` and a device
        // signature is the only credential in this module. A cookie here would be an identity the
        // plan says a visitor does not have.
        credentials: "omit",
        headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch (err) {
      return refuse("network", `The registry could not be reached (${String(err)}).`);
    }
    const retryAfterHeader = Number(res.headers.get("retry-after"));
    let body: Record<string, unknown> = {};
    try {
      const text = await res.text();
      const parsed: unknown = text ? JSON.parse(text) : {};
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      if (res.ok) return refuse("bad_response", `The registry answered ${res.status} with something that is not JSON.`);
    }
    return {
      status: res.status,
      body,
      retryAfter: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined,
    };
  };

  const isRefusal = (v: Answer | Refusal): v is Refusal => "ok" in v && v.ok === false;

  /** The worker's `{ error, code }` turned into ours, with its sentence kept. */
  const fromAnswer = (answer: Answer): Refusal => {
    const serverCode = typeof answer.body.code === "string" ? answer.body.code : "";
    const message =
      typeof answer.body.error === "string" && answer.body.error
        ? answer.body.error
        : `The registry answered ${answer.status}.`;
    const retryAfter =
      answer.retryAfter ?? (typeof answer.body.retryAfter === "number" ? answer.body.retryAfter : undefined);
    if (answer.status === 404 && !KNOWN_CODES.has(serverCode)) {
      return refuse("not_found", "This agent is not registered here.", { ...(serverCode ? { serverCode } : {}) });
    }
    if (KNOWN_CODES.has(serverCode)) {
      return refuse(serverCode as RefusalCode, message, {
        ...(retryAfter === undefined ? {} : { retryAfter }),
        ...(typeof answer.body.appId === "string" ? { appId: answer.body.appId } : {}),
      });
    }
    return refuse("unexpected", message, {
      ...(serverCode ? { serverCode } : {}),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  };

  const readStanding = (value: unknown): OriginStanding => {
    const status = (value as { status?: unknown } | null)?.status;
    return status === "allowed" || status === "requested" || status === "verified" || status === "blocked"
      ? status
      : "unknown";
  };

  const asStatus = (value: unknown): AppStatus | null =>
    value === "dev" || value === "unclaimed" || value === "claimed" ? value : null;

  // ── §5.3 registration ─────────────────────────────────────────────────────────────────────────

  /**
   * Register this site's app, on first need.
   *
   * THE 409 IS NOT ALWAYS AN ERROR, and telling the two apart is this function's real work. The
   * worker answers `ref_registered` for ANY second registration of a ref — including the second
   * VISITOR of the same site, whose browser has never registered anything and simply needs the app
   * id. So the 409's `appId` is looked up with `getApp`, which reports THIS origin's standing:
   * `allowed` or `verified` means the app is this site's and this browser has just learned its
   * name; `requested` means somebody pasted this snippet on another site (or ours on theirs), which
   * is §5.3's own scenario and stays a refusal the panel shows as *requested*.
   *
   * NOTE the one thing a browser cannot recover this way: the CLAIM NONCE is minted once, at
   * registration, and handed only to the browser that registered. A second browser therefore gets
   * `claimNonce: null` and the admin flow says so — there is no re-issue route on the worker today.
   */
  const register = async (): Promise<RegisterResult> => {
    if (base.includes(".invalid")) return notConnected();
    const known = state.current();
    if (known.appId && known.status) {
      return {
        ok: true,
        appId: known.appId,
        status: known.status,
        claimNonce: known.claimNonce,
        originStanding: known.originStanding,
        fresh: false,
      };
    }
    const linkPub = opts.linkPub();
    if (!linkPub) {
      // The honest answer, and the only one. Registration stores the ed25519 key the claim of §5.4
      // is verified against, so a made-up one would create an app ITS OWN OWNER could never claim.
      // The key is public by design and travels in the same `site.json` the settings do (§5.1).
      return refuse(
        "no_link_pub",
        "This snippet does not carry the owner's agent key yet, so it cannot be registered. Add `linkPub` to the site settings from the Infinite Agent app.",
      );
    }

    const answer = await call("POST", "/apps/register", {
      body: JSON.stringify({ ref: opts.ref, origin: opts.origin, linkPub, mode: "auto" }),
    });
    if (isRefusal(answer)) return answer;

    if (answer.status === 201) {
      const status = asStatus(answer.body.status);
      const appId = typeof answer.body.appId === "string" ? answer.body.appId : "";
      if (!appId || !status) return refuse("bad_response", "The registry created an app it did not name.");
      const claimNonce = typeof answer.body.claimNonce === "string" ? answer.body.claimNonce : null;
      await state.write({ appId, status, claimNonce, originStanding: "allowed" });
      return { ok: true, appId, status, claimNonce, originStanding: "allowed", fresh: true };
    }

    const refusal = fromAnswer(answer);
    if (refusal.code !== "ref_registered" || !refusal.appId) return refusal;

    const card = await getApp(refusal.appId);
    if (!card.ok) return refusal;
    if (card.originStanding === "allowed" || card.originStanding === "verified") {
      await state.write({
        appId: card.appId,
        status: card.status,
        originStanding: card.originStanding,
        hasPublicBundle: card.hasPublicBundle,
      });
      return {
        ok: true,
        appId: card.appId,
        status: card.status,
        claimNonce: null,
        originStanding: card.originStanding,
        fresh: false,
      };
    }
    await state.write({ originStanding: card.originStanding });
    return { ...refusal, retryAfter: undefined, appId: card.appId };
  };

  /** The loader's card: public, thin, and the one call that needs no identity of any kind. */
  async function getApp(appId: string): Promise<AppCardResult> {
    if (base.includes(".invalid")) return notConnected();
    const answer = await call("GET", `/apps/${encodeURIComponent(appId)}`);
    if (isRefusal(answer)) return answer;
    if (answer.status !== 200) return fromAnswer(answer);
    const status = asStatus(answer.body.status);
    const id = typeof answer.body.appId === "string" ? answer.body.appId : "";
    if (!id || !status) return refuse("bad_response", "The registry described an app it did not name.");
    return {
      ok: true,
      appId: id,
      ref: typeof answer.body.ref === "string" ? answer.body.ref : opts.ref,
      status,
      hasPublicBundle: answer.body.hasPublicBundle === true,
      originStanding: readStanding(answer.body.origin),
    };
  }

  /** The app id, registering first if this browser has not got one. */
  const ensureApp = async (): Promise<{ appId: string } | Refusal> => {
    const known = state.current();
    if (known.appId) return { appId: known.appId };
    const registered = await register();
    return registered.ok ? { appId: registered.appId } : registered;
  };

  // ── §5.6 the device ───────────────────────────────────────────────────────────────────────────

  const registerDevice = async (): Promise<DeviceResult> => {
    if (base.includes(".invalid")) return notConnected();
    const app = await ensureApp();
    if ("ok" in app) return app;
    const pair = await ensureDeviceKey(opts.store, opts.origin, opts.ref);
    let devicePub;
    try {
      devicePub = await devicePublicJwk(pair);
    } catch (err) {
      return refuse("bad_public_key", `This browser could not mint a device key (${String(err)}).`);
    }
    const answer = await call("POST", `/apps/${encodeURIComponent(app.appId)}/devices`, {
      body: JSON.stringify({ devicePub }),
    });
    if (isRefusal(answer)) return answer;
    if (answer.status !== 201) return fromAnswer(answer);
    const deviceId = typeof answer.body.deviceId === "string" ? answer.body.deviceId : "";
    if (!deviceId) return refuse("bad_response", "The registry registered a device it did not name.");
    const caps = (answer.body.caps ?? {}) as Record<string, unknown>;
    await state.write({ deviceId });
    return {
      ok: true,
      deviceId,
      caps: {
        inbox: caps.inbox !== false,
        poll: caps.poll !== false,
        maxTextLength: typeof caps.maxTextLength === "number" ? caps.maxTextLength : 4000,
        postsPerHour: typeof caps.postsPerHour === "number" ? caps.postsPerHour : 20,
      },
    };
  };

  const ensureDevice = async (): Promise<{ appId: string; deviceId: string; pair: CryptoKeyPair } | Refusal> => {
    const app = await ensureApp();
    if ("ok" in app) return app;
    const known = state.current();
    if (!known.deviceId) {
      const registered = await registerDevice();
      if (!registered.ok) return registered;
    }
    const deviceId = state.current().deviceId;
    if (!deviceId) return refuse("bad_response", "This browser has no device id after registering one.");
    return { appId: app.appId, deviceId, pair: await ensureDeviceKey(opts.store, opts.origin, opts.ref) };
  };

  /** One device-signed call: the five headers over METHOD\nPATH\nTIMESTAMP\nsha256(body)\nNONCE. */
  const signedCall = async (
    method: string,
    path: string,
    body: string,
  ): Promise<{ answer: Answer } | Refusal> => {
    const device = await ensureDevice();
    if ("ok" in device) return device;
    const headers = await signedHeaders({
      pair: device.pair,
      appId: device.appId,
      deviceId: device.deviceId,
      method,
      url: `${base}${path}`,
      body,
      nowMs: now(),
    });
    const answer = await call(method, path, { ...(body ? { body } : {}), headers });
    if (isRefusal(answer)) return answer;
    return { answer };
  };

  const postInbox = async (input: InboxInput): Promise<InboxResult> => {
    if (base.includes(".invalid")) return notConnected();
    const app = await ensureApp();
    if ("ok" in app) return app;
    const body = JSON.stringify({
      kind: input.kind,
      text: input.text,
      ...(input.contact ? { contact: input.contact } : {}),
    });
    const sent = await signedCall("POST", `/apps/${encodeURIComponent(app.appId)}/inbox`, body);
    if ("ok" in sent) return sent;
    if (sent.answer.status !== 201) return fromAnswer(sent.answer);
    const mid = typeof sent.answer.body.mid === "string" ? sent.answer.body.mid : "";
    if (!mid) return refuse("bad_response", "The registry accepted a message it did not name.");
    return {
      ok: true,
      mid,
      createdAt: typeof sent.answer.body.createdAt === "string" ? sent.answer.body.createdAt : new Date(now()).toISOString(),
    };
  };

  /**
   * This device's own conversation. There is no parameter in which to ask for somebody else's — the
   * device id comes from the SIGNATURE, which is the point of the path being `devices/me/messages`.
   *
   * `since` is left optional and unused by the poller ON PURPOSE. The worker filters on
   * `created_at > since`, which is the item's own timestamp and not its reply's, so a cursor moved
   * past an unanswered item would hide the answer when it finally came. The device's items are
   * capped at twenty an hour and the page at a hundred, so re-reading them is cheap and correct.
   */
  const pollMessages = async (since?: string | null): Promise<MessagesResult> => {
    if (base.includes(".invalid")) return notConnected();
    const known = state.current();
    if (!known.appId || !known.deviceId) {
      return refuse("not_registered", "This browser has not sent anything to this site's owner yet.");
    }
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const got = await signedCall("GET", `/apps/${encodeURIComponent(known.appId)}/devices/me/messages${query}`, "");
    if ("ok" in got) return got;
    if (got.answer.status !== 200) return fromAnswer(got.answer);
    const raw = Array.isArray(got.answer.body.messages) ? (got.answer.body.messages as unknown[]) : [];
    const messages: VisitorMessage[] = [];
    for (const item of raw) {
      const row = item as Record<string, unknown>;
      if (typeof row.mid !== "string") continue;
      messages.push({
        mid: row.mid,
        kind: typeof row.kind === "string" ? row.kind : "message",
        text: typeof row.text === "string" ? row.text : "",
        createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
        reply: typeof row.reply === "string" ? row.reply : null,
        repliedAt: typeof row.repliedAt === "string" ? row.repliedAt : null,
      });
    }
    return { ok: true, messages };
  };

  // ── §5.5 the public bundle ────────────────────────────────────────────────────────────────────

  const cachedBundle = async (): Promise<CachedBundle | null> => {
    const held = await opts.store.get<CachedBundle>(bundleKey(opts.origin, opts.ref));
    if (!held || typeof held !== "object") return null;
    const files = held.files && typeof held.files === "object" ? held.files : {};
    return { etag: typeof held.etag === "string" ? held.etag : null, siteFile: held.siteFile ?? null, files, at: held.at ?? 0 };
  };

  /**
   * Fetch it, conditionally, and keep the copy.
   *
   * `If-None-Match` is NOT a CORS-safelisted request header, so a conditional GET is a preflight —
   * and the worker's `Access-Control-Allow-Headers` names the five `X-Infinite-*` and `content-type`
   * and not `if-none-match`. That preflight therefore fails on a browser today, which would turn a
   * cheap 304 into no bundle at all. So the conditional GET is TRIED, and the first refusal at the
   * network layer permanently drops back to an unconditional one for this page: correctness first,
   * bytes second, and the mismatch is written down here rather than papered over.
   */
  const getPublicBundle = async (): Promise<BundleResult> => {
    if (base.includes(".invalid")) return notConnected();
    const app = state.current().appId;
    if (!app) return refuse("not_registered", "This site's agent is not registered, so it has no public bundle.");
    const held = await cachedBundle();
    const url = `${base}/apps/${encodeURIComponent(app)}/public-bundle`;

    const attempt = async (conditional: boolean): Promise<{ res: Response } | Refusal> => {
      try {
        return {
          res: await opts.fetchImpl(url, {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            ...(conditional && held?.etag ? { headers: { "if-none-match": held.etag } } : {}),
          }),
        };
      } catch (err) {
        return refuse("network", `The public bundle could not be fetched (${String(err)}).`);
      }
    };

    let got = await attempt(conditionalGetWorks && !!held?.etag);
    if (!("res" in got)) {
      if (!conditionalGetWorks || !held?.etag) return got;
      conditionalGetWorks = false;
      got = await attempt(false);
      if (!("res" in got)) return got;
    }
    const response = got.res;

    if (response.status === 304 && held) {
      return {
        ok: true,
        bundle: { ...EMPTY_BUNDLE, siteFile: held.siteFile, files: held.files },
        etag: held.etag,
        cached: true,
      };
    }
    if (response.status === 404) {
      await state.write({ hasPublicBundle: false });
      return refuse("no_bundle", "This agent has not published a public bundle.");
    }
    if (!response.ok) return refuse("unexpected", `The public bundle answered ${response.status}.`);

    let bundle: PublicBundle;
    try {
      bundle = parsePublicBundle(new Uint8Array(await response.arrayBuffer()));
    } catch (err) {
      return refuse("bundle_unreadable", `This agent's public bundle could not be read (${String(err)}).`);
    }
    const etag = response.headers.get("etag");
    await opts.store.set(bundleKey(opts.origin, opts.ref), {
      etag,
      siteFile: bundle.siteFile,
      files: bundle.files,
      at: now(),
    } satisfies CachedBundle);
    await state.write({ hasPublicBundle: true });
    return { ok: true, bundle, etag, cached: false };
  };

  return {
    configured: () => !base.includes(".invalid"),
    state: () => state.current(),
    load: () => state.read(),
    register,
    getApp,
    registerDevice,
    postInbox,
    pollMessages,
    getPublicBundle,
    cachedBundle,
    claimUrl(productOrigin: string): string | null {
      const known = state.current();
      if (!known.appId || !known.claimNonce) return null;
      const url = new URL("/", productOrigin);
      url.searchParams.set("claim", known.appId);
      url.searchParams.set("nonce", known.claimNonce);
      url.searchParams.set("origin", opts.origin);
      return url.toString();
    },
  };
}
