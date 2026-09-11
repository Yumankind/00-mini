import { describe, expect, it } from "vitest";
import { builtinModule, BUILTIN_NAMES, makeConsole } from "../src/modules/index.js";
import { createProcess, ExitSignal } from "../src/modules/process.js";
import { deepStrictEqual } from "../src/modules/core.js";
import { fileURLToPath, pathToFileURL, AssertionError } from "../src/modules/small.js";
import { splitCommandLine } from "../src/modules/child.js";
import { normalizeAbs, resolveAbs, toAgentPath, toVirtualPath, dirnameAbs, basenameAbs } from "../src/paths.js";

function ctx(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const process = createProcess({ cwd: "/w", stdout: (t) => lines.push(t), stderr: (t) => lines.push(`!${t}`) });
  return { context: { process, homedir: "/w", ...overrides }, lines, process };
}

describe("paths", () => {
  it("collapses .. against the virtual root and never climbs past it", () => {
    expect(normalizeAbs("/a/./b/../c")).toBe("/a/c");
    expect(normalizeAbs("/../../etc/passwd")).toBe("/etc/passwd");
    expect(resolveAbs("/a/b", "../c", "d")).toBe("/a/c/d");
    expect(resolveAbs("/a", "/abs")).toBe("/abs");
    expect(resolveAbs("a", "b")).toBe("/a/b");
    expect(dirnameAbs("/a/b/c.js")).toBe("/a/b");
    expect(dirnameAbs("/top")).toBe("/");
    expect(basenameAbs("/a/b/c.js")).toBe("c.js");
  });

  it("maps both ways between the virtual root and the AgentFs path", () => {
    expect(toAgentPath("workspace", "/projects/site/app.js")).toBe("workspace/projects/site/app.js");
    expect(toAgentPath("workspace", "/")).toBe("workspace");
    expect(toAgentPath("", "/a.js")).toBe("a.js");
    expect(toVirtualPath("workspace", "workspace/a/b.js")).toBe("/a/b.js");
    expect(toVirtualPath("workspace", "workspace")).toBe("/");
    expect(toVirtualPath("", "a.js")).toBe("/a.js");
    expect(toVirtualPath("workspace", "other/a.js")).toBe("/other/a.js");
  });
});

describe("builtinModule table", () => {
  it("answers every name it advertises", () => {
    const { context } = ctx();
    for (const name of BUILTIN_NAMES) {
      expect(builtinModule(name, context), name).toBeDefined();
      expect(builtinModule(`node:${name}`, context), `node:${name}`).toBeDefined();
    }
  });

  it("returns undefined for a name that is not a builtin, so the loader looks in node_modules", () => {
    const { context } = ctx();
    expect(builtinModule("express", context)).toBeUndefined();
  });

  it("hands over the real npm packages rather than re-implementations", () => {
    const { context } = ctx();
    const buffer = builtinModule("buffer", context) as { Buffer: { from(s: string): Uint8Array & { toString(e: string): string } } };
    expect(buffer.Buffer.from("hi").toString("hex")).toBe("6869");
    const events = builtinModule("events", context) as unknown as new () => { on(n: string, f: () => void): void; emit(n: string): boolean };
    const emitter = new events();
    let hit = 0;
    emitter.on("x", () => (hit += 1));
    emitter.emit("x");
    expect(hit).toBe(1);
    const sd = builtinModule("string_decoder", context) as { StringDecoder: new (e: string) => { write(b: Uint8Array): string } };
    // A three-byte character split across two writes is exactly what a hand-written decoder gets
    // wrong. `string_decoder` takes a Buffer, not a bare Uint8Array, and in THIS process its own
    // `require("buffer")` reaches Node's builtin rather than the npm package — so the test feeds it
    // the Buffer of the environment it is running in. In a browser both sides are the npm package.
    const B = (globalThis as unknown as { Buffer: { from(a: number[]): Uint8Array } }).Buffer;
    const decoder = new sd.StringDecoder("utf8");
    expect(decoder.write(B.from([0xe2, 0x82]))).toBe("");
    expect(decoder.write(B.from([0xac]))).toBe("€");
    const stream = builtinModule("stream", context) as { Readable: unknown; promises: unknown };
    expect(stream.Readable).toBeTypeOf("function");
    expect(stream.promises).toBeDefined();
  });

  it("anchors path.resolve to the process cwd, which a Worker has no global for", () => {
    const { context } = ctx();
    const path = builtinModule("path", context) as { resolve(...p: string[]): string; join(...p: string[]): string; posix: unknown; win32?: unknown };
    expect(path.resolve("a", "b")).toBe("/w/a/b");
    expect(path.resolve("/abs", "b")).toBe("/abs/b");
    expect(path.join("a", "..", "b")).toBe("b");
    expect(path.posix).toBe(path);
    expect(path.win32).toBeUndefined();
  });

  it("util carries promisify, callbackify, types and isDeepStrictEqual", async () => {
    const { context } = ctx();
    const util = builtinModule("util", context) as {
      promisify(fn: (cb: (e: unknown, v: unknown) => void) => void): () => Promise<unknown>;
      callbackify(fn: () => Promise<unknown>): (cb: (e: unknown, v?: unknown) => void) => void;
      types: { isDate(v: unknown): boolean; isUint8Array(v: unknown): boolean };
      isDeepStrictEqual(a: unknown, b: unknown): boolean;
    };
    await expect(util.promisify((cb) => cb(null, 7))()).resolves.toBe(7);
    expect(util.types.isDate(new Date())).toBe(true);
    expect(util.types.isUint8Array(new Uint8Array(1))).toBe(true);
    expect(util.isDeepStrictEqual({ a: [1] }, { a: [1] })).toBe(true);
    const seen = await new Promise((resolve) => util.callbackify(async () => 3)((_e, v) => resolve(v)));
    expect(seen).toBe(3);
  });
});

describe("deepStrictEqual", () => {
  it("is strict about types, prototypes and NaN", () => {
    expect(deepStrictEqual(NaN, NaN)).toBe(true);
    expect(deepStrictEqual(1, "1")).toBe(false);
    expect(deepStrictEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepStrictEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepStrictEqual([1, 2], [1, 2])).toBe(true);
    expect(deepStrictEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepStrictEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepStrictEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepStrictEqual(/a/g, /a/g)).toBe(true);
    expect(deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(deepStrictEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
    expect(deepStrictEqual(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(deepStrictEqual(new Set([1]), new Set([1]))).toBe(true);
    expect(deepStrictEqual(new Set([1]), new Set([2]))).toBe(false);
    expect(deepStrictEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepStrictEqual(null, {})).toBe(false);
  });
});

describe("url", () => {
  it("converts file URLs both ways and refuses another machine's host", () => {
    expect(fileURLToPath("file:///a/b%20c.js")).toBe("/a/b c.js");
    expect(fileURLToPath(new URL("file://localhost/a.js"))).toBe("/a.js");
    expect(pathToFileURL("/a/b c.js").href).toBe("file:///a/b%20c.js");
    expect(pathToFileURL("a.js").href).toBe("file:///a.js");
    expect(() => fileURLToPath("https://example.com/a")).toThrow(/scheme file:/);
    expect(() => fileURLToPath("file://other/a")).toThrow(/another machine/);
  });

  it("keeps the legacy parse/format/resolve shape half of npm still calls", () => {
    const { context } = ctx();
    const url = builtinModule("url", context) as {
      parse(u: string): Record<string, unknown>;
      format(v: unknown): string;
      resolve(a: string, b: string): string;
    };
    const parsed = url.parse("https://a.example/b?c=1#d");
    expect(parsed.hostname).toBe("a.example");
    expect(parsed.query).toBe("c=1");
    expect(parsed.hash).toBe("#d");
    expect(url.parse("/just/a/path").pathname).toBe("/just/a/path");
    expect(url.format(new URL("https://a.example/b"))).toBe("https://a.example/b");
    expect(url.format({ protocol: "https:", host: "a.example", pathname: "/b" })).toBe("https://a.example/b");
    expect(url.resolve("https://a.example/x/y", "../z")).toBe("https://a.example/z");
  });
});

describe("querystring", () => {
  it("collapses repeated keys into an array, as Node's does", () => {
    const { context } = ctx();
    const qs = builtinModule("querystring", context) as {
      parse(t: string): Record<string, string | string[]>;
      stringify(o: Record<string, unknown>): string;
      escape(s: string): string;
    };
    expect(qs.parse("a=1&a=2&a=3&b=x+y&c")).toEqual({ a: ["1", "2", "3"], b: "x y", c: "" });
    expect(qs.parse("")).toEqual({});
    expect(qs.stringify({ a: [1, 2], b: "x y", c: null })).toBe("a=1&a=2&b=x%20y&c=");
    expect(qs.escape("a b")).toBe("a%20b");
  });
});

describe("assert", () => {
  it("passes and fails with an AssertionError carrying actual/expected", () => {
    const { context } = ctx();
    const assert = builtinModule("assert", context) as unknown as ((v: unknown) => void) & Record<string, (...a: unknown[]) => unknown>;
    assert(true);
    expect(() => assert(false)).toThrow(AssertionError);
    assert.strictEqual(1, 1);
    expect(() => assert.strictEqual(1, 2)).toThrow(/strictEqual/);
    assert.equal(1, "1");
    expect(() => assert.notEqual(1, "1")).toThrow();
    assert.notStrictEqual(1, 2);
    expect(() => assert.notStrictEqual(1, 1)).toThrow();
    assert.deepEqual({ a: 1 }, { a: "1" });
    expect(() => assert.deepEqual({ a: 1 }, { a: 2 })).toThrow();
    assert.deepStrictEqual([1], [1]);
    expect(() => assert.deepStrictEqual([1], [2])).toThrow();
    assert.notDeepStrictEqual([1], [2]);
    expect(() => assert.notDeepStrictEqual([1], [1])).toThrow();
    assert.match("abc", /b/);
    expect(() => assert.match("abc", /z/)).toThrow();
    assert.throws(() => {
      throw new Error("x");
    });
    expect(() => assert.throws(() => 1)).toThrow(/Missing expected exception/);
    assert.doesNotThrow(() => 1);
    expect(() => assert.doesNotThrow(() => {
      throw new Error("x");
    })).toThrow(/unwanted exception/);
    assert.ifError(null);
    expect(() => assert.ifError(new Error("x"))).toThrow();
    expect(() => assert.fail("nope")).toThrow(/nope/);
    expect((assert as unknown as { strict: unknown }).strict).toBe(assert);
  });

  it("rejects() waits for a rejection and complains when there is none", async () => {
    const { context } = ctx();
    const assert = builtinModule("assert", context) as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
    await assert.rejects(() => Promise.reject(new Error("x")));
    await assert.rejects(Promise.reject(new Error("y")));
    await expect(assert.rejects(() => Promise.resolve(1))).rejects.toThrow(/Missing expected rejection/);
  });
});

describe("os", () => {
  it("says browser, points home at the workspace and measures endianness rather than guessing", () => {
    const { context } = ctx();
    const os = builtinModule("os", context) as Record<string, () => unknown> & { EOL: string; constants: Record<string, unknown> };
    expect(os.EOL).toBe("\n");
    expect(os.platform()).toBe("browser");
    expect(os.homedir()).toBe("/w");
    expect(os.tmpdir()).toBe("/tmp");
    expect(["LE", "BE"]).toContain(os.endianness());
    expect((os.cpus() as unknown[]).length).toBeGreaterThan(0);
    expect(os.loadavg()).toEqual([0, 0, 0]);
    expect(os.uptime()).toBeGreaterThanOrEqual(0);
    expect((os.userInfo() as { homedir: string }).homedir).toBe("/w");
    expect(os.totalmem()).toBeGreaterThanOrEqual(0);
    expect(os.freemem()).toBe(0);
    expect(os.type()).toBe("Browser");
    expect(os.arch()).toBe("wasm32");
    expect(os.release()).toBeTypeOf("string");
    expect(os.version()).toBeTypeOf("string");
    expect(os.hostname()).toBe("localhost");
    expect((os.constants.signals as Record<string, number>).SIGTERM).toBe(15);
  });
});

describe("timers", () => {
  it("has the four Node forms and a promises face with abort", async () => {
    const { context } = ctx();
    const timers = builtinModule("timers", context) as Record<string, unknown> & {
      promises: { setTimeout(ms: number, v?: unknown, o?: { signal?: AbortSignal }): Promise<unknown>; setImmediate(v?: unknown): Promise<unknown>; scheduler: { wait(ms: number): Promise<void> } };
    };
    expect(timers.setImmediate).toBeTypeOf("function");
    await expect(timers.promises.setTimeout(1, "v")).resolves.toBe("v");
    await expect(timers.promises.setImmediate("i")).resolves.toBe("i");
    await expect(timers.promises.scheduler.wait(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const pending = timers.promises.setTimeout(1000, "never", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    const handle = (timers.setImmediate as (fn: () => void) => unknown)(() => undefined);
    (timers.clearImmediate as (h: unknown) => void)(handle);
  });
});

describe("process", () => {
  it("carries argv, env, cwd, chdir and an exit that throws", () => {
    const { process } = ctx();
    expect(process.platform).toBe("browser");
    expect(process.cwd()).toBe("/w");
    process.chdir("sub");
    expect(process.cwd()).toBe("/w/sub");
    process.chdir("/root");
    expect(process.cwd()).toBe("/root");
    expect(() => process.exit(3)).toThrow(ExitSignal);
    try {
      process.exit();
    } catch (err) {
      expect((err as ExitSignal).code).toBe(0);
    }
    expect(process.hrtime()).toHaveLength(2);
    const before = process.hrtime();
    expect(process.hrtime(before)[0]).toBeGreaterThanOrEqual(0);
    expect(process.hrtime.bigint()).toBeTypeOf("bigint");
    expect(process.uptime()).toBeGreaterThanOrEqual(0);
    expect(process.memoryUsage().rss).toBe(0);
    expect(process.stdin.read()).toBeNull();
    process.stdin.on();
    process.stdin.setEncoding();
    process.stdin.resume();
    process.stdin.pause();
  });

  it("writes strings and bytes to the sinks it was given", () => {
    const { process, lines } = ctx();
    process.stdout.write("a");
    process.stderr.write(new TextEncoder().encode("b"));
    process.emitWarning("careful");
    process.emitWarning(new Error("worse"));
    process.stdout.end();
    expect(lines).toEqual(["a", "!b", "!Warning: careful\n", "!Warning: worse\n"]);
  });

  it("is a real EventEmitter, so a beforeExit listener actually fires", () => {
    const { process } = ctx();
    let hit = 0;
    process.on("beforeExit", () => (hit += 1));
    process.emit("beforeExit");
    expect(hit).toBe(1);
  });

  it("nextTick runs on the microtask queue", async () => {
    const { process } = ctx();
    let value = 0;
    process.nextTick((a) => (value = a as number), 5);
    expect(value).toBe(0);
    await Promise.resolve();
    expect(value).toBe(5);
  });
});

describe("console", () => {
  it("writes through the process's own sinks and shows circular objects", () => {
    const { process, lines } = ctx();
    const consoleShim = makeConsole(process) as Record<string, (...a: unknown[]) => void>;
    consoleShim.log("plain", 1, { a: 1 });
    consoleShim.error("bad");
    consoleShim.warn("hmm");
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    consoleShim.dir(circular);
    consoleShim.log(new Error("boom"));
    consoleShim.log(10n);
    consoleShim.trace("here");
    consoleShim.assert(false, "failed");
    consoleShim.assert(true, "not shown");
    consoleShim.count("x");
    consoleShim.countReset("x");
    consoleShim.time("t");
    consoleShim.timeLog("t");
    consoleShim.timeEnd("t");
    consoleShim.timeEnd("never-started");
    consoleShim.group("g");
    consoleShim.groupEnd();
    consoleShim.table([1]);
    consoleShim.info("i");
    consoleShim.debug("d");
    expect(lines[0]).toContain("plain 1");
    expect(lines.some((l) => l.includes("[Circular]"))).toBe(true);
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
    expect(lines.some((l) => l.includes("!Trace: here"))).toBe(true);
    expect(lines.some((l) => l.includes("Assertion failed"))).toBe(true);
  });
});

describe("the modules that refuse", () => {
  it("net, tls, dgram and cluster name the reason instead of returning undefined", () => {
    const { context } = ctx();
    const net = builtinModule("net", context) as Record<string, () => unknown>;
    expect(() => net.createConnection()).toThrow(/no TCP sockets/);
    expect(() => net.createServer()).toThrow(/no TCP sockets/);
    expect((net as unknown as { isIP(s: string): number }).isIP("127.0.0.1")).toBe(4);
    expect((net as unknown as { isIP(s: string): number }).isIP("::1")).toBe(6);
    expect((net as unknown as { isIP(s: string): number }).isIP("nope")).toBe(0);
    expect((net as unknown as { isIPv4(s: string): boolean }).isIPv4("1.2.3.4")).toBe(true);
    expect((net as unknown as { isIPv6(s: string): boolean }).isIPv6("::1")).toBe(true);
    const tls = builtinModule("tls", context) as Record<string, () => unknown>;
    expect(() => tls.connect()).toThrow(/no TCP sockets/);
    expect((tls as unknown as { rootCertificates: unknown[] }).rootCertificates).toEqual([]);
    const dgram = builtinModule("dgram", context) as Record<string, () => unknown>;
    expect(() => dgram.createSocket()).toThrow(/no TCP sockets/);
    const cluster = builtinModule("cluster", context) as Record<string, unknown>;
    expect(cluster.isPrimary).toBe(true);
    expect(() => (cluster.fork as () => void)()).toThrow(/neither a fork nor a socket/);
  });

  it("dns explains that a browser resolves names only inside fetch", () => {
    const { context } = ctx();
    const dns = builtinModule("dns", context) as Record<string, () => unknown> & { promises: Record<string, () => unknown>; Resolver: new () => unknown };
    expect(() => dns.lookup()).toThrow(/no resolver to script/);
    expect(() => dns.resolveMx()).toThrow();
    expect(() => dns.promises.resolve4()).toThrow();
    expect(() => new dns.Resolver()).toThrow();
    expect(dns.getServers()).toEqual([]);
    expect(() => dns.setServers()).toThrow();
    const promises = builtinModule("dns/promises", context) as Record<string, () => unknown>;
    expect(() => promises.lookup()).toThrow();
  });

  it("http2, v8, vm, punycode, inspector and repl refuse at call time, not at import time", () => {
    const { context } = ctx();
    for (const name of ["http2", "v8", "vm", "punycode", "inspector", "repl"]) {
      const api = builtinModule(name, context) as Record<string, () => unknown>;
      expect(api, name).toBeDefined();
      expect(() => api.anything(), name).toThrow(new RegExp(name));
    }
  });

  it("fs refuses by name when the runtime was built without a backend", () => {
    const { context } = ctx();
    const fs = builtinModule("fs", context) as Record<string, () => unknown>;
    expect(() => fs.readFile()).toThrow(/without a filesystem backend/);
    const promises = builtinModule("fs/promises", context) as Record<string, () => unknown>;
    expect(() => promises.readFile()).toThrow(/without a filesystem backend/);
  });

  it("child_process and worker_threads refuse by name without a process manager", () => {
    const { context } = ctx();
    const cp = builtinModule("child_process", context) as Record<string, (...a: unknown[]) => unknown>;
    expect(() => cp.spawn("node")).toThrow(/without a process model/);
    expect(() => cp.execSync("ls")).toThrow(/synchronous child/);
    expect(() => cp.spawnSync("ls")).toThrow(/synchronous child/);
    expect(() => cp.execFileSync("ls")).toThrow(/synchronous child/);
    expect(() => cp.exec("")).toThrow(/command line was empty/);
    const wt = builtinModule("worker_threads", context) as Record<string, unknown> & { Worker: new (f: string) => unknown; MessageChannel: new () => unknown };
    expect(wt.isMainThread).toBe(true);
    expect(() => new wt.Worker("a.js")).toThrow(/without a process model/);
    expect(() => new wt.MessageChannel()).toThrow(/one port per process/);
    expect(() => (wt.moveMessagePortToContext as () => void)()).toThrow(/vm contexts/);
    expect((wt.receiveMessageOnPort as () => unknown)()).toBeUndefined();
  });
});

describe("splitCommandLine", () => {
  it("splits on unquoted whitespace and keeps quoted runs whole", () => {
    expect(splitCommandLine("node a.js b")).toEqual(["node", "a.js", "b"]);
    expect(splitCommandLine(`echo "a b" 'c d'`)).toEqual(["echo", "a b", "c d"]);
    expect(splitCommandLine("  spaced   out  ")).toEqual(["spaced", "out"]);
    expect(splitCommandLine(`echo ""`)).toEqual(["echo", ""]);
    expect(splitCommandLine("")).toEqual([]);
  });
});

describe("the odd corners of the table", () => {
  it("async_hooks gives an AsyncLocalStorage that works for synchronous scopes", () => {
    const { context } = ctx();
    const hooks = builtinModule("async_hooks", context) as {
      AsyncLocalStorage: new () => { run<T>(s: unknown, fn: () => T): T; getStore(): unknown; enterWith(s: unknown): void; exit<T>(fn: () => T): T; disable(): void };
      AsyncResource: new (t: string) => { runInAsyncScope<T>(fn: () => T): T; emitDestroy(): unknown };
      createHook(): { enable(): void; disable(): void };
      executionAsyncId(): number;
    };
    const storage = new hooks.AsyncLocalStorage();
    expect(storage.getStore()).toBeUndefined();
    expect(storage.run("v", () => storage.getStore())).toBe("v");
    expect(storage.run("v", () => storage.exit(() => storage.getStore()))).toBeUndefined();
    storage.enterWith("w");
    expect(storage.getStore()).toBe("w");
    storage.disable();
    expect(new hooks.AsyncResource("t").runInAsyncScope(() => 4)).toBe(4);
    expect(new hooks.AsyncResource("t").emitDestroy()).toBeDefined();
    hooks.createHook().enable();
    hooks.createHook().disable();
    expect(hooks.executionAsyncId()).toBe(0);
  });

  it("diagnostics_channel publishes to subscribers and forgets them on unsubscribe", () => {
    const { context } = ctx();
    const dc = builtinModule("diagnostics_channel", context) as {
      channel(n: string): { publish(m: unknown): void; subscribe(f: (m: unknown) => void): void; unsubscribe(f: (m: unknown) => void): boolean; hasSubscribers: boolean };
      hasSubscribers(n: string): boolean;
      subscribe(n: string, f: (m: unknown) => void): void;
    };
    const seen: unknown[] = [];
    const listener = (m: unknown): void => void seen.push(m);
    dc.subscribe("a", listener);
    expect(dc.hasSubscribers("a")).toBe(true);
    dc.channel("a").publish(1);
    expect(seen).toEqual([1]);
    expect(dc.channel("a").hasSubscribers).toBe(true);
    dc.channel("a").unsubscribe(listener);
    expect(dc.hasSubscribers("a")).toBe(false);
    expect(dc.hasSubscribers("never")).toBe(false);
  });

  it("readline says there is no interactive input rather than hanging", async () => {
    const { context, lines } = ctx();
    const readline = builtinModule("readline", context) as {
      createInterface(): { question(q: string, cb: (a: string) => void): void; close(): void; on(): void; prompt(): void; write(t: string): void; [Symbol.asyncIterator](): AsyncIterableIterator<unknown> };
      clearLine(): boolean;
      cursorTo(): boolean;
    };
    const rl = readline.createInterface();
    let answered: string | null = null;
    rl.question("name?", (a) => (answered = a));
    expect(answered).toBe("");
    expect(lines.some((l) => l.includes("no interactive input"))).toBe(true);
    rl.write("x");
    rl.close();
    rl.on();
    rl.prompt();
    expect(readline.clearLine()).toBe(true);
    expect(readline.cursorTo()).toBe(true);
    const collected: unknown[] = [];
    for await (const line of rl) collected.push(line);
    expect(collected).toEqual([]);
  });

  it("stream/consumers collects a stream into bytes, text and JSON", async () => {
    const { context } = ctx();
    const consumers = builtinModule("stream/consumers", context) as {
      buffer(s: AsyncIterable<unknown>): Promise<Uint8Array>;
      text(s: AsyncIterable<unknown>): Promise<string>;
      json(s: AsyncIterable<unknown>): Promise<unknown>;
      arrayBuffer(s: AsyncIterable<unknown>): Promise<ArrayBuffer>;
    };
    const source = async function* (): AsyncGenerator<unknown> {
      yield new TextEncoder().encode(`{"a":`);
      yield `1}`;
    };
    expect(await consumers.text(source())).toBe('{"a":1}');
    expect(await consumers.json(source())).toEqual({ a: 1 });
    expect((await consumers.buffer(source())).byteLength).toBe(7);
    expect((await consumers.arrayBuffer(source())).byteLength).toBe(7);
  });

  it("module reports the builtin list and tty is never a terminal", () => {
    const { context } = ctx();
    const mod = builtinModule("module", context) as { builtinModules: string[]; isBuiltin(n: string): boolean; createRequire(): unknown; _resolveFilename(r: string): string; syncBuiltinESMExports(): void };
    expect(mod.builtinModules).toContain("fs");
    expect(mod.isBuiltin("node:path")).toBe(true);
    expect(mod.isBuiltin("express")).toBe(false);
    expect(mod._resolveFilename("x")).toBe("x");
    mod.syncBuiltinESMExports();
    expect(mod.createRequire()).toBeUndefined();
    const tty = builtinModule("tty", context) as { isatty(): boolean };
    expect(tty.isatty()).toBe(false);
    const perf = builtinModule("perf_hooks", context) as { performance: unknown; monitorEventLoopDelay(): { enable(): void; disable(): void } };
    expect(perf.performance).toBeDefined();
    perf.monitorEventLoopDelay().enable();
    perf.monitorEventLoopDelay().disable();
    const constants = builtinModule("constants", context) as Record<string, unknown>;
    expect(constants.F_OK).toBe(0);
    expect(builtinModule("util/types", context)).toBeDefined();
    expect(builtinModule("assert/strict", context)).toBeDefined();
    expect(builtinModule("path/posix", context)).toBeDefined();
    expect(builtinModule("timers/promises", context)).toBeDefined();
    expect(builtinModule("stream/promises", context)).toBeDefined();
    expect(builtinModule("process", context)).toBe(context.process);
  });

  it("buffer's module extras are the ones a script reads off it", () => {
    const { context } = ctx();
    const buffer = builtinModule("buffer", context) as {
      isUtf8(b: Uint8Array): boolean;
      constants: { MAX_LENGTH: number };
      atob(s: string): string | undefined;
      btoa(s: string): string | undefined;
    };
    expect(buffer.isUtf8(new TextEncoder().encode("hi"))).toBe(true);
    expect(buffer.isUtf8(new Uint8Array([0xff, 0xfe]))).toBe(false);
    expect(buffer.constants.MAX_LENGTH).toBeGreaterThan(0);
    expect(buffer.btoa("hi")).toBe("aGk=");
    expect(buffer.atob("aGk=")).toBe("hi");
  });
});
