import { describe, expect, it } from "vitest";
import { ANTHROPIC_DEFAULT_MAX_TOKENS, ANTHROPIC_VERSION, AnthropicProvider, readAnthropicContent, toAnthropicMessages } from "../src/anthropic.js";
import { NON_USER_IMAGE_REASON } from "../src/image-parts.js";
import type { ImagePart, ModelInfo } from "../src/types.js";
import { collect, jsonResponse, recordingFetch, sseResponse } from "./helpers.js";

const CATALOG: ModelInfo[] = [{ id: "claude-x", label: "Claude X", class: "strong", local: false, supportsTools: true }];

function provider(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return new AnthropicProvider({ apiKey: "sk-ant-test", catalog: CATALOG, defaultModel: "claude-x", fetch: fetchImpl });
}

/** One Anthropic SSE frame: the event name is on its own line, as the vendor sends it. */
function ev(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe("toAnthropicMessages", () => {
  it("hoists system turns out of the array and joins them", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "be brief" },
      { role: "system", content: "you are 00" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("be brief\n\nyou are 00");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("turns an assistant tool call into content blocks", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: "looking", toolCalls: [{ id: "tu_1", name: "read", arguments: { path: "a.md" } }] },
    ]);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "tu_1", name: "read", input: { path: "a.md" } },
      ],
    });
  });

  it("turns tool results into ONE user turn, since two in a row are refused", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "read", arguments: {} }] },
      { role: "tool", content: "one", toolCallId: "tu_1" },
      { role: "tool", content: "two", toolCallId: "tu_2" },
      { role: "user", content: "thanks" },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "one" },
        { type: "tool_result", tool_use_id: "tu_2", content: "two" },
      ],
    });
    expect(messages[2]).toEqual({ role: "user", content: "thanks" });
  });
});

describe("readAnthropicContent", () => {
  it("concatenates text blocks and reads tool_use input as the object it already is", () => {
    expect(readAnthropicContent([{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "tool_use", id: "tu_1", name: "ls", input: { path: "." } }])).toEqual({
      text: "ab",
      toolCalls: [{ id: "tu_1", name: "ls", arguments: { path: "." } }],
    });
  });

  it("survives content that is not an array", () => {
    expect(readAnthropicContent(null)).toEqual({ text: "", toolCalls: [] });
  });
});

describe("chat", () => {
  it("sends the version, the key and the browser-access header, with max_tokens always present", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse({ content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 2 } }),
    ]);
    const res = await provider(fetch).chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      tools: [{ name: "ls", description: "list", parameters: { type: "object" } }],
    });

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.system).toBe("be brief");
    expect(body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
    expect(body.tools).toEqual([{ name: "ls", description: "list", input_schema: { type: "object" } }]);

    expect(res.message.content).toBe("hello");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("maps stop_reason tool_use onto tool_calls", async () => {
    const { fetch } = recordingFetch([
      jsonResponse({ content: [{ type: "tool_use", id: "tu_1", name: "read", input: { path: "a" } }], stop_reason: "tool_use" }),
    ]);
    const res = await provider(fetch).chat({ messages: [] });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.message.toolCalls).toEqual([{ id: "tu_1", name: "read", arguments: { path: "a" } }]);
  });

  it("maps max_tokens onto length", async () => {
    const { fetch } = recordingFetch([jsonResponse({ content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" })]);
    await expect(provider(fetch).chat({ messages: [] })).resolves.toMatchObject({ finishReason: "length" });
  });

  it("turns the vendor's 401 shape into a credential refusal", async () => {
    const { fetch } = recordingFetch([
      jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }),
    ]);
    await expect(provider(fetch).chat({ messages: [] })).rejects.toMatchObject({ code: "credential", vendorCode: "authentication_error" });
  });

  it("reports no key as `credential` before a request is made", async () => {
    const p = new AnthropicProvider({ catalog: CATALOG, defaultModel: "claude-x" });
    await expect(p.readiness()).resolves.toMatchObject({ ready: false, reason: "credential" });
    expect(p.id).toBe("byok:anthropic");
    await expect(p.models()).resolves.toEqual(CATALOG);
  });
});

describe("stream", () => {
  it("reads the event sequence into text deltas and an assembled tool call", async () => {
    const { fetch } = recordingFetch([
      sseResponse([
        ev("message_start", { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } }),
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Loo" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "king" } }),
        ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_9", name: "read" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } }),
        ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"a.md"}' } }),
        ev("content_block_stop", { type: "content_block_stop", index: 1 }),
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 24 } }),
        ev("message_stop", { type: "message_stop" }),
      ]),
    ]);
    const chunks = await collect(provider(fetch).stream({ messages: [{ role: "user", content: "read a.md" }] }));
    expect(chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta)).toEqual(["Loo", "king"]);
    expect(chunks.find((c) => c.type === "tool_call")).toEqual({
      type: "tool_call",
      call: { id: "tu_9", name: "read", arguments: { path: "a.md" } },
    });
    const done = chunks.at(-1) as { response: { finishReason: string; usage?: unknown; message: { content: string } } };
    expect(done.response.finishReason).toBe("tool_calls");
    expect(done.response.usage).toEqual({ inputTokens: 11, outputTokens: 24 });
    expect(done.response.message.content).toBe("Looking");
  });

  it("raises the error event as a typed failure", async () => {
    const { fetch } = recordingFetch([
      sseResponse([ev("error", { type: "error", error: { type: "overloaded_error", message: "busy" } })]),
    ]);
    await expect(collect(provider(fetch).stream({ messages: [] }))).rejects.toMatchObject({ code: "server_error" });
  });

  it("propagates an abort raised mid-stream", async () => {
    const controller = new AbortController();
    const { fetch } = recordingFetch([
      sseResponse([
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } }),
      ]),
    ]);
    const iterator = provider(fetch).stream({ messages: [], signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("malformed answers", () => {
  it("says so when the body is not JSON", async () => {
    const { fetch } = recordingFetch([new Response("<html>", { status: 200 })]);
    await expect(provider(fetch).chat({ messages: [] })).rejects.toMatchObject({ code: "server_error" });
  });

  it("skips a frame that is not JSON and one that is not an object", async () => {
    const { fetch } = recordingFetch([
      sseResponse([
        "data: not json\n\n",
        "data: [1,2]\n\n",
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ]),
    ]);
    const out = await collect(provider(fetch).stream({ messages: [] }));
    expect(out.filter((c) => c.type === "text")).toHaveLength(1);
  });
});

// ── Pictures (gap B10) ──────────────────────────────────────────────────────────────────────────

describe("images as content blocks", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const shot: ImagePart = { mime: "image/png", data: png, source: "shot.png" };
  const BLOCK = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoH" } };

  /** A catalogue row that CLAIMS vision: `ModelInfo` says an absent flag means text-only, here too. */
  const SEEING: ModelInfo[] = [{ id: "claude-x", label: "Claude X", class: "strong", local: false, supportsTools: true, vision: true }];
  const seeing = (fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) =>
    new AnthropicProvider({ apiKey: "sk-ant-test", catalog: SEEING, defaultModel: "claude-x", fetch: fetchImpl });

  it("puts the picture before the words of its own turn, as the vendor's examples do", () => {
    const { messages } = toAnthropicMessages([{ role: "user", content: "what is this?", images: [shot] }]);
    expect(messages).toEqual([{ role: "user", content: [BLOCK, { type: "text", text: "what is this?" }] }]);
  });

  it("sends a picture with no words as a lone block", () => {
    const { messages } = toAnthropicMessages([{ role: "user", content: "", images: [shot] }]);
    expect(messages).toEqual([{ role: "user", content: [BLOCK] }]);
  });

  it("keeps a tool result's picture INSIDE the tool_result, which this wire allows", () => {
    const { messages } = toAnthropicMessages([
      { role: "tool", content: "screenshot taken", toolCallId: "tu_1", images: [shot] },
      { role: "tool", content: "and one more", toolCallId: "tu_2" },
    ]);
    // Both results still merge into ONE user turn, exactly as they did before pictures existed.
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: [BLOCK, { type: "text", text: "screenshot taken" }] },
          { type: "tool_result", tool_use_id: "tu_2", content: "and one more" },
        ],
      },
    ]);
  });

  it("posts the blocks, base64 and media type apart, on a real call", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse({ content: [{ type: "text", text: "a cat" }], stop_reason: "end_turn" })]);
    await seeing(fetch).chat({ messages: [{ role: "user", content: "?", images: [shot] }] });
    const body = JSON.parse(String(calls[0]?.init?.body)) as { messages: { content: unknown[] }[] };
    expect(body.messages[0]?.content?.[0]).toEqual(BLOCK);
  });

  it("assumes this vendor can see for a model NO ROW mentions, and obeys a row that does", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    ]);
    // An empty catalogue is what `byokProvider` hands this class by default.
    const blank = new AnthropicProvider({ apiKey: "k", catalog: [], defaultModel: "claude-x", fetch });
    expect(blank.seesImages()).toBe(true);
    await blank.chat({ messages: [{ role: "user", content: "?", images: [shot] }] });
    expect(JSON.parse(String(calls[0]?.init?.body)).messages[0].content[0]).toEqual(BLOCK);

    // The row is the catalogue speaking, and `ModelInfo` says an absent `vision` means text-only.
    const denied = new AnthropicProvider({
      apiKey: "k",
      catalog: [{ id: "claude-text", label: "Text", class: "strong", local: false, supportsTools: true }],
      defaultModel: "claude-text",
      fetch,
    });
    expect(denied.seesImages()).toBe(false);
    await denied.chat({ messages: [{ role: "user", content: "?", images: [shot] }] });
    expect(JSON.parse(String(calls[1]?.init?.body)).messages[0].content).toBe("?\n\n[A picture was attached (shot.png), but this model cannot see pictures.]");
  });

  it("names a picture an assistant turn carried rather than inventing a block for it", () => {
    const { messages } = toAnthropicMessages(
      // What the provider hands the mapper: the drop already happened, with its reason in the text.
      [{ role: "assistant", content: `here\n\n[A picture was attached, but ${NON_USER_IMAGE_REASON}.]` }],
    );
    expect(messages[0]).toEqual({ role: "assistant", content: `here\n\n[A picture was attached, but ${NON_USER_IMAGE_REASON}.]` });
  });

  it("refuses a picture over the cap by name, before anything is posted", async () => {
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fetch, calls } = recordingFetch([jsonResponse({ content: [] })]);
    await expect(seeing(fetch).chat({ messages: [{ role: "user", content: "big", images: [{ mime: "image/png", data: huge }] }] })).rejects.toMatchObject({
      vendorCode: "image_too_large",
      providerId: "byok:anthropic",
    });
    expect(calls).toEqual([]);
  });
});
