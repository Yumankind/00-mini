import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { NON_USER_IMAGE_REASON } from "../src/image-parts.js";
import { mapFinishReason, mapUsage, OpenAICompatibleProvider, parseToolArguments, splitFooter, TOOL_RESULT_IMAGE_REASON } from "../src/openai-compatible.js";
import type { ChatChunk, ImagePart, ModelInfo } from "../src/types.js";
import { collect, frame, jsonResponse, recordingFetch, sseResponse } from "./helpers.js";

const CATALOG: ModelInfo[] = [
  { id: "m-small", label: "Small", class: "small", local: false, supportsTools: true },
  { id: "m-strong", label: "Strong", class: "strong", local: false, supportsTools: true },
];

function provider(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({
    id: "test",
    baseUrl: "https://host.example/v1",
    apiKey: "sk-test",
    catalog: CATALOG,
    defaultModel: "m-strong",
    fetch: fetchImpl,
    ...extra,
  });
}

describe("pure mappers", () => {
  it("parses tool arguments and falls back to an empty object rather than inventing a key", () => {
    expect(parseToolArguments('{"path":"a.md"}')).toEqual({ path: "a.md" });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments("{not json")).toEqual({});
    expect(parseToolArguments("[1,2]")).toEqual({});
  });

  it("maps finish reasons onto the four the runtime knows", () => {
    expect(mapFinishReason("stop", false)).toBe("stop");
    expect(mapFinishReason("stop", true)).toBe("tool_calls");
    expect(mapFinishReason("tool_calls", true)).toBe("tool_calls");
    expect(mapFinishReason("length", false)).toBe("length");
    expect(mapFinishReason("max_tokens", false)).toBe("length");
    expect(mapFinishReason("content_filter", false)).toBe("error");
    expect(mapFinishReason("abort", false)).toBe("error");
    expect(mapFinishReason(undefined, false)).toBe("stop");
    expect(mapFinishReason("something-new", true)).toBe("tool_calls");
  });

  it("converts OpenRouter's usage.cost from DOLLARS to cents", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 4, cost: 0.0123 })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      costCents: 1.23,
    });
    // Fractions of a cent survive: a small turn is not free, and flooring would say it was.
    expect(mapUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.000004 })?.costCents).toBe(0.0004);
    expect(mapUsage({ input_tokens: 3, output_tokens: 2 })).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(mapUsage(undefined)).toBeUndefined();
  });

  it("splits a footer off the tail and leaves an answer without one alone", () => {
    expect(splitFooter("answer\n\n— sponsored by Acme · $0.42", "— sponsored by ")).toEqual({
      content: "answer",
      footer: "— sponsored by Acme · $0.42",
    });
    expect(splitFooter("answer", "— sponsored by ")).toEqual({ content: "answer" });
    expect(splitFooter("answer", undefined)).toEqual({ content: "answer" });
  });
});

describe("chat", () => {
  it("sends the neutral history in the OpenAI shape and reads the answer back", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.01 },
      }),
    ]);
    const res = await provider(fetch).chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ls", arguments: { path: "." } }] },
        { role: "tool", content: "a.md", toolCallId: "c1" },
      ],
      tools: [{ name: "ls", description: "list", parameters: { type: "object" } }],
      temperature: 0.2,
      maxTokens: 128,
    });

    expect(calls[0]?.url).toBe("https://host.example/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.model).toBe("m-strong");
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(128);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "ls", description: "list", parameters: { type: "object" } } });
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{"path":"."}');
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "a.md" });
    expect(String((calls[0]?.init?.headers as Record<string, string>).Authorization)).toBe("Bearer sk-test");

    expect(res.message.content).toBe("hello");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2, costCents: 1 });
  });

  it("parses tool calls into the neutral shape with real objects for arguments", async () => {
    const { fetch } = recordingFetch([
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"AGENTS.md"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);
    const res = await provider(fetch).chat({ messages: [{ role: "user", content: "read it" }] });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.message.toolCalls).toEqual([{ id: "call_a", name: "read", arguments: { path: "AGENTS.md" } }]);
    expect(res.message.content).toBe("");
  });

  it("lifts a footer out of the answer with the extractFooter hook and strips it from the content", async () => {
    const { fetch } = recordingFetch([
      jsonResponse({ choices: [{ message: { role: "assistant", content: "answer\n\n-- credit line" }, finish_reason: "stop" }] }),
    ]);
    const res = await provider(fetch, {
      extractFooter: (_json, ctx) => (ctx.content.includes("-- credit line") ? "-- credit line" : undefined),
    }).chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.message.content).toBe("answer");
    expect(res.footer).toBe("-- credit line");
  });

  it("turns a 402 into the typed insufficient_credits refusal with its topUp paths", async () => {
    const { fetch } = recordingFetch([
      jsonResponse(
        { error: { message: "Out of AI credits", code: "insufficient_credits", topUp: { packsUrl: "/packs", checkoutUrl: "/checkout" } } },
        { status: 402 },
      ),
    ]);
    await expect(provider(fetch).chat({ messages: [] })).rejects.toMatchObject({
      code: "insufficient_credits",
      status: 402,
      topUp: { packsUrl: "/packs", checkoutUrl: "/checkout", origin: "https://host.example" },
    });
  });

  it("turns 401 and 403 into a credential refusal and 429 into a rate limit", async () => {
    for (const [status, code] of [
      [401, "credential"],
      [403, "credential"],
      [429, "rate_limited"],
    ] as const) {
      const { fetch } = recordingFetch([jsonResponse({ error: { message: "no" } }, { status })]);
      await expect(provider(fetch).chat({ messages: [] })).rejects.toMatchObject({ code, status });
    }
  });

  it("refuses before the request when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = recordingFetch([jsonResponse({})]);
    await expect(provider(fetch).chat({ messages: [], signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toHaveLength(0);
  });

  it("passes the signal to fetch and reports a mid-flight abort as `aborted`", async () => {
    const controller = new AbortController();
    const { fetch, calls } = recordingFetch([
      () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    ]);
    await expect(provider(fetch).chat({ messages: [], signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("says so when the answer is not JSON", async () => {
    const { fetch } = recordingFetch([new Response("not json", { status: 200 })]);
    await expect(provider(fetch).chat({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("stream", () => {
  it("emits text deltas, then assembled tool calls, then done", async () => {
    const { fetch, calls } = recordingFetch([
      sseResponse([
        frame({ choices: [{ delta: { role: "assistant", content: "Hel" } }] }),
        frame({ choices: [{ delta: { content: "lo" } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "wr", arguments: '{"pa' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ite", arguments: 'th":"a.md"}' } }] } }] }),
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.02 } }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const chunks = (await collect(provider(fetch).stream({ messages: [{ role: "user", content: "hi" }] }))) as ChatChunk[];

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });

    expect(chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta)).toEqual(["Hel", "lo"]);
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", call: { id: "c1", name: "write", arguments: { path: "a.md" } } });
    const done = chunks.at(-1) as { type: "done"; response: { finishReason: string; usage?: unknown; message: { content: string } } };
    expect(done.type).toBe("done");
    expect(done.response.finishReason).toBe("tool_calls");
    expect(done.response.usage).toEqual({ inputTokens: 9, outputTokens: 3, costCents: 2 });
    expect(done.response.message.content).toBe("Hello");
  });

  it("skips keep-alive frames that are not JSON", async () => {
    const { fetch } = recordingFetch([
      sseResponse([": ping\n\n", frame({ choices: [{ delta: { content: "ok" } }, ] }), "data: [DONE]\n\n"]),
    ]);
    const chunks = await collect(provider(fetch).stream({ messages: [] }));
    expect(chunks.filter((c) => c.type === "text")).toHaveLength(1);
  });

  it("reads the refusal object that rides inside a streamed chunk", async () => {
    const { fetch } = recordingFetch([
      sseResponse([
        frame({
          choices: [{ delta: { content: "Out of AI credits — top up to keep this agent thinking." } }],
          error: { code: "insufficient_credits", message: "Out of AI credits", topUp: { packsUrl: "/packs" } },
        }),
      ]),
    ]);
    await expect(collect(provider(fetch).stream({ messages: [] }))).rejects.toMatchObject({ code: "insufficient_credits" });
  });

  it("streams the footer through as text but files the message without it", async () => {
    const { fetch } = recordingFetch([
      sseResponse([
        frame({ choices: [{ delta: { content: "the answer" } }] }),
        frame({ choices: [{ delta: { content: "\n\n-- credit line" } }] }),
        frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ]),
    ]);
    const chunks = await collect(provider(fetch, { footerLead: "-- credit line" }).stream({ messages: [] }));
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");
    expect(text).toBe("the answer\n\n-- credit line");
    const done = chunks.at(-1) as { response: { message: { content: string }; footer?: string } };
    expect(done.response.message.content).toBe("the answer");
    expect(done.response.footer).toBe("-- credit line");
  });

  it("stops and reports `aborted` when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    const { fetch } = recordingFetch([
      sseResponse([frame({ choices: [{ delta: { content: "a" } }] }), frame({ choices: [{ delta: { content: "b" } }] })]),
    ]);
    const iterator = provider(fetch).stream({ messages: [], signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
  });

  it("can be told not to ask for usage on the last chunk", async () => {
    const { fetch, calls } = recordingFetch([sseResponse([frame({ choices: [{ delta: {}, finish_reason: "stop" }] })])]);
    await collect(provider(fetch, { streamUsage: false }).stream({ messages: [] }));
    expect(JSON.parse(String(calls[0]?.init?.body)).stream_options).toBeUndefined();
  });
});

describe("readiness and models", () => {
  it("answers `credential` with no key and ready with one", async () => {
    const { fetch } = recordingFetch([jsonResponse({})]);
    await expect(provider(fetch, { apiKey: undefined }).readiness()).resolves.toEqual({
      ready: false,
      reason: "credential",
      detail: "test needs a key.",
    });
    await expect(provider(fetch).readiness()).resolves.toEqual({ ready: true });
  });

  it("skips the key check when the credential is not a key, and takes an override", async () => {
    const { fetch } = recordingFetch([jsonResponse({})]);
    await expect(provider(fetch, { apiKey: undefined, requiresApiKey: false }).readiness()).resolves.toEqual({ ready: true });
    await expect(provider(fetch, { readiness: async () => ({ ready: false as const, reason: "offline" as const }) }).readiness()).resolves.toEqual({
      ready: false,
      reason: "offline",
    });
  });

  it("hands back a copy of the catalog, not the catalog", async () => {
    const { fetch } = recordingFetch([jsonResponse({})]);
    const p = provider(fetch);
    const models = await p.models();
    models.pop();
    expect(await p.models()).toHaveLength(CATALOG.length);
  });
});

// ── Pictures (gap B10) ──────────────────────────────────────────────────────────────────────────

describe("images on the OpenAI wire", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const shot: ImagePart = { mime: "image/jpeg", data: png, source: "shot.png" };
  const DATA_URL = "data:image/png;base64,iVBORw0KGgoH";

  const VISION: ModelInfo[] = [
    { id: "m-sees", label: "Sees", class: "strong", local: false, supportsTools: true, vision: true },
    { id: "m-blind", label: "Blind", class: "small", local: false, supportsTools: true },
  ];

  function sent(calls: { init?: RequestInit }[]): Record<string, unknown> {
    return JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  }

  it("makes the user turn multi-part, text first and the picture as an image_url", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "a cat" }, finish_reason: "stop" }] })]);
    const p = provider(fetch, { catalog: VISION, defaultModel: "m-sees" });
    await p.chat({ messages: [{ role: "user", content: "what is this?", images: [shot] }] });
    expect(sent(calls).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          // The DECLARED `image/jpeg` loses to the PNG magic bytes — the vendor reads the bytes too.
          { type: "image_url", image_url: { url: DATA_URL } },
        ],
      },
    ]);
  });

  it("leaves a turn with no picture as the plain string it always was", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "hi" } }] })]);
    await provider(fetch, { catalog: VISION, defaultModel: "m-sees" }).chat({ messages: [{ role: "user", content: "hello" }] });
    expect(sent(calls).messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("drops the picture with a line of text when the catalogue row cannot see", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "…" } }] })]);
    const p = provider(fetch, { catalog: VISION, defaultModel: "m-blind" });
    await p.chat({ messages: [{ role: "user", content: "what is this?", images: [shot] }] });
    expect(sent(calls).messages).toEqual([
      { role: "user", content: "what is this?\n\n[A picture was attached (shot.png), but this model cannot see pictures.]" },
    ]);
    expect(p.seesImages("m-blind")).toBe(false);
    expect(p.seesImages("m-sees")).toBe(true);
  });

  it("reads a catalogue's silence as text-only, and lets the caller say otherwise", () => {
    // An id no row carries: this class is pointed at any host at all, so the safe reading is no.
    expect(provider(recordingFetch([]).fetch, { catalog: [], defaultModel: "whatever" }).seesImages()).toBe(false);
    expect(provider(recordingFetch([]).fetch, { catalog: [], defaultModel: "whatever", vision: true }).seesImages()).toBe(true);
    // A row that DOES say still wins over the option.
    expect(provider(recordingFetch([]).fetch, { catalog: VISION, defaultModel: "m-blind", vision: true }).seesImages()).toBe(false);
  });

  it("names a tool result's picture rather than putting it where the wire refuses it", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "ok" } }] })]);
    await provider(fetch, { catalog: VISION, defaultModel: "m-sees" }).chat({
      messages: [{ role: "tool", content: "screenshot taken", toolCallId: "c1", images: [shot] }],
    });
    expect(sent(calls).messages).toEqual([
      { role: "tool", tool_call_id: "c1", content: `screenshot taken\n\n[A picture was attached (shot.png), but ${TOOL_RESULT_IMAGE_REASON}.]` },
    ]);
  });

  it("says the same about an assistant turn, which is not a place a picture can go", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [{ message: { content: "ok" } }] })]);
    await provider(fetch, { catalog: VISION, defaultModel: "m-sees" }).chat({
      messages: [{ role: "assistant", content: "here it is", images: [shot] }],
    });
    expect(sent(calls).messages).toEqual([{ role: "assistant", content: `here it is\n\n[A picture was attached (shot.png), but ${NON_USER_IMAGE_REASON}.]` }]);
  });

  it("streams the same body it would have posted", async () => {
    const { fetch, calls } = recordingFetch([sseResponse([frame({ choices: [{ delta: { content: "a cat" } }] }), "data: [DONE]\n\n"])]);
    await collect(provider(fetch, { catalog: VISION, defaultModel: "m-sees" }).stream({ messages: [{ role: "user", content: "?", images: [shot] }] }));
    const messages = sent(calls).messages as { content: unknown[] }[];
    expect(messages[0]?.content).toContainEqual({ type: "image_url", image_url: { url: DATA_URL } });
  });

  it("refuses a picture over the cap by name, before anything is posted", async () => {
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fetch, calls } = recordingFetch([jsonResponse({ choices: [] })]);
    await expect(
      provider(fetch, { catalog: VISION, defaultModel: "m-sees" }).chat({ messages: [{ role: "user", content: "big", images: [{ mime: "image/png", data: huge }] }] }),
    ).rejects.toMatchObject({ vendorCode: "image_too_large", providerId: "test" });
    expect(calls).toEqual([]);
  });
});
