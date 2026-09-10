/**
 * A request/response channel over one `SharedArrayBuffer`, where the caller BLOCKS.
 *
 * WHY THIS EXISTS. `readFileSync` is synchronous by definition, and a Worker cannot ask the page a
 * question and wait for the answer — `postMessage` returns immediately and the reply arrives in a
 * later turn of the event loop. There is exactly one way out of that in a browser, and it is the one
 * the platform gives a cross-origin isolated page: put the bytes in memory both threads can see and
 * park the caller on `Atomics.wait` until the other side calls `Atomics.notify`. That is this file,
 * and it is the whole reason apps/infinite-site now sends `Cross-Origin-Opener-Policy` and
 * `Cross-Origin-Embedder-Policy`.
 *
 * ONE FUNCTION, BOTH ENDS, AND IT IS A STRING. `syncChannelEndpoint` is the client AND the server,
 * because a protocol written down twice is a protocol with two versions of every off-by-one. It is
 * also stringified twice — once into the script Worker's prelude (as the client) and once into the
 * filesystem service Worker (as the server) — so it obeys the same rule as the prelude in
 * js-runner.ts: IT MAY NOT REFERENCE ANYTHING OUTSIDE ITS OWN BODY AND ITS PARAMETERS. The layout it
 * needs travels as an argument, interpolated as JSON into the source, so the numbers are written
 * down once here and nowhere else.
 *
 * THE WIRE IS `@00/agent-node`'s, BYTE FOR BYTE. That package defines the same channel in
 * `packages/agent-node/src/fs/sync-channel.ts` (`SyncFsClient` / `serveSyncChannel`) for its own
 * Worker-per-process model, and there must not be two shared-memory protocols in one product. So the
 * header layout, the state machine, the frame size and the message encoding below are copied from
 * it and pinned by `SYNC_CHANNEL_LAYOUT`; a client of theirs and a server of ours can talk:
 *
 *   - header: 64 bytes as Int32 — [0] STATE, [1] LENGTH, [2] MORE, [3] KIND (response: 0 value,
 *     1 error). States: 0 idle, 1 req, 2 req-ack, 3 res, 4 res-ack, 5 closed;
 *   - payload: the rest of the buffer, one frame at a time, at most 1 MB each;
 *   - a message is `u32le jsonLength` + JSON + raw bytes, so a 2 MB file crosses the frame limit
 *     and arrives in three frames without ever being base64'd;
 *   - request JSON is `{ op, args }`; a reply is the value itself with KIND 0, or
 *     `{ code, message }` with KIND 1;
 *   - the CLIENT blocks (`Atomics.wait`), the SERVER never does (`Atomics.waitAsync`), which is what
 *     lets the server do asynchronous work — an OPFS `getFileHandle` — between the two.
 *
 * WHAT IS NOT SHARED IS THE CODE, and it cannot be. Their client is a class in a module, reached by
 * `import`. This one has to survive `Function.prototype.toString()` into a CLASSIC Blob Worker that
 * fetches nothing (js-runner.ts's sandbox argument, and fs-service.ts's), so it can hold no import
 * and no module-scope reference — layout included, which is why the layout travels as an argument
 * and is interpolated into the source. Two implementations of one wire, and the wire is the thing
 * that is written down.
 *
 * WHO MAY BE THE CLIENT. Anything but a browser's main thread, where `Atomics.wait` throws. In this
 * app the client is always a script's Worker (js-runner.ts) and the server is always the filesystem
 * service Worker (fs-service.ts). In the node suite both are `worker_threads`, which is why the
 * tests are a real test of this file and not of a mock.
 */

/** Where things are in the header, and what a value in the state slot means. `@00/agent-node`'s. */
export interface SyncChannelLayout {
  /** Int32 slots before the payload region: 16, i.e. `HEADER_BYTES` / 4. Four are used. */
  readonly slots: number;
  readonly state: number;
  readonly length: number;
  readonly more: number;
  /** Response only: 0 = the value, 1 = `{ code, message }`. */
  readonly kind: number;
  readonly idle: number;
  readonly request: number;
  readonly requestAck: number;
  readonly response: number;
  readonly responseAck: number;
  readonly closed: number;
  /** The most bytes one frame may carry. Anything longer travels as several. */
  readonly frameBytes: number;
}

/** `HEADER_BYTES` in packages/agent-node/src/fs/sync-channel.ts. Do not change one without the other. */
export const HEADER_BYTES = 64;

export const SYNC_CHANNEL_LAYOUT: SyncChannelLayout = {
  slots: HEADER_BYTES / 4,
  state: 0,
  length: 1,
  more: 2,
  kind: 3,
  idle: 0,
  request: 1,
  requestAck: 2,
  response: 3,
  responseAck: 4,
  closed: 5,
  frameBytes: 1024 * 1024,
};

/**
 * The payload region of a default channel: 1 MiB. Big enough that an ordinary source file, a
 * `package.json` or a directory listing is one round trip, small enough that a channel per running
 * script is not a reason to run out of memory. Anything larger simply chunks.
 */
export const FRAME_MAX_BYTES = SYNC_CHANNEL_LAYOUT.frameBytes;
/** Header plus one full frame: what `createChannelBuffer()` allocates when nobody says otherwise. */
export const DEFAULT_SAB_BYTES = HEADER_BYTES + FRAME_MAX_BYTES;

/** One request the client makes. `data` is the raw tail — file bytes, never base64. */
export interface SyncRequest {
  op: string;
  args: Record<string, unknown>;
  data?: Uint8Array;
}

/**
 * One answer the server gives. `ok: false` carries a message a person reads, never a stack, and a
 * `code` — Node's own where the operation has one (`ENOENT`), so a script can branch on `err.code`
 * exactly as it would on the Mac.
 */
export interface SyncResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  data?: Uint8Array;
}

export interface SyncChannelClient {
  /** Blocks this thread until the server answers. Throws only if the channel is closed. */
  call(op: string, args?: Record<string, unknown>, data?: Uint8Array): SyncResponse;
  close(): void;
}

export interface SyncChannelServer {
  /** Answers until the channel closes. Never blocks the thread it runs on. */
  serve(): Promise<void>;
  close(): void;
}

export type SyncHandler = (request: SyncRequest) => SyncResponse | Promise<SyncResponse>;

/**
 * A channel buffer, sized in TOTAL bytes exactly as `createSyncChannel()` sizes one in
 * `@00/agent-node` — header included, and never smaller than the header plus a kilobyte, because a
 * buffer with no room for a frame is a channel that cannot say so. `SharedArrayBuffer` existing at
 * all is the isolation check.
 */
export function createChannelBuffer(bytes: number = DEFAULT_SAB_BYTES): SharedArrayBuffer {
  return new SharedArrayBuffer(Math.max(HEADER_BYTES + 1024, bytes));
}

/**
 * Both ends of the channel. See the header: no reference to anything outside this body, because this
 * function is turned into source and evaluated in two Workers that have none of this module.
 */
export function syncChannelEndpoint(
  sab: SharedArrayBuffer,
  layout: SyncChannelLayout,
  role: "client" | "server",
  handler?: SyncHandler,
): SyncChannelClient & SyncChannelServer {
  const head = new Int32Array(sab, 0, layout.slots);
  const body = new Uint8Array(sab, layout.slots * 4);
  const frameCap = Math.min(layout.frameBytes, body.byteLength);
  // Naming the mistake rather than deadlocking on it: a client that serves would block its thread
  // inside the handler, and a server that calls would wait for itself.
  if (role === "server" && !handler) throw new Error("a sync channel server needs a handler");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** Set once by `close()`, so an answer already in flight cannot re-open a channel that ended. */
  let ended = false;

  const state = (): number => Atomics.load(head, layout.state);
  const setState = (value: number): void => {
    Atomics.store(head, layout.state, value);
    Atomics.notify(head, layout.state);
  };
  const closedError = (): Error =>
    new Error(
      "the filesystem service for this thread has stopped, so the synchronous reads have nothing behind them",
    );

  /** Park this thread until the state slot stops being `from`. Client only — a main thread throws. */
  const waitWhile = (from: number): number => {
    while (Atomics.load(head, layout.state) === from) Atomics.wait(head, layout.state, from);
    return state();
  };
  /** The same wait, without owning the thread. Server only. */
  const waitWhileAsync = async (from: number): Promise<number> => {
    while (Atomics.load(head, layout.state) === from) {
      const waiter = (
        Atomics as unknown as {
          waitAsync?: (
            slots: Int32Array,
            index: number,
            value: number,
          ) => { async: boolean; value: Promise<string> | string };
        }
      ).waitAsync;
      if (waiter) {
        const result = waiter(head, layout.state, from);
        if (result.async) await result.value;
      } else {
        // Safari before 16.4 and any engine without `waitAsync`: a 1 ms poll is slower and correct.
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    return state();
  };

  const encodeMessage = (json: unknown, data?: Uint8Array): Uint8Array => {
    const jsonBytes = encoder.encode(JSON.stringify(json === undefined ? null : json));
    const extra = data ?? new Uint8Array(0);
    const out = new Uint8Array(4 + jsonBytes.byteLength + extra.byteLength);
    new DataView(out.buffer).setUint32(0, jsonBytes.byteLength, true);
    out.set(jsonBytes, 4);
    out.set(extra, 4 + jsonBytes.byteLength);
    return out;
  };
  const decodeMessage = (bytes: Uint8Array): { json: unknown; data: Uint8Array } => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(0, true);
    return {
      json: JSON.parse(decoder.decode(bytes.subarray(4, 4 + jsonLength))) as unknown,
      data: bytes.slice(4 + jsonLength),
    };
  };
  const concat = (parts: Uint8Array[]): Uint8Array => {
    let total = 0;
    for (const part of parts) total += part.byteLength;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  };

  // ── The client half: blocking ──────────────────────────────────────────────────────────────────

  const call = (op: string, args: Record<string, unknown> = {}, data?: Uint8Array): SyncResponse => {
    if (state() === layout.closed) throw closedError();
    const message = encodeMessage({ op, args }, data);
    let at = 0;
    for (;;) {
      const size = Math.min(frameCap, message.byteLength - at);
      body.set(message.subarray(at, at + size), 0);
      at += size;
      const more = at < message.byteLength ? 1 : 0;
      Atomics.store(head, layout.length, size);
      Atomics.store(head, layout.more, more);
      setState(layout.request);
      const next = waitWhile(layout.request);
      if (!more) break;
      // Mid-message the server answers `req-ack` and the next frame goes into the same window.
      if (next !== layout.requestAck) throw closedError();
    }

    const parts: Uint8Array[] = [];
    let kind = 0;
    for (;;) {
      let now = state();
      while (now !== layout.response && now !== layout.closed) now = waitWhile(now);
      if (now === layout.closed) throw closedError();
      kind = Atomics.load(head, layout.kind);
      parts.push(body.slice(0, Atomics.load(head, layout.length)));
      if (!Atomics.load(head, layout.more)) {
        setState(layout.idle);
        break;
      }
      setState(layout.responseAck);
    }

    const { json, data: tail } = decodeMessage(concat(parts));
    if (kind === 1) {
      const err = (json ?? {}) as { code?: string; message?: string };
      const answer: SyncResponse = { ok: false, error: err.message ?? "the fs service refused" };
      if (err.code) answer.code = err.code;
      return answer;
    }
    const answer: SyncResponse = { ok: true, value: json };
    if (tail.byteLength) answer.data = tail;
    return answer;
  };

  // ── The server half: never blocking ────────────────────────────────────────────────────────────

  /** The whole request, however many frames it took, or `null` once the channel has closed. */
  const readRequest = async (): Promise<Uint8Array | null> => {
    const parts: Uint8Array[] = [];
    for (;;) {
      let now = state();
      while (now !== layout.request) {
        if (ended || now === layout.closed) return null;
        now = await waitWhileAsync(now);
      }
      parts.push(body.slice(0, Atomics.load(head, layout.length)));
      if (!Atomics.load(head, layout.more)) return concat(parts);
      setState(layout.requestAck);
    }
  };

  const writeReply = async (message: Uint8Array, kind: number): Promise<void> => {
    let at = 0;
    for (;;) {
      const size = Math.min(frameCap, message.byteLength - at);
      body.set(message.subarray(at, at + size), 0);
      at += size;
      const more = at < message.byteLength ? 1 : 0;
      Atomics.store(head, layout.length, size);
      Atomics.store(head, layout.more, more);
      Atomics.store(head, layout.kind, kind);
      setState(layout.response);
      if (!more) return;
      let now = state();
      while (now === layout.response) {
        if (ended) return;
        now = await waitWhileAsync(layout.response);
      }
      if (now === layout.closed) return;
    }
  };

  const serve = async (): Promise<void> => {
    for (;;) {
      const request = await readRequest();
      if (!request || ended) return;
      // The handler may take a while, and the page may close the channel meanwhile —
      // `service.release(sab)` when its script was killed. A reply written then would put `response`
      // back in the state slot and park a client on a channel nobody is serving.
      if (state() === layout.closed) return;
      const { json, data } = decodeMessage(request);
      const asked = (json ?? {}) as { op?: string; args?: Record<string, unknown> };
      let answer: SyncResponse;
      try {
        const parsed: SyncRequest = { op: String(asked.op ?? ""), args: asked.args ?? {} };
        if (data.byteLength) parsed.data = data;
        answer = handler
          ? await handler(parsed)
          : { ok: false, error: `fs.${parsed.op}: this channel has no server behind it` };
      } catch (err) {
        answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (ended || state() === layout.closed) return;
      if (answer.ok) {
        await writeReply(encodeMessage(answer.value ?? null, answer.data), 0);
      } else {
        const message = answer.error ?? "the fs service refused";
        // Node's own code where the sentence starts with one (`ENOENT: …`), so a script can branch
        // on `err.code` here exactly as it would on the Mac.
        const named = /^([A-Z]{4,10}):/.exec(message);
        await writeReply(encodeMessage({ code: answer.code ?? named?.[1] ?? "ERR_SYNC_FS", message }), 1);
      }
    }
  };

  return {
    call,
    serve,
    close: () => {
      ended = true;
      setState(layout.closed);
    },
  };
}

/** The blocking end, for a caller that already has the buffer (a Worker, or a node test). */
export function createSyncClient(sab: SharedArrayBuffer): SyncChannelClient {
  return syncChannelEndpoint(sab, SYNC_CHANNEL_LAYOUT, "client");
}

/** The answering end. Call `serve()` and leave it running; it never owns the thread. */
export function createSyncServer(sab: SharedArrayBuffer, handler: SyncHandler): SyncChannelServer {
  return syncChannelEndpoint(sab, SYNC_CHANNEL_LAYOUT, "server", handler);
}

/**
 * The same function as source, under a global both Workers can reach.
 *
 * The layout is interpolated rather than repeated: change a slot number above and both ends of every
 * channel change with it, including the two that live inside stringified Workers.
 */
export function syncChannelSource(): string {
  return (
    `self.__00SyncChannel = (${syncChannelEndpoint.toString()});\n` +
    `self.__00SyncChannelLayout = ${JSON.stringify(SYNC_CHANNEL_LAYOUT)};\n`
  );
}
