/**
 * The Mac's agent as a brain, on the wire it already speaks (§8.4's second door).
 *
 * `packages/agent-models/test/remote.test.ts` pins what a conversation becomes and what a refusal
 * means; this file pins the half that touches the relay: WHICH FRAME IS BUILT, that the answer is
 * the verified one, and that the three states a person is told apart — busy, asleep, refused — each
 * arrive as themselves rather than as text in a bubble.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RemoteEvent } from "@00/agent-models";
import { createMacClient, type MacClient } from "../src/mac/client.js";
import {
  __resetMacBrainForTests,
  chosenMacLabel,
  chosenMacTarget,
  createMacTransport,
  macBrainHandle,
  type MacTarget,
} from "../src/mac/transport.js";
import { __resetMacStateForTests } from "../src/mac/state.js";
import { toWireFrame, type WireIdentity } from "../src/mac/wire.js";
import { fakeRelay, ok, refused, twoIdentities } from "./mac-helpers.js";

const NOW = 1_700_000_000_000;
const SESSION = "mc-aabbccddeeff";
const AGENT = "agent-01";

/**
 * A relay that answers a `prompt` (or any other) frame the way the Mac would: with a SIGNED result
 * carrying whatever body the test names, addressed to the frame that was actually sent. The frame id
 * is fixed rather than minted so the answer can be signed up front — the client takes that seam.
 */
const FRAME = "f-000000000000000000000001";

async function harness(body: unknown | { error: string }) {
  const { phone, engine } = await twoIdentities();
  const relay = fakeRelay();
  const client = createMacClient({ relay: relay.relay, identity: phone, now: () => NOW, newFrameId: () => FRAME });
  const to: MacTarget = { sessionId: SESSION, engineFp: SESSION, agentId: AGENT, engineDeviceKey: engine.publicKeyB64u };

  let delivered = true;
  relay.route("POST", "/control", () =>
    ok(delivered ? { ok: true } : { ok: true, delivered: false, deliveryCode: "engine_not_connected" }),
  );
  relay.route("GET", "&as=result", ok(await answer(engine, FRAME, body)));

  const transport = createMacTransport({
    client: async () => client,
    target: () => to,
    wait: { timeoutMs: 50, intervalMs: 0, sleep: async () => {} },
    statusTtlMs: 0,
    now: () => NOW,
  });
  return { relay, client, to, engine, transport, asleep: () => (delivered = false) };
}

async function answer(engine: WireIdentity, frameId: string, body: unknown): Promise<{ frame: unknown; payload: string }> {
  const payload = JSON.stringify(body && typeof body === "object" && "error" in body ? body : { result: body });
  const wire = await toWireFrame(
    {
      dir: "res",
      dev: SESSION,
      sessionId: SESSION,
      frameId,
      engineFp: SESSION,
      agentId: AGENT,
      kind: "prompt",
      ts: NOW,
    },
    payload,
    engine.privateKey,
  );
  return { frame: wire.frame, payload: wire.payloadB64u };
}

/** The last frame this browser POSTED. `last("/control")` would find the result GET, not the send. */
function sent(relay: ReturnType<typeof fakeRelay>): { frame: Record<string, unknown>; payload: string } {
  const call = [...relay.calls].reverse().find((c) => c.method === "POST");
  return call?.body as { frame: Record<string, unknown>; payload: string };
}

async function drain(events: AsyncIterable<RemoteEvent>): Promise<RemoteEvent[]> {
  const out: RemoteEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(() => {
  __resetMacStateForTests();
  __resetMacBrainForTests();
});

describe("the frame a brain turn builds", () => {
  it("is one `prompt` aimed at the session the person picked", async () => {
    const h = await harness({ ok: true, text: "three files" });
    const transport = createMacTransport({
      client: async () => h.client as MacClient,
      target: () => h.to,
      session: () => "1757_target",
      wait: { timeoutMs: 50, intervalMs: 0, sleep: async () => {} },
    });
    await drain(transport.prompt("what is in the folder?", {}));

    const body = sent(h.relay);
    expect(body.frame.kind).toBe("prompt");
    expect(body.frame.dir).toBe("req");
    const payload = JSON.parse(atob(body.payload.replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload).toEqual({ text: "what is in the folder?", sessionId: "1757_target" });
  });

  it("aims at whatever the Mac is on when nobody picked a session", async () => {
    const h = await harness({ ok: true, text: "hi" });
    await drain(h.transport.prompt("hello", {}));
    const body = sent(h.relay);
    expect(JSON.parse(atob(body.payload.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ text: "hello" });
  });

  it("asks for the sessions with a `sessions.list` frame and no payload at all", async () => {
    const h = await harness({ sessions: [{ sessionId: "s1", title: "Ledger", mtime: 3 }] });
    const rows = await h.transport.sessions();
    const body = sent(h.relay);
    expect(body.frame.kind).toBe("sessions.list");
    expect(body.payload).toBe("");
    expect(rows).toEqual([{ id: "s1", title: "Ledger" }]);
  });
});

describe("the three answers a person is told apart", () => {
  it("carries the Mac's text back as one `done`, because this wire cannot stream", async () => {
    const h = await harness({ ok: true, text: "three files" });
    expect(await drain(h.transport.prompt("hi", {}))).toEqual([{ type: "done", text: "three files" }]);
  });

  it("names the far session when the Mac names one", async () => {
    const h = await harness({ ok: true, text: "done", sessionId: "1757_abc" });
    expect(await drain(h.transport.prompt("hi", {}))).toEqual([
      { type: "done", text: "done", sessionId: "1757_abc" },
    ]);
  });

  it("says BUSY for a Mac mid-turn — and for one that queued the prompt onto a running turn", async () => {
    const busy = await harness({ busy: true });
    expect(await drain(busy.transport.prompt("hi", {}))).toEqual([{ type: "busy" }]);
    // `{ queued: true }` is a fine answer for a chat box and useless for a brain: no answer to THIS
    // question is ever coming back, so it must not become a bubble reading `{"queued":true}`.
    const queued = await harness({ queued: true });
    expect(await drain(queued.transport.prompt("hi", {}))).toEqual([{ type: "busy" }]);
  });

  it("fails at once for a Mac that is asleep rather than waiting five minutes for it", async () => {
    const h = await harness({ ok: true, text: "never" });
    h.asleep();
    const events = await drain(h.transport.prompt("hi", {}));
    expect(events).toEqual([
      {
        type: "error",
        code: "engine_not_connected",
        message: "Your Mac is not connected right now, so its agent cannot answer this one.",
      },
    ]);
  });

  it("carries a named refusal through as an error, never as content", async () => {
    const h = await harness({ error: "kind_unsupported" });
    expect(await drain(h.transport.prompt("hi", {}))).toMatchObject([{ type: "error", code: "kind_unsupported" }]);
  });

  it("refuses an answer that is not signed by this Mac, by name", async () => {
    const h = await harness({ ok: true, text: "gotcha" });
    const impostor = (await twoIdentities()).engine;
    h.relay.route("GET", "&as=result", ok(await answer(impostor, FRAME, { ok: true, text: "gotcha" })));
    expect(await drain(h.transport.prompt("hi", {}))).toMatchObject([{ type: "error", code: "result_unverified" }]);
  });

  it("says the person pressed stop without sending anything", async () => {
    const h = await harness({ ok: true, text: "never" });
    const controller = new AbortController();
    controller.abort();
    expect(await drain(h.transport.prompt("hi", { signal: controller.signal }))).toMatchObject([
      { type: "error", code: "aborted" },
    ]);
    expect(h.relay.calls).toHaveLength(0);
  });

  it("says so, rather than throwing, when no Mac has been chosen at all", async () => {
    const h = await harness({ ok: true, text: "x" });
    const nowhere = createMacTransport({ client: async () => h.client as MacClient, target: () => null });
    expect(await drain(nowhere.prompt("hi", {}))).toMatchObject([{ type: "error", code: "no_mac_session" }]);
    expect(await nowhere.status()).toBe("off");
    await expect(nowhere.sessions()).rejects.toMatchObject({ code: "no_mac_session" });
  });
});

describe("is my Mac there", () => {
  it("is connected when the status route answers, and waiting when the relay refuses", async () => {
    const h = await harness({});
    h.relay.route("GET", "/status", ok({ online: true, agentId: AGENT }));
    expect(await h.transport.status()).toBe("connected");

    h.relay.route("GET", "/status", ok({ online: false }));
    expect(await h.transport.status()).toBe("waiting");

    h.relay.route("GET", "/status", refused(404, "engine_unreachable"));
    expect(await h.transport.status()).toBe("waiting");

    // A credential the relay will not take is a thing to go and fix, not a Mac that is asleep.
    h.relay.route("GET", "/status", refused(401, "unauthorized"));
    expect(await h.transport.status()).toBe("off");
  });

  it("holds the answer rather than asking the relay on every readiness poll", async () => {
    const { phone, engine } = await twoIdentities();
    const relay = fakeRelay();
    const client = createMacClient({ relay: relay.relay, identity: phone, now: () => NOW });
    relay.route("GET", "/status", ok({ online: true }));
    const transport = createMacTransport({
      client: async () => client,
      target: () => ({ sessionId: SESSION, engineFp: SESSION, agentId: AGENT, engineDeviceKey: engine.publicKeyB64u }),
      now: () => NOW,
    });
    await transport.status();
    await transport.status();
    await transport.status();
    expect(relay.calls.filter((c) => c.path.includes("/status"))).toHaveLength(1);
  });
});

describe("what the boot builds", () => {
  const vault = { unlocked: true, get: async () => "ob_live_secret" };

  it("builds nothing while no Mac has been chosen, and says which thing to do", async () => {
    const handle = await macBrainHandle(vault);
    expect(handle).toMatchObject({
      id: "remote-mac",
      peer: "remote",
      provider: null,
      readiness: { ready: false, reason: "credential", detail: "connect this browser to your Mac" },
    });
    expect(chosenMacTarget()).toBeNull();
    expect(chosenMacLabel()).toBeUndefined();
  });
});
