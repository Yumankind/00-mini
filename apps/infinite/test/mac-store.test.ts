/**
 * Both doors, driven the way the card drives them, over a relay that is a stub and an IndexedDB that
 * is a shim — but with REAL keys and REAL signatures at both ends.
 *
 * This is the test that says the wiring holds: the card calls nine functions and they either produce
 * a signed exchange or they do not. The individual refusals are pinned in `mac-client.test.ts` and
 * `mac-answer.test.ts`; what is pinned here is that a person clicking through Connections gets a key
 * generated, a device enrolled, an answer verified and a session seated, in that order.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetMacStateForTests,
  admitPhone,
  chooseMac,
  chooseMacSession,
  closeMacSession,
  connectAsClient,
  loadMacSessions,
  macAnswering,
  macDev,
  macEngineGlance,
  macEngineSessionId,
  macEngines,
  macGlance,
  macPhones,
  macProblem,
  macRows,
  macSessionRows,
  macTargetSession,
  mountMac,
  saveRelayToken,
  sendToMac,
  startAnswering,
  stopAnswering,
} from "../src/mac/state.js";
import { b64uDecode, createIdentity, parseWireFrame, toWireFrame, type Frame, type WireIdentity } from "../src/mac/wire.js";
import { installFakeIndexedDb } from "./mac-helpers.js";

const MAC_SESSION = "mc-000011112222";
let restoreIdb: () => void;
let mac: WireIdentity;
let phone: WireIdentity;
let requests: { url: string; body: Record<string, unknown> | undefined }[];

/** The relay, as a `fetch`: it stores what the client posts and answers with frames the Mac signed. */
function installFakeRelay(): void {
  const pending = new Map<string, { frame: Frame; payload: string }>();
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ url: href, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (href.includes("/api/engines/devices")) return json({ ok: true });
    if (href.includes("/api/engines/hub")) return json({ ok: true });
    if (href.endsWith("/api/engines")) {
      return json({
        engines: [
          { engineFp: MAC_SESSION, label: "Bruno's Mac", deviceKey: mac.publicKeyB64u, agents: [{ agentId: "a-1", displayName: "Zero" }] },
        ],
        hubs: [],
      });
    }
    if (href.includes("/devices")) return json({ devices: [{ dev: phone.dev, deviceKey: phone.publicKeyB64u, label: "Phone" }] });
    if (href.includes("/publish")) return json({ ok: true });
    if (href.includes("as=result")) {
      const frameId = href.split("/control/")[1]?.split("?")[0] ?? "";
      const held = pending.get(frameId);
      if (!held) return json({ code: "result_not_ready", error: "not yet" }, 404);
      return json(held);
    }
    if (href.includes("/control")) {
      // The Mac's side of the exchange: answer whatever was just asked, signed with the Mac's key.
      const asked = parseWireFrame(body?.frame);
      if (!asked) return json({ ok: true });
      const result =
        asked.kind === "sessions.list"
          ? { sessions: [{ id: "1757000000000_abc", title: "Yesterday", updatedAt: 7 }] }
          : { text: "the Mac answered" };
      const answer: Frame = { ...asked, dir: "res", dev: MAC_SESSION };
      const signed = await toWireFrame(answer, JSON.stringify({ result }), mac.privateKey);
      pending.set(asked.frameId, { frame: signed.frame as unknown as Frame, payload: signed.payloadB64u });
      return json({ ok: true, sessionId: asked.sessionId, frameId: asked.frameId, startedAt: Date.now(), expiresAt: Date.now() });
    }
    return json({});
  }) as typeof fetch;
}

function fakeVault() {
  const store: Record<string, string> = {};
  return { unlocked: true, get: async (n: string) => store[n] ?? "", set: async (n: string, v: string) => void (store[n] = v) };
}

beforeEach(async () => {
  __resetMacStateForTests();
  restoreIdb = installFakeIndexedDb();
  requests = [];
  mac = (await createIdentity("mc")).identity;
  phone = (await createIdentity("ph")).identity;
  installFakeRelay();
  mountMac({
    agentId: "agent-01",
    displayName: "Zero",
    emoji: "🟢",
    runtime: {
      run: async ({ prompt }) => ({ text: `local: ${prompt}`, sessionId: "s-1" }),
      listSessions: async () => [],
    },
    vault: fakeVault(),
    origin: "https://app.example",
  });
  await saveRelayToken("ob_live_test");
});

afterEach(() => restoreIdb());

describe("driving the Mac from here (§8.4)", () => {
  it("mints a key, enrols it, and lists what the account can reach", async () => {
    await connectAsClient("This browser");
    expect(macProblem.value).toBeNull();
    expect(macDev.value).toMatch(/^ph-[0-9a-f]{12}$/);
    expect(macEngines.value).toHaveLength(1);
    const enrol = requests.find((r) => r.url.includes("/api/engines/devices"));
    expect(enrol?.body).toMatchObject({ dev: macDev.value });
    // The same browser keeps the same identity across a "reconnect" — re-keying would mean being
    // admitted at the Mac all over again.
    const first = macDev.value;
    await connectAsClient();
    expect(macDev.value).toBe(first);
  });

  it("derives a glance code for the Mac it was pointed at", async () => {
    await connectAsClient();
    await chooseMac(MAC_SESSION, "a-1");
    expect(macGlance.value).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(JSON.stringify(requests)).not.toContain(macGlance.value!);
  });

  it("sends a prompt and renders the answer it verified", async () => {
    await connectAsClient();
    await chooseMac(MAC_SESSION, "a-1");
    await sendToMac("what is on my desk?");
    expect(macRows.value.map((r) => [r.who, r.text])).toEqual([
      ["you", "what is on my desk?"],
      ["mac", "the Mac answered"],
    ]);
    expect(macProblem.value).toBeNull();
  });

  it("says nothing at all when there is no Mac chosen, rather than sending into the void", async () => {
    await connectAsClient();
    await sendToMac("hello");
    expect(macRows.value).toEqual([]);
  });

  it("lists the agent's sessions and aims the next prompt at the one chosen", async () => {
    await connectAsClient();
    await chooseMac(MAC_SESSION, "a-1");
    await loadMacSessions();
    expect(macSessionRows.value).toEqual([{ id: "1757000000000_abc", title: "Yesterday", updatedAt: 7 }]);
    chooseMacSession("1757000000000_abc");
    expect(macTargetSession.value).toBe("1757000000000_abc");
    await sendToMac("carry on");
    const posted = requests.filter((r) => r.url.includes("/control") && r.body?.frame).pop();
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(String(posted?.body?.payload))));
    expect(payload).toEqual({ text: "carry on", sessionId: "1757000000000_abc" });
  });

  it("closes the session and forgets what it was pointed at", async () => {
    await connectAsClient();
    await chooseMac(MAC_SESSION, "a-1");
    await closeMacSession();
    expect(macGlance.value).toBeNull();
    expect(macTargetSession.value).toBe("");
    const closed = requests.filter((r) => (r.body?.frame as { kind?: string })?.kind === "session.close");
    expect(closed).toHaveLength(1);
  });
});

describe("letting the phone reach this agent (§8.5)", () => {
  it("publishes a hub, enrols a session key and offers the enrolled phones", async () => {
    await startAnswering();
    expect(macAnswering.value).toBe(true);
    expect(macEngineSessionId.value).toMatch(/^mc-[0-9a-f]{12}$/);
    expect(requests.some((r) => r.url.includes("/api/engines/hub"))).toBe(true);
    expect(macPhones.value).toEqual([{ dev: phone.dev, label: "Phone" }]);
  });

  it("admits a named phone and shows the code to compare with it", async () => {
    await startAnswering();
    await admitPhone(phone.dev);
    expect(macProblem.value).toBeNull();
    expect(macEngineGlance.value).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(JSON.stringify(requests)).not.toContain(macEngineGlance.value!);
    stopAnswering();
    expect(macAnswering.value).toBe(false);
    expect(macEngineGlance.value).toBeNull();
  });
});
