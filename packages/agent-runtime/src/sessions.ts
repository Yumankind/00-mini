/**
 * `sessions/<ts>_<uuid>.jsonl` — the engine's session store, written by a browser.
 *
 * WHY IT IS COPIED RATHER THAN INVENTED: an agent moves between hosts as one encrypted file and its
 * `sessions/` folder travels in the `record` class (docs/agent-layout.md). If the browser wrote a
 * shape of its own, a full move to the Mac would arrive with a history the Mac cannot open — the
 * agent would keep its memory and lose its conversations, which is exactly the "stranger wearing the
 * agent's name" the bundle policy exists to prevent.
 *
 * So the format is pi's `SessionManager` (@earendil-works/pi-coding-agent 0.84.2,
 * `dist/core/session-manager.js`), read off the implementation rather than a doc:
 *   · filename `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`
 *   · line 1 is the header `{ type: "session", version: 3, id, timestamp, cwd }`
 *   · every later line is an entry `{ type, id, parentId, timestamp, … }` — `id`/`parentId` make the
 *     file a TREE, not a list, which is how pi does branching. This writer only ever appends to the
 *     current leaf, so the tree it writes is a straight line; a reader that understands branches
 *     reads it correctly, and one that does not still gets the conversation in order.
 *   · a message entry carries pi's own message shape: `user` with `content: [{type:"text"}]`,
 *     `assistant` with `content: [text…, {type:"toolCall", id, name, arguments}]`, and a tool result
 *     as `role: "toolResult"` with `toolCallId`/`toolName`/`isError`.
 *
 * THE KNOWN GAPS, stated rather than hidden. pi's assistant messages also carry `api`, `provider`,
 * `model`, `usage` and `stopReason`; this writer fills what the neutral `ChatResponse` knows
 * (provider id, model, usage as far as it goes) and writes plausible defaults for the rest, because
 * `@00/agent-models` deliberately does not expose a provider's wire format. pi's `usage` has
 * cache-read/cache-write/cost fields no browser provider reports; they are written as zeroes. And pi
 * mints session ids with uuidv7 — so does this (see `uuidv7`), because the id is in the FILENAME and
 * a v4 would make `sessions/` sort randomly.
 */
import type { ChatMessage, ToolCall, Usage } from "@00/agent-models";
import type { AgentFs } from "@00/agent-fs";

export const SESSIONS_DIR = "sessions";
export const SESSION_VERSION = 3;

/** pi's own `assertValidSessionId`, so a file this writes is a file pi will open. */
export function assertValidSessionId(id: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw new Error(
      "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
    );
  }
}

/**
 * UUID v7 — time-ordered, so `sessions/` lists newest-last with a plain string sort even if the
 * timestamp prefix were ever dropped. pi uses v7 for the same reason; `crypto.randomUUID()` is v4.
 */
export function uuidv7(now: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * pi's short entry id: 8 RANDOM hex chars, collision-checked against the ids already in the file
 * (`generateId` in its session-manager). Random, not the head of a uuidv7 — that head is the
 * TIMESTAMP, so two entries written in the same millisecond would share an id and the parent chain
 * would fold back on itself.
 */
function entryId(used: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const bytes = randomBytes(4);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!used.has(id)) return id;
  }
  return uuidv7(); // 100 collisions on 4 random bytes means something is very wrong; a full uuid still works
}

// ── the file shapes (pi's, narrowed to what this writer emits) ───────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

interface TextContent {
  type: "text";
  text: string;
}
interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiUserMessage {
  role: "user";
  content: TextContent[];
  timestamp: number;
}
interface PiAssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
  timestamp: number;
}
interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
  timestamp: number;
}
type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: PiMessage;
}

export type SessionFileEntry = SessionHeader | SessionMessageEntry;

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

function piUsage(usage?: Usage): PiUsage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  // Money in the neutral shape is CENTS; pi's `cost` is in whole units, hence /100. A provider that
  // reports no cost writes zeroes, which is what a local model actually costs.
  const total = (usage?.costCents ?? 0) / 100;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

export interface AppendAssistantOptions {
  providerId: string;
  model?: string;
  usage?: Usage;
  stopReason?: PiAssistantMessage["stopReason"];
}

export interface SessionManagerOptions {
  dir?: string;
  /** Stamped into the header, the way pi stamps the process cwd. Ours is the sandbox. */
  cwd?: string;
  now?: () => Date;
  newId?: () => string;
}

/**
 * One live session: opens or resumes a file, appends entries, and reads the folder back.
 *
 * `flush`-on-first-assistant (pi's `_persist`) is NOT copied: pi delays the write so an abandoned
 * prompt leaves no file, at the cost of losing everything if the process dies mid-turn. A browser
 * tab dies far more often than a daemon, so this writes every entry as it happens — an empty session
 * file is cheap and a lost conversation is not.
 */
export class SessionManager {
  private readonly dir: string;
  private readonly cwd: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private file?: string;
  private id?: string;
  private leafId: string | null = null;
  private readonly usedIds = new Set<string>();

  constructor(
    private readonly fs: AgentFs,
    opts: SessionManagerOptions = {},
  ) {
    this.dir = opts.dir ?? SESSIONS_DIR;
    this.cwd = opts.cwd ?? "workspace";
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => uuidv7());
  }

  get sessionId(): string | undefined {
    return this.id;
  }
  get sessionFile(): string | undefined {
    return this.file;
  }

  /** Start a new session file, or resume `id` if a file for it exists. Returns the session id. */
  async open(id?: string): Promise<string> {
    if (id) {
      assertValidSessionId(id);
      const existing = await this.findFile(id);
      if (existing) {
        this.id = id;
        this.file = existing;
        const entries = await this.readEntries(existing);
        const messages = entries.filter((e): e is SessionMessageEntry => e.type === "message");
        this.usedIds.clear();
        for (const entry of messages) this.usedIds.add(entry.id);
        this.leafId = messages.at(-1)?.id ?? null;
        return id;
      }
    }
    const sessionId = id ?? this.newId();
    assertValidSessionId(sessionId);
    const timestamp = this.now().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: this.cwd,
    };
    this.id = sessionId;
    this.leafId = null;
    this.usedIds.clear();
    this.file = `${this.dir}/${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
    await this.fs.mkdir(this.dir);
    await this.fs.writeFile(this.file, `${JSON.stringify(header)}\n`);
    return sessionId;
  }

  private async append(message: PiMessage): Promise<void> {
    if (!this.file) throw new Error("no session open");
    const id = entryId(this.usedIds);
    this.usedIds.add(id);
    const entry: SessionMessageEntry = {
      type: "message",
      id,
      parentId: this.leafId,
      timestamp: this.now().toISOString(),
      message,
    };
    this.leafId = entry.id;
    // Append by read-modify-write: `AgentFs` has no append, and a session file is small enough that
    // the honest simple thing beats a second write path (an OPFS `createWritable` in append mode is
    // the adapter's business, not the runtime's).
    const current = await this.fs.readText(this.file);
    await this.fs.writeFile(this.file, `${current}${JSON.stringify(entry)}\n`);
  }

  async appendUser(text: string): Promise<void> {
    await this.append({ role: "user", content: [{ type: "text", text }], timestamp: this.now().getTime() });
  }

  async appendAssistant(text: string, toolCalls: ToolCall[], opts: AppendAssistantOptions): Promise<void> {
    const content: (TextContent | ToolCallContent)[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of toolCalls) {
      content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
    }
    await this.append({
      role: "assistant",
      content,
      // `api` is pi's provider-protocol tag. The neutral ModelProvider does not expose one, and
      // saying "openai-completions" when a WebLLM answered would be a lie in a file another host
      // reads — so it says what is true: the runtime that wrote it.
      api: "00-agent-runtime",
      provider: opts.providerId,
      model: opts.model ?? "",
      usage: piUsage(opts.usage),
      stopReason: opts.stopReason ?? (toolCalls.length ? "toolUse" : "stop"),
      timestamp: this.now().getTime(),
    });
  }

  async appendToolResult(call: { id: string; name: string }, output: string, isError = false): Promise<void> {
    await this.append({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: output }],
      isError,
      timestamp: this.now().getTime(),
    });
  }

  /** The neutral transcript for the model: pi's entries mapped back onto `ChatMessage[]`. */
  async load(id: string): Promise<ChatMessage[]> {
    const file = await this.findFile(id);
    if (!file) return [];
    return entriesToMessages(await this.readEntries(file));
  }

  /** Newest first. `title` is the first user line, which is what a person recognises a session by. */
  async list(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = (await this.fs.readdir(this.dir)).filter((e) => e.kind === "file" && e.name.endsWith(".jsonl")).map((e) => e.name);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of files) {
      const entries = await this.readEntries(`${this.dir}/${name}`);
      const header = entries.find((e): e is SessionHeader => e.type === "session");
      if (!header) continue;
      const messages = entries.filter((e): e is SessionMessageEntry => e.type === "message");
      const firstUser = messages.find((e) => e.message.role === "user");
      const title = firstUser
        ? (firstUser.message.content as TextContent[])[0]?.text.split("\n")[0]?.trim() || "(empty)"
        : "(no messages)";
      const lastTimestamp = messages.at(-1)?.timestamp ?? header.timestamp;
      out.push({ id: header.id, title, updatedAt: Date.parse(lastTimestamp) });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async findFile(id: string): Promise<string | undefined> {
    try {
      const match = (await this.fs.readdir(this.dir)).find(
        (e) => e.kind === "file" && e.name.endsWith(`_${id}.jsonl`),
      );
      return match ? `${this.dir}/${match.name}` : undefined;
    } catch {
      return undefined;
    }
  }

  private async readEntries(file: string): Promise<SessionFileEntry[]> {
    let raw: string;
    try {
      raw = await this.fs.readText(file);
    } catch {
      return [];
    }
    return parseSessionEntries(raw);
  }
}

/** Tolerant line reader: a half-written last line (a tab closed mid-write) loses that entry, not the file. */
export function parseSessionEntries(raw: string): SessionFileEntry[] {
  const out: SessionFileEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as SessionFileEntry);
    } catch {
      /* torn line — skip it */
    }
  }
  return out;
}

/** pi entries → the neutral `ChatMessage[]` the ModelProvider contract speaks. */
export function entriesToMessages(entries: SessionFileEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content.map((c) => c.text).join("") });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
      const toolCalls = message.content
        .filter((c): c is ToolCallContent => c.type === "toolCall")
        .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
      out.push({ role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) });
      continue;
    }
    out.push({
      role: "tool",
      content: message.content.map((c) => c.text).join(""),
      toolCallId: message.toolCallId,
      name: message.toolName,
    });
  }
  return out;
}
