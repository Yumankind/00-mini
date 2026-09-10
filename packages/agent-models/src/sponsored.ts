/**
 * THE SPONSORED PEER — a `fetch` that signs, and an OpenAI-compatible provider over it.
 *
 * §6.2 of docs/HANDOFF-infinite-agent.md and §9.2's isolation rule together say what this file may
 * be: the embed does NOT call a route of ours to spend, it calls `sponsoredtokens.com/api/v1/*` the
 * way that host tells every third-party developer to. So there is exactly one new thing here — a
 * transport — and the provider on top of it is the ordinary `OpenAICompatibleProvider` with its
 * `fetch` hook filled in. Nothing about signing leaks into the chat code, and nothing about chat
 * leaks into the signing code.
 *
 * TWO THINGS THIS FILE REFUSES TO DO:
 *
 *   · It never sends an `Authorization` header. A bearer on a signed call would be an app key in a
 *     browser, which is the thing device keys exist so that nobody has to ship.
 *   · It never signs a stream body. `fetch` can take a `ReadableStream`, and a stream cannot be
 *     hashed and then sent — so a body that is not a string or bytes is refused BY NAME rather than
 *     signed as the empty string, which would be a signature over content the server never saw.
 *
 * THE FOOTER. The sponsored pipeline appends its credit line to the assistant's own text
 * (`worker/src/sponsored/attribution.ts`: two newlines, then `— sponsored by `). It is meant to be
 * READ, so the streamed deltas carry it through untouched; but every harness resends its history
 * each turn, so the message the runtime FILES must not have it — the model would start imitating
 * it and the person would pay prompt tokens for our advertising. `ChatResponse.footer` is where it
 * ends up. The `Sponsored-By` response header is the same fact in a second place (CORS-exposed by
 * `attribution.ts::sponsorHeaders`); it is used only to confirm a footer exists, never to write one
 * the text did not carry.
 */

import { DEVICE_MESSAGE, SPONSOREDTOKENS_ORIGIN, CONNECT_DEVICE_PATH, generateDeviceKeypair, signedHeaders } from "./device-key.js";
import type { DeviceKeyStore, StoredDevice } from "./device-key.js";
import { ProviderError } from "./errors.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { FetchLike, FooterContext, Readiness } from "./openai-compatible.js";
import type { ModelInfo } from "./types.js";

/** Exactly the lead `worker/src/sponsored/config.ts::FOOTER_LEAD` writes. A twin, pinned by test. */
export const SPONSOR_FOOTER_LEAD = "— sponsored by ";

/** The base a device-signed caller dials. `/chat/completions` is appended to it. */
export const SPONSOREDTOKENS_API_BASE = `${SPONSOREDTOKENS_ORIGIN}/api/v1`;

export interface SponsoredDeviceTransportOptions {
  appId: string;
  store: DeviceKeyStore;
  /** The transport underneath the signature. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  subtle?: SubtleCrypto;
  /** Injected so a test pins the signed string rather than the clock. Unix MILLIseconds. */
  now?: () => number;
}

/**
 * `fetch`, with the four `X-Sponsoredtokens-*` headers on it.
 *
 * A browser with no registered device is a `credential` refusal rather than an unsigned call: an
 * unsigned call to `/api/v1/*` would be refused by the pool anyway, and the router's rule for
 * "this peer cannot answer for you" is the code, not the status it would have come back with.
 */
export class SponsoredDeviceTransport {
  readonly appId: string;
  private readonly opts: SponsoredDeviceTransportOptions;

  constructor(opts: SponsoredDeviceTransportOptions) {
    this.opts = opts;
    this.appId = opts.appId;
    this.fetch = this.fetch.bind(this);
  }

  /** The device this browser holds for the app, or null. */
  async device(): Promise<StoredDevice | null> {
    return this.opts.store.get(this.appId);
  }

  async readiness(): Promise<Readiness> {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    if (nav && nav.onLine === false) return { ready: false, reason: "offline" };
    const device = await this.device();
    if (!device) {
      return { ready: false, reason: "credential", detail: "This browser is not registered as a device of the app yet." };
    }
    return { ready: true };
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const device = await this.device();
    if (!device) {
      throw new ProviderError({
        status: 401,
        code: "credential",
        message: "This browser has no registered sponsoredtokens device. Connect one to use the sponsored brain.",
        providerId: "sponsored",
        vendorCode: "no_device",
      });
    }
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
      throw new ProviderError({
        status: 0,
        code: "bad_request",
        message: "A device-signed request takes a string or a Uint8Array body.",
        providerId: "sponsored",
        vendorCode: "unsupported_body",
      });
    }
    const headers = new Headers(init.headers ?? {});
    const signed = await signedHeaders({
      appId: this.appId,
      deviceId: device.deviceId,
      privateKey: device.privateKey,
      method,
      url: input,
      body: body ?? null,
      timestamp: this.opts.now ? Math.floor(this.opts.now() / 1000) : undefined,
      subtle: this.opts.subtle,
    });
    for (const [name, value] of Object.entries(signed)) headers.set(name, value);
    // NO BEARER, ever. See this file's header.
    headers.delete("Authorization");
    const send = this.opts.fetch ?? ((url: string, opts?: RequestInit) => globalThis.fetch(url, opts));
    return send(input, { ...init, method, headers });
  }
}

// ── Registration: the popup handshake ───────────────────────────────────────────────────────────

/** Just enough `window` to run the handshake, so the flow is testable without a DOM. */
export interface WindowLike {
  open(url: string, target?: string, features?: string): { postMessage(data: unknown, targetOrigin: string): void; closed?: boolean } | null;
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export class DeviceRegistrationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DeviceRegistrationError";
    this.code = code;
  }
}

export interface RegisterDeviceOptions {
  appId: string;
  /** Where the popup lives. Defaults to the pool's own `/apps/connect/device`. */
  popupUrl?: string;
  /**
   * The origin the handshake is held with — the popup's, which is the pool's.
   *
   * It is BOTH the target of our `postMessage` and the filter on theirs, and it is passed in rather
   * than read off the popup because a page CANNOT read an opened window's origin: the two documents
   * are cross-origin and the browser gives neither a property naming the other. Targeting one origin
   * and ignoring every other message is the only thing a page can do, and it is enough: the key
   * exchange is with that origin or with nobody. The real gate is the worker's, which checks
   * `Origin` against the app's registered one before it writes a row.
   */
  origin?: string;
  store: DeviceKeyStore;
  /** Injected for tests; defaults to the real `window`. */
  window?: WindowLike;
  subtle?: SubtleCrypto;
  timeoutMs?: number;
}

/**
 * Register this browser as a device of `appId`, or answer with the one it already holds.
 *
 * Idempotent by design: a page that calls this on every load and only sometimes opens a popup must
 * behave the same either way, and a browser that already has a device costs no Turnstile and no
 * row against the per-address cap.
 *
 * MUST BE CALLED FROM A CLICK. A window opened outside a user gesture is blocked, and the refusal
 * looks exactly like a network failure — hence `popup_blocked` by name.
 *
 * The exchange, in order:
 *   1. this page generates the keypair and opens `/apps/connect/device?app_id=…` on the pool;
 *   2. the popup says `ready`;
 *   3. this page answers with the PUBLIC JWK, targeted at that origin and no other;
 *   4. the popup runs Turnstile, POSTs `/api/apps/:id/devices`, and says `registered` with the id.
 * The private half never crosses that boundary, and never could: it is not extractable.
 */
export async function registerDevice(options: RegisterDeviceOptions): Promise<StoredDevice> {
  const existing = await options.store.get(options.appId);
  if (existing) return existing;

  const popupUrl = options.popupUrl ?? `${SPONSOREDTOKENS_ORIGIN}${CONNECT_DEVICE_PATH}`;
  const origin = options.origin ?? new URL(popupUrl).origin;
  const maybeWindow = options.window ?? (globalThis as { window?: WindowLike }).window;
  if (!maybeWindow) throw new DeviceRegistrationError("Device registration needs a browser window.", "no_window");
  const win: WindowLike = maybeWindow;

  const subtle = options.subtle ?? globalThis.crypto.subtle;
  const pair = await generateDeviceKeypair(subtle);
  const publicKeyJwk = await subtle.exportKey("jwk", pair.publicKey);

  const separator = popupUrl.includes("?") ? "&" : "?";
  const maybePopup = win.open(`${popupUrl}${separator}app_id=${encodeURIComponent(options.appId)}`, "sponsoredtokens-device", "width=460,height=620,noopener=no");
  if (!maybePopup) throw new DeviceRegistrationError("The browser blocked the sponsoredtokens window. Allow pop-ups and try again.", "popup_blocked");
  const popup = maybePopup;

  const deviceId = await new Promise<string>((resolve, reject) => {
    const timer = win.setTimeout(() => {
      finish();
      reject(new DeviceRegistrationError("The sponsoredtokens window did not answer in time.", "timeout"));
    }, options.timeoutMs ?? 120_000);

    function finish(): void {
      win.clearTimeout(timer);
      win.removeEventListener("message", onMessage);
    }

    function onMessage(event: MessageEvent): void {
      // ONLY THAT ORIGIN. A message from any other window is somebody else's page talking, and the
      // public key is not posted to it.
      if (event.origin !== origin) return;
      const data = event.data as { type?: unknown; deviceId?: unknown; message?: unknown; error?: unknown } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === DEVICE_MESSAGE.ready) {
        popup.postMessage({ type: DEVICE_MESSAGE.key, appId: options.appId, publicKeyJwk }, origin);
        return;
      }
      if (data.type === DEVICE_MESSAGE.registered && typeof data.deviceId === "string") {
        finish();
        resolve(data.deviceId);
        return;
      }
      if (data.type === DEVICE_MESSAGE.error) {
        finish();
        reject(
          new DeviceRegistrationError(
            typeof data.message === "string" ? data.message : "sponsoredtokens refused this device.",
            typeof data.error === "string" ? data.error : "refused",
          ),
        );
      }
    }

    win.addEventListener("message", onMessage);
  });

  const record: StoredDevice = {
    appId: options.appId,
    deviceId,
    privateKey: pair.privateKey,
    publicKeyJwk,
    createdAt: new Date().toISOString(),
  };
  await options.store.put(record);
  return record;
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────

/**
 * Lift the sponsor's credit line out of an answer.
 *
 * Text first, because the text is where the pipeline actually writes it. The `Sponsored-By` header
 * is only a corroboration: a footer the header names but the text does not carry is a footer this
 * turn did not get (a tool-call turn passes through byte-identical, by that file's first rule), and
 * inventing one here would put words in the assistant's mouth.
 */
export function sponsoredFooterExtractor(_json: unknown, ctx: FooterContext): string | undefined {
  const at = ctx.content.lastIndexOf(SPONSOR_FOOTER_LEAD);
  if (at === -1) return undefined;
  return ctx.content.slice(at).trim();
}

export interface SponsoredProviderOptions {
  appId: string;
  deviceKeyStore: DeviceKeyStore;
  /** Defaults to `https://sponsoredtokens.com/api/v1`. */
  baseUrl?: string;
  catalog: ModelInfo[];
  defaultModel?: string;
  /** The transport underneath the signature. */
  fetch?: FetchLike;
  id?: string;
  now?: () => number;
  subtle?: SubtleCrypto;
}

/** The sponsored brain: an OpenAI-compatible provider whose transport is a device signature. */
export function sponsoredProvider(options: SponsoredProviderOptions): OpenAICompatibleProvider {
  const transport = new SponsoredDeviceTransport({
    appId: options.appId,
    store: options.deviceKeyStore,
    fetch: options.fetch,
    now: options.now,
    subtle: options.subtle,
  });
  const catalog = options.catalog;
  return new OpenAICompatibleProvider({
    id: options.id ?? "sponsored",
    baseUrl: options.baseUrl ?? SPONSOREDTOKENS_API_BASE,
    fetch: transport.fetch,
    catalog,
    defaultModel: options.defaultModel ?? catalog[0]?.id ?? "",
    requiresApiKey: false,
    readiness: () => transport.readiness(),
    extractFooter: sponsoredFooterExtractor,
    footerLead: SPONSOR_FOOTER_LEAD,
  });
}
