import { describe, expect, it } from "vitest";
import {
  SESSIONS_DIR,
  SESSION_VERSION,
  SessionManager,
  assertValidSessionId,
  entriesToMessages,
  parseSessionEntries,
  uuidv7,
} from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

function clockFrom(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date((t += 1000)) };
}

describe("session files", () => {
  it("writes `<ts>_<uuid>.jsonl` with pi's header on line one", async () => {
    const fs = new MemoryFs();
    const sessions = new SessionManager(fs, { newId: () => "0192f0aa-1111-7222-8333-444455556666", now: () => new Date("2026-09-10T12:34:56.789Z") });
    const id = await sessions.open();

    expect(id).toBe("0192f0aa-1111-7222-8333-444455556666");
    expect(sessions.sessionFile).toBe(`${SESSIONS_DIR}/2026-09-10T12-34-56-789Z_${id}.jsonl`);
    const [header] = parseSessionEntries(fs.readSync(sessions.sessionFile!)!);
    expect(header).toEqual({
      type: "session",
      version: SESSION_VERSION,
      id,
      timestamp: "2026-09-10T12:34:56.789Z",
      cwd: "workspace",
    });
  });

  it("writes user, assistant-with-tool-call and toolResult entries in pi's message shape", async () => {
    const fs = new MemoryFs();
    const sessions = new SessionManager(fs, { now: clockFrom("2026-09-10T00:00:00Z").now });
    await sessions.open();
    await sessions.appendUser("count the files");
    await sessions.appendAssistant("on it", [{ id: "c1", name: "ls", arguments: { path: "." } }], {
      providerId: "local",
      model: "qwen-1.5b",
      usage: { inputTokens: 10, outputTokens: 4, costCents: 250 },
    });
    await sessions.appendToolResult({ id: "c1", name: "ls" }, "a.md\nb.md");
    await sessions.appendAssistant("two files", [], { providerId: "local", model: "qwen-1.5b" });

    const entries = parseSessionEntries(fs.readSync(sessions.sessionFile!)!);
    expect(entries.map((e) => e.type)).toEqual(["session", "message", "message", "message", "message"]);
    const [, user, assistant, tool] = entries as [unknown, any, any, any];

    expect(user.message).toMatchObject({ role: "user", content: [{ type: "text", text: "count the files" }] });
    expect(assistant.message).toMatchObject({
      role: "assistant",
      provider: "local",
      model: "qwen-1.5b",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "on it" },
        { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
      ],
    });
    // Cents in the neutral shape, whole units in pi's.
    expect(assistant.message.usage).toMatchObject({ input: 10, output: 4, totalTokens: 14, cost: { total: 2.5 } });
    expect(tool.message).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ls",
      isError: false,
      content: [{ type: "text", text: "a.md\nb.md" }],
    });
  });

  it("chains entries as a tree: each parentId is the previous entry's id", async () => {
    const fs = new MemoryFs();
    const sessions = new SessionManager(fs);
    await sessions.open();
    await sessions.appendUser("one");
    await sessions.appendAssistant("two", [], { providerId: "p" });
    const entries = parseSessionEntries(fs.readSync(sessions.sessionFile!)!).filter((e) => e.type === "message") as any[];
    expect(entries[0].parentId).toBeNull();
    expect(entries[1].parentId).toBe(entries[0].id);
    expect(entries[0].id).not.toBe(entries[1].id);
  });
});

describe("loading and resuming", () => {
  it("loadSession maps the file back onto ChatMessage[]", async () => {
    const fs = new MemoryFs();
    const sessions = new SessionManager(fs);
    const id = await sessions.open();
    await sessions.appendUser("hi");
    await sessions.appendAssistant("using a tool", [{ id: "c1", name: "read", arguments: { path: "a" } }], { providerId: "p" });
    await sessions.appendToolResult({ id: "c1", name: "read" }, "contents", true);
    await sessions.appendAssistant("done", [], { providerId: "p" });

    expect(await sessions.load(id)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "using a tool", toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }] },
      { role: "tool", content: "contents", toolCallId: "c1", name: "read" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("resuming by id appends to the SAME file", async () => {
    const fs = new MemoryFs();
    const first = new SessionManager(fs);
    const id = await first.open();
    await first.appendUser("first turn");
    const file = first.sessionFile!;

    const second = new SessionManager(fs);
    expect(await second.open(id)).toBe(id);
    expect(second.sessionFile).toBe(file);
    await second.appendUser("second turn");

    expect(fs.paths().filter((p) => p.endsWith(".jsonl"))).toEqual([file]);
    expect((await second.load(id)).map((m) => m.content)).toEqual(["first turn", "second turn"]);
  });

  it("opening an id with no file on disk starts a new session under that id", async () => {
    const fs = new MemoryFs();
    const sessions = new SessionManager(fs);
    expect(await sessions.open("brought-from-elsewhere")).toBe("brought-from-elsewhere");
    expect(sessions.sessionFile).toContain("_brought-from-elsewhere.jsonl");
  });

  it("loading an unknown id is empty, not an error", async () => {
    expect(await new SessionManager(new MemoryFs()).load("nope")).toEqual([]);
  });

  it("skips a torn last line rather than losing the file", () => {
    const entries = parseSessionEntries('{"type":"session","id":"a","version":3,"timestamp":"t","cwd":"w"}\n{"type":"mess');
    expect(entries).toHaveLength(1);
  });
});

describe("listSessions", () => {
  it("titles a session by its first user line and orders by last activity", async () => {
    const fs = new MemoryFs();
    const older = new SessionManager(fs, { now: clockFrom("2026-09-01T00:00:00Z").now });
    await older.open();
    await older.appendUser("the older question\nwith a second line");

    const newer = new SessionManager(fs, { now: clockFrom("2026-09-09T00:00:00Z").now });
    await newer.open();
    await newer.appendUser("the newer question");
    await newer.appendAssistant("answered", [], { providerId: "p" });

    const list = await new SessionManager(fs).list();
    expect(list.map((s) => s.title)).toEqual(["the newer question", "the older question"]);
    expect(list[0].updatedAt).toBeGreaterThan(list[1].updatedAt);
  });

  it("copes with a session that has no messages yet, and with no sessions folder at all", async () => {
    const fs = new MemoryFs();
    const sessions = new SessionManager(fs);
    expect(await sessions.list()).toEqual([]);
    await sessions.open();
    expect(await sessions.list()).toEqual([{ id: sessions.sessionId, title: "(no messages)", updatedAt: expect.any(Number) }]);
  });

  it("ignores a file that is not a session", async () => {
    const fs = new MemoryFs({ [`${SESSIONS_DIR}/junk.jsonl`]: '{"type":"message","id":"x","parentId":null,"timestamp":"t"}\n' });
    expect(await new SessionManager(fs).list()).toEqual([]);
  });
});

describe("ids", () => {
  it("mints time-ordered uuidv7s, so the folder sorts by age", () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early < late).toBe(true);
    expect(early[14]).toBe("7"); // version nibble
    expect("89ab").toContain(early[19]); // variant nibble
  });

  it("keeps pi's session-id rule, so a file this writes is one pi will open", () => {
    expect(() => assertValidSessionId(uuidv7())).not.toThrow();
    for (const bad of ["", "-leading", "trailing-", "has space", "has/slash"]) {
      expect(() => assertValidSessionId(bad), bad).toThrow();
    }
  });

  it("refuses to open a session under an id pi would reject", async () => {
    await expect(new SessionManager(new MemoryFs()).open("../escape")).rejects.toThrow(/Session id must be/);
  });
});

describe("entriesToMessages", () => {
  it("ignores the header and anything it does not understand", () => {
    expect(
      entriesToMessages([
        { type: "session", version: 3, id: "a", timestamp: "t", cwd: "w" },
        { type: "message", id: "1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } },
      ]),
    ).toEqual([{ role: "user", content: "hi" }]);
  });
});
