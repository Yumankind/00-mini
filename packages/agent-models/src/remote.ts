/**
 * THE BRAIN THAT THINKS ON YOUR OWN MAC — a `ModelProvider` whose far end is a whole agent.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS LEGITIMATE ───────────────────────────────────────────────────
 *
 * A Claude Code or a Codex subscription is sold for its own client, running on the person's own
 * machine, signed in as them. Its OAuth is issued to that client, and a browser tab is not that
 * client: taking those tokens and calling the vendor's API from a web page would be using a
 * credential outside the terms it was granted under, and this package would be the thing doing it.
 * So it does not, and there is no code here that could — nothing in this file holds a token, sees
 * one, or knows a vendor's URL.
 *
 * What it does instead is the ordinary thing a person may always do: ASK THEIR OWN MAC. The 00 app
 * on that Mac already offers those subscriptions as brains for the agent sitting there, under the
 * vendor's own client, on the machine it was signed in on. Mobile connect (§8.4) already lets a
 * device the operator ADMITTED AT THE MAC send that agent a prompt and read its answer. This
 * provider is those two facts joined: the browser sends a sentence, the Mac's agent thinks with
 * whatever brain it is configured with, and a sentence comes back. The subscription is used on the
 * Mac, by the Mac's own client, at the moment its owner asked it to be. The browser only asks.
 *
 * That is also the honest limit of it: if the Mac is asleep, there is no brain here. Nothing is
 * cached, proxied, pooled or shared, and a person cannot lend this brain to anyone — the far end
 * only answers a device its operator admitted by name, for twenty-four hours at a time.
 *
 * ── THE FAR SIDE IS AN AGENT, NOT A MODEL. THREE CONSEQUENCES ───────────────────────────────────
 *
 * 1. IT KEEPS ITS OWN HISTORY. A prompt frame lands in one of that agent's sessions and the Mac
 *    holds the transcript; re-sending our whole message array every turn would be telling a
 *    conversation to itself, twice. So `renderRemotePrompt` sends the LATEST USER TURN and nothing
 *    older — plus any tool results that arrived since the last assistant turn, because those are
 *    facts the far agent has not seen and cannot look up. The system prompt is never sent: that
 *    agent has its own, written by its own operator, and ours describes a browser it is not in.
 * 2. ITS TOOLS ARE ITS OWN. `models()` answers `supportsTools: false`, which is not a confession of
 *    weakness — the far end has a shell, a filesystem and a git of its own — but a boundary: this
 *    wire carries one string each way, and offering our browser's tool schemas to an agent that
 *    would run them on its Mac is not a thing the person asked for. `@00/agent-runtime` reads that
 *    field and stops offering its schemas to this provider (runtime.ts, `providerOffersTools`).
 * 3. IT CANNOT SEE. The wire is text, so a picture is described in words rather than sent, using
 *    the same note every blind peer in this package uses.
 *
 * ── THE TRANSPORT IS INJECTED, AND THAT IS THE WHOLE OF THE PORTING STORY ───────────────────────
 *
 * Not one line here knows what a relay is, what a frame is or how a signature is made. The browser
 * builds a `RemoteTransport` over mobile connect (`apps/infinite/src/mac/transport.ts`); a test
 * builds one over an array. This file is only "how does a conversation become one sentence, and
 * what does a refusal mean" — the two things that would otherwise be written twice.
 *
 * ── WHY `busy` IS `rate_limited` AND A REFUSAL IS `credential` ──────────────────────────────────
 *
 * `ProviderErrorCode` is the router's vocabulary and it is frozen (errors.ts): the two codes it
 * SWITCHES BRAINS ON are `credential` and `insufficient_credits`, and the ones it retries are
 * `rate_limited` and `server_error`. A Mac that is mid-turn is this peer being busy — a retry is
 * the right move and moving the person to another brain silently is not — so it is `rate_limited`
 * with `vendorCode: "busy"`, and `isRemoteBusy()` is here so a UI can say the true sentence. A
 * relay that refuses (no session, not admitted, the session expired, an answer that did not verify)
 * means this door is not open to you, which is exactly what `credential` means to the router, and
 * exactly the case where walking on to the local brain is the kindest thing it can do.
 */

import { droppedImagesNote } from "./image-parts.js";
import { ProviderError, isAborted, type ProviderErrorCode } from "./errors.js";
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, ModelInfo, ModelProvider, Readiness } from "./types.js";

/** What the far end is doing, in the three states a person is told apart. */
export type RemoteStatus = "connected" | "waiting" | "off";

/**
 * One thing that happened while the far agent answered.
 *
 * `text` exists for a transport that can stream (a socket, one day); the relay cannot, and emits
 * one `done`. Both shapes are legal and the provider assembles the same answer from either.
 */
export type RemoteEvent =
  | { type: "text"; delta: string }
  | { type: "done"; text: string; sessionId?: string }
  | { type: "busy" }
  | { type: "error"; code: string; message: string };

export interface RemotePromptOptions {
  /** The far agent's session this turn belongs in. */
  sessionId?: string;
  signal?: AbortSignal;
}

/** The whole of what a far agent must be able to do to be a brain here. */
export interface RemoteTransport {
  prompt(text: string, opts: RemotePromptOptions): AsyncIterable<RemoteEvent>;
  /** The far agent's own sessions, for a picker. */
  sessions(): Promise<{ id: string; title: string }[]>;
  status(): Promise<RemoteStatus>;
}

export interface RemoteBrainOptions {
  transport: RemoteTransport;
  /** The contract's provider id. One Mac, one id. */
  id?: string;
  /** The far AGENT's name, as its Mac calls it — not a sentence about where it runs. */
  label?: string;
  /** The far session to aim the first turn at; later turns follow whatever the Mac answers with. */
  sessionId?: string;
}

/** A `ModelProvider`, plus the two things only a far-end brain can be asked. */
export interface RemoteBrain extends ModelProvider {
  sessions(): Promise<{ id: string; title: string }[]>;
  /** The far session the turns are landing in, once one is known. */
  targetSession(): string | undefined;
}

export const REMOTE_PROVIDER_ID = "remote-mac";
/** One row, because a far agent is one brain however many models it has behind it. */
export const REMOTE_MODEL_ID = "mac-agent";
export const REMOTE_DEFAULT_LABEL = "Your Mac's agent";
/** The far end's own word for "I am mid-turn", carried as `vendorCode`. */
export const REMOTE_BUSY = "busy";

/** What a picture becomes on a wire that carries one string. */
export const NO_REMOTE_VISION = "your Mac's agent is asked over a text-only wire";

/** The lead-in over tool results the far agent has not seen. */
export const TOOL_RESULT_HEADER = "Results from the tools I ran in this browser since your last message:";

/**
 * The refusals that are the NETWORK failing rather than a door being shut. Everything not in here
 * and not `busy` is treated as a shut door — see the header for why that is the useful default.
 */
const NETWORK_CODES = new Set([
  "unreachable",
  "network",
  "engine_unreachable",
  "engine_not_connected",
  "result_timeout",
  "relay_not_configured",
]);

/** A transport's refusal code, in the router's vocabulary. */
export function remoteErrorCode(code: string): ProviderErrorCode {
  if (code === REMOTE_BUSY) return "rate_limited";
  if (code === "aborted") return "aborted";
  if (code === "payload_too_large") return "bad_request";
  if (NETWORK_CODES.has(code)) return "network";
  return "credential";
}

/** True for the one refusal that means "ask again in a moment", not "go and fix something". */
export function isRemoteBusy(err: unknown): boolean {
  return err instanceof ProviderError && err.vendorCode === REMOTE_BUSY;
}

function lastOf(messages: readonly ChatMessage[], role: ChatMessage["role"]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return messages[i];
  }
  return undefined;
}

/**
 * ONE SENTENCE FOR A WHOLE AGENT — the rule stated in the header, as code.
 *
 * Everything before the last assistant turn is the far agent's own memory and is not repeated. What
 * is left is what it has not seen: a new question from the person, tool results from this browser,
 * or both. A turn that is only tool results does NOT re-ask the original question — the far agent
 * asked for nothing and re-sending its own words to it is how a loop starts talking to itself.
 */
export function renderRemotePrompt(messages: readonly ChatMessage[]): string {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const tail = messages.slice(lastAssistant + 1);
  const results = tail.filter((m) => m.role === "tool");
  // The fallback to the whole transcript covers exactly one case: a tail with nothing in it at all.
  const user = lastOf(tail, "user") ?? (results.length ? undefined : lastOf(messages, "user"));

  const parts: string[] = [];
  if (results.length) {
    parts.push(TOOL_RESULT_HEADER);
    for (const r of results) parts.push(`- ${r.name ?? r.toolCallId ?? "tool"}: ${r.content.trim()}`);
  }
  if (user) {
    const note = user.images?.length ? droppedImagesNote(user.images, NO_REMOTE_VISION) : "";
    parts.push([user.content.trim(), note].filter((s) => s.length > 0).join("\n\n"));
  }
  return parts.join("\n\n").trim();
}

export function RemoteBrainProvider(options: RemoteBrainOptions): RemoteBrain {
  const id = options.id ?? REMOTE_PROVIDER_ID;
  const label = options.label?.trim() || REMOTE_DEFAULT_LABEL;
  const transport = options.transport;
  /** The far session the conversation is living in. It moves only when the Mac names one. */
  let session = options.sessionId;

  const fail = (code: ProviderErrorCode, message: string, vendorCode?: string): ProviderError =>
    new ProviderError({ status: 0, code, message, providerId: id, ...(vendorCode ? { vendorCode } : {}) });

  const busy = (): ProviderError =>
    fail("rate_limited", `${label} is in the middle of another turn on your Mac. Ask again in a moment.`, REMOTE_BUSY);

  /**
   * ONE TURN, as chunks. `chat()` drains it, `stream()` is it — so the two can never disagree about
   * what a `done` with no text, or a delta followed by a refusal, means.
   */
  async function* turn(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (req.signal?.aborted) throw fail("aborted", "The request was cancelled.");
    const text = renderRemotePrompt(req.messages);
    if (!text) throw fail("bad_request", `${label} was given nothing to answer.`);

    let assembled = "";
    let streamed = false;
    let closed = false;
    let closingText = "";
    try {
      for await (const event of transport.prompt(text, {
        ...(session ? { sessionId: session } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      })) {
        if (event.type === "text") {
          if (!event.delta) continue;
          streamed = true;
          assembled += event.delta;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "busy") {
          throw busy();
        } else if (event.type === "error") {
          throw fail(remoteErrorCode(event.code), event.message, event.code);
        } else {
          closed = true;
          closingText = event.text;
          if (event.sessionId) session = event.sessionId;
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (isAborted(err)) throw fail("aborted", "The request was cancelled.");
      throw fail("network", `${label} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A transport that ends without saying it finished has lost the answer, not delivered an empty
    // one. Said as a server error, because a retry is the right move and a brain switch is not.
    if (!closed && !streamed) throw fail("server_error", `${label} stopped answering before it finished.`);

    const content = streamed ? assembled : closingText;
    yield {
      type: "done",
      response: {
        message: { role: "assistant", content },
        finishReason: "stop",
        // Shown under the answer, never fed back (types.ts): the one place a person is told where
        // the thinking happened and whose tools ran.
        footer: `Answered by ${label} on your Mac, with its own brain and its own tools.`,
      },
    };
  }

  return {
    id,

    async models(): Promise<ModelInfo[]> {
      return [
        {
          id: REMOTE_MODEL_ID,
          label: `${label} on your Mac`,
          // A whole agent with a subscription behind it is the strong brain, whatever it is running.
          class: "strong",
          local: false,
          supportsTools: false,
        },
      ];
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      let response: ChatResponse | undefined;
      for await (const chunk of turn(req)) if (chunk.type === "done") response = chunk.response;
      // Unreachable: `turn` either throws or ends with a `done`. Here so the type needs no `!`.
      if (!response) throw fail("server_error", `${label} answered nothing at all.`);
      return response;
    },

    stream(req: ChatRequest): AsyncIterable<ChatChunk> {
      return turn(req);
    },

    async readiness(): Promise<Readiness> {
      let status: RemoteStatus;
      try {
        status = await transport.status();
      } catch {
        // A transport that cannot even say is the relay being unreachable, which is `offline`.
        return { ready: false, reason: "offline", detail: "your Mac could not be reached" };
      }
      if (status === "connected") return { ready: true };
      if (status === "waiting") {
        return { ready: false, reason: "offline", detail: "your Mac is not answering right now" };
      }
      return {
        ready: false,
        reason: "credential",
        detail: "connect this browser to your Mac and admit it there",
      };
    },

    sessions: () => transport.sessions(),
    targetSession: () => session,
  };
}
