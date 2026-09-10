/**
 * The two ends of a live transfer, over any `TransferChannel` — docs/HANDOFF-infinite-agent.md §7.1.
 *
 * WHY BOTH ENDS LIVE IN ONE FILE, IN THIS PACKAGE. Three hosts run this code: the PWA sends and
 * receives, the 00 web UI inside the Mac's WKWebView receives, and a phone browser does both. A
 * sender and a receiver written twice drift on the first change — a renamed frame, a different order
 * of `done` and the last chunk — and the failure appears as a transfer that hangs, on somebody
 * else's device, with an agent in the middle. So the protocol has exactly one implementation, it
 * takes the channel as a parameter, and what differs per host is injected: WHERE the bytes come from
 * on the sending side, and WHAT lands them on the receiving one (`importBundleInto` into OPFS in the
 * browser; a POST to the engine's octet-stream door on the Mac).
 *
 * WHAT IS DELIBERATELY NOT HERE: any knowledge of rooms, of the SFU, of Vue, of OPFS, or of the
 * engine. This module sees a channel, some bytes and a digest.
 */

import { equalStrings, sha256Hex } from "./crypto.js";
import {
  ChunkAssembler,
  WireError,
  chunkCount,
  encodeControl,
  readFrame,
  sendChunks,
  type AbortReason,
  type ControlFrame,
  type HelloFrame,
  type TransferChannel,
} from "./wire.js";

/** Either side gave up, or the far side did. `reason` is the wire's vocabulary. */
export class TransferAborted extends Error {
  constructor(
    readonly reason: AbortReason,
    message?: string,
  ) {
    super(message ?? `the transfer was stopped: ${reason}`);
    this.name = "TransferAborted";
  }
}

/** Waits for one control frame, and turns an `abort` from the peer into a throw at the call site. */
class ControlWaiter {
  private readonly queue: ControlFrame[] = [];
  private waiter: ((frame: ControlFrame) => void) | null = null;
  private failure: Error | null = null;
  private failWaiter: ((err: Error) => void) | null = null;
  private readonly stops: (() => void)[] = [];

  constructor(channel: TransferChannel, private readonly onChunk?: (data: Uint8Array) => void) {
    this.stops.push(
      channel.onMessage((data) => {
        try {
          const frame = readFrame(data);
          if ("chunk" in frame) {
            this.onChunk?.(data as Uint8Array);
            return;
          }
          this.push(frame.control);
        } catch (err) {
          this.fail(err instanceof Error ? err : new Error(String(err)));
        }
      }),
      channel.onClose(() => this.fail(new TransferAborted("cancelled", "the channel closed mid-transfer"))),
    );
  }

  private push(frame: ControlFrame): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.failWaiter = null;
      w(frame);
      return;
    }
    this.queue.push(frame);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    if (this.failWaiter) {
      const f = this.failWaiter;
      this.waiter = null;
      this.failWaiter = null;
      f(err);
    }
  }

  next(): Promise<ControlFrame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<ControlFrame>((resolve, reject) => {
      this.waiter = resolve;
      this.failWaiter = reject;
    });
  }

  /** The next frame, refused unless it is the one this step of the protocol expects. */
  async expect<T extends ControlFrame["t"]>(type: T): Promise<Extract<ControlFrame, { t: T }>> {
    const frame = await this.next();
    if (frame.t === "abort") throw new TransferAborted(frame.reason);
    if (frame.t !== type) throw new WireError("malformed", `expected a ${type} frame and got ${frame.t}`);
    return frame as Extract<ControlFrame, { t: T }>;
  }

  stop(): void {
    for (const off of this.stops) off();
  }
}

function abortWith(channel: TransferChannel, reason: AbortReason): void {
  try {
    channel.send(encodeControl({ t: "abort", reason }));
  } catch {
    /* a channel that cannot carry the refusal has already failed; the throw below is the real news */
  }
}

export interface SendBundleOptions {
  /** The encrypted `.00agent`, exactly as `exportBundle` produced it. */
  bytes: Uint8Array;
  /** The file name the far side shows. Never used as a path. */
  name: string;
  /** The 4-character confirmation from `deriveTransferKeys` — proof both sides hold the same key. */
  fingerprint: string;
  /** Fires when the peer's `ready` lands: the moment the confirmation may be shown as comparable. */
  onPeer?(): void;
  onProgress?(sent: number, total: number, chunks: number): void;
  cancelled?(): boolean;
}

export interface SendBundleResult {
  /** The id the far side reports having imported. */
  agentId: string;
  sha256: string;
}

/**
 * Send one bundle and WAIT for the far side to say it landed.
 *
 * The order is: peer says ready (with its fingerprint) → hello → chunks → done → ack. Nothing about
 * the local copy changes here; the caller locks its agent only on the resolved result, which is
 * §7's one-live-residence rule expressed as control flow.
 */
export async function sendBundle(channel: TransferChannel, opts: SendBundleOptions): Promise<SendBundleResult> {
  const control = new ControlWaiter(channel);
  try {
    const ready = await control.expect("ready");
    if (!equalStrings(ready.fp, opts.fingerprint)) {
      abortWith(channel, "code_mismatch");
      throw new TransferAborted("code_mismatch", "the other device derived a different key from its code");
    }
    opts.onPeer?.();

    const sha256 = await sha256Hex(opts.bytes);
    const hello: HelloFrame = {
      t: "hello",
      name: opts.name,
      bytes: opts.bytes.length,
      sha256,
      fp: opts.fingerprint,
    };
    channel.send(encodeControl(hello));
    const chunks = chunkCount(opts.bytes.length);
    await sendChunks(channel, opts.bytes, {
      cancelled: opts.cancelled,
      onProgress: (sent, total) => opts.onProgress?.(sent, total, chunks),
    });
    channel.send(encodeControl({ t: "done" }));

    const ack = await control.expect("ack");
    return { agentId: ack.agentId, sha256 };
  } catch (err) {
    if (err instanceof WireError && err.code === "cancelled") abortWith(channel, "cancelled");
    throw err;
  } finally {
    control.stop();
  }
}

export interface ReceiveBundleOptions {
  /** This device's own confirmation; the sender's `hello` must carry the same one. */
  fingerprint: string;
  /**
   * What to do with the bundle once its digest is proven. In the PWA this is `importBundleInto` on
   * the OPFS root; on the Mac it is a POST to the engine's octet-stream import door. It may ask the
   * person something (replace an agent that is already here) — the ack does not go out until it has
   * answered, so the far side stays live until this one really has the agent.
   */
  land(bytes: Uint8Array, hello: HelloFrame): Promise<{ agentId: string }>;
  onHello?(hello: HelloFrame): void;
  onProgress?(received: number, total: number): void;
}

export interface ReceiveBundleResult {
  agentId: string;
  bytes: number;
  sha256: string;
  name: string;
}

/**
 * Announce readiness, take the bundle, prove it, land it, acknowledge it.
 *
 * EVERY REFUSAL IS SENT AS WELL AS THROWN. A receiver that just stops leaves the sending device
 * showing a progress bar forever and, worse, never locking — so a wrong digest, a gap in the
 * sequence and a failed import all put an `abort` on the wire before they raise here.
 */
export async function receiveBundle(
  channel: TransferChannel,
  opts: ReceiveBundleOptions,
): Promise<ReceiveBundleResult> {
  // One mutable holder rather than three `let`s: `failure` is written inside the message callback and
  // read after an `await` out here, and a captured `let` written in a closure is exactly the shape
  // TypeScript's narrowing is entitled to get wrong.
  const state: {
    assembler: ChunkAssembler | null;
    hello: HelloFrame | null;
    failure: WireError | null;
    /** Chunks that beat `hello`'s continuation to the handler. Never dropped — see below. */
    early: Uint8Array[];
  } = { assembler: null, hello: null, failure: null, early: [] };

  /**
   * Chunks are folded in as they land, so the bundle is never held twice — once in the parts and
   * once in a queue of undecoded messages. The one exception is the handful that can arrive in the
   * same tick as `hello`, BEFORE this side's `await` has resumed and built the assembler: those are
   * kept aside and folded in the moment it exists. Dropping them would be an out-of-order abort on a
   * transfer where nothing went wrong.
   */
  const feed = (data: Uint8Array): void => {
    if (state.failure) return;
    try {
      const frame = readFrame(data);
      if (!("chunk" in frame)) return;
      const assembler = state.assembler;
      if (!assembler) {
        state.early.push(data);
        return;
      }
      const received = assembler.accept(frame.chunk);
      opts.onProgress?.(received, state.hello?.bytes ?? 0);
    } catch (err) {
      state.failure = err instanceof WireError ? err : new WireError("malformed", String(err));
    }
  };

  const control = new ControlWaiter(channel, feed);

  try {
    channel.send(encodeControl({ t: "ready", fp: opts.fingerprint }));
    const hello = await control.expect("hello");
    state.hello = hello;
    if (!equalStrings(hello.fp, opts.fingerprint)) {
      abortWith(channel, "code_mismatch");
      throw new TransferAborted("code_mismatch", "the other device derived a different key from its code");
    }
    opts.onHello?.(hello);
    const assembler = new ChunkAssembler(hello.bytes);
    state.assembler = assembler;
    const early = state.early.splice(0);
    for (const data of early) feed(data);

    await control.expect("done");
    const failure = state.failure;
    if (failure) {
      abortWith(channel, failure.code === "malformed" ? "refused" : failure.code);
      throw failure;
    }

    let bytes: Uint8Array;
    try {
      bytes = assembler.finish();
    } catch (err) {
      abortWith(channel, "short_read");
      throw err;
    }

    const digest = await sha256Hex(bytes);
    if (!equalStrings(digest, hello.sha256)) {
      abortWith(channel, "sha256_mismatch");
      throw new TransferAborted("sha256_mismatch", "the bundle that arrived is not the one that was sent");
    }

    let landed: { agentId: string };
    try {
      landed = await opts.land(bytes, hello);
    } catch (err) {
      abortWith(channel, "import_failed");
      throw err;
    }
    channel.send(encodeControl({ t: "ack", agentId: landed.agentId }));
    return { agentId: landed.agentId, bytes: bytes.length, sha256: digest, name: hello.name };
  } finally {
    control.stop();
  }
}
