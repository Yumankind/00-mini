import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/anthropic.js";
import { BYOK_BASE_URLS, byokProvider, overblastProvider } from "../src/providers.js";
import type { ModelInfo } from "../src/types.js";
import { jsonResponse, recordingFetch } from "./helpers.js";

const CATALOG: ModelInfo[] = [
  { id: "anthropic/claude-opus-5", label: "Opus 5", class: "strong", local: false, supportsTools: true },
  { id: "anthropic/claude-haiku-4.5", label: "Haiku 4.5", class: "small", local: false, supportsTools: true },
];

describe("overblastProvider", () => {
  it("dials the given /ai/v1 base with the sk-obd device token as the bearer", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] })]);
    const provider = overblastProvider({ baseUrl: "https://worker.example/ai/v1", token: "sk-obd-abc.def", catalog: CATALOG, fetch });
    expect(provider.id).toBe("overblast");
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]?.url).toBe("https://worker.example/ai/v1/chat/completions");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-obd-abc.def");
    // The mint call's list is strongest-first and its default is always models[0].
    expect(JSON.parse(String(calls[0]?.init?.body)).model).toBe("anthropic/claude-opus-5");
  });

  it("is not ready without a token, so the router skips it before spending a request", async () => {
    const provider = overblastProvider({ baseUrl: "https://worker.example/ai/v1", catalog: CATALOG });
    await expect(provider.readiness()).resolves.toMatchObject({ ready: false, reason: "credential" });
  });

  it("turns the proxy's 402 into insufficient_credits with the relative topUp paths and the origin", async () => {
    const { fetch } = recordingFetch([
      jsonResponse(
        {
          error: {
            message: "Out of AI credits for this workspace — top up in the app to keep this agent thinking.",
            type: "insufficient_credits",
            code: "insufficient_credits",
            balanceCents: 0,
            topUp: { packsUrl: "/api/computers/ws-a/ai-credits", checkoutUrl: "/api/computers/ws-a/ai-credits-checkout" },
          },
        },
        { status: 402 },
      ),
    ]);
    const provider = overblastProvider({ baseUrl: "https://worker.example/ai/v1", token: "sk-obd-x.y", catalog: CATALOG, fetch });
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({
      code: "insufficient_credits",
      topUp: { packsUrl: "/api/computers/ws-a/ai-credits", origin: "https://worker.example" },
    });
  });
});

describe("byokProvider", () => {
  it("knows the three vendor bases", () => {
    expect(BYOK_BASE_URLS.openai).toBe("https://api.openai.com/v1");
    expect(BYOK_BASE_URLS.openrouter).toBe("https://openrouter.ai/api/v1");
    expect(BYOK_BASE_URLS.anthropic).toBe("https://api.anthropic.com/v1");
  });

  it("dials OpenAI with the person's own key", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })]);
    const provider = byokProvider({ vendor: "openai", apiKey: "sk-mine", catalog: CATALOG, fetch });
    expect(provider.id).toBe("byok:openai");
    await provider.chat({ messages: [] });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("asks OpenRouter to include cost, so a session can price itself", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.25 } }),
    ]);
    const provider = byokProvider({ vendor: "openrouter", apiKey: "sk-or", catalog: CATALOG, fetch });
    const res = await provider.chat({ messages: [] });
    expect(JSON.parse(String(calls[0]?.init?.body)).usage).toEqual({ include: true });
    expect(res.usage?.costCents).toBe(25);
  });

  it("gives Anthropic its own provider rather than an OpenAI-shaped one", () => {
    const provider = byokProvider({ vendor: "anthropic", apiKey: "sk-ant", catalog: CATALOG });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.id).toBe("byok:anthropic");
  });

  it("takes a custom OpenAI-compatible host, and refuses one with no base URL", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })]);
    const provider = byokProvider({ vendor: "custom", apiKey: "k", baseUrl: "http://localhost:1234/v1", catalog: CATALOG, fetch, id: "byok:lmstudio" });
    expect(provider.id).toBe("byok:lmstudio");
    await provider.chat({ messages: [] });
    expect(calls[0]?.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(() => byokProvider({ vendor: "custom", apiKey: "k" })).toThrow(/baseUrl/);
  });

  it("ships no catalog of its own — the vocabulary is configuration, not code", async () => {
    const provider = byokProvider({ vendor: "openai", apiKey: "k" });
    await expect(provider.models()).resolves.toEqual([]);
  });
});
