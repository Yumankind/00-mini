/**
 * A scripted `ModelProvider`: hand it the turns you want, get them back in order.
 *
 * The loop is the thing under test, so the model has to be a fixture rather than a model. Each entry
 * in the script is one assistant turn — text, tool calls, or both — and the provider records the
 * messages it was asked with, which is how the context and the transcript are asserted on.
 */
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ModelClass,
  ModelInfo,
  ModelProvider,
  ToolCall,
  Usage,
} from "@00/agent-models";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  footer?: string;
  /** Throw instead of answering — the "model failed" path. */
  throws?: string;
  /** Await this before answering, so a test can abort mid-flight. */
  delay?: Promise<void>;
}

export class FakeProvider implements ModelProvider {
  readonly requests: ChatRequest[] = [];
  /** How often the catalogue was read — the class-aware picker is supposed to ask once per run. */
  modelsCalls = 0;
  private index = 0;

  constructor(
    readonly id: string,
    private script: ScriptedTurn[] = [],
    private readonly opts: {
      ready?: boolean;
      reason?: "download" | "credential" | "offline" | "unsupported";
      /** What class its catalogue offers; `strong` is the default a cloud brain has. */
      classes?: ModelClass[];
      /** An empty catalogue, the shape a BYOK provider built without one has. */
      emptyCatalog?: boolean;
      modelsThrows?: boolean;
    } = {},
  ) {}

  /** Replace the script mid-test (a second run with different turns). */
  say(script: ScriptedTurn[]): this {
    this.script = script;
    this.index = 0;
    return this;
  }

  async models(): Promise<ModelInfo[]> {
    this.modelsCalls++;
    if (this.opts.modelsThrows) throw new Error(`${this.id} cannot list its models`);
    if (this.opts.emptyCatalog) return [];
    return (this.opts.classes ?? ["strong"]).map((cls) => ({
      id: `${this.id}-${cls}`,
      label: `${this.id} ${cls}`,
      class: cls,
      local: true,
      supportsTools: true,
    }));
  }

  async readiness(): Promise<{ ready: true } | { ready: false; reason: "download" | "credential" | "offline" | "unsupported" }> {
    return this.opts.ready === false ? { ready: false, reason: this.opts.reason ?? "credential" } : { ready: true };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // SNAPSHOT the messages: the loop appends to one array as it goes, so storing the reference
    // would make every recorded request show the END of the conversation instead of its own turn.
    this.requests.push({ ...req, messages: [...req.messages] });
    const turn = this.script[this.index++];
    if (!turn) {
      // Running off the end of the script means the loop asked for more turns than the test wrote —
      // answer with a plain final message so the failure is the assertion, not a crash here.
      return {
        message: { role: "assistant", content: "(script exhausted)" },
        finishReason: "stop",
      };
    }
    if (turn.delay) await turn.delay;
    if (turn.throws) throw new Error(turn.throws);
    return {
      message: {
        role: "assistant",
        content: turn.text ?? "",
        ...(turn.toolCalls?.length ? { toolCalls: turn.toolCalls } : {}),
      },
      usage: turn.usage,
      footer: turn.footer,
      finishReason: turn.toolCalls?.length ? "tool_calls" : "stop",
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const response = await this.chat(req);
    if (response.message.content) yield { type: "text", delta: response.message.content };
    for (const call of response.message.toolCalls ?? []) yield { type: "tool_call", call };
    yield { type: "done", response };
  }
}

let counter = 0;
export function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${++counter}`, name, arguments: args };
}

/**
 * A provider that streams a turn in PIECES — what a real local model does at 10 tokens a second.
 *
 * `FakeProvider.stream` is a wrapper around `chat`: it yields the whole answer as one delta, which
 * proves the loop reads the stream but not that it assembles one. This one yields the pieces the
 * test wrote, plus any tool calls, plus the closing `done` — so a test can assert on WHAT ARRIVED
 * WHEN, which is the whole of gap B11.
 */
export class ChunkedProvider implements ModelProvider {
  readonly requests: ChatRequest[] = [];
  private index = 0;
  private readonly callsByTurn = new Map<number, ToolCall[]>();
  /** Throw after this many chunks of the given turn (a stream that dies mid-answer). */
  private failAt?: { turn: number; afterChunks: number; error: unknown };

  constructor(
    readonly id: string,
    private readonly turns: string[][],
  ) {}

  callsOnTurn(turn: number, calls: ToolCall[]): this {
    this.callsByTurn.set(turn, calls);
    return this;
  }

  failsOnTurn(turn: number, afterChunks: number, error: unknown): this {
    this.failAt = { turn, afterChunks, error };
    return this;
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: `${this.id}-strong`, label: this.id, class: "strong", local: true, supportsTools: true }];
  }

  async readiness(): Promise<{ ready: true }> {
    return { ready: true };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const turn = this.index;
    for await (const chunk of this.stream(req)) if (chunk.type === "done") return chunk.response;
    throw new Error(`ChunkedProvider had no turn ${turn}`);
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const turn = this.index++;
    const pieces = this.turns[turn] ?? ["(script exhausted)"];
    const calls = this.callsByTurn.get(turn) ?? [];
    let emitted = 0;
    for (const delta of pieces) {
      if (this.failAt && this.failAt.turn === turn && emitted === this.failAt.afterChunks) throw this.failAt.error;
      yield { type: "text", delta };
      emitted++;
    }
    if (this.failAt && this.failAt.turn === turn && emitted === this.failAt.afterChunks) throw this.failAt.error;
    for (const call of calls) yield { type: "tool_call", call };
    yield {
      type: "done",
      response: {
        // The closing response repeats the text, as a real SSE `done` does. The loop must prefer
        // what it accumulated, so a test that changes this string would catch a double-append.
        message: { role: "assistant", content: pieces.join(""), ...(calls.length ? { toolCalls: calls } : {}) },
        finishReason: calls.length ? "tool_calls" : "stop",
      },
    };
  }
}
