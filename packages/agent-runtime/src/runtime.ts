/**
 * THE LOOP: understand → inspect → plan → tool → observe → continue.
 *
 * It is a small re-implementation on purpose (docs/HANDOFF-infinite-agent.md §2). Pi is Node and
 * does not run in a browser; the interesting behaviour lives in the TOOLS and in what the context
 * withholds, not in the loop, so the loop is kept boring and readable:
 *
 *   context → model → tool calls → permission → execute → observe → repeat, until a turn with no
 *   tool calls (a final answer), `maxSteps`, an abort, or an error.
 *
 * FOUR RULES THAT ARE DECISIONS, not incidents:
 *
 * 1. PARALLEL TOOL CALLS RUN SEQUENTIALLY, IN THE ORDER THE MODEL EMITTED THEM. Models emit several
 *    calls per turn and the temptation is `Promise.all`. But two of them may write the same file, and
 *    the person is being asked to approve each one — approving #3 while #1 is still running means
 *    approving something whose starting state you cannot see. Order is also what makes a session
 *    replayable. The cost is latency on reads; the alternative is a race with a confirmation dialog
 *    in it.
 * 2. A TOOL FAILURE IS AN OBSERVATION, NOT AN END. The error goes back as the tool result and the
 *    loop continues — a model that is told "that path does not exist" fixes it, and a run that dies
 *    on the first typo is a worse agent. Only the MODEL failing ends the run.
 * 3. A DENIED PERMISSION IS ALSO AN OBSERVATION, and it is worded so the model stops asking: the
 *    person said no, and the correct next move is to say so, not to try a different spelling.
 * 4. ABORT IS CHECKED BETWEEN EVERY STEP AND PASSED INTO EVERY TOOL. `abort()` mid-tool works
 *    because the tool holds the signal, and the loop stops the moment it returns.
 */
import type { ChatMessage, ChatResponse, ToolCall, Usage } from "@00/agent-models";
import type { AgentFs } from "@00/agent-fs";
import type {
  AgentEvent,
  AgentRuntime,
  AgentRuntimeOptions,
  PermissionTier,
  RunOptions,
  RunResult,
  Tool,
  ToolContext,
} from "./api.js";
import { ContextManager, type ContextManagerOptions } from "./context.js";
import { EventBus } from "./events.js";
import { ModelRouter } from "./model-router.js";
import { PermissionManager } from "./permissions.js";
import { SessionManager } from "./sessions.js";
import { ToolRegistry } from "./tool-registry.js";
import { SeenFiles } from "./tools-fs.js";
import { MAX_OUTPUT_CHARS, capToolOutput } from "./truncate.js";

export const DEFAULT_MAX_STEPS = 40;
/** The full agent's sandbox. The light agent's is its own thread folder, passed per run. */
export const DEFAULT_WORKSPACE = "workspace";

/**
 * Everything the loop needs beyond the frozen `AgentRuntimeOptions`.
 *
 * It EXTENDS rather than edits `api.ts`: that file is the contract the PWA and the embed are written
 * against, and every field here has a default, so `createAgentRuntime(frozenOptions)` still compiles
 * and still runs.
 */
export interface RuntimeExtensions {
  /** Permission scope: the product origin, or the site an embed sits on. */
  origin?: string;
  /** Default sandbox when a run does not name one. */
  workspace?: string;
  /** Shared with the tool set so a NEW session resets the read-before-overwrite guard. */
  seenFiles?: SeenFiles;
  permissions?: PermissionManager;
  sessions?: SessionManager;
  /** Context knobs: shell label, secret names, the light agent's channel/from. */
  context?: Partial<Omit<ContextManagerOptions, "trust" | "sandbox" | "toolNames">>;
  maxToolOutputChars?: number;
  temperature?: number;
  maxTokens?: number;
  now?: () => Date;
}

export type AgentRuntimeOptionsExt = AgentRuntimeOptions & RuntimeExtensions;

function usageZero(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(total: Usage, add?: Usage): Usage {
  if (!add) return total;
  const cost =
    add.costCents === undefined && total.costCents === undefined
      ? undefined
      : (total.costCents ?? 0) + (add.costCents ?? 0);
  return {
    inputTokens: total.inputTokens + add.inputTokens,
    outputTokens: total.outputTokens + add.outputTokens,
    ...(cost === undefined ? {} : { costCents: cost }),
  };
}

/** Two signals, one abort: the caller's per-run one and the runtime's `abort()`. */
function linkSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const live = signals.filter((s): s is AbortSignal => !!s);
  const onAbort = () => controller.abort();
  for (const s of live) {
    if (s.aborted) controller.abort();
    else s.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const s of live) s.removeEventListener("abort", onAbort);
    },
  };
}

export function createAgentRuntime(opts: AgentRuntimeOptionsExt): AgentRuntime {
  const fs: AgentFs = opts.fs;
  const bus = new EventBus();
  const registry = new ToolRegistry(opts.tools);
  const router = new ModelRouter(opts.providers);
  const origin = opts.origin ?? "local";
  const defaultWorkspace = opts.workspace ?? DEFAULT_WORKSPACE;
  const now = opts.now ?? (() => new Date());
  const permissions = opts.permissions ?? new PermissionManager(fs, { now: () => now().getTime() });
  const sessions =
    opts.sessions ?? new SessionManager(fs, { cwd: defaultWorkspace, now });
  const seenFiles = opts.seenFiles;
  const maxToolOutput = opts.maxToolOutputChars ?? MAX_OUTPUT_CHARS;

  /** The live run's abort handle; `abort()` between runs is a no-op rather than an error. */
  let running: AbortController | null = null;

  const emit = (event: AgentEvent) => bus.emit(event);

  async function runOne(run: RunOptions): Promise<RunResult> {
    const workspace = run.workspace ?? defaultWorkspace;
    const controller = new AbortController();
    running = controller;
    const linked = linkSignals(controller.signal, run.signal);
    const signal = linked.signal;

    const usage = { value: usageZero() };
    let steps = 0;
    let finalText = "";
    let stopped: RunResult["stopped"] = "final";

    try {
      const resuming = !!run.sessionId;
      const sessionId = await sessions.open(run.sessionId);
      // A NEW session means a new "have you read it this session" book. Resuming keeps the old one,
      // which is what resuming means.
      if (!resuming) seenFiles?.clear();

      const toolNames = run.tools ? run.tools.filter((n) => registry.has(n)) : registry.names();
      const schemas = registry.schemas(toolNames);
      const context = new ContextManager(fs, {
        ...opts.context,
        trust: opts.trust,
        sandbox: workspace,
        toolNames,
        now,
      });

      const history = resuming ? await sessions.load(sessionId) : [];
      await sessions.appendUser(run.prompt);
      const messages: ChatMessage[] = [
        { role: "system", content: await context.system() },
        ...history,
        { role: "user", content: run.prompt },
      ];

      const finish = (reason: RunResult["stopped"]): RunResult => {
        stopped = reason;
        return { sessionId, text: finalText, steps, usage: usage.value, stopped };
      };

      const maxSteps = run.maxSteps ?? DEFAULT_MAX_STEPS;
      while (steps < maxSteps) {
        if (signal.aborted) return finish("aborted");
        steps++;

        const { provider, model } = await router.pick(run.model);
        emit({ type: "model_started", providerId: provider.id, model });
        let response: ChatResponse;
        try {
          response = await provider.chat({
            messages,
            tools: schemas.length ? schemas : undefined,
            model,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            signal,
          });
        } catch (err) {
          if (signal.aborted) return finish("aborted");
          emit({ type: "error", message: `model failed: ${(err as Error).message}` });
          return finish("error");
        }
        usage.value = addUsage(usage.value, response.usage);
        emit({ type: "model_completed", providerId: provider.id, usage: response.usage, footer: response.footer });

        const text = response.message.content ?? "";
        const calls = response.message.toolCalls ?? [];
        await sessions.appendAssistant(text, calls, {
          providerId: provider.id,
          model,
          usage: response.usage,
          stopReason: calls.length ? "toolUse" : response.finishReason === "length" ? "length" : "stop",
        });
        messages.push({ role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) });
        if (text) {
          finalText = text;
          emit({ type: "agent_message", text, final: calls.length === 0 });
        }
        if (!calls.length) return finish("final");

        // Rule 1: sequential, in emitted order.
        for (const call of calls) {
          if (signal.aborted) return finish("aborted");
          const result = await runToolCall(call, { workspace, sessionId, signal });
          await sessions.appendToolResult(call, result.output, result.isError);
          messages.push({ role: "tool", content: result.output, toolCallId: call.id, name: call.name });
        }
      }
      return finish("max_steps");
    } finally {
      linked.dispose();
      if (running === controller) running = null;
    }
  }

  async function runToolCall(
    call: ToolCall,
    ctx: { workspace: string; sessionId: string; signal: AbortSignal },
  ): Promise<{ output: string; isError: boolean }> {
    const tool: Tool | undefined = registry.get(call.name);
    if (!tool) {
      const message = `No tool named "${call.name}". Available: ${registry.names().join(", ")}`;
      emit({ type: "tool_failed", callId: call.id, name: call.name, error: message });
      return { output: message, isError: true };
    }
    const tier: PermissionTier = tool.tier;
    const scope = { tool: call.name, origin, workspace: ctx.workspace, sessionId: ctx.sessionId };
    const outcome = await permissions.decide(scope, tier, async () => {
      emit({ type: "permission_requested", callId: call.id, name: call.name, tier, args: call.arguments });
      return opts.askPermission({ name: call.name, tier, args: call.arguments });
    });
    if (tier !== "safe") {
      emit({ type: "permission_answered", callId: call.id, allowed: outcome.allowed, remember: outcome.remember });
    }
    if (!outcome.allowed) {
      // Rule 3: worded so the model reports the refusal rather than retrying it.
      const message = `Denied: the person did not allow ${call.name}. Do not retry it — tell them what you wanted to do and why.`;
      return { output: message, isError: true };
    }

    emit({ type: "tool_started", callId: call.id, name: call.name, args: call.arguments });
    const started = now().getTime();
    const toolCtx: ToolContext = { fs, sandbox: ctx.workspace, signal: ctx.signal, emit };
    try {
      const result = await tool.run(call.arguments ?? {}, toolCtx);
      const output = capToolOutput(result.output ?? "", maxToolOutput);
      emit({ type: "tool_completed", callId: call.id, name: call.name, output, ms: now().getTime() - started });
      return { output, isError: result.isError === true };
    } catch (err) {
      // Rule 2: the model sees what went wrong and gets another turn.
      const message = (err as Error).message ?? String(err);
      emit({ type: "tool_failed", callId: call.id, name: call.name, error: message });
      return { output: `${call.name} failed: ${message}`, isError: true };
    }
  }

  return {
    run: runOne,
    on: (listener) => bus.on(listener),
    async listSessions() {
      return sessions.list();
    },
    async loadSession(id) {
      return sessions.load(id);
    },
    abort() {
      running?.abort();
    },
  };
}
