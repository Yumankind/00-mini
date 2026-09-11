/**
 * The shared-memory channel that makes `fs.readFileSync` a real read.
 *
 * WHY THIS EXISTS AT ALL. `require()`, `readFileSync` and `existsSync` are synchronous by
 * definition, and the filesystem under this runtime (`AgentFs` over OPFS) is asynchronous by
 * definition. There are exactly two ways out: pre-load a snapshot of the folder and answer from it
 * (what `apps/infinite/src/power/js-runner.ts` does today — bounded, honest, and wrong the moment a
 * file is written by one module and read by the next), or BLOCK the calling thread while another
 * thread does the async work. This module is the second one.
 *
 * WHAT IT COSTS. `Atomics.wait` is forbidden on a page's main thread, and `SharedArrayBuffer` only
 * exists under cross-origin isolation (COOP `same-origin` + COEP `require-corp`). So the sync half
 * of `fs` works when, and only when, the code runs in a Worker on an isolated origin. Everywhere
 * else `SyncFsClient` is simply absent and every `*Sync` call throws `ERR_SYNC_FS_UNAVAILABLE` with
 * the sentence that says why (`src/errors.ts`). That is a feature: a runtime that silently answered
 * from a stale snapshot would be worse than one that refuses.
 *
 * THE PROTOCOL, in full, because a shared-memory protocol you have to guess is a bug factory.
 *
 *   Header: an Int32Array over the first 64 bytes.
 *     [0] STATE   0 idle · 1 req · 2 req-ack · 3 res · 4 res-ack · 5 closed
 *     [1] LENGTH  bytes of payload in THIS frame
 *     [2] MORE    1 when another frame of the same message follows
 *     [3] KIND    response only: 0 value, 1 error
 *   Payload: the rest of the buffer, one frame at a time, at most FRAME_BYTES (1 MB) each.
 *   A message is `u32 jsonLength` + JSON + raw bytes, so a 2 MB file crosses the frame limit and
 *   arrives in three frames without ever being base64'd.
 *
 *   Client (sync, on a Worker):  write frame → STATE=REQ → notify → wait for STATE≠REQ.
 *                                 If MORE was set the server answers REQ_ACK and the loop repeats;
 *                                 otherwise the next state is RES.
 *                                 Read frames: while MORE, STATE=RES_ACK → notify → wait for RES.
 *   Server (async, anywhere):    wait for REQ → read → (REQ_ACK, wait REQ)* → do the work →
 *                                 write frames, RES between each, waiting for RES_ACK.
 *
 * Both halves live here on purpose. A protocol whose two ends are written in different files drifts,
 * and this one is only testable end to end — which the node suite does with a real
 * `SharedArrayBuffer` and a real `worker_threads` Worker, 2 MB across the frame limit included.
 */

/**
 * NOTE — this file imports NOTHING, deliberately. Both ends of the protocol have to be loadable
 * standalone: the client half runs inside a Worker that a host may build from a bare file, and the
 * node test suite loads it into a real `worker_threads` Worker with no bundler in front of it. A
 * single import would drag the rest of the package across that boundary, so the one error class it
 * needs lives here rather than in `src/errors.ts` — same shape (`name`, `code`, a sentence).
 */
export class SyncChannelError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NodeCompatError";
    this.code = code;
  }
}

export const HEADER_BYTES = 64;
/** One frame. Big enough that a source file is one round trip, small enough to keep the SAB cheap. */
export const FRAME_BYTES = 1024 * 1024;
/** What `createSyncChannel()` allocates when nobody says otherwise: header + one full frame. */
export const DEFAULT_SAB_BYTES = HEADER_BYTES + FRAME_BYTES;
/** How long a blocking call waits before it decides the service is gone. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

const STATE = 0;
const LENGTH = 1;
const MORE = 2;
const KIND = 3;

const IDLE = 0;
const REQ = 1;
const REQ_ACK = 2;
const RES = 3;
const RES_ACK = 4;
const CLOSED = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the fs service must answer. `NodeFsBackend` implements exactly this. */
export interface SyncFsService {
  call(
    op: string,
    args: Record<string, unknown>,
    data: Uint8Array | null,
  ): Promise<{ value?: unknown; data?: Uint8Array }>;
}

export interface SyncChannelHandle {
  /** Stop serving. The next client call throws rather than blocking forever. */
  stop(): void;
}

/** A SharedArrayBuffer sized for this protocol, or a plain one where SAB does not exist (tests). */
export function createSyncChannel(bytes = DEFAULT_SAB_BYTES): SharedArrayBuffer {
  const size = Math.max(HEADER_BYTES + 1024, bytes);
  return new SharedArrayBuffer(size);
}

function views(sab: SharedArrayBuffer): { head: Int32Array; body: Uint8Array; frame: number } {
  const head = new Int32Array(sab, 0, HEADER_BYTES / 4);
  const body = new Uint8Array(sab, HEADER_BYTES);
  return { head, body, frame: Math.min(FRAME_BYTES, body.byteLength) };
}

function encodeMessage(json: unknown, data: Uint8Array | null): Uint8Array {
  const head = encoder.encode(JSON.stringify(json));
  const extra = data ?? new Uint8Array(0);
  const out = new Uint8Array(4 + head.byteLength + extra.byteLength);
  new DataView(out.buffer).setUint32(0, head.byteLength, true);
  out.set(head, 4);
  out.set(extra, 4 + head.byteLength);
  return out;
}

function decodeMessage(bytes: Uint8Array): { json: unknown; data: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(0, true);
  const json = JSON.parse(decoder.decode(bytes.subarray(4, 4 + jsonLength))) as unknown;
  return { json, data: bytes.slice(4 + jsonLength) };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// ── The client: synchronous, and only legal on a Worker ───────────────────────────────────────────

/**
 * The module side of the channel. Every method BLOCKS the calling thread until the service answers,
 * which is the entire point and also the reason this may never run on a page's main thread — the
 * service lives there, and a main thread waiting on itself is a frozen tab.
 */
export class SyncFsClient {
  private readonly head: Int32Array;
  private readonly body: Uint8Array;
  private readonly frame: number;
  private readonly sab: SharedArrayBuffer;
  private readonly timeoutMs: number;

  constructor(sab: SharedArrayBuffer, opts: { timeoutMs?: number } = {}) {
    this.sab = sab;
    const v = views(sab);
    this.head = v.head;
    this.body = v.body;
    this.frame = v.frame;
    // A BOUNDED wait, always. A service that crashed mid-call would otherwise freeze this thread for
    // the life of the tab, and a frozen Worker is the one failure a person cannot see the cause of.
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** True when this thread can actually block — a Worker with `Atomics.wait`. */
  static usable(): boolean {
    return typeof SharedArrayBuffer !== "undefined" && typeof Atomics !== "undefined" && typeof Atomics.wait === "function";
  }

  /** The raw buffer, so a host can hand the same channel to a child process. */
  get buffer(): SharedArrayBuffer {
    return this.sab;
  }

  call(op: string, args: Record<string, unknown> = {}, data: Uint8Array | null = null): { value: unknown; data: Uint8Array } {
    const message = encodeMessage({ op, args }, data);
    this.send(message);
    const reply = this.receive();
    const decoded = decodeMessage(reply.bytes);
    if (reply.kind === 1) {
      const err = decoded.json as { code?: string; message?: string };
      throw new SyncChannelError(err.code ?? "ERR_SYNC_FS", err.message ?? "the fs service refused");
    }
    return { value: decoded.json, data: decoded.data };
  }

  private send(message: Uint8Array): void {
    // The service may already have stopped; storing REQ over CLOSED would be a wait nobody answers.
    if (Atomics.load(this.head, STATE) === CLOSED) this.fail(CLOSED);
    const deadline = Date.now() + this.timeoutMs;
    let at = 0;
    for (;;) {
      const size = Math.min(this.frame, message.byteLength - at);
      this.body.set(message.subarray(at, at + size), 0);
      at += size;
      const more = at < message.byteLength ? 1 : 0;
      Atomics.store(this.head, LENGTH, size);
      Atomics.store(this.head, MORE, more);
      Atomics.store(this.head, STATE, REQ);
      Atomics.notify(this.head, STATE);
      this.waitWhile(REQ, deadline);
      if (!more) return;
      const state = Atomics.load(this.head, STATE);
      if (state !== REQ_ACK) this.fail(state);
    }
  }

  private receive(): { bytes: Uint8Array; kind: number } {
    const parts: Uint8Array[] = [];
    const deadline = Date.now() + this.timeoutMs;
    let kind = 0;
    for (;;) {
      let state = Atomics.load(this.head, STATE);
      while (state !== RES && state !== CLOSED) {
        if (Atomics.wait(this.head, STATE, state, Math.max(0, deadline - Date.now())) === "timed-out") this.timeout();
        state = Atomics.load(this.head, STATE);
      }
      if (state === CLOSED) this.fail(state);
      const size = Atomics.load(this.head, LENGTH);
      kind = Atomics.load(this.head, KIND);
      parts.push(this.body.slice(0, size));
      if (!Atomics.load(this.head, MORE)) {
        Atomics.store(this.head, STATE, IDLE);
        Atomics.notify(this.head, STATE);
        return { bytes: concat(parts), kind };
      }
      Atomics.store(this.head, STATE, RES_ACK);
      Atomics.notify(this.head, STATE);
    }
  }

  private waitWhile(state: number, deadline: number): void {
    while (Atomics.load(this.head, STATE) === state) {
      if (Atomics.wait(this.head, STATE, state, Math.max(0, deadline - Date.now())) === "timed-out") this.timeout();
    }
  }

  private timeout(): never {
    throw new SyncChannelError(
      "ERR_SYNC_FS_TIMEOUT",
      `the filesystem service did not answer within ${this.timeoutMs}ms — it has stopped, crashed, or is blocked behind work of its own`,
    );
  }

  private fail(state: number): never {
    throw new SyncChannelError(
      "ERR_SYNC_FS_CLOSED",
      state === CLOSED
        ? "the filesystem service for this thread has stopped, so the synchronous reads have nothing behind them"
        : `the sync filesystem channel is in an unexpected state (${state})`,
    );
  }
}

// ── The server: asynchronous, wherever the real filesystem is ─────────────────────────────────────

/** `Atomics.waitAsync` where it exists, a poll where it does not. Never blocks the caller. */
function waitForChange(head: Int32Array, expected: number): Promise<void> {
  // `Atomics.waitAsync` is ES2024 and the lib here is ES2022 on purpose (this code targets browsers
  // that predate it), so it is reached through a narrow local type rather than by raising the lib.
  type WaitAsync = (
    view: Int32Array,
    index: number,
    value: number,
  ) => { async: boolean; value: unknown };
  const asyncWait = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;
  if (typeof asyncWait === "function") {
    const result = asyncWait.call(Atomics, head, STATE, expected);
    if (!result.async) return Promise.resolve();
    return Promise.resolve(result.value as Promise<string>).then(() => undefined);
  }
  return new Promise((resolve) => {
    const tick = (): void => {
      if (Atomics.load(head, STATE) !== expected) resolve();
      else setTimeout(tick, 1);
    };
    tick();
  });
}

/**
 * Serve `fs` over `sab` until `stop()`. Returns immediately; the loop runs on the microtask/timer
 * queue of whatever thread called this, which is the thread that owns the real filesystem.
 */
export function serveSyncChannel(fs: SyncFsService, sab: SharedArrayBuffer): SyncChannelHandle {
  const { head, body, frame } = views(sab);
  let running = true;

  const readRequest = async (): Promise<Uint8Array | null> => {
    const parts: Uint8Array[] = [];
    for (;;) {
      let state = Atomics.load(head, STATE);
      while (state !== REQ) {
        if (!running) return null;
        await waitForChange(head, state);
        state = Atomics.load(head, STATE);
      }
      parts.push(body.slice(0, Atomics.load(head, LENGTH)));
      if (!Atomics.load(head, MORE)) return concat(parts);
      Atomics.store(head, STATE, REQ_ACK);
      Atomics.notify(head, STATE);
    }
  };

  const writeReply = async (message: Uint8Array, kind: number): Promise<void> => {
    let at = 0;
    for (;;) {
      const size = Math.min(frame, message.byteLength - at);
      body.set(message.subarray(at, at + size), 0);
      at += size;
      const more = at < message.byteLength ? 1 : 0;
      Atomics.store(head, LENGTH, size);
      Atomics.store(head, MORE, more);
      Atomics.store(head, KIND, kind);
      Atomics.store(head, STATE, RES);
      Atomics.notify(head, STATE);
      if (!more) return;
      let state = Atomics.load(head, STATE);
      while (state === RES) {
        if (!running) return;
        await waitForChange(head, state);
        state = Atomics.load(head, STATE);
      }
    }
  };

  void (async () => {
    while (running) {
      const request = await readRequest();
      if (!request || !running) return;
      const { json, data } = decodeMessage(request);
      const { op, args } = json as { op: string; args: Record<string, unknown> };
      try {
        const result = await fs.call(op, args ?? {}, data.byteLength ? data : null);
        await writeReply(encodeMessage(result.value ?? null, result.data ?? null), 0);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        await writeReply(encodeMessage({ code: e.code ?? "ERR_SYNC_FS", message: e.message ?? String(err) }, null), 1);
      }
    }
  })();

  return {
    stop() {
      running = false;
      Atomics.store(head, STATE, CLOSED);
      Atomics.notify(head, STATE);
    },
  };
}
