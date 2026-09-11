/**
 * The client half of the sync channel, in a REAL `worker_threads` Worker.
 *
 * This file is loaded by Node directly (type stripping), not by vitest, which is why it may import
 * only `src/fs/sync-channel.ts` — the one module in this package that imports nothing itself. That
 * constraint is the point: it proves the client half can be loaded standalone into a Worker the way
 * a browser host would load it, with no bundler and no rest-of-the-package in front of it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { SyncFsClient } from "../src/fs/sync-channel.ts";

const client = new SyncFsClient(workerData.sab as SharedArrayBuffer);
const port = parentPort as NonNullable<typeof parentPort>;

port.on("message", (message: { op: string; args?: Record<string, unknown>; data?: Uint8Array; id: number }) => {
  try {
    const reply = client.call(message.op, message.args ?? {}, message.data ? new Uint8Array(message.data) : null);
    port.postMessage({ id: message.id, ok: true, value: reply.value, data: reply.data, length: reply.data.byteLength });
  } catch (err) {
    port.postMessage({ id: message.id, ok: false, code: (err as { code?: string }).code, message: (err as Error).message });
  }
});

port.postMessage({ ready: true, usable: SyncFsClient.usable(), sameBuffer: client.buffer === workerData.sab });
