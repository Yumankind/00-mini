/**
 * §8.4's SECOND DOOR: the Mac's agent as a brain for this browser, over the relay we already speak.
 *
 * The argument for why this is allowed at all lives in `packages/agent-models/src/remote.ts` and is
 * not repeated here. This file is the plumbing under it: a `RemoteTransport` — three methods — built
 * out of the same `MacClient` the chat box in `MacConnectCard.vue` drives. Nothing new goes on the
 * wire. A brain turn is a `prompt` frame with a target session, exactly as the card sends one; the
 * session list is a `sessions.list` frame; "is my Mac there" is the `status` route.
 *
 * ── NO STREAMING ON THIS WIRE, AND ONE `done` RATHER THAN A LIE ────────────────────────────────
 *
 * The relay carries whole frames: the Mac runs the turn, posts a signed result, and this side polls
 * for it (`awaitResult`). There is no channel for a token to arrive on, so the transport emits a
 * single `done` and the provider yields the answer in one piece. It would be easy to fake deltas by
 * chopping the finished text into words, and it would be a lie about latency that a person reads as
 * "it is thinking" when the thinking finished a second ago. The contract has room for real deltas
 * the day the wire grows a socket; until then, one `done`.
 *
 * ── A SLEEPING MAC IS AN ANSWER, NOT A FIVE-MINUTE WAIT ────────────────────────────────────────
 *
 * The card's chat is happy to leave a frame queued for a Mac that is asleep — the relay stores it and
 * the Mac drains it when it wakes, and the person is told so. A BRAIN cannot do that: a run that
 * blocks for five minutes and then times out is a broken app, not a patient one. So `delivered:
 * false` fails immediately, by name, with the sentence that says what happened.
 *
 * ── WHY THE STATUS ANSWER IS CACHED ────────────────────────────────────────────────────────────
 *
 * `readiness()` is asked by the Connections pane on a five-second poll, by the chip, and by the
 * router before every turn. Each ask would otherwise be a relay round trip about a fact that changes
 * on the scale of a laptop lid closing, so it is held for `MAC_POLL_MS` — the same rhythm the engine
 * half polls on, chosen for the same reason.
 */
import type { ModelProvider, Readiness, RemoteEvent, RemotePromptOptions, RemoteStatus, RemoteTransport } from "@00/agent-models";
import { RemoteBrainProvider, REMOTE_PROVIDER_ID } from "@00/agent-models";
import { MAC_POLL_MS, RESULT_POLL_MS, RESULT_TIMEOUT_MS, relayConfigured } from "./config.js";
import { MacClientError, createMacClient, readAnswerText, readSessionRows, type MacClient } from "./client.js";
import { clientIdentity } from "./keys.js";
import { createRelay } from "./relay.js";
import { RELAY_TOKEN_SECRET, macChosen, macEngines, macTargetSession } from "./state.js";

/** Where one frame is aimed: the session, the Mac, the agent, and the key its answers are checked with. */
export interface MacTarget {
  sessionId: string;
  engineFp: string;
  agentId: string;
  engineDeviceKey: string;
}

export interface MacTransportDeps {
  /** The signing client. A FACTORY because minting the identity touches IndexedDB, and a boot that
   *  merely built a provider must not have opened a database to do it. */
  client: () => Promise<MacClient>;
  /** The Mac and agent this brain is, or null when the person has not chosen one. */
  target: () => MacTarget | null;
  /** Which of the far agent's sessions the turns land in; its own current one when undefined. */
  session?: () => string | undefined;
  /** How long to wait for the Mac's answer, and how often to ask. */
  wait?: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  now?: () => number;
  /** How long a `status` answer is trusted. `0` asks every time (what a test wants). */
  statusTtlMs?: number;
}

const evError = (code: string, message: string): RemoteEvent => ({ type: "error", code, message });

/** A `MacClientError`, or anything else that came back, as one named refusal. */
function asEvent(err: unknown): RemoteEvent {
  if (err instanceof MacClientError) return evError(err.code, err.message);
  return evError("unreachable", err instanceof Error ? err.message : String(err));
}

export function createMacTransport(deps: MacTransportDeps): RemoteTransport {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.statusTtlMs ?? MAC_POLL_MS;
  const wait = {
    timeoutMs: deps.wait?.timeoutMs ?? RESULT_TIMEOUT_MS,
    intervalMs: deps.wait?.intervalMs ?? RESULT_POLL_MS,
    ...(deps.wait?.sleep ? { sleep: deps.wait.sleep } : {}),
  };
  let cached: { at: number; value: RemoteStatus } | null = null;

  /** The pair every call needs, or the named reason there is not one. */
  async function ready(): Promise<{ client: MacClient; to: MacTarget }> {
    const to = deps.target();
    if (!to) throw new MacClientError("no_mac_session", "No Mac session is chosen for this browser to ask.");
    return { client: await deps.client(), to };
  }

  async function* prompt(text: string, opts: RemotePromptOptions): AsyncIterable<RemoteEvent> {
    let client: MacClient;
    let to: MacTarget;
    try {
      ({ client, to } = await ready());
    } catch (err) {
      yield asEvent(err);
      return;
    }
    if (opts.signal?.aborted) {
      yield evError("aborted", "The request was cancelled.");
      return;
    }
    try {
      const target = opts.sessionId ?? deps.session?.();
      const sent = await client.prompt(to, text, target || undefined);
      if (!sent.delivered) {
        yield evError(
          sent.deliveryCode ?? "engine_not_connected",
          "Your Mac is not connected right now, so its agent cannot answer this one.",
        );
        return;
      }
      const answer = await client.awaitResult({ ...to, frameId: sent.frameId }, wait);
      if (answer.error) {
        yield evError(answer.error, `Your Mac refused that: ${answer.error}`);
        return;
      }
      const result = answer.result;
      // TWO SHAPES MEAN "not now" and the Mac chooses between them (apps/00d/src/server.ts): a
      // prompt aimed at ONE session while that agent is mid-turn comes back `busy`, and one aimed
      // at no session in particular is QUEUED onto the running turn — which is a fine thing for a
      // chat box and useless for a brain, because no answer to this question is ever coming back.
      const shape = (result ?? {}) as { busy?: unknown; queued?: unknown };
      if (shape.busy === true || shape.queued === true) {
        yield { type: "busy" };
        return;
      }
      const row = (result ?? {}) as { sessionId?: unknown };
      yield {
        type: "done",
        text: readAnswerText(result),
        // The Mac names the session its answer landed in when it names one; otherwise the turn
        // stays aimed where it was aimed, and `undefined` says "whatever that agent is on".
        ...(typeof row.sessionId === "string" && row.sessionId ? { sessionId: row.sessionId } : {}),
      };
    } catch (err) {
      yield asEvent(err);
    }
  }

  async function sessions(): Promise<{ id: string; title: string }[]> {
    const { client, to } = await ready();
    const sent = await client.listSessions(to);
    const answer = await client.awaitResult({ ...to, frameId: sent.frameId }, wait);
    if (answer.error) throw new MacClientError(answer.error, `Your Mac refused that: ${answer.error}`);
    return readSessionRows(answer.result).map((r) => ({ id: r.id, title: r.title }));
  }

  async function status(): Promise<RemoteStatus> {
    if (cached && now() - cached.at < ttl) return cached.value;
    const value = await read();
    cached = { at: now(), value };
    return value;
  }

  async function read(): Promise<RemoteStatus> {
    const to = deps.target();
    // Nothing chosen is not a failure and must never read as one: it is the ordinary state of a
    // browser that has not been admitted at a Mac yet, and `off` is what the card says about it.
    if (!to || !relayConfigured()) return "off";
    try {
      const client = await deps.client();
      const answered = await client.status(to.engineFp, to.agentId);
      // Tolerant on purpose, like `readSessionRows`: the Mac's status body has grown fields before.
      // Only an EXPLICIT no counts as one; anything else that came back at all means it is there.
      const online = (answered as { online?: unknown; connected?: unknown }).online ?? (answered as { connected?: unknown }).connected;
      return online === false ? "waiting" : "connected";
    } catch (err) {
      // A refusal the person can fix by going to their Mac is `off`; anything else is the relay or
      // the machine not being there, which is what "waiting" means to a card and to readiness.
      if (err instanceof MacClientError && (err.code === "unauthorized" || err.code === "relay_not_configured")) return "off";
      return "waiting";
    }
  }

  return { prompt, sessions, status };
}

// ── The app's own wiring ────────────────────────────────────────────────────────────────────────

/** The narrow shape of the vault this file needs — structurally typed, so nothing imports the app. */
export interface MacVault {
  readonly unlocked: boolean;
  get(name: string): Promise<string>;
}

/** The Mac and agent the person chose on the card, as a target, or null. */
export function chosenMacTarget(): MacTarget | null {
  const { engineFp, agentId } = macChosen.value;
  const row = macEngines.value.find((e) => e.engineFp === engineFp);
  if (!row || !agentId) return null;
  // The session id IS the engine fingerprint: the Mac publishes one row per session under it.
  return { sessionId: row.engineFp, engineFp: row.engineFp, agentId, engineDeviceKey: row.deviceKey };
}

/** The far agent's name, as its Mac calls it — the label the chip and the picker show. */
export function chosenMacLabel(): string | undefined {
  const { engineFp, agentId } = macChosen.value;
  const agent = macEngines.value.find((e) => e.engineFp === engineFp)?.agents.find((a) => a.agentId === agentId);
  return agent?.displayName?.trim() || undefined;
}

/**
 * The three things that must OUTLIVE one `buildProviders()` call, and why each does.
 *
 * `refreshBrains()` runs every five seconds while the Connections pane is open, and it rebuilds the
 * handle list each time. A provider rebuilt on that rhythm would be a new object with a new memory:
 * it would forget the far session the Mac named on the last turn (so turn two would land in a
 * different conversation from turn one), and it would throw away the cached `status` answer and ask
 * the relay again — twelve round trips a minute about a fact that changes when a laptop lid closes.
 * So the signing client, the sealed token and the provider itself are held here, and rebuilt only
 * when the person actually points this browser at a different Mac or a different agent.
 */
let sealedToken: string | null = null;
let macClient: MacClient | null = null;
let built: { key: string; provider: ModelProvider } | null = null;

/** Test seam, and only that: module state outlives a test file otherwise. */
export function __resetMacBrainForTests(): void {
  sealedToken = null;
  macClient = null;
  built = null;
}

async function clientFor(): Promise<MacClient> {
  if (!macClient) {
    // The token is read through a FUNCTION (relay.ts takes one, not a string), so a vault unlocked
    // mid-session starts working without a reload and a locked one stops it without a stale copy.
    macClient = createMacClient({ relay: createRelay({ token: () => sealedToken }), identity: await clientIdentity() });
  }
  return macClient;
}

/**
 * THE ONE LINE `runtime/bootstrap.ts` ADDS — a `ProviderHandle` for the Mac brain.
 *
 * It builds nothing when there is nothing to build: no relay origin in this build, no Mac session
 * chosen, or no sealed relay key — and the handle then carries a null provider and the sentence
 * saying what to do about it. That is the same shape the other three connected peers have when they
 * are not set up, so the card, the picker and the offline reducer need no special case for this one.
 */
export async function macBrainHandle(vault: MacVault): Promise<{
  id: string;
  peer: "remote";
  provider: ModelProvider | null;
  readiness: Readiness;
}> {
  const off = (detail: string): { id: string; peer: "remote"; provider: null; readiness: Readiness } => ({
    id: REMOTE_PROVIDER_ID,
    peer: "remote",
    provider: null,
    readiness: { ready: false, reason: "credential", detail },
  });
  if (!relayConfigured()) return off("this build has no relay origin");
  const target = chosenMacTarget();
  if (!target) return off("connect this browser to your Mac");

  sealedToken = vault.unlocked ? (await vault.get(RELAY_TOKEN_SECRET).catch(() => ""))?.trim() || null : null;
  if (!sealedToken) return off(vault.unlocked ? "add your relay key on the Mac card" : "unlock your vault");

  const key = `${target.engineFp}|${target.agentId}`;
  if (!built || built.key !== key) {
    const label = chosenMacLabel();
    built = {
      key,
      provider: RemoteBrainProvider({
        id: REMOTE_PROVIDER_ID,
        ...(label ? { label } : {}),
        ...(macTargetSession.value ? { sessionId: macTargetSession.value } : {}),
        transport: createMacTransport({
          client: clientFor,
          target: chosenMacTarget,
          session: () => macTargetSession.value || undefined,
        }),
      }),
    };
  }
  return { id: REMOTE_PROVIDER_ID, peer: "remote", provider: built.provider, readiness: await built.provider.readiness() };
}
