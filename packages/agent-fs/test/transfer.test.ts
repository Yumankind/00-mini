// The live transfer, end to end, with no browser and no network — docs/HANDOFF-infinite-agent.md §7.1.
//
// The channel is a pair of arrays: everything WebRTC lives in the PWA behind `TransferChannel`, and
// what is left is a protocol, which is exactly the kind of thing a node runner can hold to account.
// The round trip below is NOT a mock of the bundle: it exports a scaffolded agent for real, moves the
// ciphertext through the wire, and imports it into a second MemoryFs with the secret the two sides
// derived independently from the six-word code.

import { describe, expect, it, vi } from "vitest";
import { MemoryFs } from "../src/memory-fs.js";
import { scaffoldAgent } from "../src/scaffold.js";
import { exportBundle, importBundleInto } from "../src/bundle.js";
import {
  BUFFER_LOW_WATER,
  CHUNK_BYTES,
  CONFIRM_ALPHABET,
  CONFIRM_LENGTH,
  ChunkAssembler,
  TransferAborted,
  WireError,
  chunkCount,
  decodeChunk,
  decodeControl,
  deriveTransferKeys,
  encodeChunk,
  encodeControl,
  equalStrings,
  fromBase64Url,
  readFrame,
  receiveBundle,
  sendBundle,
  sendChunks,
  sha256Hex,
  toBase64Url,
  type TransferChannel,
} from "../src/transfer/index.js";

const CODE = "acorn-basil-cedar-dawn-ember-falcon";
const SALT = toBase64Url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));

// ── A channel pair, and the ways a channel can misbehave ─────────────────────────────────────────

type Tamper = (data: string | Uint8Array, index: number) => string | Uint8Array | null;

class FakeChannel implements TransferChannel {
  peer!: FakeChannel;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent = 0;
  private readonly messageHandlers = new Set<(data: string | Uint8Array) => void>();
  private readonly lowHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  closed = false;

  constructor(private readonly tamper: Tamper = (d) => d) {}

  send(data: string | Uint8Array): void {
    const next = this.tamper(data, this.sent++);
    if (next === null) return;
    // Asynchronous on purpose: a transport that delivered inside `send` would hide every ordering
    // bug this protocol exists to catch.
    queueMicrotask(() => {
      for (const h of [...this.peer.messageHandlers]) h(next);
    });
  }

  drainTo(level: number): void {
    this.bufferedAmount = level;
    if (level <= this.bufferedAmountLowThreshold) for (const h of [...this.lowHandlers]) h();
  }

  onMessage(handler: (data: string | Uint8Array) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onBufferedAmountLow(handler: () => void): () => void {
    this.lowHandlers.add(handler);
    return () => this.lowHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    for (const h of [...this.closeHandlers]) h();
  }
}

function pair(aTamper?: Tamper, bTamper?: Tamper): [FakeChannel, FakeChannel] {
  const a = new FakeChannel(aTamper);
  const b = new FakeChannel(bTamper);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// ── The frames ───────────────────────────────────────────────────────────────────────────────────

describe("the wire", () => {
  it("round-trips every control frame", () => {
    const frames = [
      { t: "hello", name: "zero.00agent", bytes: 10, sha256: "a".repeat(64), fp: "7K2M" },
      { t: "ready", fp: "7K2M" },
      { t: "done" },
      { t: "ack", agentId: "ag_1" },
      { t: "abort", reason: "refused" },
    ] as const;
    for (const frame of frames) expect(decodeControl(encodeControl(frame))).toEqual(frame);
  });

  it("refuses junk rather than guessing what a peer meant", () => {
    for (const bad of [
      "not json",
      "[]",
      '"a string"',
      JSON.stringify({ t: "whatever" }),
      JSON.stringify({ t: "hello", name: "x", bytes: 0, sha256: "a".repeat(64), fp: "7K2M" }),
      JSON.stringify({ t: "hello", name: "x", bytes: 4, sha256: "zz", fp: "7K2M" }),
      JSON.stringify({ t: "ready" }),
      JSON.stringify({ t: "ack" }),
    ]) {
      expect(() => decodeControl(bad)).toThrow(WireError);
    }
  });

  it("reads an unknown abort reason as a plain refusal", () => {
    expect(decodeControl(JSON.stringify({ t: "abort", reason: "because" }))).toEqual({ t: "abort", reason: "refused" });
  });

  it("carries the sequence number in front of the payload", () => {
    const chunk = encodeChunk(70_000, new Uint8Array([9, 8, 7]));
    expect(chunk.length).toBe(7);
    expect(decodeChunk(chunk)).toEqual({ seq: 70_000, payload: new Uint8Array([9, 8, 7]) });
  });

  it("refuses a chunk that is empty, oversized, headerless or unnumbered", () => {
    expect(() => encodeChunk(0, new Uint8Array(0))).toThrow(WireError);
    expect(() => encodeChunk(0, new Uint8Array(CHUNK_BYTES + 1))).toThrow(WireError);
    expect(() => encodeChunk(-1, new Uint8Array(2))).toThrow(WireError);
    expect(() => decodeChunk(new Uint8Array([0, 0, 0, 1]))).toThrow(WireError);
  });

  it("tells a control frame from a chunk by its type, not by its contents", () => {
    expect(readFrame(encodeControl({ t: "done" }))).toEqual({ control: { t: "done" } });
    expect(readFrame(encodeChunk(0, new Uint8Array([1])))).toEqual({ chunk: { seq: 0, payload: new Uint8Array([1]) } });
  });

  it("counts the chunks a bundle becomes", () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2);
  });
});

describe("the assembler", () => {
  it("accepts chunks in order and rebuilds the bundle", () => {
    const a = new ChunkAssembler(5);
    a.accept({ seq: 0, payload: new Uint8Array([1, 2, 3]) });
    expect(a.bytes).toBe(3);
    a.accept({ seq: 1, payload: new Uint8Array([4, 5]) });
    expect(a.finish()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("refuses a gap, a repeat and an overrun", () => {
    const a = new ChunkAssembler(4);
    a.accept({ seq: 0, payload: new Uint8Array([1, 2]) });
    expect(() => a.accept({ seq: 2, payload: new Uint8Array([3]) })).toThrow(/expected chunk 1/);
    expect(() => a.accept({ seq: 0, payload: new Uint8Array([3]) })).toThrow(WireError);
    expect(() => a.accept({ seq: 1, payload: new Uint8Array([3, 4, 5]) })).toThrow(/more bytes than it announced/);
  });

  it("refuses to finish short", () => {
    const a = new ChunkAssembler(9);
    a.accept({ seq: 0, payload: new Uint8Array([1]) });
    expect(() => a.finish()).toThrow(/1 of 9 bytes/);
  });
});

describe("backpressure", () => {
  it("waits for the queue to drain before feeding it more", async () => {
    const [a] = pair();
    a.bufferedAmount = BUFFER_LOW_WATER * 8;
    const bytes = new Uint8Array(CHUNK_BYTES * 3).fill(7);
    let settled = false;
    const run = sendChunks(a, bytes).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(a.bufferedAmountLowThreshold).toBe(BUFFER_LOW_WATER);
    a.drainTo(0);
    await run;
    expect(settled).toBe(true);
  });

  it("stops when the caller says the person cancelled", async () => {
    const [a] = pair();
    await expect(sendChunks(a, new Uint8Array(CHUNK_BYTES * 2), { cancelled: () => true })).rejects.toThrow(
      /cancelled/,
    );
  });
});

// ── The key ──────────────────────────────────────────────────────────────────────────────────────

describe("the derived key", () => {
  it("is the same on both devices and different in another room", async () => {
    const one = await deriveTransferKeys(CODE, SALT);
    const two = await deriveTransferKeys(CODE, SALT);
    const elsewhere = await deriveTransferKeys(CODE, toBase64Url(new Uint8Array(16).fill(9)));
    const mistyped = await deriveTransferKeys(`${CODE}x`, SALT);
    expect(two).toEqual(one);
    expect(elsewhere.secret).not.toBe(one.secret);
    expect(mistyped.secret).not.toBe(one.secret);
    expect(mistyped.confirmation).not.toBe(one.confirmation);
  });

  it("is pinned, so a change of rule is a change of this line", async () => {
    const keys = await deriveTransferKeys(CODE, SALT);
    expect(keys.secret).toBe("JMnVTRyQDP3Y8vzLbYjWKiGD-ROzhvtFbEGHrgNs22o");
    expect(keys.confirmation).toBe("4LKZ");
  });

  it("shows four readable characters and never the key itself", async () => {
    const { confirmation, secret } = await deriveTransferKeys(CODE, SALT);
    expect(confirmation).toHaveLength(CONFIRM_LENGTH);
    for (const ch of confirmation) expect(CONFIRM_ALPHABET).toContain(ch);
    expect(confirmation).not.toContain("0");
    expect(secret).not.toContain(confirmation.toLowerCase());
  });

  it("refuses a missing code and a salt too short to bind a room", async () => {
    await expect(deriveTransferKeys("", SALT)).rejects.toThrow(/transfer needs its code/);
    await expect(deriveTransferKeys(CODE, toBase64Url(new Uint8Array(4)))).rejects.toThrow(/too short/);
    await expect(deriveTransferKeys(CODE, "not base64!!")).rejects.toThrow(/base64url/);
  });

  it("round-trips base64url with and without padding", () => {
    const bytes = new Uint8Array([251, 239, 190, 0, 1]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url("++//")).toEqual(fromBase64Url("--__"));
  });

  it("compares without a length-shortcut on the content", () => {
    expect(equalStrings("ABCD", "ABCD")).toBe(true);
    expect(equalStrings("ABCD", "ABCE")).toBe(false);
    expect(equalStrings("ABCD", "ABC")).toBe(false);
  });

  it("digests the bytes the way the wire says", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

// ── The two ends ─────────────────────────────────────────────────────────────────────────────────

/**
 * A real agent, deliberately BIGGER THAN ONE CHUNK. The sequence numbers, the ordering rule and the
 * dropped-chunk abort are only exercised by a bundle that takes several messages, and a scaffolded
 * agent gzips down to a few kilobytes — so one incompressible file is added to push it past 16 KB
 * several times over.
 */
async function agentBundle(secret: string): Promise<Uint8Array> {
  const fs = new MemoryFs();
  await scaffoldAgent(fs, { id: "ag_move_me", displayName: "Zero", emoji: "🟢" });
  await fs.writeFile("workspace/notes/keep.md", "the memory that has to survive the move");
  const bulk = new Uint8Array(120 * 1024);
  for (let i = 0; i < bulk.length; i += 65_536) {
    crypto.getRandomValues(bulk.subarray(i, Math.min(i + 65_536, bulk.length)));
  }
  await fs.writeFile("workspace/notes/bulk.bin", bulk);
  return exportBundle(fs, { secret, host: "browser" });
}

describe("send → receive", () => {
  it("moves a real agent from one filesystem to another and acks it", async () => {
    const source = await deriveTransferKeys(CODE, SALT);
    const target = await deriveTransferKeys(CODE, SALT);
    const bytes = await agentBundle(source.secret);
    const [a, b] = pair();
    const landed = new MemoryFs();
    const progress: number[] = [];

    const [sent, received] = await Promise.all([
      sendBundle(a, {
        bytes,
        name: "zero-2026-09-10.00agent",
        fingerprint: source.confirmation,
        onProgress: (n) => progress.push(n),
      }),
      receiveBundle(b, {
        fingerprint: target.confirmation,
        land: async (incoming) => {
          const result = await importBundleInto(landed, incoming, { secret: target.secret });
          return { agentId: result.manifest.agentId };
        },
      }),
    ]);

    expect(sent.agentId).toBe("ag_move_me");
    expect(received.bytes).toBe(bytes.length);
    expect(received.sha256).toBe(sent.sha256);
    expect(received.name).toBe("zero-2026-09-10.00agent");
    expect(progress.at(-1)).toBe(bytes.length);
    expect(await landed.readText("workspace/notes/keep.md")).toBe("the memory that has to survive the move");
    expect(JSON.parse(await landed.readText("profile.json")).id).toBe("ag_move_me");
  });

  it("tells the sender who has the agent, and nothing before the far side says so", async () => {
    const { secret, confirmation } = await deriveTransferKeys(CODE, SALT);
    const bytes = await agentBundle(secret);
    const [a, b] = pair();
    const order: string[] = [];

    const [sent] = await Promise.all([
      sendBundle(a, { bytes, name: "n.00agent", fingerprint: confirmation, onPeer: () => order.push("peer") }),
      receiveBundle(b, {
        fingerprint: confirmation,
        onHello: () => order.push("hello"),
        land: async () => {
          order.push("landed");
          return { agentId: "ag_move_me" };
        },
      }),
    ]);
    order.push("acked");
    expect(order).toEqual(["peer", "hello", "landed", "acked"]);
    expect(sent.agentId).toBe("ag_move_me");
  });

  it("refuses a peer that derived a different key, on both sides", async () => {
    const bytes = new Uint8Array(64).fill(3);
    const [a, b] = pair();
    await expect(
      Promise.all([
        sendBundle(a, { bytes, name: "n", fingerprint: "AAAA" }),
        receiveBundle(b, { fingerprint: "BBBB", land: async () => ({ agentId: "no" }) }),
      ]),
    ).rejects.toThrow(TransferAborted);
  });

  it("refuses a bundle whose bytes changed on the way", async () => {
    const { secret, confirmation } = await deriveTransferKeys(CODE, SALT);
    const bytes = await agentBundle(secret);
    // Flip one byte of the third chunk: the sequence is intact, so only the digest can catch it.
    const [a, b] = pair((data, i) => {
      if (typeof data === "string" || i !== 4) return data;
      const copy = new Uint8Array(data);
      copy[10] ^= 0xff;
      return copy;
    });
    const land = vi.fn(async () => ({ agentId: "never" }));
    const results = await Promise.allSettled([
      sendBundle(a, { bytes, name: "n", fingerprint: confirmation }),
      receiveBundle(b, { fingerprint: confirmation, land }),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TransferAborted);
    expect((results[1] as PromiseRejectedResult).reason.reason).toBe("sha256_mismatch");
    expect((results[0] as PromiseRejectedResult).reason.reason).toBe("sha256_mismatch");
    expect(land).not.toHaveBeenCalled();
  });

  it("aborts when a chunk is dropped rather than inventing the file", async () => {
    const { secret, confirmation } = await deriveTransferKeys(CODE, SALT);
    const bytes = await agentBundle(secret);
    const [a, b] = pair((data, i) => (typeof data === "string" || i !== 3 ? data : null));
    const results = await Promise.allSettled([
      sendBundle(a, { bytes, name: "n", fingerprint: confirmation }),
      receiveBundle(b, { fingerprint: confirmation, land: async () => ({ agentId: "no" }) }),
    ]);
    const receiver = results[1] as PromiseRejectedResult;
    expect(receiver.reason).toBeInstanceOf(WireError);
    expect(receiver.reason.code).toBe("out_of_order");
    expect((results[0] as PromiseRejectedResult).reason.reason).toBe("out_of_order");
  });

  it("aborts when the sender stops early", async () => {
    const { confirmation } = await deriveTransferKeys(CODE, SALT);
    const [a, b] = pair();
    const receiving = receiveBundle(b, { fingerprint: confirmation, land: async () => ({ agentId: "no" }) });
    // A hello that promises more than the one chunk that follows it.
    await new Promise<void>((resolve) => a.onMessage(() => resolve()));
    a.send(encodeControl({ t: "hello", name: "n", bytes: 40, sha256: "a".repeat(64), fp: confirmation }));
    a.send(encodeChunk(0, new Uint8Array(8)));
    a.send(encodeControl({ t: "done" }));
    await expect(receiving).rejects.toThrow(/8 of 40 bytes/);
  });

  it("tells the sender when the far side could not import it", async () => {
    const { secret, confirmation } = await deriveTransferKeys(CODE, SALT);
    const bytes = await agentBundle(secret);
    const [a, b] = pair();
    const results = await Promise.allSettled([
      sendBundle(a, { bytes, name: "n", fingerprint: confirmation }),
      receiveBundle(b, {
        fingerprint: confirmation,
        land: async () => {
          throw new Error("this Mac said no");
        },
      }),
    ]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("this Mac said no");
    expect((results[0] as PromiseRejectedResult).reason.reason).toBe("import_failed");
  });

  it("fails the waiting side when the channel closes mid-transfer", async () => {
    const [a, b] = pair();
    const sending = sendBundle(a, { bytes: new Uint8Array(4), name: "n", fingerprint: "AAAA" });
    b.close();
    a.close();
    await expect(sending).rejects.toThrow(/closed mid-transfer/);
  });

  it("refuses a frame that arrives out of turn", async () => {
    const [a, b] = pair();
    const sending = sendBundle(a, { bytes: new Uint8Array(4), name: "n", fingerprint: "AAAA" });
    b.send(encodeControl({ t: "done" }));
    await expect(sending).rejects.toThrow(/expected a ready frame and got done/);
  });

  it("stops a cancelled send and tells the far side", async () => {
    const { confirmation } = await deriveTransferKeys(CODE, SALT);
    const [a, b] = pair();
    const seen: string[] = [];
    b.onMessage((data) => {
      if (typeof data === "string") seen.push(data);
    });
    const sending = sendBundle(a, {
      bytes: new Uint8Array(CHUNK_BYTES * 2).fill(1),
      name: "n",
      fingerprint: confirmation,
      cancelled: () => true,
    });
    b.send(encodeControl({ t: "ready", fp: confirmation }));
    await expect(sending).rejects.toThrow(/cancelled/);
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(seen.some((s) => s.includes('"abort"') && s.includes("cancelled"))).toBe(true);
  });
});
