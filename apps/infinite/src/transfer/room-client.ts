/**
 * The room — docs/HANDOFF-infinite-agent.md §7.1 and §9.4.
 *
 * A room is a ten-minute, identity-free rendezvous held in the worker's KV: the sender opens one and
 * is given a six-word code; the receiver types the code and is given credentials for the SAME SFU
 * session pair. Nothing here carries an account, a device key or a name — "rooms carry no identity;
 * the code is what admits a peer, and it dies with the room".
 *
 * THE CODE IS NEVER IN A URL. It goes in the POST body, for the reason lib/move.ts states about the
 * Mac's deep link: a URL is written to access logs, to browser history and to whatever the OS shows
 * in an "open this?" prompt, and this code is the bundle's key (crypto.ts derives the secret from
 * it). Hence `POST /rooms/join { code }` and not `GET /rooms/<code>`.
 *
 * WHAT THIS MODULE ASSUMES, since the worker is being written in the other repo right now: the two
 * shapes below. They are the plan's `{ code, sfu: { sessionId, token } }` plus the three things the
 * plan implies but does not spell — the HKDF salt (§7.1 "the bundle key is HKDF(code, room salt)"),
 * the name of the one DataChannel ("ONE DataChannel named by the room"), and the publisher's session
 * id, which the joining peer needs to pull that channel (the SFU's `location: "remote"` takes the
 * publisher's session id, see sfu.ts). `apiBase` is optional and defaults to a worker-side proxy
 * path, so the SFU app id and secret never reach a browser.
 */

import { infiniteApiBase } from "./config.js";

/** What a peer needs to talk to the SFU. `apiBase` already includes the `/apps/<appId>` segment. */
export interface RoomSfu {
  sessionId: string;
  token: string;
  apiBase: string;
}

export interface Room {
  /** Present for the peer that CREATED the room; the joining peer already knows the code it typed. */
  code: string;
  roomId: string;
  /** The DataChannel's name. The room's, never the code's — a channel name reaches the SFU in clear. */
  channel: string;
  /** base64url; HKDF's salt. */
  salt: string;
  expiresAt: string;
  sfu: RoomSfu;
  /** The session that PUBLISHES the channel. Absent for the publisher itself (it is its own). */
  publisherSessionId?: string;
}

export class RoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The room service, as a pair of OPTIONAL methods rather than two different objects: a caller that
 * only sends supplies `create`, one that only receives supplies `join`, and `TransferDeps` (the
 * intersection of both halves) stays satisfiable by either. The default is the real client.
 */
export interface RoomService {
  create?(opts?: RoomClientOptions): Promise<Room>;
  join?(code: string, opts?: RoomClientOptions): Promise<Room>;
}

export interface RoomClientOptions {
  base?: string;
  fetchImpl?: FetchLike;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Everything the worker sends is read defensively: it is another repo's code, on another schedule. */
function parseRoom(payload: unknown, fallbackCode: string, base: string): Room {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RoomError("room_malformed", "the room service answered something that is not a room");
  }
  const raw = payload as Record<string, unknown>;
  const sfuRaw = raw.sfu;
  if (!sfuRaw || typeof sfuRaw !== "object" || Array.isArray(sfuRaw)) {
    throw new RoomError("room_malformed", "the room service sent no SFU credentials");
  }
  const sfu = sfuRaw as Record<string, unknown>;
  const sessionId = str(sfu, "sessionId");
  const token = str(sfu, "token");
  const salt = str(raw, "salt");
  const roomId = str(raw, "roomId") ?? str(raw, "id");
  if (!sessionId || !token) throw new RoomError("room_malformed", "the SFU credentials are incomplete");
  if (!salt) throw new RoomError("room_malformed", "the room sent no salt, so no key can be derived");
  if (!roomId) throw new RoomError("room_malformed", "the room has no id");
  const publisher = raw.publisher;
  const publisherSessionId =
    str(raw, "publisherSessionId") ??
    (publisher && typeof publisher === "object" && !Array.isArray(publisher)
      ? str(publisher as Record<string, unknown>, "sessionId")
      : undefined);
  return {
    code: str(raw, "code") ?? fallbackCode,
    roomId,
    // A room that does not name its channel is served by its id, which both peers know and which is
    // not a secret. Never the code.
    channel: str(raw, "channel") ?? `room-${roomId}`,
    salt,
    expiresAt: str(raw, "expiresAt") ?? "",
    sfu: {
      sessionId,
      token,
      // The default keeps the app id and the app secret in the worker: the browser talks to a
      // per-room proxy that speaks the SFU's own paths. A deployment that would rather hand out a
      // real rtc.live token just sends `apiBase`.
      apiBase: (str(sfu, "apiBase") ?? `${base}/rooms/${roomId}/sfu`).replace(/\/+$/, ""),
    },
    ...(publisherSessionId ? { publisherSessionId } : {}),
  };
}

async function post(url: string, body: unknown, fetchImpl: FetchLike): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new RoomError("room_unreachable", `the room service could not be reached: ${String(err)}`);
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const named =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    throw new RoomError(
      str(named, "code") ?? `http_${res.status}`,
      str(named, "error") ?? `the room service answered ${res.status}`,
    );
  }
  return payload;
}

/** The sending device: open a room and get the code to read out. No account, no identity. */
export async function createRoom(opts: RoomClientOptions = {}): Promise<Room> {
  const base = (opts.base ?? infiniteApiBase()).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const payload = await post(`${base}/rooms`, {}, fetchImpl);
  const room = parseRoom(payload, "", base);
  if (!room.code) throw new RoomError("room_malformed", "the room service minted no code");
  return room;
}

/** The receiving device: the person typed the code, and this is the only place it is ever sent. */
export async function joinRoom(code: string, opts: RoomClientOptions = {}): Promise<Room> {
  const base = (opts.base ?? infiniteApiBase()).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const payload = await post(`${base}/rooms/join`, { code }, fetchImpl);
  const room = parseRoom(payload, code, base);
  if (!room.publisherSessionId) {
    throw new RoomError("room_no_publisher", "the room has no sender in it — check the code, or start the move again");
  }
  return room;
}
