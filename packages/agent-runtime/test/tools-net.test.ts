// The first door out of the tab (gap B17): what it fetches, what it refuses, and what it asks about.

import { describe, expect, it } from "vitest";
import {
  HTTP_GET_MAX_BYTES,
  createAgentRuntime,
  hostAllowed,
  httpGetTool,
  type AgentEvent,
  type AgentRuntimeOptionsExt,
  type ToolContext,
} from "../src/index.js";
import { FakeProvider, call } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

function ctxFor(): ToolContext {
  return { fs: new MemoryFs(), sandbox: "workspace", signal: new AbortController().signal, emit: () => {} };
}

/** A fetch that records what it was called with and answers what the test wants. */
function fakeFetch(answer: { status?: number; type?: string; body?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(answer.body ?? "hello", {
      status: answer.status ?? 200,
      headers: { "content-type": answer.type ?? "text/plain" },
    });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

describe("the allow list", () => {
  it("matches a host and its subdomains, and nothing that merely ends the same way", () => {
    const policy = { allow: ["example.com", "*.docs.dev"] };
    expect(hostAllowed("example.com", policy)).toBe(true);
    expect(hostAllowed("api.example.com", policy)).toBe(true);
    expect(hostAllowed("EXAMPLE.com", policy)).toBe(true);
    expect(hostAllowed("notexample.com", policy)).toBe(false);
    expect(hostAllowed("docs.dev", policy)).toBe(true);
    expect(hostAllowed("anything", undefined)).toBe(false);
    expect(hostAllowed("anything", { allow: [] })).toBe(false);
    expect(hostAllowed("anything.at.all", { allow: ["*"] })).toBe(true);
  });
});

describe("http_get", () => {
  it("is safe for an allowed host and asks for every other one", () => {
    const tool = httpGetTool({ policy: { allow: ["example.com"] } });
    expect(tool.tier).toBe("safe");
    expect(tool.tierFor!({ url: "https://api.example.com/x" }, ctxFor())).toBe("safe");
    expect(tool.tierFor!({ url: "https://elsewhere.test/x" }, ctxFor())).toBe("confirm");
    // Nonsense arguments ask too, rather than sliding through as `safe`.
    expect(tool.tierFor!({ url: 42 }, ctxFor())).toBe("confirm");
    expect(tool.tierFor!({}, ctxFor())).toBe("confirm");
  });

  it("fetches with no credentials and reports what came back", async () => {
    const fetch = fakeFetch({ body: "the page text" });
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: fetch.fn }).run(
      { url: "https://example.com/page" },
      ctxFor(),
    );
    expect(result.output).toContain("the page text");
    expect(result.output).toContain("HTTP 200");
    expect(fetch.calls[0].init).toMatchObject({ method: "GET", credentials: "omit" });
  });

  it("refuses anything that is not http(s) — a file: URL would read this machine", async () => {
    const fetch = fakeFetch();
    const tool = httpGetTool({ policy: { allow: ["*"] }, fetch: fetch.fn });
    for (const url of ["file:///etc/passwd", "data:text/html,<b>x</b>", "not a url", ""]) {
      expect(await tool.run({ url }, ctxFor())).toMatchObject({ isError: true });
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("names a non-text answer instead of pouring it into the transcript", async () => {
    const fetch = fakeFetch({ type: "application/pdf" });
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: fetch.fn }).run(
      { url: "https://example.com/a.pdf" },
      ctxFor(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("application/pdf");
  });

  it("reports an HTTP error and a thrown fetch as observations, not as crashes", async () => {
    const failing = fakeFetch({ status: 404 });
    expect(
      await httpGetTool({ policy: { allow: ["*"] }, fetch: failing.fn }).run({ url: "https://example.com/x" }, ctxFor()),
    ).toMatchObject({ isError: true });

    const throwing = (async () => {
      throw new Error("offline");
    }) as typeof globalThis.fetch;
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: throwing }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(result.output).toContain("Could not reach example.com: offline");
  });

  it("caps the body and says it capped it", async () => {
    const fetch = fakeFetch({ body: "x".repeat(HTTP_GET_MAX_BYTES + 100) });
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: fetch.fn }).run(
      { url: "https://example.com/big" },
      ctxFor(),
    );
    expect(result.output).toContain("[Truncated at 1024KB.]");
    expect(result.output.length).toBeLessThan(HTTP_GET_MAX_BYTES + 400);
  });

  it("names the pre-approved hosts in its own description, and says they are untrusted data", () => {
    const described = httpGetTool({ policy: { allow: ["example.com"] } }).schema.description;
    expect(described).toContain("example.com");
    expect(described).toContain("untrusted DATA");
    expect(httpGetTool({ policy: { allow: [] } }).schema.description).toContain("Every host asks the person first");
  });
});

describe("the read-only proxy fallback", () => {
  const proxy = (u: URL) => `https://site.test/~fetch?url=${encodeURIComponent(u.href)}`;

  it("retries through the proxy when the browser refuses the direct read, and says so", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      // The first call is the direct one, and a blocked cross-origin read is a TypeError with no
      // detail — exactly what a browser throws for CORS and for a dead host alike.
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response("<html><title>T</title><body><p>the page</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof globalThis.fetch;

    const result = await httpGetTool({ policy: { allow: ["*"], proxy }, fetch: fetchFn }).run(
      { url: "https://example.com/page" },
      ctxFor(),
    );
    expect(calls).toEqual([
      "https://example.com/page",
      "https://site.test/~fetch?url=https%3A%2F%2Fexample.com%2Fpage",
    ]);
    expect(result.output).toContain("(fetched through the site's read-only proxy)");
    expect(result.output).toContain("the page");
    expect(result.isError).toBeUndefined();
  });

  it("retries an OPAQUE answer too — a no-cors response is a refusal wearing a hat", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) return Response.error(); // status 0, type "error"/opaque
      return new Response("through the proxy", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof globalThis.fetch;

    const result = await httpGetTool({ policy: { allow: ["*"], proxy }, fetch: fetchFn }).run(
      { url: "https://example.com/page" },
      ctxFor(),
    );
    expect(calls).toHaveLength(2);
    expect(result.output).toContain("through the proxy");
  });

  it("without a proxy, the error text is exactly what it always was", async () => {
    const throwing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: throwing }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toBe("Could not reach example.com: Failed to fetch");
    expect(result.output).not.toContain("proxy");
  });

  it("names the host that was asked for when the proxy fails too, and when the policy declines this URL", async () => {
    const throwing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    const both = await httpGetTool({ policy: { allow: ["*"], proxy }, fetch: throwing }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(both.output).toBe("Could not reach example.com: Failed to fetch");

    // `null` is the policy saying "not through me" for this particular URL.
    const declined = await httpGetTool({ policy: { allow: ["*"], proxy: () => null }, fetch: throwing }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(declined.output).toBe("Could not reach example.com: Failed to fetch");
  });

  it("does not retry an ordinary Error — only the browser's blocked-read TypeError", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("aborted");
    }) as typeof globalThis.fetch;
    const result = await httpGetTool({ policy: { allow: ["*"], proxy }, fetch: fetchFn }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(calls).toEqual(["https://example.com/x"]);
    expect(result.output).toContain("aborted");
  });

  it("reports the CORS refusal by name when an opaque answer has nowhere to go", async () => {
    const fetchFn = (async () => Response.error()) as typeof globalThis.fetch;
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: fetchFn }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("refused to be read from this page (CORS)");
  });
});

describe("the answer as text", () => {
  it("converts HTML to readable text and leaves JSON alone", async () => {
    const html = fakeFetch({
      type: "text/html; charset=utf-8",
      body: `<html><head><title>Docs</title><script>var x=1</script></head>
             <body><h1>Install</h1><p>Read the <a href="/api">API</a>.</p></body></html>`,
    });
    const page = await httpGetTool({ policy: { allow: ["*"] }, fetch: html.fn }).run(
      { url: "https://example.com/docs" },
      ctxFor(),
    );
    expect(page.output).toContain("# Install");
    expect(page.output).toContain("[API](https://example.com/api)");
    expect(page.output).not.toContain("<script>");

    const json = fakeFetch({ type: "application/json", body: `{"a":"<b>not html</b>"}` });
    const data = await httpGetTool({ policy: { allow: ["*"] }, fetch: json.fn }).run(
      { url: "https://example.com/a.json" },
      ctxFor(),
    );
    expect(data.output).toContain(`{"a":"<b>not html</b>"}`);
  });

  it("sniffs a page a server forgot to type, and caps AFTER the conversion", async () => {
    const sniffed = fakeFetch({ type: "", body: "<!doctype html><p>typed by nobody</p>" });
    const result = await httpGetTool({ policy: { allow: ["*"] }, fetch: sniffed.fn }).run(
      { url: "https://example.com/x" },
      ctxFor(),
    );
    expect(result.output).toContain("typed by nobody");
    expect(result.output).not.toContain("doctype");

    // Markup far past the cap whose TEXT is small: the old rule would have truncated it, the new
    // one converts first and the whole page arrives.
    const bloated = fakeFetch({
      type: "text/html",
      body: `<html><body><p>short answer</p>${"<span></span>".repeat(120_000)}</body></html>`,
    });
    const small = await httpGetTool({ policy: { allow: ["*"] }, fetch: bloated.fn }).run(
      { url: "https://example.com/bloat" },
      ctxFor(),
    );
    expect(small.output).toContain("short answer");
    expect(small.output).not.toContain("[Truncated");
  });
});

describe("http_get through the loop", () => {
  it("asks the person for a host off the list and does not ask for one on it", async () => {
    const fetch = fakeFetch({ body: "ok" });
    const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief" });
    const provider = new FakeProvider("local", [
      { toolCalls: [call("http_get", { url: "https://example.com/a" }), call("http_get", { url: "https://other.test/b" })] },
      { text: "read both" },
    ]);
    const asked: { name: string; tier: string }[] = [];
    const events: AgentEvent[] = [];
    const runtime = createAgentRuntime({
      fs,
      providers: [provider],
      tools: [httpGetTool({ policy: { allow: ["example.com"] }, fetch: fetch.fn })],
      trust: "full",
      now,
      async askPermission(req) {
        asked.push({ name: req.name, tier: req.tier });
        return { allowed: true };
      },
    } as AgentRuntimeOptionsExt);
    runtime.on((e) => events.push(e));

    await runtime.run({ prompt: "read both pages" });

    // One question, for the host nobody approved — and it carries the raised tier.
    expect(asked).toEqual([{ name: "http_get", tier: "confirm" }]);
    expect(fetch.calls.map((c) => c.url)).toEqual(["https://example.com/a", "https://other.test/b"]);
  });
});
