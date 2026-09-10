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
  private index = 0;

  constructor(
    readonly id: string,
    private script: ScriptedTurn[] = [],
    private readonly opts: { ready?: boolean; reason?: "download" | "credential" | "offline" | "unsupported" } = {},
  ) {}

  /** Replace the script mid-test (a second run with different turns). */
  say(script: ScriptedTurn[]): this {
    this.script = script;
    this.index = 0;
    return this;
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: `${this.id}-model`, label: this.id, class: "strong", local: true, supportsTools: true }];
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
