/**
 * The fallback is a heuristic over what a small model actually writes, so what it is tested against
 * is the set of shapes small models actually write: the one the prompt teaches, the fenced block
 * half of them produce anyway, and the Hermes wrapper the rest imitate. Shared by both local
 * brains (WebLLM's small models and every LiteRT model), which is why it is tested on its own.
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_DESC_MAX, fallbackToolPrompt, parseFallbackToolCalls, toolSignature } from "../src/tool-fallback.js";
import type { ToolSchema } from "../src/types.js";

// ── The fallback ────────────────────────────────────────────────────────────────────────────────

describe("the prompt-based tool fallback", () => {
  it("teaches exactly one shape, and names the tools", () => {
    const prompt = fallbackToolPrompt([{ name: "read", description: "read a file", parameters: { type: "object" } }]);
    expect(prompt).toContain('{"tool_call": {"name": "<name>", "arguments": {<args>}}}');
    expect(prompt).toContain("read() — read a file");
  });
});

// ── The compact signatures (2026-09-11) ─────────────────────────────────────────────────────────

/** A tool set shaped like the runtime's own: the schemas whose raw dump caused the regression. */
const SET: ToolSchema[] = [
  {
    name: "read",
    description: "Read a file's contents. Images are attached for you to look at, and output is truncated.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description: "Edit a file by exact text replacement.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" } } } },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "grep",
    description: "Search file contents for a pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  { name: "list_secrets", description: "List the NAMES of your operator's vault secrets.", parameters: { type: "object", properties: {} } },
];

describe("compact tool signatures", () => {
  it("writes one line per tool: name, argument names and types, optionality, one clause", () => {
    expect(toolSignature(SET[0])).toBe("read(path: string, offset?: number, limit?: number) — Read a file's contents.");
    expect(toolSignature(SET[3])).toBe("list_secrets() — List the NAMES of your operator's vault secrets.");
  });

  it("names an array by what it holds, and stops naming arguments after the fourth", () => {
    expect(toolSignature(SET[1])).toContain("edits: object[]");
    // grep has six; the line ends in `…` rather than growing.
    expect(toolSignature(SET[2])).toBe("grep(pattern: string, path?: string, glob?: string, ignoreCase?: boolean, …) — Search file contents for a pattern.");
  });

  it("keeps the first sentence only, and caps even that", () => {
    const long = { name: "x", description: `${"a".repeat(200)}. And a second sentence.`, parameters: {} };
    const line = toolSignature(long);
    expect(line).toContain("…");
    expect(line.length).toBeLessThanOrEqual(`x() — `.length + FALLBACK_DESC_MAX);
    // A description with no full stop at all is still capped rather than dumped whole.
    expect(toolSignature({ name: "y", description: "b".repeat(200), parameters: {} }).length).toBeLessThanOrEqual(`y() — `.length + FALLBACK_DESC_MAX);
  });

  it("survives a schema that is not one: no properties, no types, an enum, a union", () => {
    expect(toolSignature({ name: "n", description: "", parameters: {} })).toBe("n()");
    expect(toolSignature({ name: "n", description: "", parameters: "nonsense" as unknown as Record<string, unknown> })).toBe("n()");
    const odd: ToolSchema = {
      name: "odd",
      description: "",
      parameters: {
        type: "object",
        properties: { a: { enum: ["x", "y"] }, b: { type: ["string", "null"] }, c: {}, d: { type: "array" } },
        required: ["a", 7],
      },
    };
    expect(toolSignature(odd)).toBe("odd(a: enum, b?: string|null, c?: any, d?: array)");
  });

  it("is DRASTICALLY smaller than the schema dump it replaced — the whole point", () => {
    const compact = fallbackToolPrompt(SET);
    const dumped = fallbackToolPrompt(SET, { schemas: true });
    expect(compact.length).toBeLessThan(dumped.length / 2);
    // The dump is still exactly what it always was, for a model with the context to spend on it.
    expect(dumped).toContain('arguments schema: {"type":"object"');
  });
});

describe("parsing what the model writes back", () => {
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
