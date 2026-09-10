/**
 * The browser as an engine (§8.5) — the half the shipped Flutter app talks to.
 *
 * Every test here drives it the way a phone does: a real signed `req` frame handed to `handleFrame`,
 * and the assertion is on the SIGNED ANSWER that comes back out. That is the only shape of test worth
 * writing for this module, because the whole promise of §8.5 is that the phone needs no change — so
 * what matters is not that our handlers ran but that what left the browser is a frame a phone will
 * verify and understand.
 */
import { describe, expect, it, vi } from "vitest";
import { SESSION_TTL_MS } from "@00/shared";
import {
  KIND_UNSUPPORTED,
  browserMachineFp,
  createBrowserEngine,
  type AnswerRuntime,
} from "../src/mac/answer.js";
import { b64uDecode, toWireFrame, verifySignature, type Frame, type FrameKind, type WireIdentity } from "../src/mac/wire.js";
import { fakeRelay, ok, refused, twoIdentities } from "./mac-helpers.js";

const NOW = 1_700_000_000_000;
const AGENT = "agent-01";
const ORIGIN = "https://app.example";

function fakeRuntime(over: Partial<AnswerRuntime> = {}): AnswerRuntime & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    run: async ({ prompt }) => {
      runs.push(prompt);
      return { text: `answered: ${prompt}`, sessionId: "1757000000000_abc" };
    },
    listSessions: async () => [{ id: "1757000000000_abc", title: "Yesterday", updatedAt: 42 }],
    ...over,
  } as AnswerRuntime & { runs: string[] };
}

async function harness(runtime: AnswerRuntime & { runs: string[] } = fakeRuntime()) {
  const { phone, engine: identity } = await twoIdentities();
  const relay = fakeRelay();
  relay.route("GET", "/devices", ok({ devices: [{ dev: phone.dev, deviceKey: phone.publicKeyB64u, label: "Phone" }] }));
  const engine = createBrowserEngine({
    relay: relay.relay,
    identity,
    agentId: AGENT,
    displayName: "Zero",
    emoji: "🟢",
    origin: ORIGIN,
    runtime,
    now: () => NOW,
  });
  return { phone, identity, relay, engine, runtime };
}

/** A frame from the phone, signed for real. */
async function fromPhone(
  phone: WireIdentity,
  sessionId: string,
  kind: FrameKind,
  payload?: string,
  over: Partial<Frame> = {},
): Promise<{ frame: unknown; payload: string }> {
  const frame: Frame = {
    dir: "req",
    dev: phone.dev,
    sessionId,
    frameId: `f-${kind.replace(/[^a-z]/g, "")}0000000000`.slice(0, 26),
    engineFp: sessionId,
    agentId: AGENT,
    kind,
    ts: NOW,
    ...over,
  };
  const wire = await toWireFrame(frame, payload, phone.privateKey);
  return { frame: wire.frame, payload: wire.payloadB64u };
}

/** The answer this browser posted, decoded and checked against its own signature. */
async function postedResult(
  relay: ReturnType<typeof fakeRelay>,
  identity: WireIdentity,
): Promise<{ signed: boolean; dir: unknown; kind: unknown; result?: unknown; error?: string } | null> {
  const call = relay.last("/result");
  if (!call) return null;
  const body = call.body as { frame: Record<string, unknown>; payload: string };
  const payload = b64uDecode(body.payload);
  const signed = await verifySignature(
    body.frame as unknown as Frame,
    payload,
    body.frame.sig as string,
    identity.publicKey,
    body.frame.v as string,
  );
  return { signed, dir: body.frame.dir, kind: body.frame.kind, ...(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>) };
}

describe("what the phone's home screen sees", () => {
  it("names this browser-hosted agent the way the Mac names a machine", async () => {
    const fp = await browserMachineFp(ORIGIN, AGENT);
    expect(fp).toMatch(/^hub-[0-9a-f]{24}$/);
    // Stable across reloads (same origin, same agent) and different for a different agent — which is
    // what stops the phone's list growing an entry every time a tab opens.
    expect(await browserMachineFp(ORIGIN, AGENT)).toBe(fp);
    expect(await browserMachineFp(ORIGIN, "agent-02")).not.toBe(fp);
    expect(await browserMachineFp("https://other.example", AGENT)).not.toBe(fp);
  });

  it("publishes only the agent it was mounted for, marked opted in", async () => {
    const { relay, engine } = await harness();
    expect(await engine.publishHub("Zero in this browser")).toBe(true);
    const body = relay.last("/api/engines/hub")?.body as Record<string, unknown>;
    expect(body.machineFp).toBe(await browserMachineFp(ORIGIN, AGENT));
    expect(body.agents).toEqual([{ agentId: AGENT, displayName: "Zero", mobileConnect: true, emoji: "🟢" }]);
  });

  it("enrols the session key under the session's own fingerprint", async () => {
    const { relay, engine, identity } = await harness();
    await engine.publishSession();
    const body = relay.last("/publish")?.body as Record<string, unknown>;
    expect(relay.last("/publish")?.path).toContain(engine.sessionId);
    expect(body).toEqual({
      dev: identity.dev,
      deviceKey: identity.publicKeyB64u,
      agents: [{ agentId: AGENT, mobileConnect: true }],
    });
    expect(engine.sessionId).toMatch(/^mc-[0-9a-f]{12}$/);
  });
});

describe("seating a session", () => {
  it("signs session.open at the instant the session starts, and pulls the phone's key", async () => {
    const { relay, engine, phone } = await harness();
    const opened = await engine.openSession(phone.dev);
    expect(opened).toMatchObject({ ok: true, startedAt: NOW, expiresAt: NOW + SESSION_TTL_MS });
    const body = relay.last("/control")?.body as { frame: Record<string, unknown>; payload: string; phoneDev: string };
    expect(body.frame.kind).toBe("session.open");
    // The relay anchors its 24-hour backstop on this `ts`, and the payload must agree with it — a
    // signature applied before a correction would cover a different number than the wire carries.
    expect(body.frame.ts).toBe(NOW);
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(body.payload)))).toEqual({ startedAt: NOW });
    expect(body.phoneDev).toBe(phone.dev);
    expect(engine.live).toBe(true);
  });

  it("derives the glance code from the key it PULLED, and sends it nowhere", async () => {
    const { relay, engine, phone } = await harness();
    await engine.openSession(phone.dev);
    const code = await engine.glance();
    expect(code).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(JSON.stringify(relay.calls)).not.toContain(code!);
  });

  it("refuses to seat a session for a phone the relay cannot name", async () => {
    const { relay, engine } = await harness();
    relay.route("GET", "/devices", ok({ devices: [] }));
    expect(await engine.openSession("ph-000000000000")).toMatchObject({ code: "unknown_phone" });
    expect(engine.live).toBe(false);
  });

  it("says so by name when it cannot enrol at all", async () => {
    const { relay, engine, phone } = await harness();
    relay.route("POST", "/publish", refused(401, "unauthorized"));
    expect(await engine.openSession(phone.dev)).toMatchObject({ code: "engine_unreachable" });
  });
});

describe("answering frames", () => {
  it("runs a prompt and answers the text, signed", async () => {
    const { engine, phone, relay, identity, runtime } = await harness();
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "hello" }));
    await engine.handleFrame(f.frame, f.payload);
    expect(runtime.runs).toEqual(["hello"]);
    const posted = await postedResult(relay, identity);
    expect(posted).toMatchObject({ signed: true, dir: "res", kind: "prompt" });
    expect(posted?.result).toMatchObject({ text: "answered: hello" });
  });

  it("aims a prompt at the session it names", async () => {
    const seen: (string | undefined)[] = [];
    const runtime = fakeRuntime({
      run: async ({ prompt, sessionId }) => {
        seen.push(sessionId);
        return { text: prompt, sessionId: sessionId ?? "new" };
      },
    });
    const { engine, phone } = await harness(runtime);
    await engine.openSession(phone.dev);
    const aimed = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "x", sessionId: "s-1" }));
    await engine.handleFrame(aimed.frame, aimed.payload);
    const loose = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "y" }), {
      frameId: "f-000000000000000000000002",
    });
    await engine.handleFrame(loose.frame, loose.payload);
    expect(seen).toEqual(["s-1", undefined]);
  });

  it("answers busy rather than queueing a second turn onto the same runtime", async () => {
    let release: (() => void) | null = null;
    const runtime = fakeRuntime({
      run: async ({ prompt }) => {
        await new Promise<void>((res) => {
          release = res;
        });
        return { text: prompt, sessionId: "s" };
      },
    });
    const { engine, phone, relay, identity } = await harness(runtime);
    await engine.openSession(phone.dev);
    const first = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "slow" }));
    const inFlight = engine.handleFrame(first.frame, first.payload);
    // The verify-then-execute path is asynchronous, so busy becomes true a few microtasks in — which
    // is exactly the window a second prompt can land in, and the reason this test exists.
    await vi.waitFor(() => expect(engine.busy).toBe(true));
    const second = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "quick" }), {
      frameId: "f-000000000000000000000003",
    });
    await engine.handleFrame(second.frame, second.payload);
    expect((await postedResult(relay, identity))?.result).toEqual({ busy: true });
    release!();
    await inFlight;
    expect(engine.busy).toBe(false);
  });

  it("lists the agent's sessions for the phone's picker", async () => {
    const { engine, phone, relay, identity } = await harness();
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, "sessions.list");
    await engine.handleFrame(f.frame, f.payload);
    expect((await postedResult(relay, identity))?.result).toEqual({
      sessions: [{ id: "1757000000000_abc", title: "Yesterday", updatedAt: 42 }],
    });
  });

  it("acknowledges session.close and stops being live", async () => {
    const { engine, phone, relay, identity } = await harness();
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, "session.close");
    await engine.handleFrame(f.frame, f.payload);
    expect((await postedResult(relay, identity))?.result).toEqual({ ok: true });
    expect(engine.live).toBe(false);
  });

  it("serves a retry from the cache rather than running the turn twice", async () => {
    const { engine, phone, runtime } = await harness();
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "once" }));
    await engine.handleFrame(f.frame, f.payload);
    await engine.handleFrame(f.frame, f.payload);
    expect(runtime.runs).toEqual(["once"]);
  });

  it("names a handler that blew up without leaking what it said", async () => {
    const runtime = fakeRuntime({
      run: async () => {
        throw new Error("/Users/someone/secret/path exploded");
      },
    });
    const { engine, phone, relay, identity } = await harness(runtime);
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "boom" }));
    await engine.handleFrame(f.frame, f.payload);
    const posted = await postedResult(relay, identity);
    expect(posted?.error).toBe("handler-failed");
    expect(JSON.stringify(posted)).not.toContain("secret/path");
  });
});

describe("what it refuses, by name", () => {
  it.each<FrameKind>(["approve", "skill-ui.list", "skill-ui.open"])("refuses %s with kind_unsupported", async (kind) => {
    const { engine, phone, relay, identity, runtime } = await harness();
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, kind, "{}");
    await engine.handleFrame(f.frame, f.payload);
    const posted = await postedResult(relay, identity);
    expect(posted?.error).toBe(KIND_UNSUPPORTED);
    expect(posted?.signed).toBe(true);
    expect(runtime.runs).toEqual([]);
  });

  it("will not be told to open a session by the far end", async () => {
    const { engine, phone, relay, identity } = await harness();
    await engine.openSession(phone.dev);
    const f = await fromPhone(phone, engine.sessionId, "session.open", JSON.stringify({ startedAt: NOW }));
    await engine.handleFrame(f.frame, f.payload);
    expect((await postedResult(relay, identity))?.error).toBe("session-open-not-receivable");
  });

  it("refuses a version it does not speak instead of reading it as a bad signature", async () => {
    const { engine, phone, relay, identity } = await harness();
    await engine.openSession(phone.dev);
    const f = (await fromPhone(phone, engine.sessionId, "prompt", '{"text":"hi"}')) as {
      frame: Record<string, unknown>;
      payload: string;
    };
    f.frame.v = "00mc/9";
    await engine.handleFrame(f.frame, f.payload);
    expect((await postedResult(relay, identity))?.error).toBe("version-unsupported");
  });

  it("checks the claimed payload hash against the bytes, not just the signature", async () => {
    const { engine, phone, relay, identity } = await harness();
    await engine.openSession(phone.dev);
    const f = (await fromPhone(phone, engine.sessionId, "prompt", '{"text":"hi"}')) as {
      frame: Record<string, unknown>;
      payload: string;
    };
    f.frame.payloadSha256 = "0".repeat(64);
    await engine.handleFrame(f.frame, f.payload);
    expect((await postedResult(relay, identity))?.error).toBe("payload-mismatch");
  });

  it("refuses a frame from a device this session never admitted", async () => {
    const { engine, phone, relay, identity } = await harness();
    await engine.openSession(phone.dev);
    const stranger = (await twoIdentities()).phone;
    relay.route("GET", "/devices", ok({ devices: [] }));
    const f = await fromPhone(stranger, engine.sessionId, "prompt", '{"text":"hi"}', { dev: stranger.dev });
    await engine.handleFrame(f.frame, f.payload);
    // The phone's key is already held, so a frame from another `dev` fails the signature check
    // against it — the refusal is named either way, which is what the phone can act on.
    expect(["signature", "unknown-device"]).toContain((await postedResult(relay, identity))?.error);
  });

  it("refuses everything while no session is seated", async () => {
    const { engine, phone, relay, identity } = await harness();
    const f = await fromPhone(phone, engine.sessionId, "prompt", '{"text":"hi"}');
    await engine.handleFrame(f.frame, f.payload);
    expect((await postedResult(relay, identity))?.error).toBe("unknown-device");
  });

  it("drops something that is not a frame at all without answering it", async () => {
    const { engine, relay } = await harness();
    await engine.handleFrame({ nonsense: true }, "");
    expect(relay.last("/result")).toBeUndefined();
  });
});

describe("the drain — what queued while the tab was shut", () => {
  it("pulls each queued frame, answers it, and moves the cursor past it", async () => {
    const { engine, phone, relay, runtime } = await harness();
    await engine.openSession(phone.dev);
    const queued = await fromPhone(phone, engine.sessionId, "prompt", JSON.stringify({ text: "while away" }));
    relay.route("GET", "&dir=req", ok({ frames: [{ frameId: "f-promptqueued00000000", receivedAt: NOW + 10 }] }));
    relay.route("GET", "/control/f-", ok({ frame: queued.frame, payload: queued.payload }));
    expect(await engine.drainPending()).toBe(1);
    expect(runtime.runs).toEqual(["while away"]);
    // The second sweep asks from the cursor, not from the session's start: the answered cache makes
    // an over-fetch harmless, but the cursor is what stops it being unbounded.
    relay.route("GET", "&dir=req", ok({ frames: [] }));
    await engine.drainPending();
    expect(relay.last("&dir=req")?.path).toContain(`since=${NOW + 10}`);
  });

  it("drains nothing while no session is seated, and survives a relay that refuses", async () => {
    const { engine, phone, relay } = await harness();
    expect(await engine.drainPending()).toBe(0);
    await engine.openSession(phone.dev);
    relay.route("GET", "&dir=req", refused(404, "session_not_found"));
    expect(await engine.drainPending()).toBe(0);
  });

  it("polls while the tab is open and stops when told, on the engine's own cadence", async () => {
    vi.useFakeTimers();
    try {
      const { engine, phone, relay } = await harness();
      await engine.openSession(phone.dev);
      const before = relay.calls.length;
      engine.start();
      engine.start(); // idempotent: a second card mount must not double the poll
      await vi.advanceTimersByTimeAsync(15_000);
      expect(relay.calls.length).toBeGreaterThan(before);
      const after = relay.calls.length;
      engine.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(relay.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a session that outlived a reload without trusting anything from it", async () => {
    const { engine } = await harness();
    engine.restore(NOW - 1000);
    expect(engine.live).toBe(true);
    expect(engine.expiresAt).toBe(NOW - 1000 + SESSION_TTL_MS);
    engine.restore(NOW - SESSION_TTL_MS - 1);
    expect(engine.live).toBe(false);
  });
});
