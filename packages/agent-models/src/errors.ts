/**
 * ONE VOCABULARY FOR A FAILED ANSWER — because the router has to decide, not guess.
 *
 * Four peers answer the same `ModelProvider` interface (§6 of docs/HANDOFF-infinite-agent.md), and
 * each fails in its own dialect: sponsoredtokens refuses a device with `401 unknown_device`, the
 * Overblast proxy refuses an empty wallet with `402 insufficient_credits` and a `topUp` object,
 * Anthropic answers `{"type":"error","error":{"type":"authentication_error"}}`, OpenAI answers
 * `{"error":{"code":"invalid_api_key"}}`. The router's rule — fall through the preference list on a
 * dead credential or an empty purse, and on nothing else — is unwriteable unless all four arrive as
 * the same shape. So every provider in this package maps its own wire onto `ProviderError` and the
 * router reads `code`, never a status and never a message.
 *
 * `topUp` is carried VERBATIM and RELATIVE, the way the cloud-agents contract sends it, with the
 * origin the caller dialled beside it. Resolving it here would build an absolute URL out of a
 * response body, which is the phishing primitive that contract names by name; the UI resolves it
 * against `origin` when it draws the button, and can see what it is resolving.
 */

import type { ChatRequest } from "./types.js";

/** Where a person goes to fix an empty wallet. Relative paths, as the worker sends them. */
export interface TopUpPaths {
  packsUrl?: string;
  checkoutUrl?: string;
  /** The origin the refused request was made against — what the paths above resolve under. */
  origin?: string;
}

/**
 * What went wrong, in the terms the router and the UI act on.
 *
 * `credential` and `insufficient_credits` are the two the router falls through on: both mean *this
 * peer cannot answer for you at all*, and the next peer in the preference list might. `rate_limited`
 * and `server_error` are this peer being busy or broken, which a retry fixes and a switch does not.
 */
export type ProviderErrorCode =
  | "insufficient_credits"
  | "credential"
  | "rate_limited"
  | "bad_request"
  | "server_error"
  | "network"
  | "aborted"
  | "unsupported"
  /** No provider in the preference list was ready. Raised by the router, never by a provider. */
  | "no_brain";

export interface ProviderErrorInit {
  status: number;
  code: ProviderErrorCode;
  message: string;
  providerId?: string;
  topUp?: TopUpPaths;
  retryAfterSeconds?: number;
  /** The provider's own code (`unknown_device`, `invalid_api_key`, …), kept for the UI's sentence. */
  vendorCode?: string;
  /** The parsed body, when there was one. Never logged by this package; the caller decides. */
  raw?: unknown;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly code: ProviderErrorCode;
  readonly providerId?: string;
  readonly topUp?: TopUpPaths;
  readonly retryAfterSeconds?: number;
  readonly vendorCode?: string;
  readonly raw?: unknown;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderError";
    this.status = init.status;
    this.code = init.code;
    this.providerId = init.providerId;
    this.topUp = init.topUp;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.vendorCode = init.vendorCode;
    this.raw = init.raw;
  }
}

/** True for the two refusals a switch to another peer can actually fix. */
export type SwitchableCode = Extract<ProviderErrorCode, "credential" | "insufficient_credits">;

export function isSwitchable(err: unknown): err is ProviderError & { code: SwitchableCode } {
  return err instanceof ProviderError && (err.code === "credential" || err.code === "insufficient_credits");
}

/** True when the caller pulled the plug. Never retried, never switched — the person said stop. */
export function isAborted(err: unknown): boolean {
  if (err instanceof ProviderError) return err.code === "aborted";
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** What a vendor error body has in it, once the four dialects are flattened. */
export interface ParsedErrorBody {
  message?: string;
  vendorCode?: string;
  topUp?: TopUpPaths;
  retryAfterSeconds?: number;
  raw: unknown;
}

/**
 * Flatten any of the error bodies this package meets into the same three fields.
 *
 * The shapes, all seen on the wire: OpenAI/OpenRouter/the Overblast proxy nest under `error`;
 * Anthropic nests under `error` inside `{"type":"error"}`; sponsoredtokens' own refusals are flat
 * (`{"code":"unknown_device","message":"…"}`); and a proxy that fell over answers HTML or nothing.
 * A body that parses as none of them is not an error worth inventing a code for — the status decides.
 */
export function parseErrorBody(text: string): ParsedErrorBody {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { message: text.slice(0, 400).trim() || undefined, raw: text };
  }
  const root = asRecord(raw);
  if (!root) return { raw };
  const inner = asRecord(root.error) ?? root;
  const topUpRaw = asRecord(inner.topUp) ?? asRecord(root.topUp);
  const topUp: TopUpPaths | undefined = topUpRaw
    ? { packsUrl: str(topUpRaw.packsUrl), checkoutUrl: str(topUpRaw.checkoutUrl) }
    : undefined;
  const retry = inner.retryAfterSeconds ?? root.retryAfterSeconds;
  return {
    message: str(inner.message) ?? str(root.message),
    vendorCode: str(inner.code) ?? str(inner.type) ?? str(root.code),
    topUp,
    retryAfterSeconds: typeof retry === "number" && Number.isFinite(retry) ? retry : undefined,
    raw,
  };
}

/**
 * HTTP status + body → a `ProviderErrorCode`.
 *
 * The status leads and the body only sharpens it, because a status is the one field every peer
 * spells the same way. The single place the body overrules the status is `insufficient_credits` on a
 * 402: a 402 that is NOT that code is somebody's payment-required page, and calling it an empty
 * wallet would send the router looking for a purse that was never the problem.
 */
export function classifyStatus(status: number, body: ParsedErrorBody): ProviderErrorCode {
  if (status === 402) return body.vendorCode === "insufficient_credits" || !body.vendorCode ? "insufficient_credits" : "bad_request";
  if (status === 401 || status === 403) return "credential";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 405 || status === 501) return "unsupported";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  return "server_error";
}

/** Build the typed error for a refused HTTP answer. `retry-after` beats a body's own number. */
export function providerErrorFromResponse(input: {
  providerId: string;
  status: number;
  text: string;
  headers?: Headers;
  origin?: string;
}): ProviderError {
  const body = parseErrorBody(input.text);
  const code = classifyStatus(input.status, body);
  const header = input.headers?.get("retry-after");
  const headerSeconds = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
  const topUp = body.topUp && (body.topUp.packsUrl || body.topUp.checkoutUrl) ? { ...body.topUp, origin: input.origin } : undefined;
  return new ProviderError({
    status: input.status,
    code,
    message: body.message ?? `${input.providerId} refused the request (HTTP ${input.status}).`,
    providerId: input.providerId,
    vendorCode: body.vendorCode,
    retryAfterSeconds: headerSeconds ?? body.retryAfterSeconds,
    topUp,
    raw: body.raw,
  });
}

/** A thrown `fetch` — DNS, TLS, offline, or the person pressing stop. */
export function providerErrorFromThrow(providerId: string, err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isAborted(err) || signal?.aborted) {
    return new ProviderError({ status: 0, code: "aborted", message: "The request was cancelled.", providerId, cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError({ status: 0, code: "network", message: `${providerId} could not be reached: ${message}`, providerId, cause: err });
}

/** Raised before a request is built, so the caller learns it cancelled rather than that we did. */
export function throwIfAborted(providerId: string, req: Pick<ChatRequest, "signal">): void {
  if (req.signal?.aborted) {
    throw new ProviderError({ status: 0, code: "aborted", message: "The request was cancelled.", providerId });
  }
}
