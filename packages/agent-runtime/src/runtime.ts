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
 *
 * TWO MORE, ADDED 2026-09-10 (gaps B11 and B16), and both are about the same instant — the first
 * token:
 *
 * 5. THE LOOP STREAMS. It calls `provider.stream()` and emits `agent_delta` per chunk, then ONE
 *    whole `agent_message` when the turn closes. `chat()` is used only by a provider that has no
 *    `stream` at all. A 10 tok/s local model used to show a blank pane for a minute and then a
 *    paragraph; the answer is now legible as it is written, which is the difference between "is
 *    this broken?" and "it is thinking".
 * 6. A DEAD CREDENTIAL FALLS THROUGH TO THE NEXT BRAIN — BEFORE THE FIRST TOKEN, NEVER AFTER. If a
 *    provider refuses with `credential` or `insufficient_credits` (`isSwitchable` in
 *    @00/agent-models) and nothing has been emitted, the loop walks to the next ready provider of
 *    the same class and emits `model_started` AGAIN, so the UI's chip is never lying about who is
 *    answering. Once a delta is out, an error is an error: half an answer from one model followed by
 *    a whole answer from another is not a fallback, it is a corrupted turn. (Same rule, same
 *    sentence, as the models router's own `stream`.)
 */
import { isSwitchable, type ChatMessage, type ChatResponse, type ImagePart, type ModelProvider, type ToolCall, type Usage } from "@00/agent-models";
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
import { classifyCall } from "./brain-class.js";
import { ContextManager, type ContextManagerOptions } from "./context.js";
import { EventBus } from "./events.js";
import { ModelRouter } from "./model-router.js";
import { PermissionManager } from "./permissions.js";
import { SessionManager } from "./sessions.js";
import { ToolRegistry } from "./tool-registry.js";
import { redact, resolveSecretArgs } from "./secrets.js";
import { SeenFiles } from "./tools-fs.js";
import { MAX_OUTPUT_CHARS, capToolOutput } from "./truncate.js";

export const DEFAULT_MAX_STEPS = 40;
/** The full agent's sandbox. The light agent's is its own thread folder, passed per run. */
export const DEFAULT_WORKSPACE = "workspace";

/**
 * ── THE CONTEXT BUDGET (2026-09-11) ────────────────────────────────────────────────────────────
 *
 * A model row may declare how wide its context is (`ModelInfo.contextTokens`). Nothing used to read
 * it, which was free while every brain was a cloud one and cost the product a day the moment the
 * default brain was a LiteRT row that asks for its KV cache AT LOAD: the system prompt alone was
 * wider than the whole cache, so every turn failed before the conversation started.
 *
 * The loop is the only place that knows both halves — the prompt it is about to build and the brain
 * that is about to read it — so the budget is derived here and handed to the ContextManager, which
 * knows what is safe to drop (context.ts, `TRIM_ORDER`).
 *
 * 45% TO THE SYSTEM PROMPT. The other 55% is the conversation, the tool results and the answer, and
 * those are the parts that GROW: a system prompt is the same size on turn 12 as on turn 1, while
 * the transcript behind it is not. A prompt allowed half the window leaves a ten-step run nowhere
 * to put its observations.
 */
export const DEFAULT_CONTEXT_TOKENS = 8192;
export const SYSTEM_PROMPT_SHARE = 0.45;

/**
 * How wide is this brain's context? The row that will answer, when it can be identified.
 *
 * A provider fixed to ONE model (both local brains) carries the id on `modelId`, and the router
 * names one in `<providerId>/<modelId>` spelling; either identifies the row exactly. When neither
 * does, the SMALLEST declared context in the catalogue is taken — if we cannot tell which row will
 * answer, the prompt has to fit the narrowest one that could. A catalogue that declares none at all
 * (every cloud peer in this package) gets the default, which is deliberately generous: those models
 * have the room, and an over-trimmed prompt on a 200k-token brain is a self-inflicted wound.
 */
export async function contextTokensOf(provider: ModelProvider, model?: string): Promise<number> {
  try {
    const rows = await provider.models();
    const loaded = (provider as { modelId?: unknown }).modelId;
    const named =
      (model ? rows.find((row) => row.id === model) : undefined) ??
      (typeof loaded === "string" ? rows.find((row) => row.id === loaded) : undefined);
    if (named) return named.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    const declared = rows.map((row) => row.contextTokens).filter((n): n is number => typeof n === "number" && n > 0);
    return declared.length ? Math.min(...declared) : DEFAULT_CONTEXT_TOKENS;
  } catch {
    // A catalogue that throws is a provider that cannot describe itself, not a reason to refuse to
    // build a prompt — the same "I do not know means yes" rule `providerOffersTools` states below.
    return DEFAULT_CONTEXT_TOKENS;
  }
}

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

/** The invariant a runtime is built on, checked wherever the list is set rather than where it is used. */
function nonEmpty(providers: ModelProvider[]): ModelProvider[] {
  if (!providers.length) throw new Error("a runtime needs at least one ModelProvider");
  return providers.slice();
}

/**
 * WHAT A BRAIN THAT BRINGS ITS OWN TOOLS IS TOLD — the sentence, and the line under the answer.
 *
 * `ModelInfo.supportsTools` has always been in the contract and the loop has always ignored it,
 * which cost nothing while every peer was a bare model: a model that cannot call a function simply
 * ignores the schemas, and the marked-prompt fallback of `@00/agent-models` picks up the local ones.
 * It stops being free the moment a peer is a WHOLE AGENT — the browser talking to the agent on the
 * person's own Mac (`RemoteBrainProvider`). That one has a shell, a filesystem and a git of its own,
 * on a machine this browser cannot see; handing it forty JSON schemas for tools that only exist here
 * invites it to call one, and the best case is that it wastes the turn describing a call nobody can
 * run. So a provider whose catalogue says `supportsTools: false` is asked WITHOUT them, and the
 * transcript says whose tools ran instead, because "it did not use my tools" is a thing a person
 * should be told rather than left to infer from a shell that never opened.
 */
export const OWN_TOOLS_FOOTER = "This brain ran its own tools; the tools in this browser were not offered to it.";

/**
 * Does this provider want our tool schemas? Yes unless its catalogue says otherwise, ALWAYS.
 *
 * The three "I do not know" answers — an empty catalogue, a `models()` that throws, a row with the
 * field absent — all mean YES, because that is what the loop did before this existed and a silent
 * loss of every tool is the worst way to be wrong. Only an explicit `supportsTools: false` on every
 * row it lists drops them.
 */
export async function providerOffersTools(provider: ModelProvider): Promise<boolean> {
  try {
    const rows = await provider.models();
    return rows.length === 0 || rows.some((row) => row.supportsTools !== false);
  } catch {
    return true;
  }
}

/** Tier order, so `tierFor` can raise a tool's tier for one call and never lower it. */
const TIER_ORDER: Record<PermissionTier, number> = { safe: 0, confirm: 1, "high-risk": 2 };
function strictest(a: PermissionTier, b: PermissionTier): PermissionTier {
  return TIER_ORDER[b] > TIER_ORDER[a] ? b : a;
}

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
  /**
   * The brains, swappable (`setProviders`, contract revision 2026-09-10).
   *
   * A router is a wrapper around an ordered list and costs nothing to make, so one is built PER RUN
   * and a swap between runs is simply the next run seeing a different list. That is the whole
   * mechanism behind "a run in flight keeps the list it started with": there is no shared mutable
   * router for a live loop to notice changing underneath it.
   */
  let providers = nonEmpty(opts.providers);
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

    const router = new ModelRouter(providers);
    /** One catalogue read per provider per run — the same budget the class question already has. */
    const toolsCache = new Map<string, Promise<boolean>>();
    const offersTools = (provider: ModelProvider): Promise<boolean> => {
      let pending = toolsCache.get(provider.id);
      if (!pending) {
        pending = providerOffersTools(provider);
        toolsCache.set(provider.id, pending);
      }
      return pending;
    };
    /** One catalogue read per provider-and-model per run, the same budget the two questions above have. */
    const contextCache = new Map<string, Promise<number>>();
    const contextBudget = (provider: ModelProvider, model?: string): Promise<number> => {
      const key = `${provider.id} ${model ?? ""}`;
      let pending = contextCache.get(key);
      if (!pending) {
        pending = contextTokensOf(provider, model);
        contextCache.set(key, pending);
      }
      return pending;
    };
    const usage = { value: usageZero() };
    let steps = 0;
    let finalText = "";
    let stopped: RunResult["stopped"] = "final";
    /** Who answered last — the run's receipt (`RunResult.providerId`), never the model's context. */
    let answeredBy: { providerId: string; model?: string } | undefined;

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
      /**
       * The system turn is left EMPTY until a brain is picked, because how much of it fits is that
       * brain's answer (`fitSystem` below). It is filled before the first model call of every step
       * and rebuilt only when the budget actually changes, so a run that never switches brains
       * builds the prompt exactly once — the cost this had before the budget existed.
       */
      const messages: ChatMessage[] = [
        { role: "system", content: "" },
        ...history,
        { role: "user", content: run.prompt },
      ];
      let systemBudget: number | null = null;
      const fitSystem = async (provider: ModelProvider, model?: string): Promise<void> => {
        const tokens = Math.floor((await contextBudget(provider, model)) * SYSTEM_PROMPT_SHARE);
        if (tokens === systemBudget) return;
        systemBudget = tokens;
        messages[0] = {
          role: "system",
          content: await context.system({
            tokens,
            onTrim: (info) => emit({ type: "context_trimmed", ...info }),
          }),
        };
      };

      const finish = (reason: RunResult["stopped"]): RunResult => {
        stopped = reason;
        return {
          sessionId,
          text: finalText,
          steps,
          usage: usage.value,
          stopped,
          ...(answeredBy ? { providerId: answeredBy.providerId, model: answeredBy.model } : {}),
        };
      };

      const maxSteps = run.maxSteps ?? DEFAULT_MAX_STEPS;
      while (steps < maxSteps) {
        if (signal.aborted) return finish("aborted");
        steps++;

        /**
         * The class is derived PER CALL, not per run (§6, class-aware routing 2026-09-10). The two
         * facts the rule needs that only the loop holds are here: `step` counts the calls of THIS
         * run, and "did this follow a tool result" is read off the transcript rather than inferred
         * from the step number, so a resumed session cannot fool it. `run.brain` forces.
         */
        const wanted =
          run.brain && run.brain !== "auto"
            ? run.brain
            : classifyCall({
                step: steps,
                afterToolResult: messages[messages.length - 1]?.role === "tool",
                toolNames,
                promptChars: run.prompt.length,
                trust: opts.trust,
              });
        /**
         * Rule 6: walk the candidates, not one pick. `walk()` yields lazily, so a run where the
         * first brain answers costs exactly what `pick()` cost before this existed.
         */
        const walker = router.walk(run.model, wanted);
        let attempt = await walker.next();
        let response: ChatResponse | undefined;
        let provider: ModelProvider | undefined;
        let model: string | undefined;
        /** True when this attempt's brain brings its own tools and ours were withheld. */
        let ownTools = false;
        while (!attempt.done) {
          ({ provider, model } = attempt.value);
          answeredBy = { providerId: provider.id, model };
          emit({ type: "model_started", providerId: provider.id, model, brainClass: attempt.value.brainClass });
          // After `model_started`, so a `context_trimmed` is attributable to the brain that caused
          // it — a fallthrough to a narrower brain trims again, and the transcript shows which.
          await fitSystem(provider, model);
          /** Set the instant a token is emitted: after this, this turn belongs to this provider. */
          let emitted = false;
          ownTools = schemas.length > 0 && !(await offersTools(provider));
          try {
            response = await callModel(provider, {
              messages,
              tools: schemas.length && !ownTools ? schemas : undefined,
              model,
              signal,
              onDelta: (delta) => {
                emitted = true;
                emit({ type: "agent_delta", text: delta });
              },
            });
            break;
          } catch (err) {
            if (signal.aborted) return finish("aborted");
            if (!emitted && isSwitchable(err)) {
              const next = await walker.next();
              if (!next.done) {
                attempt = next;
                continue;
              }
            }
            emit({ type: "error", message: `model failed: ${(err as Error).message}` });
            return finish("error");
          }
        }
        if (!response || !provider) {
          // `walk()` always yields at least one candidate, so this is unreachable; it is here so the
          // types below need no `!` and a future change to the router cannot silently skip a turn.
          emit({ type: "error", message: "model failed: no provider answered" });
          return finish("error");
        }
        usage.value = addUsage(usage.value, response.usage);
        // The provider's own footer wins — a far agent names itself better than this loop can — and
        // the generic sentence stands in when a tool-less brain gave none.
        const footer = response.footer ?? (ownTools ? OWN_TOOLS_FOOTER : undefined);
        emit({ type: "model_completed", providerId: provider.id, usage: response.usage, footer });

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
          // ONE whole message per assistant turn, AFTER its deltas and repeating them (contract
          // revision 2026-09-10): a consumer that accumulated deltas REPLACES its accumulation with
          // this text rather than appending it. That is what makes a re-render after a reconnect,
          // or a session replay, land on the same paragraph as the live one.
          emit({ type: "agent_message", text, final: true });
        }
        if (!calls.length) return finish("final");

        // Rule 1: sequential, in emitted order.
        for (const call of calls) {
          if (signal.aborted) return finish("aborted");
          const result = await runToolCall(call, { workspace, sessionId, signal });
          // The SESSION FILE gets the text only: pi's transcript format has no place for bytes, and
          // a resumed session that re-sent a four-megabyte picture on every turn would be worse than
          // one that carries the caption and the path the picture came from (gap B10).
          await sessions.appendToolResult(call, result.output, result.isError);
          messages.push({
            role: "tool",
            content: result.output,
            toolCallId: call.id,
            name: call.name,
            ...(result.images ? { images: result.images } : {}),
          });
        }
      }
      return finish("max_steps");
    } finally {
      linked.dispose();
      if (running === controller) running = null;
    }
  }

  /**
   * ONE MODEL CALL, streamed when the provider can stream (rule 5).
   *
   * The assembly rule, stated because a stream can say the same thing twice: the TEXT is what the
   * deltas built when any arrived, and the closing `done` response's content only when none did (a
   * provider whose `stream` is a wrapper around `chat` yields no text chunk before its `done`). Tool
   * calls are taken from the stream for the same reason and fall back the same way. Everything else
   * — usage, footer, finishReason — comes from `done`, which is the only chunk that carries them.
   *
   * `stream` is REQUIRED by `ModelProvider`, and this still checks: a fake, a façade or a provider
   * written against an older copy of the interface is a real thing to meet, and falling back to
   * `chat()` costs one `typeof`.
   */
  async function callModel(
    provider: ModelProvider,
    req: {
      messages: ChatMessage[];
      tools?: ReturnType<ToolRegistry["schemas"]>;
      model?: string;
      signal: AbortSignal;
      onDelta(delta: string): void;
    },
  ): Promise<ChatResponse> {
    const request = {
      messages: req.messages,
      tools: req.tools,
      model: req.model,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: req.signal,
    };
    if (typeof provider.stream !== "function") return provider.chat(request);

    let text = "";
    let sawText = false;
    const calls: ToolCall[] = [];
    let done: ChatResponse | undefined;
    for await (const chunk of provider.stream(request)) {
      if (chunk.type === "text") {
        if (!chunk.delta) continue;
        sawText = true;
        text += chunk.delta;
        req.onDelta(chunk.delta);
      } else if (chunk.type === "tool_call") {
        calls.push(chunk.call);
      } else {
        done = chunk.response;
      }
    }
    const toolCalls = calls.length ? calls : (done?.message.toolCalls ?? []);
    return {
      message: {
        role: "assistant",
        content: sawText ? text : (done?.message.content ?? ""),
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage: done?.usage,
      footer: done?.footer,
      finishReason: done?.finishReason ?? (toolCalls.length ? "tool_calls" : "stop"),
    };
  }

  async function runToolCall(
    call: ToolCall,
    ctx: { workspace: string; sessionId: string; signal: AbortSignal },
  ): Promise<{ output: string; isError: boolean; images?: ImagePart[] }> {
    const tool: Tool | undefined = registry.get(call.name);
    if (!tool) {
      const message = `No tool named "${call.name}". Available: ${registry.names().join(", ")}`;
      emit({ type: "tool_failed", callId: call.id, name: call.name, error: message });
      return { output: message, isError: true };
    }
    const toolCtx: ToolContext = {
      fs,
      sandbox: ctx.workspace,
      signal: ctx.signal,
      emit,
      ...(opts.secrets ? { secrets: opts.secrets } : {}),
    };
    /**
     * The tier for THESE arguments, never lower than the tool's own (api.ts, `tierFor`). A
     * `tierFor` that throws is treated as "the declared tier", because a tool that cannot decide is
     * not thereby allowed to skip the question.
     */
    let tier: PermissionTier = tool.tier;
    if (tool.tierFor) {
      try {
        tier = strictest(tier, await tool.tierFor(call.arguments ?? {}, toolCtx));
      } catch {
        /* the declared tier stands */
      }
    }
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

    /**
     * `${secret:NAME}` is resolved HERE, between the permission and the run (secrets.ts).
     *
     * The event above and the session file carry the PLACEHOLDER — the person confirming the call
     * sees `${secret:STRIPE_KEY}`, not the key — and only `tool.run` sees the value. On the way back
     * `redact` puts every resolved value back to its placeholder, so a tool that echoes its own
     * arguments cannot smuggle the secret into the transcript.
     */
    emit({ type: "tool_started", callId: call.id, name: call.name, args: call.arguments });
    const started = now().getTime();
    const resolved = await resolveSecretArgs(call.arguments ?? {}, opts.secrets);
    if (resolved.error) {
      emit({ type: "tool_failed", callId: call.id, name: call.name, error: resolved.error });
      return { output: resolved.error, isError: true };
    }
    try {
      const result = await tool.run(resolved.args, toolCtx);
      const output = capToolOutput(redact(result.output ?? "", resolved.used), maxToolOutput);
      emit({ type: "tool_completed", callId: call.id, name: call.name, output, ms: now().getTime() - started });
      return { output, isError: result.isError === true, ...(result.images?.length ? { images: result.images } : {}) };
    } catch (err) {
      // Rule 2: the model sees what went wrong and gets another turn — with any secret value taken
      // back out of the message, since a thrown error loves to quote the argument that caused it.
      const message = redact((err as Error).message ?? String(err), resolved.used);
      emit({ type: "tool_failed", callId: call.id, name: call.name, error: message });
      return { output: `${call.name} failed: ${message}`, isError: true };
    }
  }

  return {
    run: runOne,
    setProviders(next) {
      // The invariant fails HERE rather than at the next run, so the caller who emptied the list is
      // the one who hears about it.
      providers = nonEmpty(next);
    },
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
