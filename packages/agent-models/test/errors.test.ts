import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  isAborted,
  isSwitchable,
  parseErrorBody,
  ProviderError,
  providerErrorFromResponse,
  providerErrorFromThrow,
  throwIfAborted,
} from "../src/errors.js";

describe("parseErrorBody", () => {
  it("flattens the OpenAI shape", () => {
    const body = parseErrorBody(JSON.stringify({ error: { message: "no key", code: "invalid_api_key" } }));
    expect(body).toMatchObject({ message: "no key", vendorCode: "invalid_api_key" });
  });

  it("flattens the Anthropic shape, whose code lives in `type`", () => {
    const body = parseErrorBody(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
    expect(body).toMatchObject({ message: "bad key", vendorCode: "authentication_error" });
  });

  it("flattens a flat sponsoredtokens refusal", () => {
    const body = parseErrorBody(JSON.stringify({ code: "unknown_device", message: "not registered" }));
    expect(body).toMatchObject({ message: "not registered", vendorCode: "unknown_device" });
  });

  it("keeps the topUp paths of the cloud-agents 402 exactly as sent", () => {
    const body = parseErrorBody(
      JSON.stringify({
        error: {
          message: "Out of AI credits…",
          code: "insufficient_credits",
          topUp: { packsUrl: "/api/computers/ws-a/ai-credits", checkoutUrl: "/api/computers/ws-a/ai-credits-checkout" },
        },
      }),
    );
    expect(body.topUp).toEqual({ packsUrl: "/api/computers/ws-a/ai-credits", checkoutUrl: "/api/computers/ws-a/ai-credits-checkout" });
  });

  it("survives a body that is not JSON at all", () => {
    const body = parseErrorBody("<html>502 Bad Gateway</html>");
    expect(body.message).toBe("<html>502 Bad Gateway</html>");
    expect(body.vendorCode).toBeUndefined();
  });
});

describe("classifyStatus", () => {
  const empty = { raw: null };
  it("maps the statuses the router acts on", () => {
    expect(classifyStatus(402, empty)).toBe("insufficient_credits");
    expect(classifyStatus(401, empty)).toBe("credential");
    expect(classifyStatus(403, empty)).toBe("credential");
    expect(classifyStatus(429, empty)).toBe("rate_limited");
    expect(classifyStatus(400, empty)).toBe("bad_request");
    expect(classifyStatus(404, empty)).toBe("unsupported");
    expect(classifyStatus(503, empty)).toBe("server_error");
    expect(classifyStatus(200, empty)).toBe("server_error");
  });

  it("refuses to read somebody else's 402 as an empty wallet", () => {
    expect(classifyStatus(402, { raw: null, vendorCode: "subscription_required" })).toBe("bad_request");
  });
});

describe("providerErrorFromResponse", () => {
  it("carries the topUp paths and the origin the caller dialled", () => {
    const err = providerErrorFromResponse({
      providerId: "overblast",
      status: 402,
      text: JSON.stringify({ error: { code: "insufficient_credits", message: "empty", topUp: { packsUrl: "/packs" } } }),
      origin: "https://worker.example",
    });
    expect(err.code).toBe("insufficient_credits");
    expect(err.topUp).toEqual({ packsUrl: "/packs", checkoutUrl: undefined, origin: "https://worker.example" });
    expect(isSwitchable(err)).toBe(true);
  });

  it("prefers the retry-after header over the body's own number", () => {
    const err = providerErrorFromResponse({
      providerId: "sponsored",
      status: 429,
      text: JSON.stringify({ error: { retryAfterSeconds: 999 } }),
      headers: new Headers({ "retry-after": "12" }),
    });
    expect(err.retryAfterSeconds).toBe(12);
    expect(isSwitchable(err)).toBe(false);
  });

  it("writes a sentence of its own when the body had none", () => {
    const err = providerErrorFromResponse({ providerId: "byok:openai", status: 500, text: "" });
    expect(err.message).toContain("HTTP 500");
    expect(err.code).toBe("server_error");
  });
});

describe("providerErrorFromThrow", () => {
  it("recognises an AbortError by name", () => {
    const abort = Object.assign(new Error("stopped"), { name: "AbortError" });
    const err = providerErrorFromThrow("local", abort);
    expect(err.code).toBe("aborted");
    expect(isAborted(err)).toBe(true);
  });

  it("recognises an already-aborted signal even when the throw was something else", () => {
    const controller = new AbortController();
    controller.abort();
    expect(providerErrorFromThrow("local", new Error("socket"), controller.signal).code).toBe("aborted");
  });

  it("passes a ProviderError through untouched", () => {
    const original = new ProviderError({ status: 402, code: "insufficient_credits", message: "empty" });
    expect(providerErrorFromThrow("x", original)).toBe(original);
  });

  it("calls everything else a network failure and keeps the cause", () => {
    const err = providerErrorFromThrow("byok:openai", new Error("getaddrinfo ENOTFOUND"));
    expect(err.code).toBe("network");
    expect(err.message).toContain("ENOTFOUND");
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("throwIfAborted", () => {
  it("refuses before a request is built", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted("local", { signal: controller.signal })).toThrow(ProviderError);
  });

  it("says nothing when the signal is live", () => {
    expect(() => throwIfAborted("local", { signal: new AbortController().signal })).not.toThrow();
    expect(() => throwIfAborted("local", {})).not.toThrow();
  });
});
