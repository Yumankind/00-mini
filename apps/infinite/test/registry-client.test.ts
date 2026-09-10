/**
 * EVERY ROUTE'S REQUEST SHAPE, against a fetch that records instead of sending.
 *
 * What matters here is not "did it send something" but WHAT IT SENT: the method, the path (with its
 * query, because the query is signed), whether the four headers are there — and, for the claim,
 * whether they are ABSENT, which is the one place their presence would break the call. The worker
 * reads a partial header set as `signature_headers_incomplete` and refuses before it ever looks at
 * the claim, so an over-eager client that signs everything cannot claim anything.
 *
 * And every refusal by name, because the person's next move is different for each: a clock, a claim,
 * a deleted file, a wait.
 */
import { describe, expect, it } from "vitest";
import { createRegistryClient, isRefusal, type RegistryClient } from "../src/registry/client.js";
import { APP_HEADER, NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/registry/signed.js";

const BASE = "https://api.example/infinite";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

function harness(answer: (call: Recorded) => Response | Promise<Response> = () => new Response("{}", { status: 200 })): {
  client: RegistryClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const call: Recorded = {
      url: String(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | Uint8Array | undefined,
    };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  const client = createRegistryClient({
    appId: "iaa_abc",
    sign: async (message) => `sig(${message.split("\n").join("|")})`,
    fetchImpl,
    base: BASE,
    now: () => 1_757_000_000_000,
    nonce: "nonce-fixed-1",
  });
  return { client, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const signedFour = (call: Recorded) => [
  call.headers[APP_HEADER],
  call.headers[TIMESTAMP_HEADER],
  call.headers[NONCE_HEADER],
  call.headers[SIGNATURE_HEADER],
];

describe("the claim", () => {
  it("posts { ref, sig } and carries NO signed headers", async () => {
    const { client, calls } = harness(() => json({ status: "claimed", claimedAt: "2026-09-10T00:00:00.000Z", originVerified: true }));
    const result = await client.claim({ ref: "ia_abcdef_abcdefghijkl", origin: "https://shop.example", nonce: "N0NCE-abc" });
    expect(result.ok && result.value.originVerified).toBe(true);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/apps/iaa_abc/claim`);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      ref: "ia_abcdef_abcdefghijkl",
      // The signature over appId‖origin‖nonce — the claim nonce is never in the body; the worker
      // holds it in KV and compares.
      sig: "sig(iaa_abchttps://shop.exampleN0NCE-abc)",
    });
    expect(signedFour(calls[0])).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("names a refused claim rather than throwing", async () => {
    const { client } = harness(() => json({ error: "This claim has expired.", code: "claim_nonce_expired" }, 401));
    const result = await client.claim({ ref: "ia_abcdef_abcdefghijkl", origin: "https://shop.example", nonce: "old" });
    expect(isRefusal(result) && result.code).toBe("claim_nonce_expired");
    expect(isRefusal(result) && result.status).toBe(401);
  });
});

describe("the owner's routes", () => {
  it("GET /apps/:id is public and unsigned", async () => {
    const { client, calls } = harness(() =>
      json({ appId: "iaa_abc", ref: "ia_abcdef_abcdefghijkl", status: "claimed", hasPublicBundle: false, origin: null }),
    );
    expect((await client.getApp()).ok).toBe(true);
    expect(calls[0].url).toBe(`${BASE}/apps/iaa_abc`);
    expect(signedFour(calls[0])).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("GET origins is signed over the empty body's hash", async () => {
    const { client, calls } = harness(() => json({ origins: [{ origin: "https://shop.example", status: "verified", addedBy: "registration", addedAt: "x", verifiedAt: "y" }] }));
    const result = await client.listOrigins();
    expect(result.ok && result.value[0].status).toBe("verified");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers[APP_HEADER]).toBe("iaa_abc");
    expect(calls[0].headers[TIMESTAMP_HEADER]).toBe("1757000000");
    expect(calls[0].headers[NONCE_HEADER]).toBe("nonce-fixed-1");
    expect(calls[0].headers[SIGNATURE_HEADER]).toBe(
      "sig(GET|/infinite/apps/iaa_abc/origins|1757000000|e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|nonce-fixed-1)",
    );
  });

  it("POST origins carries the status the owner may set", async () => {
    const { client, calls } = harness(() => json({ origins: [] }));
    await client.setOrigin("https://www.shop.example", "blocked");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body as string)).toEqual({ origin: "https://www.shop.example", status: "blocked" });
  });

  it("names bad_status when `verified` is typed rather than earned", async () => {
    const { client } = harness(() => json({ error: 'status must be one of allowed, requested, blocked.', code: "bad_status" }, 400));
    const result = await client.setOrigin("https://shop.example", "allowed");
    expect(isRefusal(result) && result.code).toBe("bad_status");
  });

  it("verify asks for the site file and reports the reason it failed", async () => {
    const { client, calls } = harness(() => json({ verified: false, reason: "ref_mismatch" }));
    const result = await client.verifyOrigin("https://shop.example");
    expect(result.ok && result.value).toEqual({ verified: false, reason: "ref_mismatch" });
    expect(calls[0].url).toBe(`${BASE}/apps/iaa_abc/origins/verify`);
    expect(JSON.parse(calls[0].body as string)).toEqual({ origin: "https://shop.example" });
  });

  it("PUT public-bundle sends the bytes, its content type, and reads the ETag from the header", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204, headers: { ETag: '"abc123"' } }));
    const bytes = new TextEncoder().encode('{"version":1}');
    const result = await client.putPublicBundle(bytes);
    expect(result.ok && result.value.etag).toBe('"abc123"');
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toBe(bytes);
  });

  it("names too_large and carries the ceiling the worker sent", async () => {
    const { client } = harness(() => json({ error: "too big", code: "too_large", maxBytes: 262144 }, 413));
    const result = await client.putPublicBundle(new Uint8Array(10));
    expect(isRefusal(result) && result.code).toBe("too_large");
    expect(isRefusal(result) && result.maxBytes).toBe(262144);
  });

  it("DELETE public-bundle is signed with no body", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 204 }));
    expect((await client.deletePublicBundle()).ok).toBe(true);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers[SIGNATURE_HEADER]).toContain("DELETE|/infinite/apps/iaa_abc/public-bundle");
  });

  it("the inbox drain signs the cursor it asked for", async () => {
    const { client, calls } = harness(() => json({ items: [], cursor: null }));
    await client.drainInbox({ since: "2026-09-10T00:00:00.000Z", includeDrained: true });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/infinite/apps/iaa_abc/inbox");
    expect(url.searchParams.get("since")).toBe("2026-09-10T00:00:00.000Z");
    expect(url.searchParams.get("includeDrained")).toBe("1");
    // The query is INSIDE the signature: a signature for ?since=0 must not be liftable onto another.
    expect(calls[0].headers[SIGNATURE_HEADER]).toContain(`${url.pathname}${url.search}`);
  });

  it("drains with no query when there is no cursor yet", async () => {
    const { client, calls } = harness(() => json({ items: [], cursor: null }));
    await client.drainInbox();
    expect(calls[0].url).toBe(`${BASE}/apps/iaa_abc/inbox`);
  });

  it("replies to one message by its mid", async () => {
    const { client, calls } = harness(() => json({ mid: "iam_x", repliedAt: "2026-09-10T01:00:00.000Z" }));
    const result = await client.reply("iam_x", "on its way");
    expect(result.ok && result.value.mid).toBe("iam_x");
    expect(calls[0].url).toBe(`${BASE}/apps/iaa_abc/inbox/iam_x/reply`);
    expect(JSON.parse(calls[0].body as string)).toEqual({ reply: "on its way" });
  });

  it("names already_replied — a second thought is a second item", async () => {
    const { client } = harness(() => json({ error: "answered", code: "already_replied" }, 409));
    expect(isRefusal(await client.reply("iam_x", "again")) && true).toBe(true);
  });

  it("push: subscribe, list and forget", async () => {
    const { client, calls } = harness((call) =>
      call.method === "GET"
        ? json({ subscriptions: [{ appId: "iaa_abc", endpoint: "https://push.example/x", createdAt: "t" }], sending: false })
        : call.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json({ endpoint: "https://push.example/x", replaced: false, sending: false }, 201),
    );
    const made = await client.subscribePush({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } });
    expect(made.ok && made.value.sending).toBe(false);
    expect(JSON.parse(calls[0].body as string)).toEqual({ subscription: { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } } });

    const list = await client.listPush();
    expect(list.ok && list.value.subscriptions.length).toBe(1);

    await client.deletePush("https://push.example/x");
    expect(calls[2].method).toBe("DELETE");
    // The endpoint is inside the signed body: a signature that did not cover it would forget the
    // wrong browser.
    expect(JSON.parse(calls[2].body as string)).toEqual({ endpoint: "https://push.example/x" });
  });

  it("link sends both halves, nulling what was left blank", async () => {
    const { client, calls } = harness(() => json({ appId: "iaa_abc", stAppId: "app_7f3k", overblastCid: null }));
    const result = await client.link({ stAppId: "app_7f3k" });
    expect(result.ok && result.value.stAppId).toBe("app_7f3k");
    expect(JSON.parse(calls[0].body as string)).toEqual({ stAppId: "app_7f3k", overblastCid: null });
  });
});

describe("refusals that are not the worker's", () => {
  it("says not_configured while the build points at the .invalid placeholder", async () => {
    // No `base`, so `infiniteApiBase()` answers the placeholder and nothing is sent at all.
    const client = createRegistryClient({ appId: "iaa_abc", sign: async () => "sig", fetchImpl: (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch });
    const result = await client.getApp();
    expect(isRefusal(result) && result.code).toBe("not_configured");
  });

  it("says unreachable when the fetch itself fails", async () => {
    const client = createRegistryClient({
      appId: "iaa_abc",
      sign: async () => "sig",
      base: BASE,
      fetchImpl: (() => Promise.reject(new Error("dns"))) as unknown as typeof fetch,
    });
    const result = await client.getApp();
    expect(isRefusal(result) && result.code).toBe("unreachable");
    expect(isRefusal(result) && result.status).toBe(0);
  });

  it("carries Retry-After off the header when the body has no retryAfter", async () => {
    const { client } = harness(() => json({ error: "slow down", code: "rate_limited" }, 429, { "Retry-After": "120" }));
    const result = await client.reply("iam_x", "hi");
    expect(isRefusal(result) && result.retryAfter).toBe(120);
  });

  it("turns a signing failure into a named refusal, never a throw", async () => {
    const client = createRegistryClient({
      appId: "iaa_abc",
      base: BASE,
      sign: async () => {
        const err = new Error("no Ed25519 here") as Error & { code: string };
        err.code = "link_key_unavailable";
        throw err;
      },
      fetchImpl: (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch,
    });
    const result = await client.listOrigins();
    expect(isRefusal(result) && result.code).toBe("link_key_unavailable");
  });

  it("turns an unreadable answer into bad_response", async () => {
    const { client } = harness(() => new Response("<html>proxy</html>", { status: 200 }));
    const result = await client.getApp();
    expect(isRefusal(result) && result.code).toBe("bad_response");
  });
});
