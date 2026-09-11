// THE FOUR CALLS, AND THE ONE THAT IS NOT SIGNED — §14.1–14.3.
//
// What is pinned here is the SHAPE of each request, because that is the whole of the contract with
// the engine builder: the path, the method, which headers ride along, and — for the git transport —
// that the signature covers the path the request is actually sent to and the body it actually
// carries. A signature over the wrong string is a 401 nobody can debug from either side.

import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "@00/agent-models";
import { companionFingerprint } from "../src/companion/key.js";
import {
  COMPANION_FETCH_PATH,
  COMPANION_GIT_PATH,
  COMPANION_ME_PATH,
  COMPANION_PAIR_PATH,
  CompanionError,
  collectBody,
  companionFetchPath,
  fetchUrl,
  gitHttp,
  gitProxyBase,
  me,
  pair,
  revoke,
} from "../src/companion/client.js";
import { canonicalCompanion, companionKey, fromBase64Url } from "../src/companion/key.js";

const BASE = "http://127.0.0.1:4600";
const ENGINE = "a1b2c3d4e5f60718";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

function recorder(reply: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const row: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | ArrayBuffer | undefined,
    };
    seen.push(row);
    return reply(row);
  }) as typeof globalThis.fetch;
  return { seen, env: { fetch: fetchFn, store: new MemoryDeviceKeyStore() } };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pairing", () => {
  it("posts the code and the PUBLIC half, unsigned, and carries `alg: p256`", async () => {
    const { seen, env } = recorder(() => json({ fingerprint: "dev-fp", engineName: "Studio", scopes: ["git", "fetch"] }));
    const identity = await pair(
      { base: BASE, engineFp: ENGINE, code: " amber-lantern-quiet ", name: "this browser", agentId: "ag_1" },
      env,
    );
    expect(identity).toEqual({ fingerprint: "dev-fp", engineName: "Studio", scopes: ["git", "fetch"] });
    expect(seen[0].url).toBe(`${BASE}${COMPANION_PAIR_PATH}`);
    expect(seen[0].method).toBe("POST");
    // No signature: the engine has nothing to verify one against yet. The terminal is the proof.
    expect(Object.keys(seen[0].headers)).toEqual(["content-type"]);
    const sent = JSON.parse(String(seen[0].body)) as Record<string, unknown>;
    expect(sent.code).toBe("amber-lantern-quiet");
    expect(sent).toMatchObject({ alg: "p256", name: "this browser", agentId: "ag_1" });
    const jwk = sent.publicKeyJwk as JsonWebKey;
    expect(jwk.crv).toBe("P-256");
    // The private half is not in the body, and could not be: it is non-extractable.
    expect(jwk).not.toHaveProperty("d");
  });

  it("turns the engine's `code_refused` into the sentence about the two minutes", async () => {
    const { env } = recorder(() => json({ code: "code_refused" }, 403));
    await expect(
      pair({ base: BASE, engineFp: ENGINE, code: "wrong", name: "b", agentId: "a" }, env),
    ).rejects.toMatchObject({ code: "code_refused" });
    await expect(
      pair({ base: BASE, engineFp: ENGINE, code: "wrong", name: "b", agentId: "a" }, env),
    ).rejects.toThrow(/two minutes/);
  });

  it("keeps any other refusal's own code and status", async () => {
    const { env } = recorder(() => json({ error: "nope" }, 500));
    const err = await pair({ base: BASE, engineFp: ENGINE, code: "x y z", name: "b", agentId: "a" }, env).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CompanionError);
    expect(err).toMatchObject({ code: "http_500", status: 500, message: "nope" });
  });
});

describe("me and revoke", () => {
  it("signs the GET and reports the scopes the grant carries", async () => {
    const { seen, env } = recorder(() => json({ fingerprint: "dev-fp", engineName: "Studio", scopes: ["git"] }));
    const identity = await me(BASE, ENGINE, env);
    expect(identity.scopes).toEqual(["git"]);
    expect(identity.engineName).toBe("Studio");
    expect(seen[0].url).toBe(`${BASE}${COMPANION_ME_PATH}`);
    expect(Object.keys(seen[0].headers).sort()).toEqual(["x-00-dev", "x-00-sig", "x-00-ts"]);
  });

  it("never reads /me's `name` as the computer's name — that field is THIS BROWSER's", async () => {
    // The engine's /me answers { fingerprint, name, origin, agentId, scopes, pairedAt } where `name`
    // is the device's. Reading it as the engine's would rename the card on the first poll.
    const { env } = recorder(() => json({ fingerprint: "dev-fp", name: "00 Mini in this browser", scopes: ["git"] }));
    expect((await me(BASE, ENGINE, env)).engineName).toBe("");
  });

  it("a revoked grant is an error with the engine's code, not a silent null", async () => {
    const { env } = recorder(() => json({ code: "unknown_device" }, 401));
    await expect(me(BASE, ENGINE, env)).rejects.toMatchObject({ code: "unknown_device", status: 401 });
  });

  it("DELETEs the pairing, signed — and answers false rather than throwing when it cannot", async () => {
    const { seen, env } = recorder(() => new Response(null, { status: 204 }));
    expect(await revoke(BASE, ENGINE, env)).toBe(true);
    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toBe(`${BASE}${COMPANION_PAIR_PATH}`);

    const broken = {
      fetch: (() => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof globalThis.fetch,
      store: new MemoryDeviceKeyStore(),
    };
    expect(await revoke(BASE, ENGINE, broken)).toBe(false);
  });
});

describe("the fetch scope", () => {
  it("builds the path the signature covers, with the target URL encoded into the query", () => {
    expect(companionFetchPath("http://192.168.1.9/status?a=b")).toBe(
      `${COMPANION_FETCH_PATH}?url=http%3A%2F%2F192.168.1.9%2Fstatus%3Fa%3Db`,
    );
  });

  it("hands the network policy a `{ url, headers }` whose signature is over that same path", async () => {
    const store = new MemoryDeviceKeyStore();
    const target = await fetchUrl(BASE, ENGINE, "https://example.com/a", { store });
    expect(target.url).toBe(`${BASE}${companionFetchPath("https://example.com/a")}`);

    const device = await companionKey(ENGINE, { store });
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      device.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const canonical = canonicalCompanion("GET", companionFetchPath("https://example.com/a"), target.headers["x-00-ts"], empty);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        fromBase64Url(target.headers["x-00-sig"]).slice().buffer as ArrayBuffer,
        new TextEncoder().encode(canonical),
      ),
    ).toBe(true);
  });
});

describe("the git transport", () => {
  it("is the corsProxy base isomorphic-git rewrites onto", () => {
    expect(gitProxyBase(BASE)).toBe(`${BASE}${COMPANION_GIT_PATH}`);
  });

  it("signs each call over the path AND query it is sent to, and keeps git's own headers", async () => {
    const { seen, env } = recorder(() => new Response("refs", { status: 200, headers: { "x-a": "b" } }));
    const http = gitHttp(BASE, ENGINE, env);
    const url = `${gitProxyBase(BASE)}/github.com/o/r.git/info/refs?service=git-upload-pack`;
    const response = await http.request({ url, method: "GET", headers: { "user-agent": "git/isomorphic-git" } });

    expect(seen[0].url).toBe(url);
    expect(seen[0].headers["user-agent"]).toBe("git/isomorphic-git");
    expect(seen[0].headers["x-00-dev"]).toHaveLength(16);

    const device = await companionKey(ENGINE, env);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      device.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const canonical = canonicalCompanion(
      "GET",
      "/api/companion/git/github.com/o/r.git/info/refs?service=git-upload-pack",
      seen[0].headers["x-00-ts"],
      empty,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        fromBase64Url(seen[0].headers["x-00-sig"]).slice().buffer as ArrayBuffer,
        new TextEncoder().encode(canonical),
      ),
    ).toBe(true);

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-a"]).toBe("b");
    const chunks: string[] = [];
    for await (const chunk of response.body) chunks.push(new TextDecoder().decode(chunk));
    expect(chunks.join("")).toBe("refs");
  });

  it("buffers a POST body so it can be hashed, and sends those same bytes", async () => {
    const { seen, env } = recorder(() => new Response("", { status: 200 }));
    const http = gitHttp(BASE, ENGINE, env);
    async function* body(): AsyncIterableIterator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
    }
    await http.request({
      url: `${gitProxyBase(BASE)}/github.com/o/r.git/git-receive-pack`,
      method: "POST",
      body: body(),
    });
    expect(seen[0].method).toBe("POST");
    expect([...new Uint8Array(seen[0].body as ArrayBuffer)]).toEqual([1, 2, 3, 4, 5]);
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3, 4, 5]).slice().buffer as ArrayBuffer),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const device = await companionKey(ENGINE, env);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      device.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        fromBase64Url(seen[0].headers["x-00-sig"]).slice().buffer as ArrayBuffer,
        new TextEncoder().encode(
          canonicalCompanion("POST", "/api/companion/git/github.com/o/r.git/git-receive-pack", seen[0].headers["x-00-ts"], hash),
        ),
      ),
    ).toBe(true);
  });

  it("refuses a push over the cap BEFORE it is sent, by name", async () => {
    async function* big(): AsyncIterableIterator<Uint8Array> {
      yield new Uint8Array(600);
      yield new Uint8Array(600);
    }
    await expect(collectBody(big(), 1000)).rejects.toMatchObject({ code: "git_body_too_large" });
    expect(await collectBody(undefined)).toBeUndefined();
    expect([...((await collectBody([new Uint8Array([7])])) ?? [])]).toEqual([7]);
  });

  it("reads a response with no stream body — a fetch polyfill, or a 204", async () => {
    const { env } = recorder(() => json({ ok: true }));
    const http = gitHttp(BASE, ENGINE, env);
    const response = await http.request({ url: `${gitProxyBase(BASE)}/github.com/o/r.git/info/refs` });
    let seenBytes = 0;
    for await (const chunk of response.body) seenBytes += chunk.length;
    expect(seenBytes).toBeGreaterThan(0);
  });
});

describe("the fingerprint the engine filed (2026-09-11: the two halves derived it differently)", () => {
  it("adopts the engine's fingerprint at pairing, so every signed call after it names the device the engine knows", async () => {
    const { seen, env } = recorder((row) =>
      row.url.endsWith(COMPANION_PAIR_PATH)
        ? json({ fingerprint: "b3c43ddc7271295d", engineName: "Mac", scopes: ["git", "fetch"] })
        : json({ fingerprint: "b3c43ddc7271295d", name: "b", origin: BASE, agentId: "a", scopes: ["git", "fetch"], pairedAt: "t" }),
    );
    const before = await companionFingerprint(ENGINE, env);
    expect(before).not.toBe("b3c43ddc7271295d"); // the browser's own derivation, over the raw point
    await pair({ base: BASE, engineFp: ENGINE, code: "one two three four five six", name: "b", agentId: "a" }, env);
    await me(BASE, ENGINE, env);
    expect(seen[1].headers["x-00-dev"]).toBe("b3c43ddc7271295d");
    expect(await companionFingerprint(ENGINE, env)).toBe("b3c43ddc7271295d");
  });

  it("ignores a malformed fingerprint in the pairing reply and keeps its own", async () => {
    const { env } = recorder(() => json({ fingerprint: "not-a-fingerprint", engineName: "Mac", scopes: [] }));
    const before = await companionFingerprint(ENGINE, env);
    await pair({ base: BASE, engineFp: ENGINE, code: "a b c d e f", name: "b", agentId: "a" }, env).catch(() => undefined);
    expect(await companionFingerprint(ENGINE, env)).toBe(before);
  });
});
