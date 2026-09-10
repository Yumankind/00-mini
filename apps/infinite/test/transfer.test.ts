// The live transfer's app half — the room, the SFU negotiation and the two orchestrations.
//
// No browser: `openTransferChannel` takes a `WebRtc` factory and a `fetch`, so the whole negotiation
// (establish → answer → renegotiate → datachannels/new → negotiated channel) is asserted here as a
// list of calls with their bodies. That list is the contract with Cloudflare Realtime, and it is the
// thing most likely to be got wrong from memory, so it is pinned rather than described.

import { describe, expect, it, vi } from "vitest";
import { deriveTransferKeys, receiveBundle, toBase64Url, type TransferChannel } from "@00/agent-fs";
import { infiniteApiBase, roomsConfigured } from "../src/transfer/config.js";
import { RoomError, createRoom, joinRoom, type Room } from "../src/transfer/room-client.js";
import {
  SfuError,
  openTransferChannel,
  type DataChannelLike,
  type PeerConnectionLike,
  type WebRtc,
} from "../src/transfer/sfu.js";
import { mountTransfer } from "../src/transfer/index.js";

const SALT = toBase64Url(new Uint8Array(16).fill(4));
const CODE = "acorn-basil-cedar-dawn-ember-falcon";

const ROOM_BODY = {
  code: CODE,
  roomId: "rm_1",
  salt: SALT,
  expiresAt: "2026-09-10T00:10:00.000Z",
  sfu: { sessionId: "sess_a", token: "tok_a" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ── config ───────────────────────────────────────────────────────────────────────────────────────

describe("where the room service is", () => {
  it("is one placeholder constant, and says so rather than pretending", () => {
    expect(infiniteApiBase()).toBe("https://infinite-rooms.invalid/infinite");
    expect(infiniteApiBase().endsWith("/")).toBe(false);
    expect(roomsConfigured()).toBe(false);
  });
});

// ── the room ─────────────────────────────────────────────────────────────────────────────────────

describe("the room client", () => {
  it("opens a room and never puts the code in a URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const room = await createRoom({
      base: "https://rooms.test/infinite",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(ROOM_BODY);
      },
    });
    expect(calls[0].url).toBe("https://rooms.test/infinite/rooms");
    expect(calls[0].url).not.toContain(CODE);
    expect(room.code).toBe(CODE);
    expect(room.channel).toBe("room-rm_1");
    expect(room.sfu.apiBase).toBe("https://rooms.test/infinite/rooms/rm_1/sfu");
  });

  it("joins with the code in the BODY, and takes the publisher's session id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const room = await joinRoom(CODE, {
      base: "https://rooms.test/infinite/",
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ ...ROOM_BODY, code: undefined, sfu: { sessionId: "sess_b", token: "tok_b", apiBase: "https://rtc.test/v1/apps/app1" }, publisher: { sessionId: "sess_a" }, channel: "chan-1" });
      },
    });
    expect(calls[0].url).toBe("https://rooms.test/infinite/rooms/join");
    expect(calls[0].url).not.toContain("acorn");
    expect(calls[0].body).toEqual({ code: CODE });
    expect(room.publisherSessionId).toBe("sess_a");
    expect(room.channel).toBe("chan-1");
    expect(room.code).toBe(CODE);
    expect(room.sfu.apiBase).toBe("https://rtc.test/v1/apps/app1");
  });

  it("refuses a room that is missing anything the transfer needs", async () => {
    const bad = [
      "not an object",
      { roomId: "r", salt: SALT },
      { roomId: "r", salt: SALT, sfu: { sessionId: "s" } },
      { roomId: "r", sfu: { sessionId: "s", token: "t" } },
      { salt: SALT, sfu: { sessionId: "s", token: "t" } },
    ];
    for (const body of bad) {
      await expect(
        createRoom({ base: "https://rooms.test", fetchImpl: async () => jsonResponse(body) }),
      ).rejects.toBeInstanceOf(RoomError);
    }
    await expect(
      createRoom({ base: "https://rooms.test", fetchImpl: async () => jsonResponse({ ...ROOM_BODY, code: "" }) }),
    ).rejects.toThrow(/minted no code/);
    await expect(
      joinRoom(CODE, { base: "https://rooms.test", fetchImpl: async () => jsonResponse(ROOM_BODY) }),
    ).rejects.toThrow(/no sender in it/);
  });

  it("carries the worker's own refusal, and survives one that is not JSON", async () => {
    await expect(
      joinRoom(CODE, {
        base: "https://rooms.test",
        fetchImpl: async () => jsonResponse({ code: "room_expired", error: "that code has expired" }, 410),
      }),
    ).rejects.toThrow(/that code has expired/);
    await expect(
      createRoom({ base: "https://rooms.test", fetchImpl: async () => new Response("nope", { status: 500 }) }),
    ).rejects.toThrow(/answered 500/);
    await expect(
      createRoom({
        base: "https://rooms.test",
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow(/could not be reached/);
  });
});

// ── the SFU ──────────────────────────────────────────────────────────────────────────────────────

class FakeDataChannel implements DataChannelLike {
  readyState = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<(e: { data?: unknown }) => void>>();
  readonly sent: (string | ArrayBuffer | ArrayBufferView)[] = [];

  constructor(readonly label: string, readonly init: { negotiated: boolean; id: number; ordered: boolean }) {}

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (e: { data?: unknown }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (e: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }
  open(): void {
    this.readyState = "open";
    this.emit("open");
  }
}

class FakePeer implements PeerConnectionLike {
  connectionState = "new";
  closed = false;
  channel: FakeDataChannel | null = null;
  remote: unknown = null;
  local: unknown = null;
  private readonly listeners = new Set<() => void>();

  async setRemoteDescription(d: unknown): Promise<void> {
    this.remote = d;
  }
  async createAnswer(): Promise<{ type: string; sdp?: string }> {
    return { type: "answer", sdp: "v=0 answer" };
  }
  async setLocalDescription(d: unknown): Promise<void> {
    this.local = d;
    // A real peer connects a moment later; the fake does it here so the wait has something to see.
    queueMicrotask(() => {
      this.connectionState = "connected";
      for (const l of [...this.listeners]) l();
    });
  }
  createDataChannel(label: string, init: { negotiated: boolean; id: number; ordered: boolean }): DataChannelLike {
    this.channel = new FakeDataChannel(label, init);
    queueMicrotask(() => this.channel?.open());
    return this.channel;
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
}

function sfuFetch(overrides: Record<string, unknown> = {}) {
  const calls: { url: string; method?: string; body: Record<string, unknown>; auth?: string }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)), auth: headers.authorization });
    if (url.endsWith("/datachannels/establish")) {
      return jsonResponse({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "v=0 offer" },
        dataChannel: { location: "remote", dataChannelName: "server-events", id: 0 },
      });
    }
    if (url.endsWith("/renegotiate")) return jsonResponse({});
    if (url.endsWith("/datachannels/new")) {
      return jsonResponse(overrides.new ?? { dataChannels: [{ dataChannelName: "room-rm_1", location: "local", id: 3 }] });
    }
    if (url.endsWith("/datachannels/close")) return jsonResponse({ dataChannels: [{ id: 3 }] });
    return jsonResponse({ errorCode: "unexpected_path" }, 404);
  };
  return { calls, impl };
}

const room: Room = {
  code: CODE,
  roomId: "rm_1",
  channel: "room-rm_1",
  salt: SALT,
  expiresAt: "",
  sfu: { sessionId: "sess_a", token: "tok_a", apiBase: "https://rtc.test/v1/apps/app1" },
  publisherSessionId: "sess_a",
};

describe("the SFU channel", () => {
  it("negotiates the way the Realtime docs say, then opens ONE negotiated channel", async () => {
    const { calls, impl } = sfuFetch();
    const peer = new FakePeer();
    const rtc: WebRtc = { create: () => peer };
    const opened = await openTransferChannel({ room, role: "send", rtc, fetchImpl: impl });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://rtc.test/v1/apps/app1/sessions/sess_a/datachannels/establish",
      "PUT https://rtc.test/v1/apps/app1/sessions/sess_a/renegotiate",
      "POST https://rtc.test/v1/apps/app1/sessions/sess_a/datachannels/new",
    ]);
    expect(calls[0].auth).toBe("Bearer tok_a");
    expect(calls[0].body).toEqual({ dataChannel: { location: "remote", dataChannelName: "server-events" } });
    expect(peer.remote).toEqual({ type: "offer", sdp: "v=0 offer" });
    expect(calls[1].body).toEqual({ sessionDescription: { type: "answer", sdp: "v=0 answer" } });
    expect(calls[2].body).toEqual({
      dataChannels: [{ location: "local", dataChannelName: "room-rm_1", ordered: true }],
    });
    expect(peer.channel?.init).toEqual({ negotiated: true, id: 3, ordered: true });
    expect(peer.channel?.label).toBe("room-rm_1");
    expect(peer.channel?.binaryType).toBe("arraybuffer");

    await opened.close();
    expect(calls.at(-1)?.url).toContain("/datachannels/close");
    expect(peer.closed).toBe(true);
  });

  it("pulls the publisher's channel with canReply, so the ack can come back", async () => {
    const { calls, impl } = sfuFetch({ new: { dataChannels: [{ id: 4 }] } });
    const peer = new FakePeer();
    await openTransferChannel({ room, role: "receive", rtc: { create: () => peer }, fetchImpl: impl });
    expect(calls[2].body).toEqual({
      dataChannels: [
        {
          location: "remote",
          sessionId: "sess_a",
          dataChannelName: "room-rm_1",
          ordered: true,
          canReply: true,
        },
      ],
    });
  });

  it("closes the peer connection on every refusal the SFU can send", async () => {
    const peer = new FakePeer();
    const rtc: WebRtc = { create: () => peer };
    // A 200 that carries an errorCode is a failure, and so is a missing offer or a missing id.
    for (const impl of [
      async () => jsonResponse({ errorCode: "session_gone", errorDescription: "no such session" }),
      async () => jsonResponse({ requiresImmediateRenegotiation: true }),
      async (url: string) =>
        url.endsWith("/datachannels/new")
          ? jsonResponse({ dataChannels: [{ errorCode: "channel_refused" }] })
          : jsonResponse({
              requiresImmediateRenegotiation: true,
              sessionDescription: { type: "offer", sdp: "v=0" },
              dataChannel: { id: 0 },
            }),
      async (url: string) =>
        url.endsWith("/datachannels/new")
          ? jsonResponse({ dataChannels: [{ id: "three" }] })
          : jsonResponse({
              requiresImmediateRenegotiation: true,
              sessionDescription: { type: "offer", sdp: "v=0" },
              dataChannel: { id: 0 },
            }),
    ]) {
      await expect(
        openTransferChannel({ room, role: "send", rtc, fetchImpl: impl as never }),
      ).rejects.toBeInstanceOf(SfuError);
      expect(peer.closed).toBe(true);
      peer.closed = false;
    }
  });

  it("gives up rather than hanging when the connection never comes up", async () => {
    const { impl } = sfuFetch();
    const peer = new FakePeer();
    peer.setLocalDescription = async () => {
      /* never connects */
    };
    await expect(
      openTransferChannel({ room, role: "send", rtc: { create: () => peer }, fetchImpl: impl, timeoutMs: 5 }),
    ).rejects.toThrow(/did not come up in time/);
  });

  it("hands the wire a channel that speaks bytes and strings", async () => {
    const { impl } = sfuFetch();
    const peer = new FakePeer();
    const opened = await openTransferChannel({ room, role: "send", rtc: { create: () => peer }, fetchImpl: impl });
    const dc = peer.channel!;
    const seen: (string | Uint8Array)[] = [];
    const off = opened.channel.onMessage((data) => seen.push(data));

    opened.channel.send("hello");
    opened.channel.send(new Uint8Array([1, 2, 3]));
    expect(dc.sent[0]).toBe("hello");
    expect(new Uint8Array(dc.sent[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

    dc.emit("message", { data: "text" });
    dc.emit("message", { data: new Uint8Array([7]).buffer });
    dc.emit("message", { data: new Uint8Array([8]) });
    dc.emit("message", { data: 42 });
    expect(seen).toEqual(["text", new Uint8Array([7]), new Uint8Array([8])]);

    off();
    dc.emit("message", { data: "ignored" });
    expect(seen).toHaveLength(3);

    let low = 0;
    let closed = 0;
    const offLow = opened.channel.onBufferedAmountLow(() => low++);
    const offClose = opened.channel.onClose(() => closed++);
    opened.channel.bufferedAmountLowThreshold = 99;
    expect(dc.bufferedAmountLowThreshold).toBe(99);
    expect(opened.channel.bufferedAmountLowThreshold).toBe(99);
    dc.bufferedAmount = 12;
    expect(opened.channel.bufferedAmount).toBe(12);
    dc.emit("bufferedamountlow");
    dc.emit("close");
    offLow();
    offClose();
    dc.emit("bufferedamountlow");
    expect([low, closed]).toEqual([1, 1]);

    opened.channel.close();
    expect(dc.closed).toBe(true);
  });
});

// ── the two orchestrations ───────────────────────────────────────────────────────────────────────

/** The same transport `adapt()` produces, including its buffer-before-anyone-listens rule. */
class LoopChannel implements TransferChannel {
  peer!: LoopChannel;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private readonly handlers = new Set<(d: string | Uint8Array) => void>();
  private readonly pending: (string | Uint8Array)[] = [];
  closedTimes = 0;

  send(data: string | Uint8Array): void {
    queueMicrotask(() => this.peer.deliver(data));
  }
  private deliver(data: string | Uint8Array): void {
    if (this.handlers.size === 0) {
      this.pending.push(data);
      return;
    }
    for (const h of [...this.handlers]) h(data);
  }
  onMessage(handler: (d: string | Uint8Array) => void): () => void {
    this.handlers.add(handler);
    for (const data of this.pending.splice(0)) handler(data);
    return () => this.handlers.delete(handler);
  }
  onBufferedAmountLow(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {
    this.closedTimes++;
  }
}

function loop(): [LoopChannel, LoopChannel] {
  const a = new LoopChannel();
  const b = new LoopChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("mountTransfer", () => {
  it("sends: room, code, confirmation, bytes, ack — and the receipt's file name", async () => {
    const [mine, theirs] = loop();
    const bundle = new Uint8Array(40 * 1024).fill(5);
    const phases: string[] = [];
    let shownCode = "";
    let shownConfirmation = "";
    const closes = vi.fn(async () => {});

    const api = mountTransfer({
      exportBundle: async (secret) => {
        expect(secret).toBe((await deriveTransferKeys(CODE, SALT)).secret);
        return bundle;
      },
      importBundle: async () => ({ agentId: "unused" }),
      hasAgent: () => false,
      profile: () => ({ id: "ag_1", displayName: "Zero Two", emoji: "🟢" }),
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      rooms: { create: async () => ({ ...room, sfu: { ...room.sfu } }) },
      open: async (opts) => {
        expect(opts.role).toBe("send");
        return { channel: mine, close: closes };
      },
    });

    const keys = await deriveTransferKeys(CODE, SALT);
    const [sent] = await Promise.all([
      api.send({
        hooks: {
          onCode: (c) => (shownCode = c),
          onConfirmation: (fp) => (shownConfirmation = fp),
          onPhase: (p) => phases.push(p),
        },
      }),
      receiveBundle(theirs, { fingerprint: keys.confirmation, land: async () => ({ agentId: "ag_1" }) }),
    ]);

    expect(shownCode).toBe(CODE);
    expect(shownConfirmation).toBe(keys.confirmation);
    expect(phases).toEqual(["opening", "packing", "waiting", "sending", "landing", "done"]);
    expect(sent.fileName).toBe("zero-two-2026-09-10.00agent");
    expect(sent.agentId).toBe("ag_1");
    expect(closes).toHaveBeenCalledOnce();
  });

  it("refuses to send when there is no agent, and closes the channel when a send fails", async () => {
    const noAgent = mountTransfer({
      exportBundle: async () => new Uint8Array(1),
      importBundle: async () => ({ agentId: "x" }),
      hasAgent: () => false,
      profile: () => null,
    });
    await expect(noAgent.send()).rejects.toThrow(/no agent in this browser/);

    const [mine, theirs] = loop();
    const closes = vi.fn(async () => {});
    const api = mountTransfer({
      exportBundle: async () => new Uint8Array(8),
      importBundle: async () => ({ agentId: "x" }),
      hasAgent: () => false,
      profile: () => ({ id: "a", displayName: "Zero", emoji: "🟢" }),
      rooms: { create: async () => ({ ...room }) },
      open: async () => ({ channel: mine, close: closes }),
    });
    const sending = api.send();
    // A peer that derived a different key: the send must refuse and still let go of the channel.
    theirs.send(JSON.stringify({ t: "ready", fp: "ZZZZ" }));
    await expect(sending).rejects.toThrow(/different key/);
    expect(closes).toHaveBeenCalledOnce();
  });

  it("receives: joins with the typed code, shows the confirmation, imports, acks", async () => {
    const [mine, theirs] = loop();
    const keys = await deriveTransferKeys(CODE, SALT);
    const bundle = new Uint8Array(20 * 1024).fill(9);
    const phases: string[] = [];
    const imported = vi.fn(async (_bytes: Uint8Array, _secret: string) => ({ agentId: "ag_landed" }));
    const confirmReplace = vi.fn(async () => true);

    const api = mountTransfer({
      exportBundle: async () => bundle,
      importBundle: imported,
      hasAgent: () => true,
      confirmReplace,
      profile: () => ({ id: "a", displayName: "Zero", emoji: "🟢" }),
      rooms: { join: async (code) => ({ ...room, code }) },
      open: async (opts) => {
        expect(opts.role).toBe("receive");
        return { channel: mine, close: async () => {} };
      },
    });

    const [received] = await Promise.all([
      api.receive(` ${CODE.toUpperCase()} `, { onPhase: (p) => phases.push(p) }),
      (async () => {
        const { sendBundle } = await import("@00/agent-fs");
        return sendBundle(theirs, { bytes: bundle, name: "zero.00agent", fingerprint: keys.confirmation });
      })(),
    ]);

    expect(received).toEqual({ agentId: "ag_landed", bytes: bundle.length, name: "zero.00agent" });
    expect(phases).toEqual(["joining", "waiting", "receiving", "importing", "done"]);
    expect(confirmReplace).toHaveBeenCalledOnce();
    expect(imported.mock.calls[0][1]).toBe(keys.secret);
  });

  it("refuses a code that is not six words before it reaches the worker", async () => {
    const join = vi.fn();
    const api = mountTransfer({
      exportBundle: async () => new Uint8Array(1),
      importBundle: async () => ({ agentId: "x" }),
      hasAgent: () => false,
      profile: () => null,
      rooms: { join },
    });
    await expect(api.receive("two words")).rejects.toThrow(/six-word code/);
    expect(join).not.toHaveBeenCalled();
  });

  it("does not import over an agent the person did not agree to replace", async () => {
    const [mine, theirs] = loop();
    const keys = await deriveTransferKeys(CODE, SALT);
    const bundle = new Uint8Array(1024).fill(1);
    const imported = vi.fn(async (_bytes: Uint8Array, _secret: string) => ({ agentId: "never" }));
    const api = mountTransfer({
      exportBundle: async () => bundle,
      importBundle: imported,
      hasAgent: () => true,
      confirmReplace: async () => false,
      profile: () => null,
      rooms: { join: async () => ({ ...room }) },
      open: async () => ({ channel: mine, close: async () => {} }),
    });
    const { sendBundle } = await import("@00/agent-fs");
    const results = await Promise.allSettled([
      api.receive(CODE),
      sendBundle(theirs, { bytes: bundle, name: "n", fingerprint: keys.confirmation }),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(imported).not.toHaveBeenCalled();
    expect((results[1] as PromiseRejectedResult).reason.reason).toBe("import_failed");
  });
});
