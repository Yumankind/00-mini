/**
 * THE BROWSER AS A MOBILE-CONNECT CLIENT — §8.4's first door: drive the Mac's agent from here.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────────────
 *
 * It is the Flutter app's client half, in TypeScript, over the same relay and the same `00mc/3`
 * frames. The Mac cannot tell the difference and does not need to: to the engine this browser is a
 * `ph-…` device like any other, and `docs/HANDOFF-infinite-agent.md` §8.4 is explicit that the browser
 * is a SHARED DEVICE — it talks to an agent and never configures one.
 *
 * ── THERE IS NO "JOIN WITH A CODE", AND THAT IS THE DESIGN ──────────────────────────────────────
 *
 * The obvious shape for a browser would be a pairing code typed into a box. It is exactly the shape
 * this protocol refuses. A session is started AT THE MAC by the operator sitting in front of it, who
 * names which enrolled device it admits; nothing off that machine can ask for access, because a
 * request-to-connect is a queue an attacker can join. So the flow here is:
 *
 *   1. this browser enrols its public key (`POST /api/engines/devices`) — that is all it may do;
 *   2. the operator opens 00 on the Mac, starts mobile connect, and ADMITS this browser by name;
 *   3. both ends independently DERIVE the glance code and the person compares two screens.
 *
 * The code is never sent, never received and never entered. It is derived from (sessionId, engine
 * public key, this browser's public key) at both ends precisely so a relay that swapped a key shows
 * two different numbers. A code the relay chose would prove nothing — it could show both screens the
 * same one while standing in the middle — which is why `glanceFor()` computes and `nothing` posts.
 *
 * ── `approve` IS NOT HERE, AND THIS IS THE NOTE EXPLAINING THE HOLE ─────────────────────────────
 *
 * The engine refuses `approve` by name. A permission prompt is the moment the agent asks to do
 * something it is not otherwise allowed to do, and answering that over a relay — in a browser tab,
 * out of context, possibly hours later — needs its own design pass rather than a button bolted onto a
 * chat box. Until that design exists, permission prompts are answered at the Mac.
 */
import { MAX_PAYLOAD_BYTES, RESULT_POLL_MS, RESULT_TIMEOUT_MS } from "./config.js";
import { relayFailure, type Relay } from "./relay.js";
import {
  b64uDecode,
  decodePayload,
  glanceCode,
  mintFrameId,
  parseWireFrame,
  toWireFrame,
  verifySignature,
  type Frame,
  type FrameKind,
  type WireIdentity,
} from "./wire.js";

/** A refusal this module NAMES. Every failure a person can act on differently gets its own code —
 *  "go and admit this browser at your Mac" is a different instruction from "your session expired". */
export class MacClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MacClientError";
  }
}

/** One Mac session this browser may drive. `engineFp` IS the session id: the engine publishes itself
 *  under the session's own fingerprint, one row per session, so a leaked key is worth one session. */
export interface EngineRow {
  engineFp: string;
  label?: string;
  /** The engine's PUBLIC key. It travels; the glance code derived from it never does. */
  deviceKey: string;
  agents: { agentId: string; displayName?: string | null }[];
}

/** One Mac, whether or not it has a live session — the phone's home screen, and ours. */
export interface HubRow {
  machineFp: string;
  label?: string;
  agents: { agentId: string; displayName?: string | null; emoji?: string | null }[];
}

export interface MacSessionRow {
  id: string;
  title: string;
  updatedAt: number;
}

export interface MacClientOptions {
  relay: Relay;
  identity: WireIdentity;
  now?: () => number;
  newFrameId?: () => string;
}

const enc = new TextEncoder();

export function createMacClient(opts: MacClientOptions) {
  const { relay, identity } = opts;
  const now = opts.now ?? (() => Date.now());
  const newFrameId = opts.newFrameId ?? mintFrameId;

  /** Enrol this browser's public key. The private half appears in no request, here or anywhere. */
  async function enrol(label?: string): Promise<void> {
    const r = await relay("POST", "/api/engines/devices", {
      dev: identity.dev,
      deviceKey: identity.publicKeyB64u,
      ...(label && label.trim() ? { label: label.trim() } : {}),
    });
    if (!r.ok) {
      const f = relayFailure(r);
      throw new MacClientError(f.code ?? "enrol_failed", f.error, r.status);
    }
  }

  /** The Macs this account can reach: `engines` are the sessions that may be driven, `hubs` are the
   *  machines and their opted-in agents whether or not a session exists. */
  async function listEngines(): Promise<{ engines: EngineRow[]; hubs: HubRow[] }> {
    const r = await relay("GET", "/api/engines");
    if (!r.ok) {
      const f = relayFailure(r);
      throw new MacClientError(f.code ?? "engines_failed", f.error, r.status);
    }
    const engines = Array.isArray(r.json.engines) ? (r.json.engines as EngineRow[]) : [];
    const hubs = Array.isArray(r.json.hubs) ? (r.json.hubs as HubRow[]) : [];
    return { engines, hubs };
  }

  /** The NAMED state for one (Mac, agent) — six of them, never conflated, because the fix differs. */
  async function status(engineFp: string, agentId: string): Promise<Record<string, unknown>> {
    const r = await relay(
      "GET",
      `/api/engines/${encodeURIComponent(engineFp)}/status?agentId=${encodeURIComponent(agentId)}`,
    );
    if (!r.ok) {
      const f = relayFailure(r);
      throw new MacClientError(f.code ?? "status_failed", f.error, r.status);
    }
    return r.json;
  }

  /** The four groups of four to compare with the Mac's screen. Derived here; posted nowhere. */
  function glanceFor(sessionId: string, engineDeviceKeyB64u: string): Promise<string> {
    return glanceCode(sessionId, engineDeviceKeyB64u, identity.publicKeyB64u);
  }

  // ── Sending ────────────────────────────────────────────────────────────────────────────────────

  interface SendInput {
    sessionId: string;
    engineFp: string;
    agentId: string;
    kind: FrameKind;
    payload?: string;
  }

  /**
   * Build, sign and enqueue one request frame.
   *
   * The frame is validated by `signingString` BEFORE it is signed — a newline in any field would let
   * the sender choose where the boundaries of an LF-joined string fall, so validating afterwards
   * would be validating a string someone else already picked.
   */
  async function send(input: SendInput): Promise<{ frameId: string; delivered: boolean; deliveryCode?: string }> {
    if (input.payload && enc.encode(input.payload).length > MAX_PAYLOAD_BYTES) {
      throw new MacClientError("payload_too_large", "That is larger than the relay will carry (256 KB).");
    }
    const frame: Frame = {
      dir: "req",
      dev: identity.dev,
      sessionId: input.sessionId,
      frameId: newFrameId(),
      engineFp: input.engineFp,
      agentId: input.agentId,
      kind: input.kind,
      ts: now(),
    };
    const { frame: wire, payloadB64u } = await toWireFrame(frame, input.payload, identity.privateKey);
    const r = await relay("POST", `/api/engines/${encodeURIComponent(input.engineFp)}/control`, {
      frame: wire,
      payload: payloadB64u,
    });
    if (!r.ok) {
      const f = relayFailure(r);
      throw new MacClientError(f.code ?? "send_failed", f.error, r.status);
    }
    // `delivered` is absent on frames that were not for the engine; a missing field is not a failed
    // delivery, so it reads as delivered only when it is explicitly false. A false one is REPORTED —
    // the frame is stored either way and the Mac drains it when it wakes, and a person told "your Mac
    // is asleep, it will get this" is in a different situation from one told nothing.
    return {
      frameId: frame.frameId,
      delivered: r.json.delivered === false ? false : true,
      ...(typeof r.json.deliveryCode === "string" ? { deliveryCode: r.json.deliveryCode } : {}),
    };
  }

  const promptFrame = (to: { sessionId: string; engineFp: string; agentId: string }, text: string, targetSessionId?: string) =>
    send({
      ...to,
      kind: "prompt",
      payload: JSON.stringify({ text, ...(targetSessionId ? { sessionId: targetSessionId } : {}) }),
    });

  const sessionsListFrame = (to: { sessionId: string; engineFp: string; agentId: string }) =>
    send({ ...to, kind: "sessions.list" });

  /** `session.close` — no payload, which signs the empty-string hash. */
  const closeFrame = (to: { sessionId: string; engineFp: string; agentId: string }) =>
    send({ ...to, kind: "session.close" });

  // ── Receiving ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Pull and VERIFY the engine's answer to one frame.
   *
   * Every check below has to pass before a single byte becomes content:
   *   * the envelope is well formed and `dir` is `res`;
   *   * it is for THIS session, THIS engine and THIS agent, and answers THIS frame;
   *   * the signature verifies against the engine's `deviceKey` from `GET /api/engines`;
   *   * sha256 of the payload AS IT ARRIVED equals the hash the engine signed (that one is inside
   *     the signing string, so a rewritten payload fails as a bad signature — which is the point).
   *
   * The timestamp is deliberately NOT re-checked for skew: the relay already enforced the ±120 s
   * window when the engine posted, and re-applying it here would reject a good answer for the crime
   * of having been polled for three minutes.
   */
  async function pullResult(to: {
    sessionId: string;
    engineFp: string;
    agentId: string;
    frameId: string;
    engineDeviceKey: string;
  }): Promise<{ result?: unknown; error?: string }> {
    if (!to.engineDeviceKey.trim()) {
      throw new MacClientError(
        "engine_key_unknown",
        "No public key is known for this Mac, so an answer from it cannot be verified.",
      );
    }
    const r = await relay(
      "GET",
      `/api/engines/${encodeURIComponent(to.engineFp)}/control/${encodeURIComponent(to.frameId)}` +
        `?sessionId=${encodeURIComponent(to.sessionId)}&as=result`,
    );
    if (!r.ok) {
      const f = relayFailure(r);
      throw new MacClientError(f.code ?? "result_failed", f.error, r.status);
    }
    const frame = parseWireFrame(r.json.frame);
    if (!frame) throw new MacClientError("result_malformed", "The relay returned something that is not a frame.");
    if (frame.dir !== "res") throw new MacClientError("result_malformed", "That is a request, not an answer.");
    if (
      frame.sessionId !== to.sessionId ||
      frame.engineFp !== to.engineFp ||
      frame.agentId !== to.agentId ||
      frame.frameId !== to.frameId
    ) {
      throw new MacClientError("result_mismatch", "That answer belongs to a different exchange.");
    }
    const payload = decodePayload(r.json.payload);
    const ok = await verifySignature(frame, payload, frame.sig, b64uDecode(to.engineDeviceKey), frame.v);
    if (!ok) {
      throw new MacClientError(
        "result_unverified",
        "That answer is not signed by your Mac. It has been discarded.",
      );
    }
    const body = payload ? (JSON.parse(new TextDecoder().decode(payload)) as { result?: unknown; error?: string }) : {};
    return body;
  }

  /** Poll until the engine answers. `result_not_ready` is the normal case, not a failure. */
  async function awaitResult(
    to: { sessionId: string; engineFp: string; agentId: string; frameId: string; engineDeviceKey: string },
    wait: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<{ result?: unknown; error?: string }> {
    const timeoutMs = wait.timeoutMs ?? RESULT_TIMEOUT_MS;
    const intervalMs = wait.intervalMs ?? RESULT_POLL_MS;
    const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const deadline = now() + timeoutMs;
    for (;;) {
      try {
        return await pullResult(to);
      } catch (err) {
        // Anything else — a refusal, an ended session, an unverifiable answer — is FINAL and is
        // rethrown by name. Only "not yet" is worth waiting through.
        if (!(err instanceof MacClientError) || err.code !== "result_not_ready") throw err;
        if (now() >= deadline) {
          throw new MacClientError("result_timeout", "Your Mac has not answered in the time this pane waits.");
        }
        await sleep(intervalMs);
      }
    }
  }

  /**
   * Answers this browser did not wait around for — a tab that was closed mid-turn, a reload.
   *
   * The relay stores every frame either way, so an answer is never lost by not being present for it;
   * it is here, by the id of the request it answers, and each is then pulled and verified like any
   * other. This is the client-side twin of the engine's pending-frame drain.
   */
  async function pendingResultIds(to: { sessionId: string; engineFp: string; sinceMs: number }): Promise<string[]> {
    const r = await relay(
      "GET",
      `/api/engines/${encodeURIComponent(to.engineFp)}/control` +
        `?sessionId=${encodeURIComponent(to.sessionId)}&since=${to.sinceMs}&dir=res`,
    );
    if (!r.ok) return [];
    const frames = Array.isArray(r.json.frames) ? (r.json.frames as { inReplyTo?: string }[]) : [];
    return frames.map((f) => f.inReplyTo ?? "").filter((id) => id.length > 0);
  }

  /** There is NO `approve`, and this is the note explaining the hole. See the module header. */
  function refuseApprove(): never {
    throw new MacClientError(
      "approve_refused",
      "Permission prompts are answered at your Mac. This browser never sends an `approve` frame.",
    );
  }

  return {
    dev: identity.dev,
    publicKeyB64u: identity.publicKeyB64u,
    enrol,
    listEngines,
    status,
    glanceFor,
    prompt: promptFrame,
    listSessions: sessionsListFrame,
    close: closeFrame,
    pullResult,
    awaitResult,
    pendingResultIds,
    refuseApprove,
  };
}

export type MacClient = ReturnType<typeof createMacClient>;

/** The `{ sessions: [...] }` an engine answers `sessions.list` with, shaped for a picker. Tolerant
 *  on purpose: the Mac's own list has grown fields before and a picker should not break when it does. */
export function readSessionRows(result: unknown): MacSessionRow[] {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { sessions?: unknown })?.sessions)
      ? ((result as { sessions: unknown[] }).sessions)
      : [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      id: String(r.id ?? r.sessionId ?? ""),
      title: String(r.title ?? "Untitled"),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    }))
    .filter((r) => r.id.length > 0);
}

/** The text an answer carries, whatever shape the far end used for it. A `prompt` result from the
 *  Mac is the engine's handler return value, and that is not a shape this side gets to dictate. */
export function readAnswerText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.busy === true) return "Your Mac is busy with another turn. Try again in a moment.";
    for (const key of ["text", "answer", "output", "message"]) {
      if (typeof r[key] === "string") return r[key] as string;
    }
  }
  return JSON.stringify(result ?? null);
}
