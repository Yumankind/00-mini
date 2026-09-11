/// <reference path="../../../../packages/agent-node/src/vendor.d.ts" />
// ^ `@00/agent-node` is TypeScript sources, so this app typechecks them with ITS tsconfig — which
// does not include that package's hand-written declarations for the six npm packages it stands on
// (`events/events.js`, `readable-stream`, `buffer/index.js`, …; see the header of vendor.d.ts for
// why they are hand-written). One reference pulls them into this program rather than copying them.
/**
 * One process, one Worker: `@00/agent-node`'s `serveProcess`, wired to this page.
 *
 * WHY THIS FILE REPLACED A STRINGIFIED PRELUDE. Until now `node` in this tab was a Blob Worker built
 * from `Function.prototype.toString()` of a function in js-runner.ts — which bought a typechecked
 * prelude at the price of one rule nobody could see from the call site ("reference nothing outside
 * this function") and a runtime that stopped at the edge of the working folder: no `node_modules`, no
 * `require("express")`, a hand-written `fs` with three verbs missing. `@00/agent-node` is that
 * runtime written properly — Node's resolution algorithm, the whole `fs` surface in all three shapes,
 * `http` over a host bridge, an npm client — and it is an ordinary module graph. So this is an
 * ordinary module, built by vite as a module Worker (`new Worker(new URL(...), { type: "module" })`
 * in js-runner.ts), and the prelude and its rule are gone.
 *
 * THE WORKER IS STILL THE SANDBOX. It has no DOM, no `window`, no OPFS handle of this app's and no
 * `AgentFs` — it reaches the filesystem only through the `t:"fs"` RPC the page answers
 * (`answerFs` in js-runner.ts, which is `NodeFsBackend.call` over the real `AgentFs`), so every path
 * is resolved against the workspace TWICE, here and there, and `../../vault.json` collapses at the
 * workspace root both times. Outbound traffic goes through `network.fetch` below, which obeys the
 * SAME allow list the agent's own `http_get` tool obeys (`hostAllowed`, packages/agent-runtime).
 *
 * THE TWO ROADS INTO A SYNCHRONOUS `require`. Under cross-origin isolation the page hands this Worker
 * a `SharedArrayBuffer` served by the filesystem service Worker (src/power/fs-service.ts), and
 * `backendLoaderFs` reads the REAL workspace synchronously — which is what makes
 * `npm install` followed by `require("is-number")` work in one command. Without the headers there is
 * no channel, and the loader falls back to `snapshotLoaderFs` over the folder the page read once
 * before the run. One runtime, two answers, and every `*Sync` that cannot be answered refuses by
 * name with agent-node's isolation sentence.
 *
 * IT IS THE SAME CODE IN THE NODE SUITE. `createInlineNodeWorker` below runs THIS `serveNodeProcess`
 * in the test process over an asynchronous channel, exactly as `createInlineWorkerFactory` does for
 * agent-node's own suite. A fake that only pretended to be a worker would be a test of the fake.
 *
 * WHAT IT STILL REFUSES, by name and on purpose: `child_process`/`worker_threads` (no
 * `ProcessManager` is passed, because a nested Worker would need a second filesystem channel of its
 * own and there is exactly one per run), sockets, DNS, and — the one divergence from Node worth
 * saying out loud — a `server.listen()` on a port this tab already has: the sentence is printed and
 * the process ends 1, where Node would emit an `error` event a script could catch.
 */
import type { AgentFs, FsEntry, FsStat } from "@00/agent-fs";
import { hostAllowed, type NetworkPolicy } from "@00/agent-runtime";
import {
  NodeFsBackend,
  SyncFsClient,
  backendLoaderFs,
  serveProcess,
  snapshotLoaderFs,
  type BridgeRequest,
  type BridgeResponse,
  type CreateLoaderOptions,
  type HttpBridge,
  type LoaderFs,
  type NetworkBridge,
  type NodeProcess,
  type ProcessIo,
  createEsbuildTransformer,
  type ProcessSpec,
  type ProcessWorker,
  type WorkerChannel,
} from "@00/agent-node";

/**
 * One transformer per Worker, made on first use. The wasm path is a build-time constant from
 * vite.config.ts; a host that built without it (a test) gets no transformer and `.ts` refuses by name.
 */
function transformer(): ReturnType<typeof createEsbuildTransformer> | null {
  const path = typeof __ESBUILD_WASM_URL__ === "string" ? __ESBUILD_WASM_URL__ : null;
  if (!path || typeof self === "undefined" || !("location" in self)) return null;
  return createEsbuildTransformer({ wasmURL: new URL(path, (self as unknown as { location: Location }).location.origin).href });
}

// ── The wire this file adds to agent-node's own ───────────────────────────────────────────────────

/** The blocking half of the filesystem, as the runtime uses it. `SyncFsClient` is the real one. */
export interface SyncCallable {
  call(op: string, args?: Record<string, unknown>, data?: Uint8Array | null): { value: unknown; data: Uint8Array };
}

/**
 * Everything the page knows and this Worker cannot work out for itself, sent BEFORE agent-node's own
 * `{ t: "start" }` (the factory posts it the moment it makes the worker, and postMessage is FIFO).
 * It is a separate message rather than a field on the spec because the spec is agent-node's contract
 * and this is ours.
 */
export interface BootMessage {
  t: "boot";
  /** The channel to the filesystem service. Absent on an origin without the isolation headers. */
  sab?: SharedArrayBuffer | null;
  /** The read-once folder `require` falls back to when there is no channel. */
  files?: Record<string, Uint8Array>;
  /** `node -e`: the source, as the file `spec.entry` names, so `runMain` can load it like any other. */
  eval?: { path: string; source: string } | null;
  /** The hosts a script may reach. Absent or empty = every outbound call refuses, by host name. */
  network?: NetworkPolicy | null;
  /**
   * The node suite's way in: `Atomics.wait` is illegal on a main thread, so the tests hand over a
   * client object instead of a buffer. A browser never sends this field.
   */
  syncClient?: SyncCallable | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return encoder.encode(value);
  return new Uint8Array(0);
}

/** A virtual absolute path for the page: the backend hands out agent-relative ones (root `""`). */
function virtual(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

// ── The filesystem, as an `AgentFs` that lives on the other side of a postMessage ─────────────────

/**
 * `AgentFs` over the page's `t:"fs"` RPC.
 *
 * WHY AN `AgentFs` AND NOT A SECOND `NodeFsBackend` WIRE. Because the page must keep owning the
 * sandbox: it answers with its own `NodeFsBackend` rooted at `workspace`, so the workspace root is
 * enforced where the real filesystem is, not where the script is. What crosses is the small,
 * already-normalised vocabulary of `AgentFs`.
 */
export function remoteAgentFs(op: (op: string, args: Record<string, unknown>, data?: Uint8Array | null) => Promise<{ value?: unknown; data?: Uint8Array }>): AgentFs {
  const fs: AgentFs = {
    async stat(path: string): Promise<FsStat | null> {
      try {
        const shape = (await op("stat", { path: virtual(path) })).value as { size: number; mtimeMs: number; kind: "file" | "dir" };
        return { kind: shape.kind, size: shape.size, mtime: shape.mtimeMs };
      } catch {
        // `AgentFs.stat` answers `null` for "not there"; anything else the page said is the same
        // answer to the one question this method asks.
        return null;
      }
    },
    async readFile(path: string): Promise<Uint8Array> {
      return (await op("readFile", { path: virtual(path) })).data ?? new Uint8Array(0);
    },
    async readText(path: string): Promise<string> {
      return decoder.decode(await fs.readFile(path));
    },
    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      await op("writeFile", { path: virtual(path) }, bytesOf(data));
    },
    async mkdir(path: string): Promise<void> {
      await op("mkdir", { path: virtual(path), recursive: true });
    },
    async readdir(path: string): Promise<FsEntry[]> {
      const entries = ((await op("readdir", { path: virtual(path) })).value ?? []) as { name: string; kind: "file" | "dir" }[];
      return entries.map((e) => ({ name: e.name, kind: e.kind, size: 0, mtime: 0 }));
    },
    async remove(path: string): Promise<void> {
      await op("rm", { path: virtual(path), recursive: true, force: true });
    },
    async rename(from: string, to: string): Promise<void> {
      await op("rename", { path: virtual(from), to: virtual(to) });
    },
    async *walk(path: string, opts: { maxEntries?: number } = {}): AsyncIterable<{ path: string; stat: FsStat }> {
      const max = opts.maxEntries ?? Infinity;
      let seen = 0;
      const visit = async function* (dir: string): AsyncIterable<{ path: string; stat: FsStat }> {
        for (const entry of await fs.readdir(dir)) {
          const full = dir === "" ? entry.name : `${dir}/${entry.name}`;
          if (entry.kind === "dir") {
            yield* visit(full);
            continue;
          }
          if (seen >= max) return;
          seen += 1;
          yield { path: full, stat: (await fs.stat(full)) ?? { kind: "file", size: 0, mtime: 0 } };
        }
      };
      yield* visit(path.replace(/^\/+/, ""));
    },
  };
  return fs;
}

/**
 * The blocking client, with the paths a script typed made absolute first.
 *
 * WHY THE WRAPPER. `NodeFsBackend.opSync` hands the channel whatever the script wrote — `./data.json`
 * as often as not — because agent-node's own recipe puts a backend (which knows the cwd) on the far
 * end. Ours is the OPFS service Worker, which knows only the workspace, so the cwd is applied HERE,
 * by the same `absolute()` the async half uses. Without this, `readFileSync('./x')` would look for
 * `/x`.
 */
class ResolvingSyncClient extends SyncFsClient {
  constructor(
    sab: SharedArrayBuffer,
    private readonly absolute: (path: string) => string,
  ) {
    super(sab);
  }
  override call(op: string, args: Record<string, unknown> = {}, data: Uint8Array | null = null): { value: unknown; data: Uint8Array } {
    return super.call(op, resolveArgs(args, this.absolute), data);
  }
}

function resolveArgs(args: Record<string, unknown>, absolute: (path: string) => string): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.path === "string") out.path = absolute(out.path);
  if (typeof out.to === "string") out.to = absolute(out.to);
  return out;
}

/** The same resolution in front of an injected client (the node suite's). */
function resolvingCallable(client: SyncCallable, absolute: (path: string) => string): SyncCallable {
  return { call: (op, args = {}, data = null) => client.call(op, resolveArgs(args, absolute), data) };
}

// ── The loader's synchronous view, with `node -e`'s source in it ──────────────────────────────────

/**
 * A `#!` first line, dropped before the loader compiles the file.
 *
 * WHY IT IS THE HOST'S JOB HERE. Node strips a shebang itself before it wraps a module, because the
 * CommonJS wrapper is `new Function` and a function body has no hashbang grammar — `new Function("#!/x")`
 * is a SyntaxError in V8. `@00/agent-node`'s loader hands the bytes straight to that wrapper, and the
 * `.bin` shims its own npm client writes start with `#!/usr/bin/env node`, so without this every
 * `npm run` of a tool from `node_modules/.bin` would die on line one. The newline is kept so a stack
 * trace still points at the right line.
 */
export function shebangSafe(base: LoaderFs): LoaderFs {
  return {
    readFileSync: (path: string) => {
      const bytes = base.readFileSync(path);
      if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return bytes;
      const newline = bytes.indexOf(0x0a);
      return newline < 0 ? new Uint8Array(0) : bytes.subarray(newline);
    },
    statSync: (path: string) => base.statSync(path),
  };
}

/** `node -e` has no file, so it gets one: a single path the loader can read like any other module. */
export function evalOverlay(base: LoaderFs, path: string, source: string): LoaderFs {
  const bytes = encoder.encode(source);
  return {
    readFileSync: (asked: string) => (asked === path ? bytes : base.readFileSync(asked)),
    statSync: (asked: string) =>
      asked === path ? { isFile: () => true, isDirectory: () => false } : base.statSync(asked),
  };
}

// ── The outbound door ─────────────────────────────────────────────────────────────────────────────

/**
 * `fetch`, and with it `http.get`, gated by the person's own allow list.
 *
 * The rule is not re-implemented: `hostAllowed` is the function the agent's `http_get` tool obeys
 * (packages/agent-runtime/src/tools-net.ts), so a host the agent may not reach is a host a script the
 * agent wrote may not reach either. An empty list denies everything, by host name, in one sentence.
 */
export function guardedNetwork(policy: NetworkPolicy | null | undefined): NetworkBridge {
  return {
    async fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<Response> {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new Error(`fetch('${String(input)}'): a script in this tab needs an absolute http(s) URL — there is no origin to be relative to`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`fetch('${url.href}'): only http and https leave this tab — file:, data: and blob: would read this machine`);
      }
      if (!hostAllowed(url.hostname, policy ?? undefined)) {
        throw new Error(
          `fetch('${url.href}'): ${url.hostname} is not on this agent's network allow list, so nothing was sent — ` +
            `add the host in Settings (it is the same list the agent's own http_get obeys), and remember that the other origin's CORS still decides`,
        );
      }
      return await fetch(url.href, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body ? (init.body as BodyInit) : undefined,
        credentials: "omit",
        redirect: "follow",
      });
    },
  };
}

// ── The process ───────────────────────────────────────────────────────────────────────────────────

/**
 * Serve one process on `channel`: agent-node's runner, plus the four roads only this host can supply
 * (the filesystem RPC, the sync channel, the virtual-port bridge, the network door).
 */
export function serveNodeProcess(channel: WorkerChannel): void {
  let boot: BootMessage = { t: "boot" };
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: { value?: unknown; data?: Uint8Array }) => void; reject: (err: Error) => void }>();
  const servers = new Map<number, (request: BridgeRequest) => Promise<BridgeResponse>>();
  const holds = new Map<number, () => void>();
  let io: ProcessIo | null = null;
  let nodeProcess: NodeProcess | null = null;
  let ended = false;

  const ask = (message: Record<string, unknown>, data?: Uint8Array | null): Promise<{ value?: unknown; data?: Uint8Array }> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      channel.post({ ...message, id, data: data ?? null });
    });

  const op = (name: string, args: Record<string, unknown>, data?: Uint8Array | null): Promise<{ value?: unknown; data?: Uint8Array }> =>
    ask({ t: "fs", op: name, args }, data);

  /** The one place this file writes to the person's terminal without going through `process`. */
  const say = (text: string): void => channel.post({ t: "stderr", text });

  channel.onMessage((raw) => {
    const message = raw as Record<string, unknown> & { t?: string };
    if (!message || typeof message.t !== "string") return;
    switch (message.t) {
      case "boot":
        boot = message as unknown as BootMessage;
        return;
      case "fs-reply":
      case "listen-reply":
      case "close-reply": {
        const waiting = pending.get(Number(message.id));
        if (!waiting) return;
        pending.delete(Number(message.id));
        if (message.ok) waiting.resolve({ value: message.value, data: message.data as Uint8Array | undefined });
        else {
          const err = new Error(String(message.error ?? "the page refused")) as Error & { code?: string };
          if (typeof message.code === "string") err.code = message.code;
          waiting.reject(err);
        }
        return;
      }
      case "request": {
        const handler = servers.get(Number(message.port));
        const id = Number(message.id);
        if (!handler) {
          channel.post({ t: "response", id, status: 502, headers: {}, body: encoder.encode("nothing is listening here") });
          return;
        }
        void handler({
          method: String(message.method ?? "GET"),
          url: String(message.url ?? "/"),
          headers: (message.headers as Record<string, string>) ?? {},
          body: (message.body as Uint8Array | null) ?? null,
        }).then(
          (response) => channel.post({ t: "response", id, status: response.status, headers: response.headers, body: response.body }),
          (err: unknown) =>
            channel.post({
              t: "response",
              id,
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
              body: encoder.encode(`the handler on ${String(message.port)} threw: ${err instanceof Error ? err.message : String(err)}`),
            }),
        );
        return;
      }
      default:
        return;
    }
  });

  /**
   * The virtual-port bridge. `listen` holds the process alive across the round trip, so a refusal is
   * printed BEFORE the process can settle — and keeps the hold while the port is registered, which is
   * what makes `node server.js` a server instead of a script that ended.
   */
  const httpBridge: HttpBridge = {
    listen(port, handler) {
      const release = io?.hold() ?? ((): void => undefined);
      return ask({ t: "listen", port }).then(
        () => {
          servers.set(port, handler);
          holds.set(port, release);
        },
        (err: Error) => {
          release();
          // Node would emit `error` on the server; agent-node's http turns a rejected `listen` into
          // an unhandled rejection when the script has no handler, which in a Worker is silence. So
          // the sentence is printed here and the process ends the way Node's uncaught one does — and
          // the returned promise never settles, because settling it is what would raise the ghost.
          if (!ended) {
            ended = true;
            say(`${err.message}\n`);
            channel.post({ t: "exit", code: 1 });
          }
          return new Promise<void>(() => undefined);
        },
      );
    },
    close(port) {
      servers.delete(port);
      holds.get(port)?.();
      holds.delete(port);
      return ask({ t: "close", port }).then(
        () => undefined,
        () => undefined,
      );
    },
  };

  serveProcess(channel, {
    configure(spec: ProcessSpec, processIo: ProcessIo): CreateLoaderOptions {
      io = processIo;
      const backend = new NodeFsBackend({
        fs: remoteAgentFs(op),
        // The virtual root IS the workspace: the page's own backend adds `workspace/` in front, and
        // both ends collapse `..` before anything is opened.
        root: "",
        cwd: () => nodeProcess?.cwd() ?? spec.cwd,
      });
      const absolute = (path: string): string => backend.absolute(path);
      if (boot.syncClient) backend.sync = resolvingCallable(boot.syncClient, absolute) as unknown as SyncFsClient;
      else if (boot.sab) {
        try {
          backend.sync = new ResolvingSyncClient(boot.sab, absolute);
        } catch {
          backend.sync = null; // a browser that took the buffer and refuses the wait keeps the snapshot
        }
      }
      const base = backend.hasSync ? backendLoaderFs(backend) : snapshotLoaderFs(boot.files ?? {});
      const network = guardedNetwork(boot.network);
      return {
        fs: shebangSafe(boot.eval ? evalOverlay(base, boot.eval.path, boot.eval.source) : base),
        cwd: spec.cwd,
        root: "/",
        backend,
        conditions: ["browser", "require", "default"],
        httpBridge,
        network,
        // There is one filesystem channel per run, so there is one process per run: `spawn` refuses
        // by name (ERR_NO_PROCESS_MANAGER) rather than starting a Worker with no way to read a file.
        processes: null,
        homedir: "/",
        // `fetch` inside a module is the same door `http.get` is, and it is shadowed rather than left
        // as the Worker's own global so the allow list cannot be walked around by spelling.
        globals: { fetch: (input: string, init?: Record<string, unknown>) => network.fetch(input, init as { method?: string }) },
        // TypeScript, TSX and JSX through esbuild-wasm, initialised lazily from this origin's copy of
        // the binary (vite.config.ts `esbuildWasm()`); a plain .js run never fetches it.
        transformer: transformer(),
      };
    },
    onReady(loader) {
      nodeProcess = loader.process;
    },
  });
}

// ── The two ways to make one ──────────────────────────────────────────────────────────────────────

/**
 * The in-process factory the node suite uses: the SAME `serveNodeProcess`, on an asynchronous
 * channel. Delivery is a microtask late in both directions, exactly as a real Worker's is — a
 * synchronous fake would hide every ordering bug there is, starting with the one where `listen()`
 * resolves before the main module returns.
 */
export function createInlineNodeWorker(): ProcessWorker {
  const toHost: ((message: unknown) => void)[] = [];
  const toWorker: ((message: unknown) => void)[] = [];
  let dead = false;
  serveNodeProcess({
    post: (message) => {
      if (dead) return;
      queueMicrotask(() => {
        for (const handler of [...toHost]) handler(message);
      });
    },
    onMessage: (handler) => void toWorker.push(handler),
  });
  return {
    post: (message) => {
      if (dead) return;
      queueMicrotask(() => {
        for (const handler of [...toWorker]) handler(message);
      });
    },
    onMessage: (handler) => void toHost.push(handler),
    terminate: () => {
      dead = true;
    },
  };
}

/**
 * The browser's: a real module Worker built by vite from THIS file. `new URL(…, import.meta.url)` is
 * the form vite understands, and it is what emits the worker as its own chunk.
 */
export function createBrowserNodeWorker(): ProcessWorker {
  const worker = new Worker(new URL("./node-runtime-worker.ts", import.meta.url), { type: "module", name: "00-node" });
  const handlers: ((message: unknown) => void)[] = [];
  worker.onmessage = (event: MessageEvent) => {
    for (const handler of [...handlers]) handler(event.data);
  };
  worker.onerror = (event: ErrorEvent) => {
    for (const handler of [...handlers]) handler({ t: "error", message: event.message || "the script's Worker failed" });
  };
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => void handlers.push(handler),
    terminate: () => worker.terminate(),
  };
}

/**
 * Inside a real Worker this module IS the program. The guard is what keeps it importable from the
 * page and from a node test, where `postMessage` is not a global and `serveProcess` would have
 * nothing to serve.
 */
const scope = globalThis as unknown as {
  postMessage?: (message: unknown) => void;
  addEventListener?: (type: string, handler: (event: { data: unknown }) => void) => void;
  window?: unknown;
  document?: unknown;
};
if (typeof scope.postMessage === "function" && typeof scope.addEventListener === "function" && scope.window === undefined && scope.document === undefined) {
  serveNodeProcess({
    post: (message) => scope.postMessage?.(message),
    onMessage: (handler) => scope.addEventListener?.("message", (event: { data: unknown }) => handler(event.data)),
  });
}
