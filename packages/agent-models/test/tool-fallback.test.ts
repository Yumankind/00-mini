/**
 * The fallback is a heuristic over what a small model actually writes, so what it is tested against
 * is the set of shapes small models actually write: the one the prompt teaches, the fenced block
 * half of them produce anyway, and the Hermes wrapper the rest imitate. Shared by both local
 * brains (WebLLM's small models and every LiteRT model), which is why it is tested on its own.
 */
import { describe, expect, it } from "vitest";
import { fallbackToolPrompt, parseFallbackToolCalls } from "../src/tool-fallback.js";

// ── The fallback ────────────────────────────────────────────────────────────────────────────────

describe("the prompt-based tool fallback", () => {
  it("teaches exactly one shape, and names the tools", () => {
    const prompt = fallbackToolPrompt([{ name: "read", description: "read a file", parameters: { type: "object" } }]);
    expect(prompt).toContain('{"tool_call": {"name": "<tool name>", "arguments": {<arguments matching the schema>}}}');
    expect(prompt).toContain("- read: read a file");
  });

  it("parses the shape it asked for and removes it from the prose", () => {
    const { text, calls } = parseFallbackToolCalls('Sure.\n{"tool_call": {"name": "read", "arguments": {"path": "AGENTS.md"}}}');
    expect(calls).toEqual([{ id: "call_0", name: "read", arguments: { path: "AGENTS.md" } }]);
    expect(text).toBe("Sure.");
  });

  it("parses a fenced block, which is what half of these models produce anyway", () => {
    const { text, calls } = parseFallbackToolCalls('```json\n{"name": "ls", "arguments": {"path": "."}}\n```');
    expect(calls).toEqual([{ id: "call_0", name: "ls", arguments: { path: "." } }]);
    expect(text).toBe("");
  });

  it("parses the Hermes <tool_call> wrapper", () => {
    const { calls } = parseFallbackToolCalls('<tool_call>{"name": "grep", "arguments": {"pattern": "TODO"}}</tool_call>');
    expect(calls).toEqual([{ id: "call_0", name: "grep", arguments: { pattern: "TODO" } }]);
  });

  it("takes `parameters` and a stringified argument object too", () => {
    expect(parseFallbackToolCalls('{"name":"a","parameters":{"x":1}}').calls[0]?.arguments).toEqual({ x: 1 });
    expect(parseFallbackToolCalls('{"tool_call":{"name":"a","arguments":"{\\"x\\":2}"}}').calls[0]?.arguments).toEqual({ x: 2 });
  });

  it("leaves an ordinary answer alone, braces and all", () => {
    const answer = 'The config is {"a": 1} and that is all.';
    expect(parseFallbackToolCalls(answer)).toEqual({ text: answer, calls: [] });
  });

  it("is not fooled by a brace inside a quoted string", () => {
    const { calls } = parseFallbackToolCalls('{"tool_call":{"name":"write","arguments":{"text":"a } b"}}}');
    expect(calls[0]?.arguments).toEqual({ text: "a } b" });
  });

  it("survives unbalanced and unparseable JSON without throwing", () => {
    expect(parseFallbackToolCalls("{{{").calls).toEqual([]);
    expect(parseFallbackToolCalls("}}}").calls).toEqual([]);
    expect(parseFallbackToolCalls("{not json}").calls).toEqual([]);
  });

  it("finds more than one call and numbers them", () => {
    const { calls } = parseFallbackToolCalls('{"name":"a","arguments":{}}\n{"name":"b","arguments":{}}');
    expect(calls.map((c) => c.id)).toEqual(["call_0", "call_1"]);
  });
});
