/**
 * The browser as a mobile-connect client (§8.4).
 *
 * What is worth pinning here is not "does it send a request" but WHAT IT SIGNS and WHAT IT ACCEPTS
 * BACK. A client that accepts an answer the relay wrote, or one for a different exchange, has quietly
 * turned a blind relay into a trusted one — so most of this file is about answers that must be
 * refused, and each refusal is checked BY NAME because the person's next move differs for each.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_PAYLOAD_HASH, MOBILE_CONNECT_VERSION, signingString, type Frame } from "@00/shared";
import {
  MacClientError,
  createMacClient,
  readAnswerText,
  readSessionRows,
} from "../src/mac/client.js";
import { createRelay } from "../src/mac/relay.js";
import { b64u, createIdentity, payloadHash, toWireFrame, type WireIdentity } from "../src/mac/wire.js";
import { fakeRelay, ok, refused, twoIdentities } from "./mac-helpers.js";

const NOW = 1_700_000_000_000;
const SESSION = "mc-aabbccddeeff";
const AGENT = "agent-01";

async function harness() {
  const { phone, engine } = await twoIdentities();
  const relay = fakeRelay();
  const client = createMacClient({ relay: relay.relay, identity: phone, now: () => NOW });
  return { phone, engine, relay, client };
}

/** One signed answer from the far end, as the relay would hand it back. */
async function answerFrom(
  engine: WireIdentity,
  over: Partial<Frame & { body: unknown; error: string }> = {},
): Promise<{ frame: unknown; payload: string }> {
  const body = "error" in over ? { error: over.error } : { result: over.body ?? { text: "done" } };
  const payload = JSON.stringify(body);
  const frame: Frame = {
    dir: "res",
    dev: SESSION,
    sessionId: SESSION,
    frameId: "f-000000000000000000000001",
    engineFp: SESSION,
    agentId: AGENT,
    kind: "prompt",
    ts: NOW,
    ...(over as Partial<Frame>),
  };
  const wire = await toWireFrame(frame, payload, engine.privateKey);
  return { frame: wire.frame, payload: wire.payloadB64u };
}

describe("enrolling and looking around", () => {
  it("sends the public half and never anything else", async () => {
    const { relay, client, phone } = await harness();
    await client.enrol("This browser");
    const call = relay.last("/api/engines/devices");
    expect(call?.body).toEqual({ dev: phone.dev, deviceKey: phone.publicKeyB64u, label: "This browser" });
    expect(JSON.stringify(call?.body)).not.toContain("privateKey");
  });

  it("turns a relay refusal into its named code", async () => {
    const { relay, client } = await harness();
    relay.route("POST", "/api/engines/devices", refused(401, "unauthorized", "No account identity."));
    await expect(client.enrol()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("reads engines and hubs, and tolerates a relay that sends neither", async () => {
    const { relay, client } = await harness();
    relay.route("GET", "/api/engines", ok({ engines: [{ engineFp: SESSION, deviceKey: "k", agents: [] }], hubs: [] }));
    expect((await client.listEngines()).engines).toHaveLength(1);
    relay.route("GET", "/api/engines", ok({}));
    expect(await client.listEngines()).toEqual({ engines: [], hubs: [] });
  });

  it("derives the glance code and posts it nowhere", async () => {
    const { relay, client, engine } = await harness();
    const code = await client.glanceFor(SESSION, engine.publicKeyB64u);
    expect(code).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(JSON.stringify(relay.calls)).not.toContain(code);
    expect(JSON.stringify(relay.calls)).not.toContain(code.replace(/ /g, ""));
  });
});

describe("the frames it builds", () => {
  const to = { sessionId: SESSION, engineFp: SESSION, agentId: AGENT };

  it("signs a prompt over exactly the ten frozen lines", async () => {
    const { relay, client, phone } = await harness();
    const sent = await client.prompt(to, "hello");
    const call = relay.last(`/api/engines/${SESSION}/control`);
    const frame = (call?.body as { frame: Record<string, unknown> }).frame;
    expect(frame.v).toBe(MOBILE_CONNECT_VERSION);
    expect(frame.dir).toBe("req");
    expect(frame.dev).toBe(phone.dev);
    expect(frame.kind).toBe("prompt");
    expect(frame.ts).toBe(NOW);
    expect(frame.frameId).toBe(sent.frameId);
    const payload = JSON.stringify({ text: "hello" });
    expect(frame.payloadSha256).toBe(await payloadHash(payload));
    expect(signingString(frame as unknown as Frame, frame.payloadSha256 as string).split("\n")).toHaveLength(10);
    expect((call?.body as { payload: string }).payload).toBe(b64u(new TextEncoder().encode(payload)));
  });

  it("aims a prompt at one of the agent's sessions when asked, and at none when not", async () => {
    const { relay, client } = await harness();
    await client.prompt(to, "hi", "1757000000000_abc");
    let payload = (relay.last("/control")?.body as { payload: string }).payload;
    expect(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      text: "hi",
      sessionId: "1757000000000_abc",
    });
    await client.prompt(to, "hi");
    payload = (relay.last("/control")?.body as { payload: string }).payload;
    expect(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ text: "hi" });
  });

  it("sends session.close and sessions.list with no payload at all", async () => {
    const { relay, client } = await harness();
    for (const send of [client.close, client.listSessions]) {
      await send(to);
      const body = relay.last("/control")?.body as { frame: Record<string, unknown>; payload: string };
      expect(body.payload).toBe("");
      expect(body.frame.payloadSha256).toBe(EMPTY_PAYLOAD_HASH);
    }
  });

  it("refuses a payload the relay would not carry, before signing it", async () => {
    const { client } = await harness();
    await expect(client.prompt(to, "x".repeat(300_000))).rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("reports a frame the Mac was not there for instead of calling it sent", async () => {
    const { relay, client } = await harness();
    relay.route("POST", "/control", ok({ ok: true, delivered: false, deliveryCode: "engine_not_connected" }));
    expect(await client.prompt(to, "hi")).toMatchObject({ delivered: false, deliveryCode: "engine_not_connected" });
    relay.route("POST", "/control", ok({ ok: true }));
    expect((await client.prompt(to, "hi")).delivered).toBe(true);
  });

  it("never sends approve — it refuses, by name, with the reason", async () => {
    const { client, relay } = await harness();
    expect(() => client.refuseApprove()).toThrow(MacClientError);
    try {
      client.refuseApprove();
    } catch (err) {
      expect((err as MacClientError).code).toBe("approve_refused");
      expect((err as MacClientError).message).toMatch(/answered at your Mac/);
    }
    expect(JSON.stringify(relay.calls)).not.toContain("approve");
  });
});

describe("the answers it will and will not accept", () => {
  const to = { sessionId: SESSION, engineFp: SESSION, agentId: AGENT, frameId: "f-000000000000000000000001" };

  it("accepts one signed by the Mac it is talking to", async () => {
    const { relay, client, engine } = await harness();
    relay.route("GET", "&as=result", ok(await answerFrom(engine)));
    const got = await client.pullResult({ ...to, engineDeviceKey: engine.publicKeyB64u });
    expect(got.result).toEqual({ text: "done" });
  });

  it("carries a named refusal through as an error rather than as content", async () => {
    const { relay, client, engine } = await harness();
    relay.route("GET", "&as=result", ok(await answerFrom(engine, { error: "kind_unsupported" })));
    expect(await client.pullResult({ ...to, engineDeviceKey: engine.publicKeyB64u })).toEqual({
      error: "kind_unsupported",
    });
  });

  it("discards an answer signed by anyone else", async () => {
    const { relay, client, engine } = await harness();
    const impostor = (await createIdentity("mc")).identity;
    relay.route("GET", "&as=result", ok(await answerFrom(impostor)));
    await expect(client.pullResult({ ...to, engineDeviceKey: engine.publicKeyB64u })).rejects.toMatchObject({
      code: "result_unverified",
    });
  });

  it("discards an answer whose payload the relay rewrote", async () => {
    const { relay, client, engine } = await harness();
    const good = await answerFrom(engine);
    relay.route("GET", "&as=result", ok({ ...good, payload: b64u(new TextEncoder().encode('{"result":"gotcha"}')) }));
    await expect(client.pullResult({ ...to, engineDeviceKey: engine.publicKeyB64u })).rejects.toMatchObject({
      code: "result_unverified",
    });
  });

  it("discards an answer for a different exchange, and a request wearing an answer's clothes", async () => {
    const { relay, client, engine } = await harness();
    relay.route("GET", "&as=result", ok(await answerFrom(engine, { agentId: "someone-else" })));
    await expect(client.pullResult({ ...to, engineDeviceKey: engine.publicKeyB64u })).rejects.toMatchObject({
      code: "result_mismatch",
    });
    relay.route("GET", "&as=result", ok(await answerFrom(engine, { dir: "req" })));
    await expect(client.pullResult({ ...to, engineDeviceKey: engine.publicKeyB64u })).rejects.toMatchObject({
      code: "result_malformed",
    });
  });

  it("refuses to verify anything at all without the Mac's public key", async () => {
    const { client } = await harness();
    await expect(client.pullResult({ ...to, engineDeviceKey: "  " })).rejects.toMatchObject({
      code: "engine_key_unknown",
    });
  });

  it("waits through `result_not_ready` and only through that", async () => {
    const { relay, client, engine } = await harness();
    let tries = 0;
    relay.route("GET", "&as=result", () => {
      tries += 1;
      return tries < 3 ? refused(404, "result_not_ready") : ok({ frame: null });
    });
    // The third answer is malformed on purpose: waiting must end at the first NON-"not yet" answer.
    await expect(
      client.awaitResult({ ...to, engineDeviceKey: engine.publicKeyB64u }, { intervalMs: 0, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "result_malformed" });
    expect(tries).toBe(3);
  });

  it("gives up with its own name once the wait is over", async () => {
    const { relay, client, engine } = await harness();
    relay.route("GET", "&as=result", refused(404, "result_not_ready"));
    await expect(
      client.awaitResult(
        { ...to, engineDeviceKey: engine.publicKeyB64u },
        { timeoutMs: 0, intervalMs: 0, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "result_timeout" });
  });

  it("finds answers it was not present for, by the request each replies to", async () => {
    const { relay, client } = await harness();
    relay.route("GET", "&dir=res", ok({ frames: [{ inReplyTo: "f-1" }, {}, { inReplyTo: "f-2" }] }));
    expect(await client.pendingResultIds({ sessionId: SESSION, engineFp: SESSION, sinceMs: 0 })).toEqual(["f-1", "f-2"]);
    relay.route("GET", "&dir=res", refused(404, "session_not_found"));
    expect(await client.pendingResultIds({ sessionId: SESSION, engineFp: SESSION, sinceMs: 0 })).toEqual([]);
  });
});

describe("reading what the far end sent", () => {
  it("shapes a session list without breaking when the Mac grows a field", () => {
    expect(readSessionRows({ sessions: [{ id: "a", title: "One", updatedAt: 5, extra: true }, { title: "no id" }] })).toEqual([
      { id: "a", title: "One", updatedAt: 5 },
    ]);
    expect(readSessionRows([{ sessionId: "b" }])).toEqual([{ id: "b", title: "Untitled", updatedAt: 0 }]);
    expect(readSessionRows("nonsense")).toEqual([]);
  });

  it("says busy in words a person can act on", () => {
    expect(readAnswerText({ busy: true })).toMatch(/busy/i);
    expect(readAnswerText({ text: "hello" })).toBe("hello");
    expect(readAnswerText("plain")).toBe("plain");
    expect(readAnswerText({ odd: 1 })).toBe('{"odd":1}');
  });
});

describe("the relay transport", () => {
  it("refuses to call anything without a credential, and says which", async () => {
    const relay = createRelay({ token: () => null, origin: "https://example.test", fetchImpl: async () => new Response() });
    expect(await relay("GET", "/api/engines")).toMatchObject({ status: 401, json: { code: "unauthorized" } });
  });

  it("turns an unreachable relay into a shape, never a throw", async () => {
    const relay = createRelay({
      token: () => "t",
      origin: "https://example.test",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(await relay("GET", "/api/engines")).toMatchObject({ ok: false, status: 0, json: { code: "unreachable" } });
  });

  it("sends the bearer and reads a body that is not JSON without falling over", async () => {
    let seen: RequestInit | undefined;
    const relay = createRelay({
      token: () => "tok",
      origin: "https://example.test",
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response("not json", { status: 500 });
      },
    });
    expect(await relay("POST", "/x", { a: 1 })).toMatchObject({ ok: false, status: 500, json: {} });
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(seen?.body).toBe('{"a":1}');
  });
});
