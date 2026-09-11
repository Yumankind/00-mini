import { describe, expect, it } from "vitest";
import { ProcessManager, DEFAULT_MAX_PROCESSES, type ChildProcess, type ProcessSpec } from "../src/process/manager.js";
import { createInlineWorkerFactory, decodeChunk, type ProcessIo } from "../src/process/runner.js";
import { childProcessModule, workerThreadsModule } from "../src/modules/child.js";
import { createProcess } from "../src/modules/process.js";
import { snap } from "./helpers.js";
import type { CreateLoaderOptions } from "../src/loader/index.js";
import { NodeFsBackend } from "../src/fs/backend.js";
import { MemoryFs } from "@00/agent-fs";
import { createEsbuildTransformer } from "../src/transform/esbuild.js";
import type { Transformer } from "../src/loader/transform.js";

/**
 * The scripts these processes run. Ordinary CommonJS, as a person would write it, so what is being
 * tested is the process wire and not a fixture's cleverness.
 */
const scripts: Record<string, string> = {
  "/hello.js": `console.log("hello", process.argv[2] || "world"); console.error("on stderr");`,
  "/exit.js": `process.exitCode = 0; console.log("before"); process.exit(7); console.log("never");`,
  "/boom.js": `throw new Error("the script threw");`,
  "/later.js": `setTimeout(() => { console.log("late"); }, 10);`,
  "/timer-exit.js": `setTimeout(() => { process.exit(3); }, 5);`,
  "/interval.js": `const h = setInterval(() => {}, 1000); clearInterval(h); console.log("cleared");`,
  "/cleared.js": `const h = setTimeout(() => console.log("never"), 1000); clearTimeout(h); console.log("done");`,
  "/env.js": `console.log(process.env.GREETING, process.cwd());`,
  "/stdin.js": `
    let seen = "";
    __stdin((chunk) => {
      if (chunk === null) { console.log("read:" + seen); return; }
      seen += new TextDecoder().decode(chunk);
    });
  `,
  "/ipc.js": `process.send({ from: "child" }); require("worker_threads").parentPort.on("message", (m) => { console.log("got " + m.value); });`,
  "/upper.js": `
    let seen = "";
    __stdin((chunk) => {
      if (chunk === null) { process.stdout.write(seen.toUpperCase()); return; }
      seen += new TextDecoder().decode(chunk);
    });
  `,
  "/fs.js": `
    const fs = require("fs/promises");
    fs.writeFile("/written.txt", "by a child").then(() => fs.readFile("/written.txt", "utf8")).then((t) => console.log(t));
  `,
  "/held.js": `__hold(); console.log("holding");`,
  "/worker-data.js": `const wt = require("worker_threads"); console.log(JSON.stringify({ data: wt.workerData, main: wt.isMainThread, id: wt.threadId }));`,
};

interface Harness {
  manager: ProcessManager;
  fs: MemoryFs;
}

function harness(extra: Record<string, string> = {}, transformer: Transformer | null = null): Harness {
  const fs = new MemoryFs();
  const loaderFs = snap({ ...scripts, ...extra });
  const factory = createInlineWorkerFactory({
    configure(spec: ProcessSpec, io: ProcessIo): CreateLoaderOptions {
      const backend = new NodeFsBackend({ fs, root: "", cwd: () => spec.cwd });
      return {
        transformer,
        fs: loaderFs,
        cwd: spec.cwd,
        root: "/",
        backend,
        // Two host-supplied globals, so the fixtures can reach the two things only a host can wire:
        // the process's stdin, and the keep-alive an open server would take.
        globals: {
          __stdin: (handler: (chunk: Uint8Array | null) => void) => {
            const release = io.hold();
            io.onStdin((chunk) => {
              handler(chunk);
              if (chunk === null) release();
            });
          },
          __hold: () => io.hold(),
        },
      };
    },
  });
  return { manager: new ProcessManager({ createWorker: factory, cwd: "/", env: { BASE: "1" } }), fs };
}

function collect(child: ChildProcess): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on("data", (c: Uint8Array) => out.push(decodeChunk(c)));
  child.stderr?.on("data", (c: Uint8Array) => err.push(decodeChunk(c)));
  return new Promise((resolve) => {
    child.on("close", (code: number | null, signal: string | null) => {
      resolve({ code, signal, out: out.join(""), err: err.join("") });
    });
  });
}

describe("ProcessManager", () => {
  it("runs a script, streams both pipes and reports exit 0", async () => {
    const { manager } = harness();
    const child = manager.spawn("node", ["/hello.js", "there"]);
    let spawned = false;
    child.on("spawn", () => (spawned = true));
    const result = await collect(child);
    expect(result.out).toBe("hello there\n");
    expect(result.err).toBe("on stderr\n");
    expect(result.code).toBe(0);
    expect(spawned).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(child.spawnfile).toBe("node");
    expect(child.spawnargs).toEqual(["node", "/hello.js", "there"]);
  });

  it("carries process.exit's code, and the code of a throw", async () => {
    const { manager } = harness();
    const exited = await collect(manager.spawn("node", ["/exit.js"]));
    expect(exited.out).toBe("before\n");
    expect(exited.code).toBe(7);

    const threw = await collect(manager.spawn("node", ["/boom.js"]));
    expect(threw.code).toBe(1);
    expect(threw.err).toContain("the script threw");
  });

  it("stays alive for a pending timer and exits when the loop goes quiet", async () => {
    const { manager } = harness();
    const late = await collect(manager.spawn("node", ["/later.js"]));
    expect(late.out).toBe("late\n");
    expect(late.code).toBe(0);

    // A `process.exit` from inside a timer callback still sets the code.
    const fromTimer = await collect(manager.spawn("node", ["/timer-exit.js"]));
    expect(fromTimer.code).toBe(3);

    // A cleared timer releases the keep-alive rather than holding the process open.
    const cleared = await collect(manager.spawn("node", ["/cleared.js"]));
    expect(cleared.out).toBe("done\n");
    const interval = await collect(manager.spawn("node", ["/interval.js"]));
    expect(interval.out).toBe("cleared\n");
  });

  it("passes cwd and env, merged over the manager's own", async () => {
    const { manager } = harness();
    const result = await collect(manager.spawn("node", ["/env.js"], { cwd: "/sub", env: { GREETING: "hi" } }));
    expect(result.out).toBe("hi /sub\n");
  });

  it("waits for an async filesystem call the script never awaited at the top level", async () => {
    const { manager, fs } = harness();
    const result = await collect(manager.spawn("node", ["/fs.js"]));
    expect(result.out).toBe("by a child\n");
    expect(await fs.readText("written.txt")).toBe("by a child");
  });

  it("writes to a child's stdin and sees it come back out", async () => {
    const { manager } = harness();
    const child = manager.spawn("node", ["/stdin.js"]);
    const done = collect(child);
    child.stdin?.write("some input");
    child.stdin?.end();
    expect((await done).out).toBe("read:some input\n");
  });

  it("pipes one child's stdout into another's stdin", async () => {
    const { manager } = harness();
    const source = manager.spawn("node", ["/hello.js", "pipes"]);
    const sink = manager.spawn("node", ["/upper.js"]);
    manager.pipe(source, sink);
    const result = await collect(sink);
    expect(result.out).toBe("HELLO PIPES\n");
  });

  it("refuses to pipe an end that was spawned with no pipe", async () => {
    const { manager } = harness();
    const a = manager.spawn("node", ["/hello.js"], { stdio: "ignore" });
    const b = manager.spawn("node", ["/hello.js"]);
    expect(() => manager.pipe(a, b)).toThrow(/stdio 'pipe'/);
    expect(a.stdout).toBeNull();
    expect(a.stdin).toBeNull();
    a.kill();
    b.kill();
  });

  it("kill ends a held process and reports the signal rather than a code", async () => {
    const { manager } = harness();
    const child = manager.spawn("node", ["/held.js"]);
    const done = collect(child);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(child.kill("SIGTERM")).toBe(true);
    expect(child.kill("SIGTERM")).toBe(false); // already gone
    const result = await done;
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(child.killed).toBe(true);
    expect(result.out).toBe("holding\n");
  });

  it("keeps a table, hands out pids and kills everything on request", async () => {
    const { manager } = harness();
    const a = manager.spawn("node", ["/held.js"]);
    const b = manager.spawn("node", ["/held.js"]);
    expect(manager.list()).toHaveLength(2);
    expect(manager.get(a.pid)).toBe(a);
    expect(a.pid).not.toBe(b.pid);
    manager.killAll();
    expect(manager.list()).toHaveLength(0);
    expect(manager.get(a.pid)).toBeUndefined();
  });

  it("stops at the process cap rather than taking the page down", () => {
    const { manager } = harness();
    for (let i = 0; i < DEFAULT_MAX_PROCESSES; i++) manager.spawn("node", ["/held.js"]);
    expect(() => manager.spawn("node", ["/held.js"])).toThrow(/processes are already running/);
    manager.killAll();
  });

  it("says so when the command names no file to run", async () => {
    const { manager } = harness();
    const result = await collect(manager.spawn("bash", ["-c", "echo hi"]));
    expect(result.code).toBe(127);
    expect(result.err).toContain("runs JavaScript files");
  });

  it("carries messages both ways on the fork channel, and refuses them without one", async () => {
    const { manager } = harness();
    const child = manager.spawn("node", ["/ipc.js"], { ipc: true });
    const done = collect(child);
    const fromChild = await new Promise<unknown>((resolve) => child.on("message", resolve));
    expect(fromChild).toEqual({ from: "child" });
    expect(child.send({ value: "back" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.kill();
    expect((await done).out).toBe("got back\n");

    const plain = manager.spawn("node", ["/held.js"]);
    expect(plain.send({ nope: true })).toBe(false);
    plain.disconnect();
    expect(plain.connected).toBe(false);
    expect(plain.ref()).toBe(plain);
    expect(plain.unref()).toBe(plain);
    plain.kill();
  });
});

describe("child_process over the manager", () => {
  it("spawn, exec and execFile all land on the same process", async () => {
    const { manager } = harness();
    const cp = childProcessModule(manager) as Record<string, (...a: unknown[]) => ChildProcess>;
    expect((await collect(cp.spawn!("node", ["/hello.js"]))).out).toBe("hello world\n");

    const execed = await new Promise<{ err: unknown; out: string }>((resolve) => {
      cp.exec!(`node /hello.js "from exec"`, (err: unknown, out: string) => resolve({ err, out }));
    });
    expect(execed.err).toBeNull();
    expect(execed.out).toBe("hello from exec\n");

    const failed = await new Promise<unknown>((resolve) => {
      cp.exec!("node /boom.js", {}, (err: unknown) => resolve(err));
    });
    expect((failed as { code: string }).code).toBe("ERR_CHILD_EXIT");

    const filed = await new Promise<string>((resolve) => {
      cp.execFile!("node", ["/hello.js", "execFile"], (_e: unknown, out: string) => resolve(out));
    });
    expect(filed).toBe("hello execFile\n");
  });

  it("fork gives the child an IPC channel", async () => {
    const { manager } = harness();
    const cp = childProcessModule(manager) as Record<string, (...a: unknown[]) => ChildProcess>;
    const child = cp.fork!("/ipc.js");
    const message = await new Promise<unknown>((resolve) => child.on("message", resolve));
    expect(message).toEqual({ from: "child" });
    child.kill();
  });
});

describe("worker_threads over the manager", () => {
  it("new Worker runs a script and carries workerData and messages", async () => {
    const { manager } = harness();
    const current = createProcess({ cwd: "/" });
    const wt = workerThreadsModule(manager, current) as {
      Worker: new (f: string, o?: { workerData?: unknown }) => {
        on(n: string, f: (v: unknown) => void): void;
        postMessage(d: unknown): void;
        terminate(): Promise<number>;
        threadId: number;
        stdout: unknown;
        stderr: unknown;
        ref(): void;
        unref(): void;
      };
      isMainThread: boolean;
      threadId: number;
    };
    expect(wt.isMainThread).toBe(true);
    expect(wt.threadId).toBe(1);

    const worker = new wt.Worker("/worker-data.js", { workerData: { seed: 42 } });
    expect(worker.threadId).toBeGreaterThan(1);
    expect(worker.stdout).toBeDefined();
    expect(worker.stderr).toBeDefined();
    worker.ref();
    worker.unref();
    const line = await new Promise<string>((resolve) => {
      worker.on("stdout", (chunk: unknown) => resolve(decodeChunk(chunk as Uint8Array)));
    });
    expect(JSON.parse(line)).toEqual({ data: { seed: 42 }, main: false, id: expect.any(Number) });
    expect(await worker.terminate()).toBe(0);
  });

  it("a worker sees its parent port and is not the main thread", async () => {
    const { manager } = harness();
    const current = createProcess({ cwd: "/" });
    const worker = new (workerThreadsModule(manager, current) as { Worker: new (f: string) => { on(n: string, f: (v: unknown) => void): void; postMessage(d: unknown): void; terminate(): Promise<number> } }).Worker("/ipc.js");
    const message = await new Promise<unknown>((resolve) => worker.on("message", resolve));
    expect(message).toEqual({ from: "child" });
    await worker.terminate();
  });
});


describe("a TypeScript entry through the process wire (the runner warms the graph up before it runs)", () => {
  it("runs `node typed.ts` — the entry and a .ts it requires — when a transformer is configured", async () => {
    const { manager } = harness(
      {
        "/typed.ts": `import { double } from "./lib"; const n: number = 21; console.log("ts says", double(n));`,
        "/lib.ts": `export function double(x: number): number { return x * 2; }`,
      },
      createEsbuildTransformer(),
    );
    const result = await collect(manager.spawn("node", ["/typed.ts"]));
    expect(result.err).toBe("");
    expect(result.out).toBe("ts says 42\n");
    expect(result.code).toBe(0);
  });

  it("refuses a .ts entry by name when the host gave no transformer", async () => {
    const { manager } = harness({ "/typed.ts": `const n: number = 1; console.log(n);` });
    const result = await collect(manager.spawn("node", ["/typed.ts"]));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/TypeScript transform/);
  });
});
