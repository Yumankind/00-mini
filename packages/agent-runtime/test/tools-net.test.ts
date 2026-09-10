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
