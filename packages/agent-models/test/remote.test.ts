/**
 * The brain that thinks on the person's own Mac (docs/HANDOFF-infinite-agent.md §8.4).
 *
 * What is worth pinning here is not "does it call the transport" but the two rules that make a far
 * AGENT usable as a brain at all: WHAT ONE SENTENCE IS SENT to something that already remembers the
 * conversation, and WHAT A REFUSAL MEANS to a router that has to decide whether to walk on. Both are
 * asserted against a transport that is an array, because neither has anything to do with a relay.
 */
import { describe, expect, it } from "vitest";
import {
  ProviderError,
  RemoteBrainProvider,
  REMOTE_MODEL_ID,
  TOOL_RESULT_HEADER,
  isRemoteBusy,
  remoteErrorCode,
  renderRemotePrompt,
  type ChatMessage,
  type RemoteEvent,
  type RemotePromptOptions,
  type RemoteStatus,
  type RemoteTransport,
} from "../src/index.js";

interface Recorded {
  text: string;
  opts: RemotePromptOptions;
}

/** A transport that answers from a script and records what it was asked. */
function fakeTransport(
  script: RemoteEvent[][] | ((text: string) => RemoteEvent[]),
  over: Partial<{ status: RemoteStatus | (() => Promise<RemoteStatus>); sessions: { id: string; title: string }[] }> = {},
): RemoteTransport & { sent: Recorded[] } {
  const sent: Recorded[] = [];
  let turn = 0;
  return {
    sent,
    async *prompt(text, opts) {
      sent.push({ text, opts });
      const events = typeof script === "function" ? script(text) : (script[turn++] ?? []);
      for (const event of events) yield event;
    },
    async sessions() {
      return over.sessions ?? [{ id: "s1", title: "One" }];
    },
    async status() {
      const s = over.status ?? "connected";
      return typeof s === "function" ? s() : s;
    },
  };
}

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const tool = (name: string, content: string): ChatMessage => ({ role: "tool", content, name, toolCallId: "c1" });
const done = (text: string, sessionId?: string): RemoteEvent => ({ type: "done", text, ...(sessionId ? { sessionId } : {}) });

describe("one sentence for an agent that already remembers", () => {
  it("sends the latest user turn and not one word of the history", () => {
    const text = renderRemotePrompt([
      { role: "system", content: "you are a browser agent with a NoShell" },
      user("what is in the folder?"),
      assistant("three files"),
      user("open the second one"),
    ]);
    expect(text).toBe("open the second one");
    // The far agent has its own system prompt, written by its own operator, about its own machine.
    expect(text).not.toContain("NoShell");
    expect(text).not.toContain("three files");
  });

  it("carries the tool results it has not seen, and does NOT re-ask the question with them", () => {
    const text = renderRemotePrompt([
      user("what changed?"),
      assistant("let me look"),
      tool("read_file", "line one"),
      tool("list_dir", "a.txt b.txt"),
    ]);
    expect(text).toContain(TOOL_RESULT_HEADER);
    expect(text).toContain("- read_file: line one");
    expect(text).toContain("- list_dir: a.txt b.txt");
    // Re-sending "what changed?" is how a loop starts talking to itself: the far agent asked for
    // nothing, and it has its own copy of the question already.
    expect(text).not.toContain("what changed?");
  });

  it("puts a new question after the results when there is both", () => {
    const text = renderRemotePrompt([assistant("looking"), tool("grep", "two hits"), user("and now?")]);
    expect(text.indexOf("two hits")).toBeLessThan(text.indexOf("and now?"));
  });

  it("describes a picture rather than pretending it travelled", () => {
    const text = renderRemotePrompt([
      { role: "user", content: "what is this?", images: [{ mime: "image/png", data: "AAA", source: "screenshot" }] },
    ]);
    expect(text).toContain("what is this?");
    expect(text).toMatch(/text-only wire/);
  });

  it("answers nothing at all for a transcript with nothing to ask", () => {
    expect(renderRemotePrompt([{ role: "system", content: "hello" }])).toBe("");
  });
});

describe("one turn", () => {
  it("asks the far agent and dresses the answer as a ChatResponse", async () => {
    const transport = fakeTransport([[done("the folder has three files")]]);
    const brain = RemoteBrainProvider({ id: "remote-mac", label: "Claude Code", transport });

    const answer = await brain.chat({ messages: [user("what is in the folder?")] });

    expect(transport.sent[0].text).toBe("what is in the folder?");
    expect(answer.message).toEqual({ role: "assistant", content: "the folder has three files" });
    expect(answer.finishReason).toBe("stop");
    // B20's line under the answer: where the thinking happened, and whose tools ran.
    expect(answer.footer).toBe("Answered by Claude Code on your Mac, with its own brain and its own tools.");
  });

  it("streams the deltas a transport can give, and closes on what they built", async () => {
    const transport = fakeTransport([
      [{ type: "text", delta: "one " }, { type: "text", delta: "" }, { type: "text", delta: "two" }, done("IGNORED")],
    ]);
    const brain = RemoteBrainProvider({ transport });

    const chunks = [];
    for await (const chunk of brain.stream({ messages: [user("count") ] })) chunks.push(chunk);

    expect(chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta)).toEqual(["one ", "two"]);
    const last = chunks.at(-1);
    // The deltas win over the closing text — the same assembly rule the runtime's loop keeps.
    expect(last).toMatchObject({ type: "done", response: { message: { content: "one two" } } });
  });

  it("follows the far session the Mac names, so turn two lands where turn one did", async () => {
    const transport = fakeTransport([[done("hello", "1757_abc")], [done("again")]]);
    const brain = RemoteBrainProvider({ transport });

    await brain.chat({ messages: [user("hi")] });
    expect(brain.targetSession()).toBe("1757_abc");
    await brain.chat({ messages: [user("more")] });
    expect(transport.sent[1].opts.sessionId).toBe("1757_abc");
  });

  it("starts in the session the person picked, when they picked one", async () => {
    const transport = fakeTransport([[done("ok")]]);
    const brain = RemoteBrainProvider({ transport, sessionId: "chosen" });
    await brain.chat({ messages: [user("hi")] });
    expect(transport.sent[0].opts.sessionId).toBe("chosen");
  });
});

describe("what a refusal means", () => {
  it("says busy in the one code the router RETRIES rather than switches on", async () => {
    const brain = RemoteBrainProvider({ label: "Codex", transport: fakeTransport([[{ type: "busy" }]]) });
    const err = await brain.chat({ messages: [user("hi")] }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("rate_limited");
    expect((err as ProviderError).vendorCode).toBe("busy");
    expect(isRemoteBusy(err)).toBe(true);
    expect((err as ProviderError).message).toMatch(/Codex is in the middle of another turn/);
  });

  it("turns a relay refusal into `credential`, the code that lets the local brain take over", async () => {
    const brain = RemoteBrainProvider({
      transport: fakeTransport([[{ type: "error", code: "session_ended", message: "That session has ended." }]]),
    });
    const err = (await brain.chat({ messages: [user("hi")] }).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("credential");
    expect(err.vendorCode).toBe("session_ended");
    expect(err.message).toBe("That session has ended.");
  });

  it("keeps a Mac that is simply not there as `network`, which no brain switch would fix", () => {
    expect(remoteErrorCode("engine_not_connected")).toBe("network");
    expect(remoteErrorCode("result_timeout")).toBe("network");
    expect(remoteErrorCode("payload_too_large")).toBe("bad_request");
    expect(remoteErrorCode("aborted")).toBe("aborted");
    expect(remoteErrorCode("device_unknown")).toBe("credential");
    expect(isRemoteBusy(new Error("busy"))).toBe(false);
  });

  it("refuses before it sends when the person pressed stop, or when there is nothing to ask", async () => {
    const transport = fakeTransport([[done("never")]]);
    const brain = RemoteBrainProvider({ transport });
    const controller = new AbortController();
    controller.abort();
    await expect(brain.chat({ messages: [user("hi")], signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    await expect(brain.chat({ messages: [] })).rejects.toMatchObject({ code: "bad_request" });
    expect(transport.sent).toHaveLength(0);
  });

  it("calls a transport that stops mid-turn a server error, not an empty answer", async () => {
    const brain = RemoteBrainProvider({ transport: fakeTransport([[]]) });
    await expect(brain.chat({ messages: [user("hi")] })).rejects.toMatchObject({ code: "server_error" });
  });

  it("wraps a transport that throws, and keeps an abort an abort", async () => {
    const boom: RemoteTransport = {
      // eslint-disable-next-line require-yield
      async *prompt() {
        throw new Error("socket died");
      },
      async sessions() {
        return [];
      },
      async status() {
        return "connected";
      },
    };
    await expect(RemoteBrainProvider({ transport: boom }).chat({ messages: [user("hi")] })).rejects.toMatchObject({
      code: "network",
    });

    const stopped: RemoteTransport = {
      async *prompt() {
        const err = new Error("stopped");
        err.name = "AbortError";
        throw err;
      },
      async sessions() {
        return [];
      },
      async status() {
        return "connected";
      },
    };
    await expect(RemoteBrainProvider({ transport: stopped }).chat({ messages: [user("hi")] })).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

describe("what it says about itself", () => {
  it("offers one row, strong, not local, and NOT a tool caller", async () => {
    const brain = RemoteBrainProvider({ label: "Claude Code", transport: fakeTransport([]) });
    expect(await brain.models()).toEqual([
      { id: REMOTE_MODEL_ID, label: "Claude Code on your Mac", class: "strong", local: false, supportsTools: false },
    ]);
  });

  it("falls back to a name that is true when the Mac has not told us one", async () => {
    const brain = RemoteBrainProvider({ transport: fakeTransport([]) });
    expect((await brain.models())[0].label).toBe("Your Mac's agent on your Mac");
  });

  it("is ready when the Mac answers, offline when it does not, and asks to be connected when it is not", async () => {
    expect(await RemoteBrainProvider({ transport: fakeTransport([], { status: "connected" }) }).readiness()).toEqual({
      ready: true,
    });
    expect(await RemoteBrainProvider({ transport: fakeTransport([], { status: "waiting" }) }).readiness()).toMatchObject({
      ready: false,
      reason: "offline",
    });
    expect(await RemoteBrainProvider({ transport: fakeTransport([], { status: "off" }) }).readiness()).toMatchObject({
      ready: false,
      reason: "credential",
    });
    const throws = fakeTransport([], {
      status: () => Promise.reject(new Error("relay down")),
    });
    expect(await RemoteBrainProvider({ transport: throws }).readiness()).toMatchObject({ ready: false, reason: "offline" });
  });

  it("hands the far agent's session list straight through, for a picker", async () => {
    const brain = RemoteBrainProvider({ transport: fakeTransport([], { sessions: [{ id: "a", title: "Ledger" }] }) });
    expect(await brain.sessions()).toEqual([{ id: "a", title: "Ledger" }]);
  });
});
