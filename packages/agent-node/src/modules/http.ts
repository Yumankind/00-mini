/**
 * `http` and `https` — a server half the host routes, an outbound half the host may deny.
 *
 * THE TWO HALVES ARE DIFFERENT PROBLEMS, and that is why there are two interfaces.
 *
 * INBOUND (`http.createServer(...).listen(3000)`). A tab cannot bind a TCP port; nothing in a
 * browser can. But everything a person wants from `node server.js` needs a URL, so the port becomes
 * a HANDLER the host registers and routes — a service worker turning `/~/3000/…` into a call, in
 * this product (`apps/infinite/src/power/virtual-ports.ts`). That host-specific half is an interface
 * here: `HttpBridge { listen(port, handler), close(port) }`. This module never knows how a request
 * arrived, and the app never has to know what an `IncomingMessage` is.
 *
 * OUTBOUND (`http.request` / `http.get`). There are no sockets, so the only road is `fetch` —
 * subject to the other origin's CORS, and subject to whatever policy the host puts in front of it.
 * `NetworkBridge` is that door: a host may hand a plain `fetch`, a policy-checking wrapper, or
 * nothing at all, and with nothing at all every outbound call refuses by name.
 *
 * DOES: `createServer`, `Server#listen/close/address`, `IncomingMessage` as a real readable stream
 * with `method`/`url`/`headers`, `ServerResponse` with `writeHead`/`setHeader`/`write`/`end` and a
 * content-type guess when the handler set none, `request`/`get` with the `(options|url, cb)` shapes
 * and a `ClientRequest` that streams its response, `STATUS_CODES`, `METHODS`, `Agent` as an inert
 * object so `new http.Agent()` does not crash a module's top level.
 *
 * DOES NOT: `server.on("upgrade")` (no WebSocket handshake through a virtual port — the host's own
 * WebSocket is the road), keep-alive or connection pooling (fetch owns those), trailers, HTTP/2,
 * `http.createConnection`, TLS options on the outbound side (the browser's trust store decides),
 * `req.socket` beyond a stub address. `https` is the same module: fetch decides the scheme.
 */

import { Buffer } from "buffer/index.js";
import { Readable } from "readable-stream";
import EventEmitter from "events/events.js";
import { failNoSockets, NodeCompatError } from "../errors.js";

export interface BridgeRequest {
  method: string;
  /** Node's spelling: path plus query, never an absolute URL. */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface BridgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** What the host implements so `listen()` means something. */
export interface HttpBridge {
  listen(port: number, handler: (request: BridgeRequest) => Promise<BridgeResponse>): Promise<void> | void;
  close(port: number): Promise<void> | void;
}

/** The outbound door. A host that hands none has denied the network, and this module says so. */
export interface NetworkBridge {
  fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<Response>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const STATUS_CODES: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  418: "I'm a Teapot",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function bytesOf(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return encoder.encode(String(chunk));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * A browser with no content-type SNIFFS, which is how a page of text becomes script. So the one
 * guess this module makes: markup looks like markup, JSON looks like JSON, everything else is text.
 */
export function guessContentType(body: Uint8Array): string {
  const head = decoder.decode(body.subarray(0, 64)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "text/html; charset=utf-8";
  if (head.startsWith("{") || head.startsWith("[")) return "application/json; charset=utf-8";
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "application/xml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export class ServerResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "";
  headersSent = false;
  finished = false;
  private headers: Record<string, string> = {};
  private chunks: Uint8Array[] = [];
  constructor(private readonly settle: (response: BridgeResponse) => void) {
    super();
  }
  setHeader(name: string, value: unknown): this {
    this.headers[String(name).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers[String(name).toLowerCase()];
  }
  getHeaders(): Record<string, string> {
    return { ...this.headers };
  }
  removeHeader(name: string): void {
    delete this.headers[String(name).toLowerCase()];
  }
  writeHead(status: number, a?: unknown, b?: unknown): this {
    this.statusCode = status;
    if (typeof a === "string") this.statusMessage = a;
    const headers = (typeof a === "object" && a ? a : typeof b === "object" && b ? b : null) as Record<string, unknown> | null;
    if (headers) for (const key of Object.keys(headers)) this.setHeader(key, headers[key]);
    this.headersSent = true;
    return this;
  }
  write(chunk: unknown): boolean {
    if (chunk !== undefined && chunk !== null) this.chunks.push(bytesOf(chunk));
    return true;
  }
  end(chunk?: unknown): this {
    if (this.finished) return this;
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") this.chunks.push(bytesOf(chunk));
    this.finished = true;
    const body = concat(this.chunks);
    if (!this.headers["content-type"]) this.headers["content-type"] = guessContentType(body);
    this.settle({ status: this.statusCode, headers: this.headers, body });
    this.emit("finish");
    this.emit("close");
    return this;
  }
}

/** `IncomingMessage`: a real readable stream, so `for await (const chunk of req)` works. */
export function makeIncoming(request: BridgeRequest): Readable & Record<string, unknown> {
  const stream = new Readable({ read() {} }) as Readable & Record<string, unknown>;
  stream.method = request.method;
  stream.url = request.url;
  stream.headers = request.headers;
  stream.httpVersion = "1.1";
  stream.socket = { remoteAddress: "127.0.0.1", remotePort: 0 };
  stream.connection = stream.socket;
  // The body arrives AFTER the handler has had a chance to subscribe, exactly as Node's does.
  queueMicrotask(() => {
    if (request.body && request.body.byteLength) stream.push(Buffer.from(request.body));
    stream.push(null);
  });
  return stream;
}

class Server extends EventEmitter {
  private port = 0;
  constructor(
    private readonly bridge: HttpBridge | null,
    handler?: (req: unknown, res: unknown) => void,
  ) {
    super();
    if (handler) this.on("request", handler);
  }
  listen(...args: unknown[]): this {
    const port = (args.find((a) => typeof a === "number") as number | undefined) ?? 3000;
    const done = args.find((a) => typeof a === "function") as (() => void) | undefined;
    if (!this.bridge) {
      const err = new NodeCompatError(
        "ERR_NO_HTTP_BRIDGE",
        `server.listen(${port}): this runtime has no way to route a port — the host must supply an HttpBridge (in the app that is the virtual-port registry behind /~/<port>/)`,
      );
      if (this.listenerCount("error")) queueMicrotask(() => this.emit("error", err));
      else throw err;
      return this;
    }
    // `Promise.resolve().then(...)`, not `Promise.resolve(bridge.listen(...))`: a bridge that refuses
    // SYNCHRONOUSLY (a port already in use is the common one) would otherwise throw straight out of
    // `server.listen()`, past the `error` event a Node script is waiting on.
    void Promise.resolve().then(() =>
      this.bridge?.listen(port, async (request) => {
        return await new Promise<BridgeResponse>((resolve) => {
          const res = new ServerResponse(resolve);
          try {
            this.emit("request", makeIncoming(request), res);
          } catch (err) {
            resolve({
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
              body: encoder.encode(`the handler threw: ${(err as Error)?.message ?? String(err)}`),
            });
          }
        });
      }),
    ).then(
      () => {
        this.port = port;
        done?.();
        this.emit("listening");
      },
      (err) => {
        if (this.listenerCount("error")) this.emit("error", err);
        else throw err;
      },
    );
    return this;
  }
  close(done?: () => void): this {
    if (this.port && this.bridge) void Promise.resolve(this.bridge.close(this.port));
    this.port = 0;
    done?.();
    this.emit("close");
    return this;
  }
  address(): { address: string; family: string; port: number } | null {
    return this.port ? { address: "127.0.0.1", family: "IPv4", port: this.port } : null;
  }
  get listening(): boolean {
    return this.port !== 0;
  }
}

/** `ClientRequest` over fetch. `write()`/`end()` collect the body; the response is a readable stream. */
class ClientRequest extends EventEmitter {
  private chunks: Uint8Array[] = [];
  private sent = false;
  constructor(
    private readonly network: NetworkBridge | null,
    private readonly url: string,
    private readonly method: string,
    private readonly headers: Record<string, string>,
  ) {
    super();
  }
  setHeader(name: string, value: unknown): this {
    this.headers[String(name).toLowerCase()] = String(value);
    return this;
  }
  write(chunk: unknown): boolean {
    this.chunks.push(bytesOf(chunk));
    return true;
  }
  end(chunk?: unknown): this {
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") this.chunks.push(bytesOf(chunk));
    if (this.sent) return this;
    this.sent = true;
    if (!this.network) {
      const err = new NodeCompatError(
        "ERR_NETWORK_DENIED",
        `http.request('${this.url}'): outbound traffic is closed for this runtime — the host supplies a NetworkBridge when it allows one, and every call goes through fetch (so the other origin's CORS still decides)`,
      );
      queueMicrotask(() => this.emit("error", err));
      return this;
    }
    const body = this.chunks.length ? concat(this.chunks) : undefined;
    this.network
      .fetch(this.url, { method: this.method, headers: this.headers, body })
      .then(async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const stream = new Readable({ read() {} }) as Readable & Record<string, unknown>;
        stream.statusCode = response.status;
        stream.statusMessage = response.statusText;
        stream.headers = Object.fromEntries([...response.headers.entries()]);
        stream.httpVersion = "1.1";
        this.emit("response", stream);
        queueMicrotask(() => {
          if (bytes.byteLength) stream.push(Buffer.from(bytes));
          stream.push(null);
        });
      })
      .catch((err: unknown) => this.emit("error", err));
    return this;
  }
  abort(): void {
    this.emit("abort");
  }
  destroy(): void {
    this.emit("close");
  }
}

function urlOf(options: unknown, fallbackProtocol: string): { url: string; method: string; headers: Record<string, string> } {
  if (typeof options === "string") return { url: options, method: "GET", headers: {} };
  if (options instanceof URL) return { url: options.href, method: "GET", headers: {} };
  const o = (options ?? {}) as {
    protocol?: string;
    hostname?: string;
    host?: string;
    port?: number | string;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  const protocol = o.protocol ?? fallbackProtocol;
  const host = o.hostname ?? o.host ?? "localhost";
  const port = o.port ? `:${o.port}` : "";
  return { url: `${protocol}//${host}${port}${o.path ?? "/"}`, method: o.method ?? "GET", headers: o.headers ?? {} };
}

export interface HttpModuleOptions {
  bridge?: HttpBridge | null;
  network?: NetworkBridge | null;
}

export function httpModule(opts: HttpModuleOptions = {}, scheme: "http:" | "https:" = "http:"): Record<string, unknown> {
  const bridge = opts.bridge ?? null;
  const network = opts.network ?? null;
  const request = (options: unknown, maybeOptions?: unknown, maybeCb?: unknown): ClientRequest => {
    const cb = [maybeOptions, maybeCb].find((a) => typeof a === "function") as ((res: unknown) => void) | undefined;
    const merged = typeof options === "string" && typeof maybeOptions === "object" && maybeOptions
      ? { ...(maybeOptions as Record<string, unknown>), url: options }
      : options;
    const spec = typeof merged === "object" && merged && "url" in merged
      ? { ...urlOf((merged as { url: string }).url, scheme), method: String((merged as { method?: string }).method ?? "GET"), headers: ((merged as { headers?: Record<string, string> }).headers ?? {}) }
      : urlOf(merged, scheme);
    const req = new ClientRequest(network, spec.url, spec.method, { ...spec.headers });
    if (cb) req.on("response", cb);
    return req;
  };
  const api: Record<string, unknown> = {
    createServer: (a?: unknown, b?: unknown) => new Server(bridge, (typeof a === "function" ? a : b) as ((req: unknown, res: unknown) => void) | undefined),
    Server,
    ServerResponse,
    IncomingMessage: Readable,
    STATUS_CODES,
    METHODS: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
    globalAgent: { maxSockets: Infinity, keepAlive: false },
    Agent: class Agent {
      constructor(readonly options: unknown = {}) {}
    },
    request,
    get: (options: unknown, maybeOptions?: unknown, maybeCb?: unknown) => request(options, maybeOptions, maybeCb).end(),
    createConnection: () => failNoSockets("http.createConnection"),
  };
  api.default = api;
  return api;
}
