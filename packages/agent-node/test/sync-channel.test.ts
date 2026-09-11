import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSyncChannel,
  serveSyncChannel,
  SyncFsClient,
  DEFAULT_SAB_BYTES,
  FRAME_BYTES,
  HEADER_BYTES,
  type SyncChannelHandle,
} from "../src/fs/sync-channel.js";
import { fsModule } from "../src/modules/fs.js";
import { memoryBackend, text } from "./helpers.js";

/**
 * The channel end to end, with a real SharedArrayBuffer and a real worker_threads Worker.
 *
 * WHY A REAL WORKER. `Atomics.wait` blocks the thread that calls it. If the service and the client
 * shared a thread the very first call would deadlock, so a fake would have to fake the blocking —
 * which is the only interesting part. The vitest thread runs the SERVICE (the real filesystem side)
 * and a genuine Worker runs the CLIENT, which is exactly the browser's arrangement with the page and
 * the script's Worker.
 */

function sum(bytes: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < bytes.length; i++) total = (total + bytes[i]! * ((i % 7) + 1)) % 2147483647;
  return total;
}

interface Reply {
  id: number;
  ok: boolean;
  value?: unknown;
  data?: Uint8Array;
  length?: number;
  code?: string;
  message?: string;
}

class Harness {
  private worker: Worker;
  private handle: SyncChannelHandle;
  private id = 0;
  private waiting = new Map<number, (reply: Reply) => void>();
  ready: Promise<{ usable: boolean; sameBuffer: boolean }>;

  constructor(service: { call(op: string, args: Record<string, unknown>, data: Uint8Array | null): Promise<{ value?: unknown; data?: Uint8Array }> }, bytes?: number) {
    const sab = createSyncChannel(bytes);
    this.handle = serveSyncChannel(service, sab);
    // `execArgv: []` matters: a Worker inherits the parent's execArgv by default, and vitest starts
    // its pool with its own module-runner flags — a worker that inherited them would try to join
    // vitest's RPC and hang before running a line of this file.
    this.worker = new Worker(new URL("./sync-fs-worker.ts", import.meta.url), { workerData: { sab }, execArgv: [] });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("error", reject);
      this.worker.on("message", (message: Reply & { ready?: boolean; usable?: boolean; sameBuffer?: boolean }) => {
        if (message.ready) {
          resolve({ usable: Boolean(message.usable), sameBuffer: Boolean(message.sameBuffer) });
          return;
        }
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      });
    });
  }

  call(op: string, args: Record<string, unknown> = {}, data?: Uint8Array): Promise<Reply> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, op, args, data });
    });
  }

  async stop(): Promise<void> {
    this.handle.stop();
    await this.worker.terminate();
  }
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

describe("the sync filesystem channel", () => {
  it("carries a small call both ways", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one" });
    harness = new Harness(backend);
    const ready = await harness.ready;
    expect(ready.usable).toBe(true);
    expect(ready.sameBuffer).toBe(true);

    const read = await harness.call("readFile", { path: "/a.txt" });
    expect(read.ok).toBe(true);
    expect(text(read.data)).toBe("one");

    const stat = await harness.call("stat", { path: "/a.txt" });
    expect(stat.value).toMatchObject({ kind: "file", size: 3 });

    const exists = await harness.call("exists", { path: "/nope" });
    expect(exists.value).toBe(false);
  });

  it("crosses the 1 MB frame limit in both directions with a 2 MB file", async () => {
    const { backend } = await memoryBackend();
    harness = new Harness(backend);
    await harness.ready;

    // A pattern rather than zeros, so a frame that arrived in the wrong order would be visible.
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    expect(big.byteLength).toBeGreaterThan(FRAME_BYTES);

    const written = await harness.call("writeFile", { path: "/big.bin" }, big);
    expect(written.ok, written.message).toBe(true);
    expect((await backend.readFile("/big.bin")).byteLength).toBe(big.byteLength);

    const read = await harness.call("readFile", { path: "/big.bin" });
    expect(read.ok).toBe(true);
    expect(read.length).toBe(big.byteLength);
    // A checksum, not a deep-equal: `toEqual` over two million elements is minutes of chai, and a
    // sum plus the boundary bytes catches a dropped, doubled or reordered frame just as well.
    expect(sum(read.data as Uint8Array)).toBe(sum(big));
    expect([...(read.data as Uint8Array).subarray(FRAME_BYTES - 2, FRAME_BYTES + 2)]).toEqual([...big.subarray(FRAME_BYTES - 2, FRAME_BYTES + 2)]);
  });

  it("carries an error back as an error, with its code", async () => {
    const { backend } = await memoryBackend();
    harness = new Harness(backend);
    await harness.ready;
    const missing = await harness.call("readFile", { path: "/gone.txt" });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("ENOENT");
    expect(missing.message).toContain("gone.txt");
  });

  it("works on a channel barely bigger than the header, so every message is many frames", async () => {
    const { backend } = await memoryBackend();
    harness = new Harness(backend, HEADER_BYTES + 1024);
    await harness.ready;
    const body = new TextEncoder().encode("x".repeat(9000));
    expect((await harness.call("writeFile", { path: "/many.txt" }, body)).ok).toBe(true);
    const read = await harness.call("readFile", { path: "/many.txt" });
    expect(read.length).toBe(9000);
    expect(text(read.data)).toBe("x".repeat(9000));
  });

  it("makes the whole sync face of fs real once the backend has a client", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one" });
    const sab = createSyncChannel();
    const handle = serveSyncChannel(backend, sab);
    // The CLIENT is created here purely to prove the wiring; it is not called from this thread,
    // because a thread that serves and waits on itself is the deadlock this design exists around.
    backend.sync = new SyncFsClient(sab);
    expect(backend.hasSync).toBe(true);
    const { fs } = fsModule(backend);
    expect((fs as { readFileSync: unknown }).readFileSync).toBeTypeOf("function");
    handle.stop();
  });

  it("a stopped service turns the next call into a named refusal rather than a hang", async () => {
    const { backend } = await memoryBackend();
    const sab = createSyncChannel();
    const handle = serveSyncChannel(backend, sab);
    handle.stop();
    const client = new SyncFsClient(sab, { timeoutMs: 200 });
    expect(() => client.call("readFile", { path: "/a" })).toThrow(/has stopped/);
  });

  it("gives up on a service that stopped mid-call rather than freezing the thread", async () => {
    const { backend } = await memoryBackend();
    const sab = createSyncChannel();
    // Served by nobody: the state never leaves IDLE, so the wait runs out and says so.
    void backend;
    const client = new SyncFsClient(sab, { timeoutMs: 150 });
    expect(() => client.call("readFile", { path: "/a" })).toThrow(/did not answer within 150ms/);
  });

  it("sizes itself for one full frame by default and never smaller than the header", () => {
    expect(DEFAULT_SAB_BYTES).toBe(HEADER_BYTES + FRAME_BYTES);
    expect(createSyncChannel(1).byteLength).toBe(HEADER_BYTES + 1024);
    expect(createSyncChannel().byteLength).toBe(DEFAULT_SAB_BYTES);
    expect(SyncFsClient.usable()).toBe(true);
  });
});
