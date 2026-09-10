/**
 * The shared-memory channel, run for real.
 *
 * WHAT MAKES THESE REAL. The client is not a mock and it is not even an import: the worker thread
 * below evaluates `syncChannelSource()` — the SAME string apps/infinite/src/power/js-runner.ts
 * appends to the script Worker's source and fs-service.ts puts in the service Worker — and blocks on
 * `Atomics.wait` in that thread exactly as a browser Worker does. The server is the real
 * `createSyncServer`, running asynchronously on this thread, exactly as it runs in the service
 * Worker. Node's `worker_threads` and a browser's `Worker` are different objects; `SharedArrayBuffer`
 * and `Atomics` are the same specification, and they are the whole protocol.
 *
 * The one thing node cannot check is that a browser hands out `SharedArrayBuffer` at all — that is
 * `crossOriginIsolated`, and it is the live check recorded in apps/infinite-site/README.md.
 */
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
// The MODULE, not the package root. `@00/agent-node`'s entry point re-exports its whole runtime —
// the loader, the npm client, the process manager — and pulling that into this app's `vue-tsc`
// program would make this suite's typecheck a typecheck of code it does not run. One file is what
// the reconciliation below is about.
import { NodeCompatError } from "../../../packages/agent-node/src/errors.js";
import { createSyncChannel, serveSyncChannel } from "../../../packages/agent-node/src/fs/sync-channel.js";
import {
  FRAME_MAX_BYTES,
  HEADER_BYTES,
  SYNC_CHANNEL_LAYOUT,
  createChannelBuffer,
  createSyncServer,
  syncChannelSource,
  type SyncRequest,
  type SyncResponse,
} from "../src/power/sync-channel.js";

interface CallSpec {
  op: string;
  args?: Record<string, unknown>;
  data?: Uint8Array;
}

interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  dataLength: number;
  /** A cheap fingerprint of the returned bytes, so a 2 MB body is checked without shipping it back. */
  sum: number;
}

/** The bytes a chunked frame is made of: distinct enough that a lost or reordered chunk shows up. */
function pattern(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

function sum(bytes: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) total = (total + bytes[i]! * (i % 7) + i) % 2_147_483_647;
  return total;
}

/**
 * One blocking client, in its own thread, running the shipped source. It makes the calls it was
 * given, in order, and reports what came back.
 */
function callFromWorker(sab: SharedArrayBuffer, calls: CallSpec[]): Promise<CallResult[]> {
  const program = `
    const { workerData, parentPort } = require("node:worker_threads");
    const self = globalThis;
    ${syncChannelSource()}
    const client = self.__00SyncChannel(workerData.sab, self.__00SyncChannelLayout, "client");
    const out = [];
    for (const call of workerData.calls) {
      try {
        const answer = client.call(call.op, call.args || {}, call.data);
        const data = answer.data || new Uint8Array(0);
        let total = 0;
        for (let i = 0; i < data.byteLength; i += 1) total = (total + data[i] * (i % 7) + i) % 2147483647;
        out.push({ ok: answer.ok, value: answer.value, error: answer.error, code: answer.code, dataLength: data.byteLength, sum: total });
      } catch (err) {
        out.push({ ok: false, error: String(err && err.message ? err.message : err), dataLength: 0, sum: 0 });
      }
    }
    parentPort.postMessage(out);
  `;
  return new Promise<CallResult[]>((resolve, reject) => {
    const worker = new Worker(program, { eval: true, workerData: { sab, calls } });
    worker.once("message", (message: CallResult[]) => {
      void worker.terminate();
      resolve(message);
    });
    worker.once("error", reject);
  });
}

/** Run a server on this thread for as long as the client needs it, then close it. */
async function withServer<T>(
  sab: SharedArrayBuffer,
  handler: (request: SyncRequest) => SyncResponse | Promise<SyncResponse>,
  body: () => Promise<T>,
): Promise<T> {
  const server = createSyncServer(sab, handler);
  const serving = server.serve();
  try {
    return await body();
  } finally {
    server.close();
    await serving;
  }
}

describe("the shared-memory channel", () => {
  it("answers a call made from another thread, JSON and bytes together", async () => {
    const sab = createChannelBuffer(4096);
    const seen: SyncRequest[] = [];
    const results = await withServer(
      sab,
      (request) => {
        seen.push(request);
        return { ok: true, value: { echoed: request.args.path }, data: new TextEncoder().encode("hello") };
      },
      () => callFromWorker(sab, [{ op: "readFile", args: { path: "/a.txt" } }]),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.op).toBe("readFile");
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.value).toEqual({ echoed: "/a.txt" });
    expect(results[0]!.dataLength).toBe(5);
  });

  it("carries a 2 MB body both ways, in chunks, byte for byte", async () => {
    // TWO MEGABYTES over a ONE MEGABYTE window: the continuation is not an edge case here, it is the
    // path. A file a script reads or writes is routinely bigger than the window, and a protocol that
    // only ever had one chunk tested is a protocol that has never been tested.
    const sab = createChannelBuffer();
    const sent = pattern(2 * FRAME_MAX_BYTES);
    const back = pattern(2 * FRAME_MAX_BYTES + 12_345);
    let received: Uint8Array | undefined;
    const results = await withServer(
      sab,
      (request) => {
        received = request.data;
        return { ok: true, value: { size: request.data?.byteLength ?? 0 }, data: back };
      },
      () => callFromWorker(sab, [{ op: "writeFile", args: { path: "/big.bin" }, data: sent }]),
    );
    expect(received?.byteLength).toBe(sent.byteLength);
    expect(sum(received!)).toBe(sum(sent));
    expect(results[0]!.value).toEqual({ size: sent.byteLength });
    expect(results[0]!.dataLength).toBe(back.byteLength);
    expect(results[0]!.sum).toBe(sum(back));
  });

  it("keeps the window clean between calls, whatever their sizes", async () => {
    const sab = createChannelBuffer(1024);
    const results = await withServer(
      sab,
      (request) => ({ ok: true, value: request.args.n, data: pattern(Number(request.args.n)) }),
      () =>
        callFromWorker(
          sab,
          [0, 1, 1023, 1024, 1025, 4096, 7].map((n) => ({ op: "readFile", args: { n } })),
        ),
    );
    expect(results.map((r) => r.dataLength)).toEqual([0, 1, 1023, 1024, 1025, 4096, 7]);
    expect(results.map((r) => r.sum)).toEqual([0, 1, 1023, 1024, 1025, 4096, 7].map((n) => sum(pattern(n))));
  });

  it("gives a refusal back as a refusal, not as a throw", async () => {
    const sab = createChannelBuffer(512);
    const results = await withServer(
      sab,
      () => ({ ok: false, error: "ENOENT: no such file or directory, open '/nope'" }),
      () => callFromWorker(sab, [{ op: "readFile", args: { path: "/nope" } }]),
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("ENOENT");
  });

  it("turns a handler that throws into an answer, because the caller is blocked", async () => {
    const sab = createChannelBuffer(512);
    const results = await withServer(
      sab,
      () => {
        throw new Error("the service fell over");
      },
      () => callFromWorker(sab, [{ op: "stat", args: {} }]),
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("the service fell over");
  });

  it("releases a blocked client when the channel closes instead of leaving it parked", async () => {
    const sab = createChannelBuffer(512);
    const server = createSyncServer(sab, async (request) => {
      if (request.op === "slow") {
        // Close from underneath a client that is already waiting: the page does exactly this when a
        // script is killed, and a client that never woke would hang that Worker for ever.
        server.close();
        return { ok: true, value: null };
      }
      return { ok: true, value: null };
    });
    const serving = server.serve();
    const results = await callFromWorker(sab, [{ op: "slow", args: {} }, { op: "again", args: {} }]);
    await serving;
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("has stopped");
    expect(results[1]!.error).toContain("has stopped");
  });

  it("names the mistake of a server with nothing behind it", () => {
    expect(() => createSyncServer(createChannelBuffer(64), undefined as never)).toThrow(/needs a handler/);
  });

  it("writes the layout into the source once, so both ends cannot drift", () => {
    const source = syncChannelSource();
    expect(source).toContain(JSON.stringify(SYNC_CHANNEL_LAYOUT));
    // The same rule as the runner's prelude: the closure does not travel into a Worker.
    for (const outside of ["SYNC_CHANNEL_LAYOUT", "FRAME_MAX_BYTES", "createChannelBuffer"]) {
      expect(source.slice(source.indexOf("(function")), `the channel reaches for ${outside}`).not.toContain(outside);
    }
  });
});

/**
 * THE RECONCILIATION, RUN. `@00/agent-node` defines the same channel for its own Worker-per-process
 * model (`packages/agent-node/src/fs/sync-channel.ts`), and the point of copying its header layout,
 * its state machine and its message encoding is that there is ONE wire in this product, not two that
 * look alike. The only way to know that is to put one side's client against the other side's server
 * and see bytes come back — so this drives THEIR server with OUR stringified client. (The mirror
 * direction would need their class inside a worker thread, which has no TypeScript loader; the wire
 * is symmetric, so one crossing proves the layout, the acks and the frame boundary all agree.)
 */
describe("the same wire as @00/agent-node", () => {
  it("agrees on the header, so their server answers our client", async () => {
    expect(HEADER_BYTES).toBe(64);
    expect(createSyncChannel().byteLength).toBe(createChannelBuffer().byteLength);

    const sab = createSyncChannel();
    const seen: { op: string; bytes: number }[] = [];
    const service = {
      call: async (op: string, args: Record<string, unknown>, data: Uint8Array | null) => {
        seen.push({ op, bytes: data?.byteLength ?? 0 });
        if (op === "readFile") return { value: { path: args.path }, data: pattern(2 * FRAME_MAX_BYTES + 7) };
        throw new NodeCompatError("ENOENT", "ENOENT: no such file or directory, open '/nope'");
      },
    };
    const handle = serveSyncChannel(service, sab);
    try {
      const results = await callFromWorker(sab, [
        { op: "readFile", args: { path: "/big" }, data: pattern(3_000_000) },
        { op: "chmod", args: {} },
      ]);
      expect(seen).toEqual([{ op: "readFile", bytes: 3_000_000 }, { op: "chmod", bytes: 0 }]);
      expect(results[0]!.ok).toBe(true);
      expect(results[0]!.value).toEqual({ path: "/big" });
      expect(results[0]!.dataLength).toBe(2 * FRAME_MAX_BYTES + 7);
      expect(results[0]!.sum).toBe(sum(pattern(2 * FRAME_MAX_BYTES + 7)));
      // Their error frame (KIND 1, `{ code, message }`) arrives as our refusal, code included.
      expect(results[1]!.ok).toBe(false);
      expect(results[1]!.error).toContain("ENOENT");
      expect(results[1]!.code).toBe("ENOENT");
    } finally {
      handle.stop();
    }
  });
});
