/**
 * The site Worker's read-only fetch proxy (`apps/infinite-site/src/fetch-proxy.ts`), decided here.
 *
 * WHY THE TEST LIVES IN THIS PACKAGE, exactly as `isolation-headers.test.ts` does: `infinite-site`
 * has no `package.json` and no `node_modules` — it is deployed with the Homebrew wrangler — so the
 * only way its logic is checked without a deploy is for this package to import it across the folder
 * boundary and run it here.
 *
 * WHAT IS AT STAKE. `/~fetch` is a door out of a Cloudflare data centre with no authentication in
 * front of it. Every rule below is the difference between "the agent can read the web" and "anybody
 * on the internet has a free anonymising proxy, and one that can reach addresses only Cloudflare's
 * network can see". The decision is pure so that each of those rules is one line of a test.
 */
import { describe, expect, it } from "vitest";
import {
  PROXY_ACCEPT,
  PROXY_MAX_BYTES,
  PROXY_MAX_REDIRECTS,
  PROXY_PATH,
  PROXY_TIMEOUT_MS,
  PROXY_USER_AGENT,
  calledBySite,
  decideProxy,
  isPublicHost,
  isTextual,
  publicHttpsTarget,
} from "../../infinite-site/src/fetch-proxy.js";
import worker from "../../infinite-site/src/index.js";

const SITE = "https://0-0.chat";

/** A request as the Worker sees one, with only the headers this decision reads. */
function ask(target: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }, method = "GET") {
  const url = `${SITE}${PROXY_PATH}?url=${encodeURIComponent(target)}`;
  return { method, url, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

describe("the host rule", () => {
  it("allows an ordinary public name", () => {
    for (const host of ["example.com", "docs.rs", "sub.domain.example.co.uk", "xn--bcher-kva.example"]) {
      expect(isPublicHost(host)).toBe(true);
    }
  });

  it("refuses every address that means `the network I am standing in`", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.5",
      "169.254.169.254", // the metadata address, which is the reason this rule exists
      "192.168.1.1",
      "[::1]",
      "[fd00::1]",
      "printer.local",
      "api.internal",
      "1.0.0.127.in-addr.arpa",
      "",
      "   ",
      "intranet", // a single label has no public meaning; it resolves against a search domain
      ".com",
      "trailing.",
    ]) {
      expect(isPublicHost(host)).toBe(false);
    }
  });

  it("refuses the spellings a URL parser folds into an IP address", () => {
    // `0x7f000001`, `2130706433` and `127.1` are all 127.0.0.1 once the URL parser has seen them, so
    // the dotted-quad test above catches every one of them — which is why it is applied to the
    // PARSED hostname and never to the string somebody typed.
    for (const raw of ["https://0x7f000001/", "https://2130706433/", "https://127.1/"]) {
      expect(publicHttpsTarget(raw)).toBeNull();
    }
  });
});

describe("the target rule", () => {
  it("takes an https URL on a public host, and resolves a relative one against the hop it came from", () => {
    expect(publicHttpsTarget("https://example.com/a?b=c")?.href).toBe("https://example.com/a?b=c");
    expect(publicHttpsTarget("/next", "https://example.com/first")?.href).toBe("https://example.com/next");
  });

  it("refuses everything that is not https on a public host", () => {
    for (const raw of [
      "http://example.com/", // cleartext from a Cloudflare IP is not this proxy's business
      "file:///etc/passwd",
      "data:text/html,<b>x</b>",
      "ftp://example.com/",
      "not a url",
      "",
      "   ",
      "https://user:secret@example.com/", // userinfo is a credential, and rule 5 has no exceptions
    ]) {
      expect(publicHttpsTarget(raw)).toBeNull();
    }
  });
});

describe("who is calling", () => {
  it("believes the header a browser sets and script cannot", () => {
    expect(calledBySite(ask("https://example.com", { "sec-fetch-site": "same-origin" }), SITE)).toBe(true);
    expect(calledBySite(ask("https://example.com", { origin: SITE }), SITE)).toBe(true);
    expect(calledBySite(ask("https://example.com", { referer: `${SITE}/app` }), SITE)).toBe(true);
  });

  it("refuses a caller that is somebody else, or nobody at all", () => {
    const cases: Record<string, string>[] = [
      {},
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" }, // a pasted address bar
      { origin: "https://evil.example" },
      { referer: "https://evil.example/page" },
      // The prefix trick: `https://0-0.chat.evil.example` starts with the origin and is not it.
      { origin: `${SITE}.evil.example` },
      { referer: `${SITE}.evil.example/page` },
    ];
    for (const headers of cases) expect(calledBySite(ask("https://example.com", headers), SITE)).toBe(false);
  });
});

describe("decideProxy", () => {
  it("says fetch for a same-origin GET of a public https URL", () => {
    const decision = decideProxy(ask("https://example.com/page"), SITE);
    expect(decision).toEqual({ kind: "fetch", target: new URL("https://example.com/page") });
  });

  it("takes a HEAD as well, because a HEAD is a read", () => {
    expect(decideProxy(ask("https://example.com/page", { "sec-fetch-site": "same-origin" }, "HEAD"), SITE).kind).toBe(
      "fetch",
    );
    expect(decideProxy(ask("https://example.com/", { "sec-fetch-site": "same-origin" }, "get"), SITE).kind).toBe(
      "fetch",
    );
  });

  it("refuses a method that could change something, by name", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(decideProxy(ask("https://example.com/", { "sec-fetch-site": "same-origin" }, method), SITE)).toEqual({
        kind: "refuse",
        status: 405,
        reason: "GET and HEAD only — this proxy only reads",
      });
    }
  });

  it("refuses a caller that is not this site BEFORE it looks at the target", () => {
    // A prober learns 403 and nothing about whether their URL would have been allowed.
    const decision = decideProxy(ask("http://127.0.0.1:8787/", {}), SITE);
    expect(decision).toEqual({ kind: "refuse", status: 403, reason: "same-origin callers only" });
  });

  it("refuses a missing or empty ?url=", () => {
    const bare = { method: "GET", url: `${SITE}${PROXY_PATH}`, headers: { get: () => "same-origin" } };
    expect(decideProxy(bare, SITE)).toMatchObject({ kind: "refuse", status: 400 });
    expect(decideProxy(ask(""), SITE)).toMatchObject({ kind: "refuse", status: 400 });
    expect(decideProxy(ask("   "), SITE)).toMatchObject({ kind: "refuse", status: 400 });
  });

  it("refuses a target that is not https on a public host", () => {
    for (const target of ["http://example.com/", "https://127.0.0.1/", "file:///etc/passwd", "https://localhost/"]) {
      expect(decideProxy(ask(target), SITE)).toMatchObject({
        kind: "refuse",
        status: 400,
        reason: "?url= must be an https:// URL on a public host",
      });
    }
  });

  it("is not the route for any other path", () => {
    const elsewhere = { method: "GET", url: `${SITE}/anything`, headers: { get: () => "same-origin" } };
    expect(decideProxy(elsewhere, SITE)).toMatchObject({ kind: "refuse", status: 404 });
    const unparseable = { method: "GET", url: "://nonsense", headers: { get: () => "same-origin" } };
    expect(decideProxy(unparseable, SITE)).toMatchObject({ kind: "refuse", status: 400 });
  });
});

describe("what comes back", () => {
  it("passes through the same content types the tool itself accepts, and nothing else", () => {
    for (const type of [
      "text/html; charset=utf-8",
      "text/plain",
      "text/markdown",
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/xhtml+xml",
      "application/javascript",
      "application/x-ndjson",
    ]) {
      expect(isTextual(type)).toBe(true);
    }
    for (const type of ["application/pdf", "image/png", "video/mp4", "application/octet-stream", "font/woff2"]) {
      expect(isTextual(type)).toBe(false);
    }
  });

  it("names its caps once, where the README and the Worker both read them", () => {
    expect(PROXY_PATH).toBe("/~fetch");
    expect(PROXY_MAX_BYTES).toBe(1024 * 1024);
    expect(PROXY_MAX_REDIRECTS).toBe(3);
    expect(PROXY_TIMEOUT_MS).toBe(10_000);
    expect(PROXY_USER_AGENT).toContain("00-Mini");
    expect(PROXY_ACCEPT).toContain("text/html");
  });
});

// ── The Worker actually carrying the decision out ────────────────────────────────────────────────
//
// The pure decision above is half the story: a rule that is right in a function and never reaches a
// response is a rule that is not enforced. This half runs `apps/infinite-site/src/index.ts` with a
// stubbed global `fetch`, which is the far side of the internet as far as the Worker is concerned.

describe("the /~fetch route", () => {
  /** Answers queued in order, and every outbound request recorded. */
  function upstream(...answers: (Response | (() => Response | Promise<Response>))[]) {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const original = globalThis.fetch;
    let at = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      const answer = answers[Math.min(at++, answers.length - 1)];
      return typeof answer === "function" ? await answer() : answer;
    }) as typeof globalThis.fetch;
    return { seen, restore: () => (globalThis.fetch = original) };
  }

  // `/~fetch` is answered before either binding is touched, so the stubs only have to exist. The
  // Worker's `Env` is not exported (this folder has no node_modules and no workers types), which is
  // why the shape is asserted through `unknown` rather than declared.
  const ENV = {
    ASSETS: { fetch: async () => new Response("no", { status: 404 }) },
    MODELS: { head: async () => null, get: async () => null },
  } as unknown as Parameters<typeof worker.fetch>[1];

  async function call(target: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }, method = "GET") {
    const url = `${SITE}${PROXY_PATH}?url=${encodeURIComponent(target)}`;
    return worker.fetch(new Request(url, { method, headers }), ENV);
  }

  it("answers with the page, its type, the final URL and five minutes of cache", async () => {
    const net = upstream(new Response("<h1>hi</h1>", { status: 200, headers: { "content-type": "text/html" } }));
    try {
      const answer = await call("https://example.com/page");
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("<h1>hi</h1>");
      expect(answer.headers.get("content-type")).toBe("text/html");
      expect(answer.headers.get("x-mini-final-url")).toBe("https://example.com/page");
      expect(answer.headers.get("cache-control")).toBe("public, max-age=300");
      expect(answer.headers.get("content-disposition")).toBe("inline");
      expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
      // Any HTML that comes back lands in an opaque origin and can never reach this origin's storage.
      expect(answer.headers.get("content-security-policy")).toContain("sandbox");
      expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(answer.headers.get("x-mini-truncated")).toBeNull();

      // Nothing the caller sent is forwarded: a fresh header set, and no cookie in it.
      const sent = new Headers(net.seen[0].init?.headers as HeadersInit);
      expect(sent.get("user-agent")).toBe(PROXY_USER_AGENT);
      expect(sent.get("accept")).toBe(PROXY_ACCEPT);
      expect(sent.get("cookie")).toBeNull();
      expect(net.seen[0].init?.redirect).toBe("manual");
    } finally {
      net.restore();
    }
  });

  it("refuses a caller that is not this site, and does not dial anything", async () => {
    const net = upstream(new Response("never", { status: 200 }));
    try {
      const answer = await call("https://example.com/page", {});
      expect(answer.status).toBe(403);
      expect(await answer.text()).toContain("same-origin callers only");
      expect(answer.headers.get("cache-control")).toBe("public, max-age=60");
      expect(net.seen).toHaveLength(0);
    } finally {
      net.restore();
    }
  });

  it("names a non-text answer and pours none of it into the transcript", async () => {
    const net = upstream(new Response("PNGPNGPNG", { status: 200, headers: { "content-type": "image/png" } }));
    try {
      const answer = await call("https://example.com/a.png");
      expect(answer.status).toBe(415);
      expect(await answer.text()).toContain("not text (image/png)");
    } finally {
      net.restore();
    }
  });

  it("follows a redirect to another public https host and reports where it ended", async () => {
    const net = upstream(
      new Response(null, { status: 301, headers: { location: "https://docs.example/final" } }),
      new Response("arrived", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    try {
      const answer = await call("https://example.com/start");
      expect(await answer.text()).toBe("arrived");
      expect(answer.headers.get("x-mini-final-url")).toBe("https://docs.example/final");
      expect(net.seen.map((s) => s.url)).toEqual(["https://example.com/start", "https://docs.example/final"]);
    } finally {
      net.restore();
    }
  });

  it("refuses a redirect that leaves the public https web — the hop is checked like the first call", async () => {
    const net = upstream(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
    try {
      const answer = await call("https://example.com/start");
      expect(answer.status).toBe(403);
      expect(await answer.text()).toContain("leaves the public https web");
      expect(net.seen).toHaveLength(1);
    } finally {
      net.restore();
    }
  });

  it("stops a redirect loop instead of chasing it", async () => {
    const net = upstream(() => new Response(null, { status: 307, headers: { location: "https://example.com/again" } }));
    try {
      const answer = await call("https://example.com/start");
      expect(answer.status).toBe(508);
      expect(net.seen.length).toBe(PROXY_MAX_REDIRECTS + 1);
    } finally {
      net.restore();
    }
  });

  it("takes a redirect with no `location` as the answer it is", async () => {
    const net = upstream(new Response("moved, apparently nowhere", { status: 302, headers: { "content-type": "text/plain" } }));
    try {
      const answer = await call("https://example.com/start");
      expect(answer.status).toBe(302);
      expect(answer.headers.get("cache-control")).toBe("public, max-age=60");
    } finally {
      net.restore();
    }
  });

  it("cuts the body at a mebibyte and says that it did", async () => {
    const net = upstream(
      new Response("x".repeat(PROXY_MAX_BYTES + 4096), { status: 200, headers: { "content-type": "text/plain" } }),
    );
    try {
      const answer = await call("https://example.com/big");
      expect(answer.headers.get("x-mini-truncated")).toBe("1");
      expect((await answer.text()).length).toBe(PROXY_MAX_BYTES);
    } finally {
      net.restore();
    }
  });

  it("passes an upstream failure through with its status, cached for a minute and not an afternoon", async () => {
    const net = upstream(new Response("gone", { status: 404, headers: { "content-type": "text/plain" } }));
    try {
      const answer = await call("https://example.com/missing");
      expect(answer.status).toBe(404);
      expect(answer.headers.get("cache-control")).toBe("public, max-age=60");
    } finally {
      net.restore();
    }
  });

  it("answers a HEAD with the headers and no body", async () => {
    const net = upstream(new Response("the whole page", { status: 200, headers: { "content-type": "text/plain" } }));
    try {
      const answer = await call("https://example.com/page", { "sec-fetch-site": "same-origin" }, "HEAD");
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("");
      expect(answer.headers.get("x-mini-final-url")).toBe("https://example.com/page");
    } finally {
      net.restore();
    }
  });

  it("says which host went quiet when the upstream call fails or runs out of time", async () => {
    const net = upstream(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    try {
      const answer = await call("https://slow.example/page");
      expect(answer.status).toBe(504);
      const text = await answer.text();
      expect(text).toContain("slow.example");
      expect(text).toContain("10s");
    } finally {
      net.restore();
    }

    const dead = upstream(() => {
      throw new Error("connection refused");
    });
    try {
      const answer = await call("https://down.example/page");
      expect(answer.status).toBe(504);
      expect(await answer.text()).toContain("could not be reached");
    } finally {
      dead.restore();
    }
  });

  it("is answered before the SPA fallback — `/~fetch` never comes back as index.html", async () => {
    const net = upstream(new Response("page", { status: 200, headers: { "content-type": "text/plain" } }));
    try {
      const answer = await call("https://example.com/page");
      expect(answer.headers.get("content-type")).not.toContain("text/html");
      expect(await answer.text()).toBe("page");
    } finally {
      net.restore();
    }
  });
});
