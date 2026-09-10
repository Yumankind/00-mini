/**
 * The frame protocol of a live transfer — docs/HANDOFF-infinite-agent.md §7.1.
 *
 * WHY A PROTOCOL AT ALL, WHEN THE PAYLOAD IS ONE FILE. A DataChannel is a message pipe, not a stream:
 * every `send` is one datagram with a size limit far below an agent bundle, and the far side is told
 * nothing about how many are coming or whether the last one arrived. So the bytes need a header that
 * says how many and which, a terminator, and an answer — otherwise "the transfer finished" means "the
 * sender stopped sending", which is also what a dropped connection looks like. The three-frame shape
 * (hello, chunks, done → ack) is the smallest thing that can tell those two apart, and the `ack` is
 * what §7's one-live-residence rule hangs on: the source only locks itself once the far side has said
 * it has the agent.
 *
 * TWO ENCODINGS, ON PURPOSE. Control frames are JSON text messages, chunks are binary ones, and the
 * receiver tells them apart by the type the transport hands it rather than by peeking inside. That
 * means a chunk of ciphertext can never be mistaken for a control frame no matter what bytes the
 * encryption produced, and it costs nothing: `typeof data === "string"`.
 *
 * BACKPRESSURE IS NOT OPTIONAL. `send()` never blocks; it queues. A 200 MB agent pushed in a loop
 * would buffer the whole bundle in the tab before the first packet leaves, and browsers kill the
 * channel when the queue passes their cap. `bufferedAmountLowThreshold` + the `bufferedamountlow`
 * event is the standard way to be told the queue has drained, and this module is the only place in
 * the transfer that sends more than one message in a row.
 */

/** 16 KB — §7.1's chunk size, and comfortably under the 64 KB message ceiling every browser agrees on. */
export const CHUNK_BYTES = 16 * 1024;

/** Stop feeding the channel above this many queued bytes … */
export const BUFFER_HIGH_WATER = 1024 * 1024;
/** … and start again when it has drained to this. Both are bytes queued in OUR tab, not in flight. */
export const BUFFER_LOW_WATER = 256 * 1024;

/** The sequence number's width, in bytes, at the head of every chunk frame. */
const SEQ_BYTES = 4;

/** What the source announces before the first byte: the name, the size, the digest, the fingerprint. */
export interface HelloFrame {
  t: "hello";
  /** The `.00agent`'s file name — shown, never trusted as a path. */
  name: string;
  /** Length of the encrypted bundle in bytes, so the far side can draw a bar and refuse a short read. */
  bytes: number;
  /** Lowercase hex SHA-256 of the encrypted bundle. */
  sha256: string;
  /** The 4-character confirmation both screens show; a mismatch means the codes differ. */
  fp: string;
}

/** The receiver's "I am here, and I derived the same key as you". */
export interface ReadyFrame {
  t: "ready";
  fp: string;
}

/** Every chunk sent. No payload of its own: the digest in `hello` is what proves the whole. */
export interface DoneFrame {
  t: "done";
}

/** The far side has the agent. THIS is what lets the source lock its copy. */
export interface AckFrame {
  t: "ack";
  agentId: string;
}

/** Either side, at any point. `reason` is a code this module owns, never a free sentence. */
export interface AbortFrame {
  t: "abort";
  reason: AbortReason;
}

export type AbortReason =
  | "code_mismatch"
  | "sha256_mismatch"
  | "short_read"
  | "out_of_order"
  | "import_failed"
  | "refused"
  | "cancelled";

export type ControlFrame = HelloFrame | ReadyFrame | DoneFrame | AckFrame | AbortFrame;

/** A chunk, once decoded: its position in the sequence and its slice of the bundle. */
export interface ChunkFrame {
  seq: number;
  payload: Uint8Array;
}

/** Anything wrong with what came off the wire. Carries a code so a caller can decide, not parse. */
export class WireError extends Error {
  readonly code: AbortReason | "malformed";
  constructor(code: AbortReason | "malformed", message: string) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}

/**
 * The transport, reduced to what this protocol needs.
 *
 * WHY AN INTERFACE AND NOT `RTCDataChannel`. Node has no WebRTC, so the only way the wire, the
 * sender and the receiver can be tested at all is if the channel is a parameter. Everything WebRTC
 * lives behind this in `apps/infinite/src/transfer/sfu.ts`; everything here runs in a test with two
 * arrays and a queue.
 */
export interface TransferChannel {
  send(data: string | Uint8Array): void;
  /** Bytes queued in this tab and not yet handed to the network. */
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  /** Returns its own unsubscribe, so a receiver can stop listening without owning the channel. */
  onMessage(handler: (data: string | Uint8Array) => void): () => void;
  onBufferedAmountLow(handler: () => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}

export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

function isReason(value: unknown): value is AbortReason {
  return (
    value === "code_mismatch" ||
    value === "sha256_mismatch" ||
    value === "short_read" ||
    value === "out_of_order" ||
    value === "import_failed" ||
    value === "refused" ||
    value === "cancelled"
  );
}

/**
 * Read a control frame, refusing everything that is not exactly one of the five.
 *
 * The far side is a peer, not a friend: the room's code admits whoever typed it, and the SFU will
 * relay whatever that peer sends. So every field is checked here rather than at the three call sites,
 * and an unknown `t` is a refusal instead of a shrug.
 */
export function decodeControl(text: string): ControlFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WireError("malformed", "a control frame was not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WireError("malformed", "a control frame was not an object");
  }
  const frame = raw as Record<string, unknown>;
  switch (frame.t) {
    case "hello":
      if (
        typeof frame.name !== "string" ||
        typeof frame.bytes !== "number" ||
        !Number.isInteger(frame.bytes) ||
        frame.bytes <= 0 ||
        typeof frame.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(frame.sha256) ||
        typeof frame.fp !== "string" ||
        frame.fp.length === 0
      ) {
        throw new WireError("malformed", "the hello frame is incomplete");
      }
      return { t: "hello", name: frame.name, bytes: frame.bytes, sha256: frame.sha256, fp: frame.fp };
    case "ready":
      if (typeof frame.fp !== "string" || frame.fp.length === 0) {
        throw new WireError("malformed", "the ready frame carries no fingerprint");
      }
      return { t: "ready", fp: frame.fp };
    case "done":
      return { t: "done" };
    case "ack":
      if (typeof frame.agentId !== "string" || frame.agentId.length === 0) {
        throw new WireError("malformed", "the ack frame names no agent");
      }
      return { t: "ack", agentId: frame.agentId };
    case "abort":
      return { t: "abort", reason: isReason(frame.reason) ? frame.reason : "refused" };
    default:
      throw new WireError("malformed", `unknown frame type ${JSON.stringify(frame.t)}`);
  }
}

/** `[seq:uint32be][payload]`. Big-endian because that is what every wire format on this platform uses. */
export function encodeChunk(seq: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0) throw new WireError("malformed", "a chunk needs a sequence number");
  if (payload.length === 0 || payload.length > CHUNK_BYTES) {
    throw new WireError("malformed", `a chunk carries 1..${CHUNK_BYTES} bytes, not ${payload.length}`);
  }
  const out = new Uint8Array(SEQ_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, seq, false);
  out.set(payload, SEQ_BYTES);
  return out;
}

export function decodeChunk(bytes: Uint8Array): ChunkFrame {
  if (bytes.length <= SEQ_BYTES) throw new WireError("malformed", "a chunk frame is shorter than its header");
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  const payload = bytes.subarray(SEQ_BYTES);
  if (payload.length > CHUNK_BYTES) throw new WireError("malformed", "a chunk frame is over the chunk size");
  return { seq, payload };
}

/** How many chunks a bundle of this size becomes — the number a progress bar counts against. */
export function chunkCount(total: number): number {
  return Math.ceil(total / CHUNK_BYTES);
}

/**
 * The receiving side's ledger: in order, no gaps, no repeats, and exactly as many bytes as promised.
 *
 * WHY ORDER IS ENFORCED RATHER THAN REPAIRED. The channel is created ordered and reliable (see
 * sfu.ts), so out-of-order delivery is not congestion — it is a peer that is not sending what this
 * protocol says, and reassembling around it would be inventing a file. A gap aborts, loudly.
 */
export class ChunkAssembler {
  private readonly parts: Uint8Array[] = [];
  private next = 0;
  private received = 0;

  constructor(private readonly expectedBytes: number) {}

  get bytes(): number {
    return this.received;
  }

  accept(chunk: ChunkFrame): number {
    if (chunk.seq !== this.next) {
      throw new WireError("out_of_order", `expected chunk ${this.next} and got ${chunk.seq}`);
    }
    if (this.received + chunk.payload.length > this.expectedBytes) {
      throw new WireError("short_read", "the sender sent more bytes than it announced");
    }
    this.parts.push(chunk.payload);
    this.next += 1;
    this.received += chunk.payload.length;
    return this.received;
  }

  /** The whole bundle, once, or a refusal if the sender stopped early. */
  finish(): Uint8Array {
    if (this.received !== this.expectedBytes) {
      throw new WireError("short_read", `${this.received} of ${this.expectedBytes} bytes arrived`);
    }
    const out = new Uint8Array(this.expectedBytes);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** One place that decides what a message off the wire IS, so the two ends cannot disagree. */
export function readFrame(data: string | Uint8Array): { control: ControlFrame } | { chunk: ChunkFrame } {
  return typeof data === "string" ? { control: decodeControl(data) } : { chunk: decodeChunk(data) };
}

async function drain(channel: TransferChannel): Promise<void> {
  if (channel.bufferedAmount <= BUFFER_LOW_WATER) return;
  await new Promise<void>((resolve) => {
    const off = channel.onBufferedAmountLow(() => {
      off();
      resolve();
    });
  });
}

export interface SendChunksOptions {
  /** Called after every chunk with the bytes handed to the channel so far. */
  onProgress?(sent: number, total: number): void;
  /** Checked before each chunk; `true` stops the loop with a `cancelled` WireError. */
  cancelled?(): boolean;
}

/**
 * Feed the whole bundle into the channel, 16 KB at a time, pausing whenever the queue is deep.
 *
 * The threshold is set here rather than by the channel's owner because it is this loop that waits on
 * it: a channel whose threshold said something else would either never fire the event (and hang) or
 * fire it constantly (and buffer everything anyway).
 */
export async function sendChunks(
  channel: TransferChannel,
  bytes: Uint8Array,
  opts: SendChunksOptions = {},
): Promise<void> {
  channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
  let seq = 0;
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    if (opts.cancelled?.()) throw new WireError("cancelled", "the transfer was cancelled");
    if (channel.bufferedAmount > BUFFER_HIGH_WATER) await drain(channel);
    const slice = bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length));
    channel.send(encodeChunk(seq, slice));
    seq += 1;
    opts.onProgress?.(Math.min(at + CHUNK_BYTES, bytes.length), bytes.length);
  }
}
