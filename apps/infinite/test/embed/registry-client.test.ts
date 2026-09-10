/**
 * The registry client: one shape per route, and one typed refusal per way it can go wrong (§5.3–5.6).
 *
 * WHY A FAKE FETCH AND NOT A LIVE WORKER: the module is behind `INFINITE_ENABLED` in another repo
 * and is not deployed anywhere. What can be proved here is everything that is actually this side's
 * job — the body sent, the headers signed, the status read, the state persisted, and the ORDER of
 * calls, which is the part §9.1 depends on: nothing at all until something is reached for.
 *
 * The wire it is checked against is moltworker's `docs/infinite/API.md`, route by route.
 */

import { describe, expect, it } from "vitest";
import { createRegistryClient, type RegistryClient } from "../../embed/src/registry/client.js";
import { MemoryStore } from "../../embed/src/index/store.js";

const ORIGIN = "https://shop.example";
const REF = "ia_ktb4qz_abcdefghijkl";
const BASE = "https://registry.test/infinite";
const LINK_PUB = "A".repeat(43);

interface Route {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** For the public bundle: raw bytes instead of a JSON body. */
  bytes?: Uint8Array;
}

interface Wire {
  client: RegistryClient;
  calls: { method: string; url: string; body: string | null; headers: Record<string, string> }[];
  store: MemoryStore;
}

function wire(routes: Record<string, Route | Route[]>, opts: { linkPub?: string | null } = {}): Wire {
  const calls: Wire["calls"] = [];
  const store = new MemoryStore();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null, headers });
    const key = `${method} ${url.slice(BASE.length)}`;
    const found = routes[key];
    const route = Array.isArray(found) ? found[Math.min(calls.filter((c) => `${c.method} ${c.url.slice(BASE.length)}` === key).length - 1, found.length - 1)] : found;
    if (!route) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
    if (route.bytes) {
      return new Response(route.bytes as unknown as BodyInit, { status: route.status, headers: { "content-type": "application/json", ...route.headers } });
    }
    // 204 and 304 are null-body statuses: a `Response` with any body at all throws.
    if (route.status === 204 || route.status === 304) {
      return new Response(null, { status: route.status, headers: { ...route.headers } });
    }
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json", ...route.headers },
    });
  }) as typeof fetch;

  const client = createRegistryClient({
    origin: ORIGIN,
    ref: REF,
    store,
    fetchImpl,
    base: BASE,
    linkPub: () => (opts.linkPub === undefined ? LINK_PUB : opts.linkPub),
    nowMs: () => 1_757_500_000_000,
  });
  return { client, calls, store };
}

const REGISTERED = {
  status: 201,
  body: { appId: "iaa_shop", status: "unclaimed", claimNonce: "nonce-abc", origin: ORIGIN, dev: false },
};

describe("§5.3 registration", () => {
  it("sends ref, origin and the owner's link key, and keeps what came back", async () => {
    const w = wire({ "POST /apps/register": REGISTERED });
    const result = await w.client.register();
    expect(result.ok && result.appId).toBe("iaa_shop");
    expect(result.ok && result.fresh).toBe(true);
    expect(result.ok && result.claimNonce).toBe("nonce-abc");
    expect(JSON.parse(w.calls[0]!.body!)).toEqual({ ref: REF, origin: ORIGIN, linkPub: LINK_PUB, mode: "auto" });
    // Persisted per origin+ref, so the next open of this site knows without asking.
    const kept = await w.store.get<{ appId: string; claimNonce: string }>(`registry:${ORIGIN}:${REF}`);
    expect(kept?.appId).toBe("iaa_shop");
    expect(kept?.claimNonce).toBe("nonce-abc");
  });

  it("registers ONCE: a second call makes no request at all", async () => {
    const w = wire({ "POST /apps/register": REGISTERED });
    await w.client.register();
    const again = await w.client.register();
    expect(again.ok && again.fresh).toBe(false);
    expect(w.calls).toHaveLength(1);
  });

  it("refuses without the owner's link key, before any call", async () => {
    const w = wire({ "POST /apps/register": REGISTERED }, { linkPub: null });
    const result = await w.client.register();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("no_link_pub");
    expect(w.calls).toHaveLength(0);
  });

  it("answers `not_connected` while the build points at the placeholder", async () => {
    const client = createRegistryClient({
      origin: ORIGIN,
      ref: REF,
      store: new MemoryStore(),
      fetchImpl: (() => {
        throw new Error("nothing may be fetched");
      }) as unknown as typeof fetch,
      linkPub: () => LINK_PUB,
    });
    expect(client.configured()).toBe(false);
    const result = await client.register();
    expect(!result.ok && result.code).toBe("not_connected");
  });

  it("reads a 409 for THIS site as 'somebody else's browser already registered it'", async () => {
    // §5.3's second visitor: the worker answers `ref_registered` for any second registration, and
    // the app card is what says whose site it is. `allowed` means ours.
    const w = wire({
      "POST /apps/register": { status: 409, body: { error: "already registered", code: "ref_registered", appId: "iaa_shop" } },
      "GET /apps/iaa_shop": {
        status: 200,
        body: { appId: "iaa_shop", ref: REF, status: "claimed", hasPublicBundle: true, origin: { origin: ORIGIN, status: "allowed" } },
      },
    });
    const result = await w.client.register();
    expect(result.ok).toBe(true);
    expect(result.ok && result.status).toBe("claimed");
    // The nonce belongs to the browser that registered; this one honestly has none.
    expect(result.ok && result.claimNonce).toBeNull();
    expect(w.client.state().hasPublicBundle).toBe(true);
  });

  it("reads a 409 whose origin is only `requested` as another site holding the ref", async () => {
    const w = wire({
      "POST /apps/register": { status: 409, body: { error: "This agent is already registered for another site.", code: "ref_registered", appId: "iaa_other" } },
      "GET /apps/iaa_other": {
        status: 200,
        body: { appId: "iaa_other", ref: REF, status: "unclaimed", hasPublicBundle: false, origin: { origin: ORIGIN, status: "requested" } },
      },
    });
    const result = await w.client.register();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("ref_registered");
    expect(!result.ok && result.appId).toBe("iaa_other");
    expect(w.client.state().originStanding).toBe("requested");
  });

  it("carries `ip_limited` through with its Retry-After", async () => {
    const w = wire({
      "POST /apps/register": {
        status: 429,
        body: { error: "This address has already registered an agent today.", code: "ip_limited", retryAfter: 86400 },
        headers: { "retry-after": "86400" },
      },
    });
    const result = await w.client.register();
    expect(!result.ok && result.code).toBe("ip_limited");
    expect(!result.ok && result.retryAfter).toBe(86400);
    expect(!result.ok && result.message).toContain("already registered an agent today");
  });

  it("names a dev origin's app as dev", async () => {
    const w = wire({
      "POST /apps/register": { status: 201, body: { appId: "iaa_dev", status: "dev", claimNonce: "n", origin: ORIGIN, dev: true } },
    });
    const result = await w.client.register();
    expect(result.ok && result.status).toBe("dev");
  });

  it("turns a code it has never heard of into `unexpected`, keeping the sentence", async () => {
    const w = wire({ "POST /apps/register": { status: 400, body: { error: "The moon is wrong.", code: "lunar" } } });
    const result = await w.client.register();
    expect(!result.ok && result.code).toBe("unexpected");
    expect(!result.ok && result.serverCode).toBe("lunar");
    expect(!result.ok && result.message).toBe("The moon is wrong.");
  });

  it("turns a dead registry into `network`, never an exception", async () => {
    const client = createRegistryClient({
      origin: ORIGIN,
      ref: REF,
      store: new MemoryStore(),
      base: BASE,
      linkPub: () => LINK_PUB,
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const result = await client.register();
    expect(!result.ok && result.code).toBe("network");
  });
});

describe("§5.4 a fresh claim code", () => {
  /** A browser that knows the app and holds no nonce: the second tab, the reload, the other laptop. */
  const knowing = async (routes: Record<string, Route | Route[]>): Promise<Wire> => {
    const w = wire(routes);
    await w.store.set(`registry:${ORIGIN}:${REF}`, { appId: "iaa_shop", status: "unclaimed" });
    await w.client.load();
    expect(w.client.claimUrl("https://infinite.test")).toBeNull();
    return w;
  };

  it("asks the site's own door — POST, no body, no signature — and keeps the code that comes back", async () => {
    const w = await knowing({
      "POST /apps/iaa_shop/claim-nonce": {
        status: 200,
        body: { appId: "iaa_shop", status: "unclaimed", claimNonce: "fresh-1", origin: ORIGIN },
      },
    });
    const result = await w.client.requestClaimNonce();
    expect(result.ok && result.claimNonce).toBe("fresh-1");
    expect(w.calls[0]!.method).toBe("POST");
    expect(w.calls[0]!.url).toBe(`${BASE}/apps/iaa_shop/claim-nonce`);
    // No body and no signature: the origin IS the credential, and a partial header set would be
    // refused as `signature_headers_incomplete` before the call was ever read.
    expect(w.calls[0]!.body).toBeNull();
    expect(w.calls[0]!.headers["X-Infinite-Signature"]).toBeUndefined();
    expect(w.calls[0]!.headers["content-type"]).toBeUndefined();
    // And now the button exists, because the nonce is this browser's.
    const url = new URL(w.client.claimUrl("https://infinite.test")!);
    expect(url.searchParams.get("nonce")).toBe("fresh-1");
    expect(w.client.state().claimNonce).toBe("fresh-1");
  });

  it("carries the REGISTRATION origin the worker named, not the page's own", async () => {
    // The snippet is on www., the app was registered without it. The claim signature is over the
    // string the worker stores, so guessing this one would sign something nobody holds.
    const w = await knowing({
      "POST /apps/iaa_shop/claim-nonce": {
        status: 200,
        body: { appId: "iaa_shop", status: "unclaimed", claimNonce: "fresh-2", origin: "https://www.shop.example" },
      },
    });
    await w.client.requestClaimNonce();
    const url = new URL(w.client.claimUrl("https://infinite.test")!);
    expect(url.searchParams.get("origin")).toBe("https://www.shop.example");
  });

  it("reads `already_claimed` as news: it re-reads the card and stops offering a claim", async () => {
    const w = await knowing({
      "POST /apps/iaa_shop/claim-nonce": {
        status: 409,
        body: { error: "This agent has already been claimed.", code: "already_claimed" },
      },
      "GET /apps/iaa_shop": {
        status: 200,
        body: { appId: "iaa_shop", ref: REF, status: "claimed", hasPublicBundle: true, origin: { origin: ORIGIN, status: "verified" } },
      },
    });
    const result = await w.client.requestClaimNonce();
    expect(!result.ok && result.code).toBe("already_claimed");
    expect(w.calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual([
      "POST /apps/iaa_shop/claim-nonce",
      "GET /apps/iaa_shop",
    ]);
    expect(w.client.state().status).toBe("claimed");
    expect(w.client.state().originStanding).toBe("verified");
    expect(w.client.claimUrl("https://infinite.test")).toBeNull();
  });

  it("names an origin the agent does not answer, and keeps no code", async () => {
    const w = await knowing({
      "POST /apps/iaa_shop/claim-nonce": {
        status: 403,
        body: { error: "This agent does not answer calls from that site.", code: "origin_not_allowed" },
      },
    });
    const result = await w.client.requestClaimNonce();
    expect(!result.ok && result.code).toBe("origin_not_allowed");
    expect(w.client.state().claimNonce).toBeNull();
    expect(w.calls).toHaveLength(1);
  });

  it("carries `rate_limited` through with its Retry-After", async () => {
    const w = await knowing({
      "POST /apps/iaa_shop/claim-nonce": {
        status: 429,
        body: { error: "Five claim codes an hour from one address.", code: "rate_limited", retryAfter: 900 },
        headers: { "retry-after": "900" },
      },
    });
    const result = await w.client.requestClaimNonce();
    expect(!result.ok && result.code).toBe("rate_limited");
    expect(!result.ok && result.retryAfter).toBe(900);
  });

  it("asks for nothing when this browser has no app yet", async () => {
    const w = wire({});
    const result = await w.client.requestClaimNonce();
    expect(!result.ok && result.code).toBe("not_registered");
    expect(w.calls).toHaveLength(0);
  });

  it("says `not_connected` while the build points at the placeholder", async () => {
    const client = createRegistryClient({
      origin: ORIGIN,
      ref: REF,
      store: new MemoryStore(),
      fetchImpl: (() => {
        throw new Error("nothing may be fetched");
      }) as unknown as typeof fetch,
      linkPub: () => LINK_PUB,
    });
    const result = await client.requestClaimNonce();
    expect(!result.ok && result.code).toBe("not_connected");
  });

  it("refuses a code the registry did not send, rather than minting a link to nothing", async () => {
    const w = await knowing({
      "POST /apps/iaa_shop/claim-nonce": { status: 200, body: { appId: "iaa_shop", status: "unclaimed" } },
    });
    const result = await w.client.requestClaimNonce();
    expect(!result.ok && result.code).toBe("bad_response");
    expect(w.client.claimUrl("https://infinite.test")).toBeNull();
  });
});

describe("§5.6 the device, and the inbox", () => {
  const withApp = {
    "POST /apps/register": REGISTERED,
    "POST /apps/iaa_shop/devices": { status: 201, body: { deviceId: "iad_one", caps: { inbox: true, poll: true, maxTextLength: 4000, postsPerHour: 20 } } },
  };

  it("registers a device with the four-field JWK and keeps its id", async () => {
    const w = wire(withApp);
    const result = await w.client.registerDevice();
    expect(result.ok && result.deviceId).toBe("iad_one");
    expect(result.ok && result.caps.maxTextLength).toBe(4000);
    const body = JSON.parse(w.calls[1]!.body!) as { devicePub: Record<string, string> };
    expect(Object.keys(body.devicePub).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(w.client.state().deviceId).toBe("iad_one");
  });

  it("registers the app first, then the device, then posts — in that order and no sooner", async () => {
    const w = wire({ ...withApp, "POST /apps/iaa_shop/inbox": { status: 201, body: { mid: "iam_1", createdAt: "2026-09-10T10:00:00.000Z" } } });
    expect(w.calls).toHaveLength(0);
    const sent = await w.client.postInbox({ kind: "lead", text: "call me", contact: "a@b.c" });
    expect(sent.ok && sent.mid).toBe("iam_1");
    expect(w.calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual([
      "POST /apps/register",
      "POST /apps/iaa_shop/devices",
      "POST /apps/iaa_shop/inbox",
    ]);
    expect(JSON.parse(w.calls[2]!.body!)).toEqual({ kind: "lead", text: "call me", contact: "a@b.c" });
  });

  it("signs the inbox post with all five X-Infinite headers", async () => {
    const w = wire({ ...withApp, "POST /apps/iaa_shop/inbox": { status: 201, body: { mid: "iam_1", createdAt: "x" } } });
    await w.client.postInbox({ kind: "message", text: "hello" });
    const headers = w.calls[2]!.headers;
    expect(headers["X-Infinite-App"]).toBe("iaa_shop");
    expect(headers["X-Infinite-Device"]).toBe("iad_one");
    expect(headers["X-Infinite-Timestamp"]).toBe("1757500000");
    expect(headers["X-Infinite-Nonce"]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(headers["X-Infinite-Signature"]).toMatch(/^[A-Za-z0-9_-]+$/);
    // The device call before it is unauthenticated and origin-gated; it carries no signature.
    expect(w.calls[1]!.headers["X-Infinite-Signature"]).toBeUndefined();
  });

  it("carries the queue's own refusals through by name", async () => {
    const full = wire({ ...withApp, "POST /apps/iaa_shop/inbox": { status: 429, body: { error: "This agent’s mailbox is full.", code: "inbox_full", maxOpen: 200 } } });
    const result = await full.client.postInbox({ kind: "message", text: "hello" });
    expect(!result.ok && result.code).toBe("inbox_full");

    const long = wire({ ...withApp, "POST /apps/iaa_shop/inbox": { status: 400, body: { error: "A message is at most 4000 characters.", code: "text_too_long" } } });
    const refused = await long.client.postInbox({ kind: "message", text: "x" });
    expect(!refused.ok && refused.code).toBe("text_too_long");
  });

  it("refuses a device on an origin the owner has not allowed", async () => {
    const w = wire({
      "POST /apps/register": REGISTERED,
      "POST /apps/iaa_shop/devices": { status: 403, body: { error: "This agent does not answer calls from that site.", code: "origin_not_allowed" } },
    });
    const result = await w.client.registerDevice();
    expect(!result.ok && result.code).toBe("origin_not_allowed");
    expect(w.client.state().deviceId).toBeNull();
  });

  it("polls this device's own messages, and says so plainly before there are any", async () => {
    const w = wire({
      ...withApp,
      "POST /apps/iaa_shop/inbox": { status: 201, body: { mid: "iam_1", createdAt: "t0" } },
      "GET /apps/iaa_shop/devices/me/messages": {
        status: 200,
        body: {
          messages: [
            { mid: "iam_1", kind: "lead", text: "call me", createdAt: "t0", reply: "We will, tomorrow.", repliedAt: "t1" },
            { mid: "iam_0", kind: "message", text: "hi", createdAt: "t-1", reply: null, repliedAt: null },
          ],
        },
      },
    });
    const early = await w.client.pollMessages();
    expect(!early.ok && early.code).toBe("not_registered");
    expect(w.calls).toHaveLength(0);

    await w.client.postInbox({ kind: "lead", text: "call me" });
    const polled = await w.client.pollMessages();
    expect(polled.ok && polled.messages).toHaveLength(2);
    expect(polled.ok && polled.messages[0]!.reply).toBe("We will, tomorrow.");
    expect(polled.ok && polled.messages[1]!.reply).toBeNull();
  });

  it("puts `since` in the path it signs, so the signature cannot be lifted onto another window", async () => {
    const w = wire({
      ...withApp,
      "POST /apps/iaa_shop/inbox": { status: 201, body: { mid: "iam_1", createdAt: "t0" } },
      "GET /apps/iaa_shop/devices/me/messages?since=t0": { status: 200, body: { messages: [] } },
    });
    await w.client.postInbox({ kind: "message", text: "hello" });
    const polled = await w.client.pollMessages("t0");
    expect(polled.ok).toBe(true);
    expect(w.calls[3]!.url).toContain("?since=t0");
  });
});

describe("§5.5 the public bundle", () => {
  const document = (files: { path: string; text: string }[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({ version: 1, ref: REF, publishedAt: "2026-09-10T00:00:00.000Z", files }));

  it("fetches it, parses it, and keeps the copy with its etag", async () => {
    const w = wire({
      "POST /apps/register": REGISTERED,
      "GET /apps/iaa_shop/public-bundle": {
        status: 200,
        bytes: document([{ path: "PERSONA.md", text: "I am the shop guide." }]),
        headers: { etag: '"v1"' },
      },
    });
    await w.client.register();
    const got = await w.client.getPublicBundle();
    expect(got.ok && got.bundle.files["PERSONA.md"]).toBe("I am the shop guide.");
    expect(got.ok && got.etag).toBe('"v1"');
    expect(got.ok && got.cached).toBe(false);
    const cached = await w.client.cachedBundle();
    expect(cached?.files["PERSONA.md"]).toBe("I am the shop guide.");
    expect(w.client.state().hasPublicBundle).toBe(true);
  });

  it("sends If-None-Match on the FIRST call when it already holds an etag", async () => {
    // The worker's allow-list carries `if-none-match` now, so there is nothing to try-and-see: a
    // browser holding an etag asks conditionally straight away and pays for a 304, not for 256 KB.
    const store = new MemoryStore();
    await store.set(`registry:${ORIGIN}:${REF}`, { appId: "iaa_shop", status: "claimed", hasPublicBundle: true });
    await store.set(`registry:bundle:${ORIGIN}:${REF}`, { etag: '"v1"', siteFile: null, files: { "PERSONA.md": "held" }, at: 1 });
    const seen: (string | undefined)[] = [];
    const client = createRegistryClient({
      origin: ORIGIN,
      ref: REF,
      store,
      base: BASE,
      linkPub: () => LINK_PUB,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init?.headers as Record<string, string> | undefined)?.["if-none-match"]);
        return new Response(null, { status: 304 });
      }) as unknown as typeof fetch,
    });
    await client.load();
    const got = await client.getPublicBundle();
    expect(seen).toEqual(['"v1"']);
    expect(got.ok && got.cached).toBe(true);
    expect(got.ok && got.bundle.files["PERSONA.md"]).toBe("held");
  });

  it("sends If-None-Match next time and reads a 304 out of the cache", async () => {
    const w = wire({
      "POST /apps/register": REGISTERED,
      "GET /apps/iaa_shop/public-bundle": [
        { status: 200, bytes: document([{ path: "PERSONA.md", text: "one" }]), headers: { etag: '"v1"' } },
        { status: 304, headers: { etag: '"v1"' } },
      ],
    });
    await w.client.register();
    await w.client.getPublicBundle();
    const second = await w.client.getPublicBundle();
    expect(second.ok && second.cached).toBe(true);
    expect(second.ok && second.bundle.files["PERSONA.md"]).toBe("one");
    expect(w.calls[2]!.headers["if-none-match"]).toBe('"v1"');
  });

  it("falls back to an unconditional GET when the conditional one is refused", async () => {
    // `If-None-Match` is NOT CORS-safelisted, so a conditional GET is a preflight. The worker now
    // names it in `Access-Control-Allow-Headers` (and exposes `ETag`), so the FIRST attempt is
    // conditional — this is the older worker that does not, where the preflight fails inside the
    // browser. Losing the 304 must not mean losing the bundle, so the page drops back, once.
    const calls: { url: string; conditional: boolean }[] = [];
    const store = new MemoryStore();
    await store.set(`registry:${ORIGIN}:${REF}`, { appId: "iaa_shop", status: "claimed", hasPublicBundle: true });
    await store.set(`registry:bundle:${ORIGIN}:${REF}`, { etag: '"v1"', siteFile: null, files: { "PERSONA.md": "old" }, at: 1 });

    const client = createRegistryClient({
      origin: ORIGIN,
      ref: REF,
      store,
      base: BASE,
      linkPub: () => LINK_PUB,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const conditional = !!(init?.headers as Record<string, string> | undefined)?.["if-none-match"];
        calls.push({ url: String(input), conditional });
        if (conditional) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ version: 1, files: [{ path: "PERSONA.md", text: "new" }] }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"v2"' },
        });
      }) as unknown as typeof fetch,
    });
    await client.load();
    const got = await client.getPublicBundle();
    expect(got.ok && got.bundle.files["PERSONA.md"]).toBe("new");
    expect(calls.map((c) => c.conditional)).toEqual([true, false]);
    // And it does not try the conditional one again on this page.
    await client.getPublicBundle();
    expect(calls.map((c) => c.conditional)).toEqual([true, false, false]);
  });

  it("reads a 404 as 'nothing published', not as an error to show anybody", async () => {
    const w = wire({ "POST /apps/register": REGISTERED });
    await w.client.register();
    const got = await w.client.getPublicBundle();
    expect(!got.ok && got.code).toBe("no_bundle");
    expect(w.client.state().hasPublicBundle).toBe(false);
  });

  it("says so, and keeps nothing, when the bytes are not a bundle", async () => {
    const w = wire({
      "POST /apps/register": REGISTERED,
      "GET /apps/iaa_shop/public-bundle": { status: 200, bytes: new TextEncoder().encode("<html>nope</html>") },
    });
    await w.client.register();
    const got = await w.client.getPublicBundle();
    expect(!got.ok && got.code).toBe("bundle_unreadable");
    expect(await w.client.cachedBundle()).toBeNull();
  });

  it("will not fetch a bundle for a site that has no app", async () => {
    const w = wire({});
    const got = await w.client.getPublicBundle();
    expect(!got.ok && got.code).toBe("not_registered");
    expect(w.calls).toHaveLength(0);
  });
});

describe("the claim link (§5.4)", () => {
  it("is null until this browser holds both the app and its nonce", async () => {
    const w = wire({ "POST /apps/register": REGISTERED });
    expect(w.client.claimUrl("https://infinite.test")).toBeNull();
    await w.client.register();
    const url = new URL(w.client.claimUrl("https://infinite.test")!);
    expect(url.origin).toBe("https://infinite.test");
    expect(url.searchParams.get("claim")).toBe("iaa_shop");
    expect(url.searchParams.get("nonce")).toBe("nonce-abc");
    expect(url.searchParams.get("origin")).toBe(ORIGIN);
  });
});
