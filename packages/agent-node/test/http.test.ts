import { describe, expect, it } from "vitest";
import { guessContentType, httpModule, makeIncoming, ServerResponse, STATUS_CODES, type BridgeRequest, type BridgeResponse, type HttpBridge } from "../src/modules/http.js";
import { decodeChunk } from "../src/process/runner.js";

/** A host's HttpBridge, the size a host's really is: a table of ports and a way to call into one. */
function bridge(): HttpBridge & { hit(port: number, request: Partial<BridgeRequest>): Promise<BridgeResponse>; ports(): number[] } {
  const handlers = new Map<number, (request: BridgeRequest) => Promise<BridgeResponse>>();
  return {
    listen(port, handler) {
      if (handlers.has(port)) throw new Error(`port ${port} is already in use`);
      handlers.set(port, handler);
    },
    close(port) {
      handlers.delete(port);
    },
    ports: () => [...handlers.keys()],
    hit(port, request) {
      const handler = handlers.get(port);
      if (!handler) throw new Error(`nothing is listening on ${port}`);
      return handler({ method: "GET", url: "/", headers: {}, body: null, ...request });
    },
  };
}

describe("http — the server half", () => {
  it("listens through the bridge and answers a request", async () => {
    const host = bridge();
    const http = httpModule({ bridge: host }) as { createServer(h: (req: unknown, res: unknown) => void): Record<string, (...a: unknown[]) => unknown> };
    const server = http.createServer((req, res) => {
      const request = req as { method: string; url: string; headers: Record<string, string> };
      const response = res as ServerResponse;
      response.writeHead(201, { "x-seen": request.headers["x-sent"] ?? "" });
      response.end(`${request.method} ${request.url}`);
    });
    await new Promise<void>((resolve) => {
      (server.on as (n: string, f: () => void) => void)("listening", resolve);
      server.listen(3000);
    });
    expect(host.ports()).toEqual([3000]);
    expect(server.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port: 3000 });
    expect((server as unknown as { listening: boolean }).listening).toBe(true);

    const answer = await host.hit(3000, { method: "POST", url: "/x?y=1", headers: { "x-sent": "yes" } });
    expect(answer.status).toBe(201);
    expect(answer.headers["x-seen"]).toBe("yes");
    expect(decodeChunk(answer.body)).toBe("POST /x?y=1");

    server.close();
    expect(host.ports()).toEqual([]);
  });

  it("defaults the port, and reports a port already in use through the error event", async () => {
    const host = bridge();
    const http = httpModule({ bridge: host }) as { createServer(h?: unknown, b?: unknown): Record<string, (...a: unknown[]) => unknown> };
    const first = http.createServer(undefined, (_req: unknown, res: unknown) => (res as ServerResponse).end("ok"));
    await new Promise<void>((resolve) => first.listen(3000, resolve));
    const second = http.createServer(() => undefined);
    const err = await new Promise<Error>((resolve) => {
      (second.on as (n: string, f: (e: Error) => void) => void)("error", resolve);
      second.listen(3000);
    });
    expect(err.message).toContain("already in use");
    first.close();
    // A close with nothing bound is a no-op, and takes its callback.
    let closed = false;
    second.close(() => (closed = true));
    expect(closed).toBe(true);
    expect(second.address()).toBeNull();
  });

  it("says by name when the host gave it no bridge at all", () => {
    const http = httpModule() as { createServer(h: unknown): Record<string, (...a: unknown[]) => unknown> };
    const server = http.createServer(() => undefined);
    expect(() => server.listen(3000)).toThrow(/no way to route a port/);
    // With an error listener it arrives as an event instead, which is what Node does.
    const withHandler = http.createServer(() => undefined);
    return new Promise<void>((resolve) => {
      (withHandler.on as (n: string, f: (e: Error) => void) => void)("error", (e) => {
        expect(e.message).toContain("HttpBridge");
        resolve();
      });
      withHandler.listen(3000);
    });
  });

  it("reads a request body as a stream and as a whole", async () => {
    const host = bridge();
    const http = httpModule({ bridge: host }) as { createServer(h: (req: unknown, res: unknown) => void): Record<string, (...a: unknown[]) => unknown> };
    http
      .createServer(async (req, res) => {
        const chunks: string[] = [];
        for await (const chunk of req as AsyncIterable<Uint8Array>) chunks.push(decodeChunk(chunk));
        (res as ServerResponse).end(`body:${chunks.join("")}`);
      })
      .listen(4000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = await host.hit(4000, { method: "PUT", body: new TextEncoder().encode("payload") });
    expect(decodeChunk(answer.body)).toBe("body:payload");
  });

  it("turns a throwing handler into a 500 rather than a dead port", async () => {
    const host = bridge();
    const http = httpModule({ bridge: host }) as { createServer(h: (req: unknown, res: unknown) => void): Record<string, (...a: unknown[]) => unknown> };
    http
      .createServer(() => {
        throw new Error("handler is broken");
      })
      .listen(5000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = await host.hit(5000, {});
    expect(answer.status).toBe(500);
    expect(decodeChunk(answer.body)).toContain("handler is broken");
  });
});

describe("ServerResponse", () => {
  it("collects writes, guesses a content-type, and ignores a second end", () => {
    const seen: BridgeResponse[] = [];
    const res = new ServerResponse((r) => seen.push(r));
    res.setHeader("X-One", "1");
    res.setHeader("x-many", ["a", "b"]);
    expect(res.getHeader("x-one")).toBe("1");
    expect(res.getHeaders()["x-many"]).toBe("a, b");
    res.removeHeader("x-one");
    expect(res.getHeader("x-one")).toBeUndefined();
    res.writeHead(404, "Not Found");
    expect(res.statusMessage).toBe("Not Found");
    expect(res.headersSent).toBe(true);
    res.write("first ");
    res.write(new TextEncoder().encode("second"));
    res.end();
    res.end("ignored");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(404);
    expect(decodeChunk(seen[0]!.body)).toBe("first second");
    expect(seen[0]?.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.finished).toBe(true);
  });

  it("guesses html, json, xml and text and nothing else", () => {
    const encode = (t: string): Uint8Array => new TextEncoder().encode(t);
    expect(guessContentType(encode("<!DOCTYPE html><p>"))).toContain("text/html");
    expect(guessContentType(encode("  <html>"))).toContain("text/html");
    expect(guessContentType(encode(`{"a":1}`))).toContain("application/json");
    expect(guessContentType(encode("[1,2]"))).toContain("application/json");
    expect(guessContentType(encode("<?xml version"))).toContain("application/xml");
    expect(guessContentType(encode("<svg "))).toContain("application/xml");
    expect(guessContentType(encode("plain words"))).toContain("text/plain");
  });

  it("an explicit content-type is never overwritten", () => {
    const seen: BridgeResponse[] = [];
    const res = new ServerResponse((r) => seen.push(r));
    res.setHeader("content-type", "image/png");
    res.end(new Uint8Array([1, 2, 3]));
    expect(seen[0]?.headers["content-type"]).toBe("image/png");
  });
});

describe("makeIncoming", () => {
  it("is a readable stream carrying Node's request fields", async () => {
    const request = makeIncoming({ method: "POST", url: "/a", headers: { host: "x" }, body: new TextEncoder().encode("hi") });
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/a");
    expect(request.httpVersion).toBe("1.1");
    expect((request.socket as { remoteAddress: string }).remoteAddress).toBe("127.0.0.1");
    expect(request.connection).toBe(request.socket);
    const chunks: string[] = [];
    for await (const chunk of request as unknown as AsyncIterable<Uint8Array>) chunks.push(decodeChunk(chunk));
    expect(chunks.join("")).toBe("hi");
  });
});

describe("http — the outbound half", () => {
  const okResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

  it("goes through the NetworkBridge and streams the response", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const http = httpModule({
      network: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          return okResponse("from the network");
        },
      },
    }) as { get(u: string, cb: (res: unknown) => void): unknown; request(o: unknown, cb?: unknown): { write(c: unknown): unknown; end(): unknown; on(n: string, f: (v: unknown) => void): unknown } };

    const body = await new Promise<string>((resolve) => {
      http.get("https://example.test/a", (res) => {
        const stream = res as { statusCode: number; headers: Record<string, string> } & AsyncIterable<Uint8Array>;
        expect(stream.statusCode).toBe(200);
        expect(stream.headers["content-type"]).toBe("text/plain");
        void (async () => {
          const chunks: string[] = [];
          for await (const chunk of stream) chunks.push(decodeChunk(chunk));
          resolve(chunks.join(""));
        })();
      });
    });
    expect(body).toBe("from the network");
    expect(calls[0]?.url).toBe("https://example.test/a");
  });

  it("builds a URL from Node's option bag and sends the body it was written", async () => {
    let seen: { url: string; init: { method?: string; body?: Uint8Array; headers?: Record<string, string> } } | null = null;
    const http = httpModule(
      {
        network: {
          fetch: async (url, init) => {
            seen = { url, init: init ?? {} };
            return okResponse("ok");
          },
        },
      },
      "https:",
    ) as { request(o: unknown, cb?: unknown): { write(c: unknown): unknown; end(c?: unknown): unknown; on(n: string, f: (v: unknown) => void): unknown; abort(): void; destroy(): void; setHeader(n: string, v: unknown): unknown } };

    const req = http.request({ hostname: "api.test", port: 8443, path: "/v1/x", method: "POST", headers: { "x-a": "1" } });
    req.setHeader("x-b", "2");
    req.write("part one ");
    req.end("part two");
    req.end("ignored, already sent");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen!.url).toBe("https://api.test:8443/v1/x");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.headers).toMatchObject({ "x-a": "1", "x-b": "2" });
    expect(decodeChunk(seen!.init.body as Uint8Array)).toBe("part one part two");
    req.abort();
    req.destroy();
  });

  it("accepts a URL object and a (url, options, cb) call", async () => {
    const seen: string[] = [];
    const http = httpModule({ network: { fetch: async (url) => (seen.push(url), okResponse("ok")) } }) as {
      request(a: unknown, b?: unknown, c?: unknown): { end(): unknown; on(n: string, f: (v: unknown) => void): unknown };
    };
    http.request(new URL("https://a.test/one")).end();
    http.request("https://a.test/two", { method: "PUT" }).end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["https://a.test/one", "https://a.test/two"]);
  });

  it("refuses by name when the host denied the network", async () => {
    const http = httpModule() as { request(o: unknown): { end(): unknown; on(n: string, f: (v: unknown) => void): unknown } };
    const req = http.request("https://example.test/");
    const err = await new Promise<Error>((resolve) => {
      req.on("error", (e) => resolve(e as Error));
      req.end();
    });
    expect(err.message).toContain("outbound traffic is closed");
  });

  it("carries a fetch failure to the error event rather than an unhandled rejection", async () => {
    const http = httpModule({ network: { fetch: () => Promise.reject(new Error("network is down")) } }) as {
      request(o: unknown): { end(): unknown; on(n: string, f: (v: unknown) => void): unknown };
    };
    const req = http.request("https://example.test/");
    const err = await new Promise<Error>((resolve) => {
      req.on("error", (e) => resolve(e as Error));
      req.end();
    });
    expect(err.message).toBe("network is down");
  });

  it("carries the constants and the inert pieces a module reads at import time", () => {
    const http = httpModule() as Record<string, unknown>;
    expect(STATUS_CODES[404]).toBe("Not Found");
    expect(http.METHODS).toContain("PATCH");
    expect((http.globalAgent as { keepAlive: boolean }).keepAlive).toBe(false);
    expect(new (http.Agent as new (o?: unknown) => { options: unknown })({ keepAlive: true }).options).toEqual({ keepAlive: true });
    expect(() => (http.createConnection as () => unknown)()).toThrow(/no TCP sockets/);
    expect(http.IncomingMessage).toBeTypeOf("function");
  });
});
