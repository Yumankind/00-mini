/**
 * One DataChannel through Cloudflare Realtime's SFU — docs/HANDOFF-infinite-agent.md §7.1.
 *
 * WHY AN SFU AND NOT A DIRECT PEER CONNECTION. "Neither device needs a direct path to the other (a
 * phone on cellular and a desktop behind NAT both dial the nearest edge), and the worker never
 * carries the bytes itself." Both peers make an ordinary outbound connection to Cloudflare's edge;
 * one publishes a named DataChannel, the other pulls it. No STUN dance between the two devices, no
 * TURN bill, and nothing to open on anybody's router.
 *
 * WHY EVERY WEBRTC TYPE IS AN INTERFACE HERE. Node has no `RTCPeerConnection`, and the test rig for
 * this app is node by rule (vitest.config.ts). So the ONLY WebRTC in the app is `browserWebRtc`
 * below — twenty lines that call the real constructor — and everything above it takes a `WebRtc`
 * factory. The negotiation, the SFU calls, the ordering and the failure paths are then testable
 * without a browser, which is the difference between this module being covered and being hoped for.
 *
 * THE API IT SPEAKS, taken from the docs on 2026-09-10 (not from memory):
 *   https://developers.cloudflare.com/realtime/datachannels/  and  /realtime/https-api/
 *   OpenAPI: https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml
 *   POST {base}/sessions/{sessionId}/datachannels/establish
 *        { dataChannel: { location: "remote", dataChannelName: "server-events" } }
 *        → { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp }, dataChannel: { id } }
 *   PUT  {base}/sessions/{sessionId}/renegotiate   { sessionDescription: { type: "answer", sdp } }
 *   POST {base}/sessions/{sessionId}/datachannels/new
 *        publisher:  { dataChannels: [{ location: "local",  dataChannelName, ordered: true }] }
 *        subscriber: { dataChannels: [{ location: "remote", sessionId: <publisher>, dataChannelName,
 *                                       ordered: true, canReply: true }] }
 *        → { dataChannels: [{ id }] }
 *   PUT  {base}/sessions/{sessionId}/datachannels/close  { dataChannels: [{ id }] }
 * `{base}` already carries `/apps/{appId}`; the session itself was minted by the worker (§9.4: "the
 * worker mints per-room sessions and never joins one"), which is why `POST /sessions/new` is not
 * called from here and no app secret is ever in this bundle.
 *
 * TWO DETAILS THAT ARE NOT OPTIONAL, both from that page:
 *  · the DataChannel transport must be established (and its offer answered) BEFORE `datachannels/new`;
 *  · Realtime DataChannels are **negotiated**: the browser channel is created with
 *    `{ negotiated: true, id }` using the id the API returned, and the reliability settings are
 *    mirrored on both ends, because a negotiated channel learns nothing from the far side.
 * And one that is ours: the subscriber pulls with `canReply: true`, because this protocol's `ready`,
 * `ack` and `abort` travel back to the publisher on the same channel (§7.1's "B acks; A locks").
 */

import type { TransferChannel } from "@00/agent-fs";
import type { FetchLike, Room } from "./room-client.js";

/** The name the SFU reserves for its own control channel; establishing the transport pulls it. */
const SERVER_EVENTS = "server-events";

export class SfuError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SfuError";
  }
}

export interface SessionDescriptionLike {
  type: string;
  sdp?: string;
}

export interface DataChannelLike {
  readyState: string;
  binaryType?: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  id?: number | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export interface PeerConnectionLike {
  connectionState: string;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  createDataChannel(label: string, init: { negotiated: boolean; id: number; ordered: boolean }): DataChannelLike;
  close(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WebRtc {
  create(): PeerConnectionLike;
}

/** The only WebRTC in the app. Everything else takes this as a parameter. */
export const browserWebRtc: WebRtc = {
  create() {
    const Ctor = (globalThis as { RTCPeerConnection?: new (config: unknown) => unknown }).RTCPeerConnection;
    if (!Ctor) throw new SfuError("webrtc_unavailable", "this browser has no WebRTC, so a live transfer cannot run");
    // Cloudflare's own example's configuration: their STUN server, one bundled transport.
    return new Ctor({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    }) as PeerConnectionLike;
  },
};

export interface OpenChannelOptions {
  room: Room;
  /** `send` publishes the channel (`location: "local"`); `receive` pulls it. */
  role: "send" | "receive";
  rtc?: WebRtc;
  fetchImpl?: FetchLike;
  /** How long to wait for the peer connection and then for the channel. */
  timeoutMs?: number;
}

export interface OpenedChannel {
  channel: TransferChannel;
  /** Closes the DataChannel, the peer connection and the SFU-side channel, in that order. */
  close(): Promise<void>;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SfuError("sfu_malformed", `the SFU's ${what} was not an object`);
  }
  return value as Record<string, unknown>;
}

async function call(
  fetchImpl: FetchLike,
  token: string,
  url: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SfuError("sfu_unreachable", `the transfer relay could not be reached: ${String(err)}`);
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  // The SFU answers 200 with an `errorCode` as readily as it answers a status — both are failures.
  if (!res.ok || typeof record.errorCode === "string") {
    throw new SfuError(
      typeof record.errorCode === "string" ? record.errorCode : `http_${res.status}`,
      typeof record.errorDescription === "string" ? record.errorDescription : `the transfer relay answered ${res.status}`,
    );
  }
  return record;
}

function waitFor(
  target: { addEventListener(t: string, l: () => void): void; removeEventListener(t: string, l: () => void): void },
  events: string[],
  isReady: () => boolean,
  isFailed: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  if (isReady()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = (err?: SfuError): void => {
      clearTimeout(timer);
      for (const e of events) target.removeEventListener(e, listener);
      if (err) reject(err);
      else resolve();
    };
    const listener = (): void => {
      if (isReady()) done();
      else if (isFailed()) done(new SfuError("sfu_disconnected", `the ${what} failed before it was ready`));
    };
    const timer = setTimeout(() => done(new SfuError("sfu_timeout", `the ${what} did not come up in time`)), timeoutMs);
    for (const e of events) target.addEventListener(e, listener);
    listener();
  });
}

function requireId(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_534) {
    throw new SfuError("sfu_malformed", `the SFU returned no usable id for the ${what}`);
  }
  return value;
}

/**
 * The `TransferChannel` of the wire, over one browser DataChannel.
 *
 * WHY IT BUFFERS BEFORE ANYONE IS LISTENING. The channel opens, and only THEN does the caller start
 * the protocol — an `await` later, at best. The far side may already have spoken: the receiver's
 * `ready` is sent the instant its own channel opens, and on a fast link that is inside the sender's
 * gap. A `message` event with no listener is gone for good, and what a person sees is a transfer
 * that never starts. So the listener goes on HERE, at adapt time, and whatever arrives before the
 * first subscriber is kept and handed over in order.
 */
function adapt(dc: DataChannelLike): TransferChannel {
  dc.binaryType = "arraybuffer";
  const handlers = new Set<(data: string | Uint8Array) => void>();
  const pending: (string | Uint8Array)[] = [];
  const deliver = (data: string | Uint8Array): void => {
    if (handlers.size === 0) {
      pending.push(data);
      return;
    }
    for (const h of [...handlers]) h(data);
  };
  dc.addEventListener("message", (event: { data?: unknown }) => {
    const data = event.data;
    if (typeof data === "string") deliver(data);
    else if (data instanceof ArrayBuffer) deliver(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  });
  return {
    send(data) {
      // A Uint8Array view is copied into its own buffer: `send` on a view of a larger buffer is
      // legal but sends the WHOLE buffer in some engines, which would leak the neighbouring chunk.
      dc.send(typeof data === "string" ? data : (data.slice().buffer as ArrayBuffer));
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value: number) {
      dc.bufferedAmountLowThreshold = value;
    },
    onMessage(handler) {
      handlers.add(handler);
      if (pending.length > 0) {
        const queued = pending.splice(0);
        for (const data of queued) handler(data);
      }
      return () => handlers.delete(handler);
    },
    onBufferedAmountLow(handler) {
      const listener = (): void => handler();
      dc.addEventListener("bufferedamountlow", listener);
      return () => dc.removeEventListener("bufferedamountlow", listener);
    },
    onClose(handler) {
      const listener = (): void => handler();
      dc.addEventListener("close", listener);
      return () => dc.removeEventListener("close", listener);
    },
    close() {
      dc.close();
    },
  };
}

/**
 * Bring up one negotiated DataChannel on this room and hand back the protocol's transport.
 *
 * Everything is ordered and reliable: the bundle is a file, and a file with a hole in it is not a
 * smaller file. The wire's own sequence numbers are the belt to this transport's braces.
 */
export async function openTransferChannel(opts: OpenChannelOptions): Promise<OpenedChannel> {
  const { room, role } = opts;
  const rtc = opts.rtc ?? browserWebRtc;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const base = `${room.sfu.apiBase}/sessions/${encodeURIComponent(room.sfu.sessionId)}`;
  const pc = rtc.create();
  let channelId: number | null = null;

  const close = async (): Promise<void> => {
    if (channelId !== null) {
      try {
        await call(fetchImpl, room.sfu.token, `${base}/datachannels/close`, "PUT", {
          dataChannels: [{ id: channelId }],
        });
      } catch {
        /* the room dies in ten minutes either way; a failed tidy-up is not the person's problem */
      }
    }
    pc.close();
  };

  try {
    // 1. The transport. The SFU offers, we answer, and the answer goes back on `renegotiate`.
    const established = await call(fetchImpl, room.sfu.token, `${base}/datachannels/establish`, "POST", {
      dataChannel: { location: "remote", dataChannelName: SERVER_EVENTS },
    });
    const offer = asRecord(established.sessionDescription, "offer");
    if (offer.type !== "offer" || typeof offer.sdp !== "string") {
      throw new SfuError("sfu_malformed", "the SFU did not offer a session description");
    }
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (answer.type !== "answer" || !answer.sdp) {
      throw new SfuError("webrtc_no_answer", "this browser did not produce a complete WebRTC answer");
    }
    await call(fetchImpl, room.sfu.token, `${base}/renegotiate`, "PUT", {
      sessionDescription: { type: "answer", sdp: answer.sdp },
    });
    await waitFor(
      pc,
      ["connectionstatechange"],
      () => pc.connectionState === "connected",
      () => pc.connectionState === "failed" || pc.connectionState === "closed",
      timeoutMs,
      "connection to the transfer relay",
    );

    // 2. The one channel this room is for.
    const publish =
      role === "send"
        ? { location: "local", dataChannelName: room.channel, ordered: true }
        : {
            location: "remote",
            sessionId: room.publisherSessionId,
            dataChannelName: room.channel,
            ordered: true,
            // The receiver answers on the same channel; without this the SFU drops every reply,
            // and "A locks its copy" would never happen.
            canReply: true,
          };
    const created = await call(fetchImpl, room.sfu.token, `${base}/datachannels/new`, "POST", {
      dataChannels: [publish],
    });
    const list = created.dataChannels;
    if (!Array.isArray(list) || list.length !== 1) {
      throw new SfuError("sfu_malformed", "the SFU did not answer with exactly one DataChannel");
    }
    const first = asRecord(list[0], "DataChannel");
    if (typeof first.errorCode === "string") {
      throw new SfuError(first.errorCode, typeof first.errorDescription === "string" ? first.errorDescription : "the SFU refused the channel");
    }
    channelId = requireId(first.id, "DataChannel");

    // 3. The browser side of a NEGOTIATED channel: the id comes from the API, not from a handshake.
    const dc = pc.createDataChannel(room.channel, { negotiated: true, id: channelId, ordered: true });
    await waitFor(
      dc,
      ["open", "close", "error"],
      () => dc.readyState === "open",
      () => dc.readyState === "closing" || dc.readyState === "closed",
      timeoutMs,
      "transfer channel",
    );
    return { channel: adapt(dc), close };
  } catch (err) {
    await close();
    throw err;
  }
}
