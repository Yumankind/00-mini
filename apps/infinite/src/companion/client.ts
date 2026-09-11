/**
 * THE FOUR CALLS THIS BROWSER MAKES TO THE COMPANION (§14.1–14.3), all but one of them signed.
 *
 * `pair` is the exception and has to be: the engine cannot verify a key it has not been given, so the
 * ceremony is the six-word code the person read off their own terminal — proof of local presence,
 * once, for two minutes. Everything after it carries `x-00-dev`/`x-00-ts`/`x-00-sig` from `key.ts`.
 *
 * WHAT IS AND IS NOT IN THIS FILE. Shapes, paths and signing: yes. Policy: no. Which hosts git may
 * reach, what the fetch scope may read, what a scope means — all of that is enforced on the ENGINE,
 * where it can be enforced against a caller that lies, and this file would only be describing it
 * twice. The one bound kept here is the 200 MB body cap on a git push, and it is kept because the
 * cap belongs to the thing doing the buffering: a push bigger than that would be buffered in this
 * tab's memory before it was ever refused over there.
 */
import { COMPANION_DEV_HEADER, companionKey, signedHeaders, type CompanionKeyEnv } from "./key.js";

export const COMPANION_PAIR_PATH = "/api/companion/pair";
export const COMPANION_ME_PATH = "/api/companion/me";
export const COMPANION_FETCH_PATH = "/api/companion/fetch";
export const COMPANION_GIT_PATH = "/api/companion/git";

/** §14.3's git body cap, applied where the bytes are buffered: here. */
export const GIT_BODY_MAX_BYTES = 200 * 1024 * 1024;

export interface CompanionEnv extends CompanionKeyEnv {
  fetch?: typeof globalThis.fetch;
}

/** A refusal with the engine's own code on it, so a caller can branch without reading English. */
export class CompanionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CompanionError";
  }
}

export interface CompanionIdentity {
  /** THIS BROWSER's fingerprint as the engine filed it. */
  fingerprint: string;
  engineName: string;
  scopes: string[];
}

function fetchOf(env: CompanionEnv): typeof globalThis.fetch {
  const impl = env.fetch ?? globalThis.fetch;
  if (!impl) throw new CompanionError("this browser cannot make requests", "no_fetch");
  return impl;
}

/**
 * The two identity replies, read into one shape.
 *
 * `engineName` is EMPTY when the reply does not carry one, and is never filled from `name`: the pair
 * reply's `name` would be the engine's, but `/me`'s is THIS BROWSER's device name (checked against
 * `apps/00d/src/routes/browser-companion.ts`), and reading that as the computer's name would rename
 * the card to "00 Mini in this browser" on the first readiness poll. The caller keeps what the health
 * probe told it when this is empty.
 */
function identityOf(body: unknown, fallbackFingerprint: string): CompanionIdentity {
  const row = (body ?? {}) as Record<string, unknown>;
  return {
    fingerprint: String(row.fingerprint ?? fallbackFingerprint),
    engineName: row.engineName ? String(row.engineName) : "",
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
  };
}

async function refusal(response: Response, fallback: string): Promise<CompanionError> {
  const body = (await response.json().catch(() => null)) as { code?: string; error?: string } | null;
  const code = body?.code ?? `http_${response.status}`;
  if (code === "code_refused") {
    return new CompanionError(
      "That code was refused. It works once, for two minutes — ask your terminal for a new one.",
      code,
      response.status,
    );
  }
  return new CompanionError(body?.error ?? fallback, code, response.status);
}

export interface PairRequest {
  base: string;
  /** Which engine this key belongs to, from the probe. The key store is keyed on it. */
  engineFp: string;
  /** The six words the person read off `00d companion`. */
  code: string;
  /** What this browser should be called in the engine's device list. */
  name: string;
  agentId: string;
}

/**
 * §14.1's pairing. Sends the PUBLIC half only — the private key is non-extractable and could not be
 * sent even by a caller that wanted to.
 */
export async function pair(req: PairRequest, env: CompanionEnv = {}): Promise<CompanionIdentity> {
  const device = await companionKey(req.engineFp, env);
  const response = await fetchOf(env)(`${req.base}${COMPANION_PAIR_PATH}`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: req.code.trim(),
      publicKeyJwk: device.publicKeyJwk,
      alg: "p256",
      name: req.name,
      agentId: req.agentId,
    }),
  });
  if (!response.ok) throw await refusal(response, "This computer refused the pairing.");
  return identityOf(await response.json().catch(() => null), device.deviceId);
}

/** Who this browser is to that engine, and what it is allowed to do — the readiness poll's answer. */
export async function me(base: string, engineFp: string, env: CompanionEnv = {}): Promise<CompanionIdentity> {
  const headers = await signedHeaders(engineFp, "GET", COMPANION_ME_PATH, null, env);
  const response = await fetchOf(env)(`${base}${COMPANION_ME_PATH}`, {
    method: "GET",
    credentials: "omit",
    headers,
  });
  if (!response.ok) throw await refusal(response, "This computer no longer knows this browser.");
  return identityOf(await response.json().catch(() => null), headers[COMPANION_DEV_HEADER]);
}

/**
 * Hand the grant back (§14.1's `DELETE /api/companion/pair`, signed, self).
 *
 * A revoke that FAILS still counts on this side: the browser is disconnecting, the person asked, and
 * a grant the engine still holds for a key this browser has forgotten is a grant nothing can use.
 * The caller deletes the key either way; this returns whether the engine agreed.
 */
export async function revoke(base: string, engineFp: string, env: CompanionEnv = {}): Promise<boolean> {
  try {
    const headers = await signedHeaders(engineFp, "DELETE", COMPANION_PAIR_PATH, null, env);
    const response = await fetchOf(env)(`${base}${COMPANION_PAIR_PATH}`, {
      method: "DELETE",
      credentials: "omit",
      headers,
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── The `fetch` scope: a GET from this computer's network ────────────────────────────────────────

/** The path a proxied GET is signed over. Pure, so the signature and the URL cannot disagree. */
export function companionFetchPath(url: string): string {
  return `${COMPANION_FETCH_PATH}?url=${encodeURIComponent(url)}`;
}

/**
 * Where `http_get` should retry a blocked read, and what it must carry — `NetworkPolicy.proxy`'s
 * `{ url, headers }` shape (contract revision 2026-09-11 (f)).
 */
export async function fetchUrl(
  base: string,
  engineFp: string,
  url: string,
  env: CompanionEnv = {},
): Promise<{ url: string; headers: Record<string, string> }> {
  const path = companionFetchPath(url);
  return { url: `${base}${path}`, headers: await signedHeaders(engineFp, "GET", path, null, env) };
}

// ── The `git` scope: isomorphic-git's transport, signed ──────────────────────────────────────────

/** The `corsProxy` isomorphic-git rewrites every smart-HTTP call onto. */
export function gitProxyBase(base: string): string {
  return `${base}${COMPANION_GIT_PATH}`;
}

/** isomorphic-git's `HttpClient`, structurally — written out so this file imports no git types. */
export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array> | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}

export interface GitHttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  body: AsyncIterableIterator<Uint8Array>;
  headers: Record<string, string>;
}

/** Everything isomorphic-git streamed for one request, as one buffer, refused past the cap. */
export async function collectBody(
  body: GitHttpRequest["body"],
  cap = GIT_BODY_MAX_BYTES,
): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > cap) {
      throw new CompanionError(
        `this push is over ${Math.floor(cap / (1024 * 1024))} MB, which is more than the companion takes — push it from a terminal`,
        "git_body_too_large",
      );
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function* streamOf(response: Response): AsyncIterableIterator<Uint8Array> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length) yield bytes;
    return;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * An `HttpClient` that signs every call.
 *
 * THE BODY IS BUFFERED, and that is not an accident of convenience: the signature covers
 * `sha256(body)`, and a hash of a stream cannot be computed without reading the stream. A push is
 * therefore held in memory once, under the cap above, before it leaves. `git-upload-pack` (clone,
 * fetch, pull) streams no request body worth the name, so this costs the common case nothing.
 */
export function gitHttp(base: string, engineFp: string, env: CompanionEnv = {}) {
  const doFetch = fetchOf(env);
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const method = (req.method ?? "GET").toUpperCase();
      const target = new URL(req.url, base);
      const body = await collectBody(req.body);
      const signature = await signedHeaders(engineFp, method, `${target.pathname}${target.search}`, body ?? null, env);
      const response = await doFetch(target.toString(), {
        method,
        credentials: "omit",
        headers: { ...(req.headers ?? {}), ...signature },
        ...(body ? { body: body.slice().buffer as ArrayBuffer } : {}),
      });
      return {
        url: target.toString(),
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        body: streamOf(response),
        headers: headerRecord(response.headers),
      };
    },
  };
}
