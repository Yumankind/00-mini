// The vault reaching tools (gap B12) — and, much more important, never reaching the transcript.
//
// Every test here is really one assertion in two halves: the tool DID get the value, and the
// conversation did NOT.

import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  listSecretsTool,
  redact,
  resolveSecretArgs,
  secretNamesIn,
  type AgentEvent,
  type AgentRuntimeOptionsExt,
  type SecretsAccess,
  type Tool,
  type ToolContext,
} from "../src/index.js";
import { FakeProvider, call } from "./fake-provider.js";
import { MemoryFs } from "./memory-fs.js";

const now = () => new Date("2026-09-10T10:00:00Z");

function vault(items: Record<string, string>, opts: { locked?: boolean } = {}): SecretsAccess {
  return {
    async names() {
      return Object.keys(items).sort();
    },
    async get(name) {
      // A locked vault answers NULL rather than throwing, and answers it for a name it does hold —
      // which is the case the runtime must not be able to tell from "no such name".
      if (opts.locked) return null;
      return items[name] ?? null;
    },
  };
}

/** A tool that reports exactly what it was handed — the only way to see the resolved arguments. */
function echoTool(seen: { args?: Record<string, unknown> }): Tool {
  return {
    tier: "safe",
    schema: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
    async run(args) {
      seen.args = args;
      return { output: `called with ${JSON.stringify(args)}` };
    },
  };
}

describe("the placeholder", () => {
  it("finds every name in strings, arrays and nested objects", () => {
    expect([
      ...secretNamesIn({
        url: "https://x/?k=${secret:A}",
        headers: [{ value: "Bearer ${secret:B}" }],
        n: 3,
        nothing: null,
      }),
    ]).toEqual(["A", "B"]);
    expect(secretNamesIn({ plain: "no placeholders here" }).size).toBe(0);
  });

  it("substitutes on a COPY and leaves the caller's arguments untouched", async () => {
    const args = { url: "https://x/?k=${secret:A}" };
    const resolved = await resolveSecretArgs(args, vault({ A: "sk-live-123" }));
    expect(resolved.args).toEqual({ url: "https://x/?k=sk-live-123" });
    expect(args.url).toBe("https://x/?k=${secret:A}");
    expect(resolved.used.get("A")).toBe("sk-live-123");
  });

  it("costs nothing when nobody is using it", async () => {
    const args = { path: "notes.md" };
    const resolved = await resolveSecretArgs(args, undefined);
    expect(resolved.args).toBe(args); // same object, no walk, no copy
    expect(resolved.error).toBeUndefined();
  });

  it("refuses the call for an unknown name and for a locked vault, with the SAME sentence", async () => {
    const missing = await resolveSecretArgs({ k: "${secret:NOPE}" }, vault({ A: "x" }));
    const locked = await resolveSecretArgs({ k: "${secret:A}" }, vault({ A: "x" }, { locked: true }));
    expect(missing.error).toContain("${secret:NOPE}");
    expect(locked.error).toContain("${secret:A}");
    expect(missing.error?.replace("NOPE", "A")).toBe(locked.error);
    expect(missing.used.size).toBe(0);
  });

  it("says which host has no vault at all", async () => {
    const resolved = await resolveSecretArgs({ k: "${secret:A}" }, undefined);
    expect(resolved.error).toContain("no vault");
  });

  it("puts values back, longest first, so one secret inside another leaves nothing behind", () => {
    const used = new Map([
      ["SHORT", "abc"],
      ["LONG", "abcdef"],
    ]);
    expect(redact("token=abcdef and abc", used)).toBe("token=${secret:LONG} and ${secret:SHORT}");
    expect(redact("nothing here", used)).toBe("nothing here");
    expect(redact("", used)).toBe("");
  });
});

describe("list_secrets", () => {
  const ctx = (secrets?: SecretsAccess): ToolContext => ({
    fs: new MemoryFs(),
    sandbox: "workspace",
    signal: new AbortController().signal,
    emit: () => {},
    ...(secrets ? { secrets } : {}),
  });

  it("gives names and the placeholder to use them with, and never a value", async () => {
    const output = (await listSecretsTool().run({}, ctx(vault({ OPENAI_API_KEY: "sk-secret" })))).output;
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).toContain("${secret:OPENAI_API_KEY}");
    expect(output).not.toContain("sk-secret");
  });

  it("works on a LOCKED vault: a name is not a secret", async () => {
    const output = (await listSecretsTool().run({}, ctx(vault({ A: "x" }, { locked: true })))).output;
    expect(output).toContain("A");
  });

  it("says the honest thing for an empty vault and for a host with none", async () => {
    expect((await listSecretsTool().run({}, ctx(vault({})))).output).toContain("empty");
    expect((await listSecretsTool().run({}, ctx())).output).toContain("no vault");
  });

  it("is safe — asking to see a list of names must not teach anyone to click through vault prompts", () => {
    expect(listSecretsTool().tier).toBe("safe");
  });
});

describe("secrets through the loop", () => {
  function harness(secrets: SecretsAccess | undefined, tools: Tool[], script: Parameters<FakeProvider["say"]>[0]) {
    const fs = new MemoryFs({ "workspace/AGENTS.md": "be brief" });
    const provider = new FakeProvider("local", script);
    const events: AgentEvent[] = [];
    const runtime = createAgentRuntime({
      fs,
      providers: [provider],
      tools,
      trust: "full",
      now,
      ...(secrets ? { secrets } : {}),
      async askPermission() {
        return { allowed: true };
      },
    } as AgentRuntimeOptionsExt);
    runtime.on((e) => events.push(e));
    return { runtime, events, provider };
  }

  it("resolves at use: the tool sees the value, the events and the model see the placeholder", async () => {
    const seen: { args?: Record<string, unknown> } = {};
    const h = harness(vault({ STRIPE_KEY: "sk-live-42" }), [echoTool(seen)], [
      { toolCalls: [call("echo", { token: "Bearer ${secret:STRIPE_KEY}" })] },
      { text: "done" },
    ]);
    await h.runtime.run({ prompt: "call it" });

    expect(seen.args).toEqual({ token: "Bearer sk-live-42" });
    const started = h.events.find((e) => e.type === "tool_started") as { args: Record<string, unknown> };
    expect(started.args).toEqual({ token: "Bearer ${secret:STRIPE_KEY}" });
    // And the echoed value is put BACK before the model ever sees the observation.
    const observed = h.provider.requests[1].messages.at(-1)!.content;
    expect(observed).toContain("${secret:STRIPE_KEY}");
    expect(observed).not.toContain("sk-live-42");
  });

  it("keeps the value out of a THROWN error too", async () => {
    const thrower: Tool = {
      tier: "safe",
      schema: { name: "thrower", description: "throws", parameters: { type: "object", properties: {} } },
      async run(args) {
        throw new Error(`bad request: ${String(args.token)}`);
      },
    };
    const h = harness(vault({ K: "sk-live-99" }), [thrower], [
      { toolCalls: [call("thrower", { token: "${secret:K}" })] },
      { text: "it failed" },
    ]);
    await h.runtime.run({ prompt: "go" });
    const observed = h.provider.requests[1].messages.at(-1)!.content;
    expect(observed).not.toContain("sk-live-99");
    expect(observed).toContain("${secret:K}");
  });

  it("refuses the call, and does not run the tool, when the name is not in the vault", async () => {
    const seen: { args?: Record<string, unknown> } = {};
    const h = harness(vault({}), [echoTool(seen)], [
      { toolCalls: [call("echo", { token: "${secret:GHOST}" })] },
      { text: "I could not" },
    ]);
    await h.runtime.run({ prompt: "go" });
    expect(seen.args).toBeUndefined();
    expect(h.events.some((e) => e.type === "tool_failed")).toBe(true);
    expect(h.provider.requests[1].messages.at(-1)!.content).toContain("${secret:GHOST}");
  });

  it("hands the vault to the tool's own context, so `list_secrets` can read it", async () => {
    const h = harness(vault({ A: "x" }), [listSecretsTool()], [
      { toolCalls: [call("list_secrets", {})] },
      { text: "you have one" },
    ]);
    await h.runtime.run({ prompt: "what keys do I have?" });
    expect(h.provider.requests[1].messages.at(-1)!.content).toContain("${secret:A}");
  });
});
