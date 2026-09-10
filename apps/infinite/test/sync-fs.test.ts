/**
 * The synchronous filesystem a script gets on a cross-origin isolated origin — and the refusal it
 * gets everywhere else.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The script, the prelude and the runner are the shipped ones:
 * `createEvalWorker` evaluates the same `workerSource()` a Blob Worker is built from, so `require`,
 * `fs.readFileSync` and `fs.writeFileSync` below are the real code paths. What is faked is the far
 * end of the channel — a real one would need two threads and a real OPFS, and both are covered
 * elsewhere (test/sync-channel.test.ts drives the protocol across `worker_threads`; the OPFS half is
 * the untestable-in-node adapter, checked live in a browser and recorded in
 * apps/infinite-site/README.md). The fake answers the ops with the same names and the same sentences
 * the service Worker answers them with, which is exactly the seam worth pinning: if the runner asked
 * for `read` instead of `readFile`, this fails.
 */
import { describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import { createEvalWorker, runScript, type RunnerWorkerFactory } from "../src/power/js-runner.js";
import {
  SYNC_CHANNEL_LAYOUT,
  createChannelBuffer,
  type SyncChannelClient,
  type SyncResponse,
} from "../src/power/sync-channel.js";
import {
  fsServiceSource,
  isCrossOriginIsolated,
  resetFsService,
  startFsService,
  type FsService,
  type ServiceWorkerLike,
} from "../src/power/fs-service.js";
import { resetPorts } from "../src/power/virtual-ports.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A channel with a folder behind it. Synchronous, in memory, and deliberately NOT the workspace the
 * runner's async RPC writes to — so a test can tell which road a call took.
 */
function fakeChannel(seed: Record<string, string> = {}): SyncChannelClient & { store: Map<string, Uint8Array>; ops: string[] } {
  const store = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(seed)) store.set(path, encoder.encode(text));
  const ops: string[] = [];
  const dirs = (path: string): string[] =>
    [...store.keys()].filter((key) => key.startsWith(path === "/" ? "/" : `${path}/`));
  const call = (op: string, args: Record<string, unknown> = {}, data?: Uint8Array): SyncResponse => {
    ops.push(op);
    const path = String(args.path ?? "");
    switch (op) {
      case "readFile": {
        const found = store.get(path);
        return found ? { ok: true, data: found } : { ok: false, error: `ENOENT: no such file or directory, open '${path}'` };
      }
      case "writeFile":
        store.set(path, data ?? new Uint8Array(0));
        return { ok: true, value: null };
      case "appendFile": {
        const before = store.get(path) ?? new Uint8Array(0);
        const joined = new Uint8Array(before.byteLength + (data?.byteLength ?? 0));
        joined.set(before, 0);
        if (data) joined.set(data, before.byteLength);
        store.set(path, joined);
        return { ok: true, value: null };
      }
      case "mkdir":
        return { ok: true, value: null };
      case "exists":
        return { ok: true, value: store.has(path) || dirs(path).length > 0 };
      case "stat": {
        const found = store.get(path);
        if (found) return { ok: true, value: { size: found.byteLength, mtimeMs: 5, file: true, directory: false } };
        if (dirs(path).length) return { ok: true, value: { size: 0, mtimeMs: 0, file: false, directory: true } };
        return { ok: false, error: `ENOENT: no such file or directory, stat '${path}'` };
      }
      case "readdir": {
        const prefix = path === "/" ? "/" : `${path}/`;
        const names = new Set<string>();
        for (const key of store.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
        }
        if (!names.size) return { ok: false, error: `ENOENT: no such file or directory, scandir '${path}'` };
        return { ok: true, value: [...names] };
      }
      case "unlink":
      case "rm":
        store.delete(path);
        return { ok: true, value: null };
      case "rename": {
        const found = store.get(path);
        if (!found) return { ok: false, error: `ENOENT: no such file or directory, rename '${path}'` };
        store.delete(path);
        store.set(String(args.to ?? ""), found);
        return { ok: true, value: null };
      }
      default:
        return { ok: false, error: `fs.${op} is not one of the operations this browser runtime has` };
    }
  };
  return { call, close: () => undefined, store, ops };
}

/** A service that hands out real buffers (nothing reads them) and counts what the runner does. */
function fakeService(): FsService & { opened: number; released: number } {
  const service = {
    agentId: "test-agent",
    opened: 0,
    released: 0,
    open(): SharedArrayBuffer {
      service.opened += 1;
      return createChannelBuffer(64);
    },
    release(): void {
      service.released += 1;
    },
    stop(): void {},
  };
  return service;
}

interface Run {
  out: string;
  err: string;
  code: number;
}

async function runWith(
  code: string,
  channel: SyncChannelClient | null,
  extra: Partial<Parameters<typeof runScript>[1]> = {},
): Promise<Run & { service: ReturnType<typeof fakeService> | null }> {
  const fs = new MemoryFs();
  await fs.mkdir("workspace/projects/site");
  await fs.writeFile("workspace/projects/site/data.json", '{"who":"snapshot"}');
  const service = channel ? fakeService() : null;
  const createWorker: RunnerWorkerFactory = (source) =>
    createEvalWorker(source, channel ? { __00SyncChannel: () => channel } : undefined);
  let out = "";
  let err = "";
  const result = await runScript(fs, {
    code,
    cwd: "/projects/site",
    createWorker,
    syncFs: service,
    onStdout: (t) => (out += t),
    onStderr: (t) => (err += t),
    ...extra,
  });
  resetPorts();
  return { out, err, code: result.exitCode, service };
}

describe("the sync filesystem, when the origin is isolated", () => {
  it("reads a file the snapshot never had, because the channel asks the workspace", async () => {
    const channel = fakeChannel({ "/projects/site/written-later.txt": "from the workspace" });
    const r = await runWith("console.log(require('fs').readFileSync('./written-later.txt', 'utf8'))", channel);
    expect(r.err).toBe("");
    expect(r.out).toBe("from the workspace\n");
    expect(channel.ops).toContain("readFile");
  });

  it("writes for real, and reads back what it just wrote", async () => {
    const channel = fakeChannel();
    const r = await runWith(
      "const fs = require('fs');" +
        "fs.writeFileSync('./out.txt', 'one');" +
        "fs.appendFileSync('./out.txt', '-two');" +
        "console.log(fs.readFileSync('./out.txt', 'utf8'), fs.existsSync('./out.txt'));",
      channel,
    );
    expect(r.err).toBe("");
    expect(r.out).toBe("one-two true\n");
    expect(decoder.decode(channel.store.get("/projects/site/out.txt")!)).toBe("one-two");
  });

  it("does the rest of the sync verbs against the service, not against the snapshot", async () => {
    const channel = fakeChannel({ "/projects/site/a.txt": "a" });
    const r = await runWith(
      "const fs = require('fs');" +
        "fs.mkdirSync('./sub');" +
        "fs.renameSync('./a.txt', './b.txt');" +
        "console.log(fs.statSync('./b.txt').size, fs.statSync('./b.txt').isFile(), fs.readdirSync('.').join(','));" +
        "fs.unlinkSync('./b.txt');" +
        "console.log(fs.existsSync('./b.txt'));",
      channel,
    );
    expect(r.err).toBe("");
    expect(r.out).toBe("1 true b.txt\nfalse\n");
    expect(channel.ops).toEqual(expect.arrayContaining(["mkdir", "rename", "stat", "readdir", "unlink", "exists"]));
  });

  it("lets require load a file the working folder never held", async () => {
    // The point of the whole exercise: `require` used to see the cwd snapshot and nothing else.
    const channel = fakeChannel({ "/shared/kit/greet.js": "module.exports = () => 'hello from the kit';" });
    const r = await runWith("console.log(require('/shared/kit/greet.js')())", channel);
    expect(r.err).toBe("");
    expect(r.out).toBe("hello from the kit\n");
  });

  it("gives back ENOENT, not a lecture about isolation, when the file is simply not there", async () => {
    const channel = fakeChannel();
    const r = await runWith("require('fs').readFileSync('./nope.txt', 'utf8')", channel);
    expect(r.err).toContain("ENOENT");
    expect(r.err).not.toContain("SyncUnsupportedError");
    expect(r.code).toBe(1);
  });

  it("opens one channel per run and releases it when the script ends", async () => {
    const channel = fakeChannel();
    const r = await runWith("console.log('done')", channel);
    expect(r.service?.opened).toBe(1);
    expect(r.service?.released).toBe(1);
  });
});

describe("the sync filesystem, when the origin is not isolated", () => {
  it("refuses a sync write by name and says what to use instead", async () => {
    const r = await runWith("require('fs').writeFileSync('./x.txt', 'no')", null);
    expect(r.err).toContain("SyncUnsupportedError");
    expect(r.err).toContain("cross-origin isolation");
    expect(r.err).toContain("fs.promises.writeFile");
  });

  it("explains a sync read the snapshot cannot answer", async () => {
    const r = await runWith("require('fs').readFileSync('./written-later.txt', 'utf8')", null);
    expect(r.err).toContain("SyncUnsupportedError");
    expect(r.err).toContain("snapshot of your working folder");
  });

  it("still answers from the snapshot, which is the whole point of keeping it", async () => {
    const r = await runWith("console.log(require('fs').readFileSync('./data.json', 'utf8'))", null);
    expect(r.out).toBe('{"who":"snapshot"}\n');
  });
});

describe("the filesystem service", () => {
  it("is nothing at all on an origin without the headers", async () => {
    expect(isCrossOriginIsolated()).toBe(false);
    await expect(startFsService()).resolves.toBeNull();
  });

  it("opens a workspace, hands out channels, and closes them on release", async () => {
    const scope = globalThis as { crossOriginIsolated?: boolean };
    const before = scope.crossOriginIsolated;
    scope.crossOriginIsolated = true;
    try {
      expect(isCrossOriginIsolated()).toBe(true);
      const posted: { t?: string; sab?: SharedArrayBuffer }[] = [];
      let stopped = false;
      const worker: ServiceWorkerLike = {
        post: (message) => {
          posted.push(message as { t?: string });
          if ((message as { t?: string }).t === "open") {
            queueMicrotask(() => handler?.({ t: "open-reply", ok: true, agentId: "agent-7" }));
          }
        },
        onMessage: (fn) => (handler = fn),
        terminate: () => (stopped = true),
      };
      let handler: ((message: unknown) => void) | undefined;
      const service = await startFsService({ createWorker: () => worker });
      expect(service?.agentId).toBe("agent-7");
      // `filesRoot` travels rather than being written down twice: the service is opened at the same
      // folder `virtual-ports.ts` calls the workspace.
      expect(posted[0]).toMatchObject({ t: "open", filesRoot: "workspace" });

      const sab = service!.open();
      expect(posted[1]).toMatchObject({ t: "serve" });
      expect(posted[1]!.sab).toBe(sab);
      // Release is not a message: the page holds the same memory, so it ends the loop by writing to it.
      const slots = new Int32Array(sab, 0, SYNC_CHANNEL_LAYOUT.slots);
      expect(Atomics.load(slots, SYNC_CHANNEL_LAYOUT.state)).toBe(SYNC_CHANNEL_LAYOUT.idle);
      service!.release(sab);
      expect(Atomics.load(slots, SYNC_CHANNEL_LAYOUT.state)).toBe(SYNC_CHANNEL_LAYOUT.closed);

      service!.stop();
      expect(stopped).toBe(true);
    } finally {
      if (before === undefined) delete (scope as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      else scope.crossOriginIsolated = before;
      resetFsService();
    }
  });

  it("carries no reference to this module's scope into the Worker", () => {
    // Same rule as the runner's prelude: the closure does not travel, and a slip is a ReferenceError
    // in a browser and nowhere else.
    const source = fsServiceSource();
    for (const outside of ["FILES_ROOT", "SYNC_CHANNEL_LAYOUT", "createChannelBuffer", "startFsService"]) {
      expect(source, `the service reaches for ${outside}`).not.toContain(outside);
    }
    expect(source).toContain("__00SyncChannel");
  });
});
