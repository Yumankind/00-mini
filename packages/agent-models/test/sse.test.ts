import { describe, expect, it } from "vitest";
import { readSse, sseSplitter, SSE_DONE } from "../src/sse.js";
import { sseResponse } from "./helpers.js";

describe("sseSplitter", () => {
  it("emits one event per blank-line-terminated block", () => {
    const s = sseSplitter();
    expect(s.push("data: one\n\ndata: two\n\n")).toEqual([{ event: undefined, data: "one" }, { event: undefined, data: "two" }]);
  });

  it("holds a partial event across chunk boundaries, mid-word", () => {
    const s = sseSplitter();
    expect(s.push("data: hel")).toEqual([]);
    expect(s.push("lo\n")).toEqual([]);
    expect(s.push("\n")).toEqual([{ event: undefined, data: "hello" }]);
  });

  it("joins repeated data fields with a newline, per the spec", () => {
    const s = sseSplitter();
    expect(s.push("data: a\ndata: b\n\n")).toEqual([{ event: undefined, data: "a\nb" }]);
  });

  it("reads CRLF line endings the same as LF", () => {
    const s = sseSplitter();
    expect(s.push("event: ping\r\ndata: {}\r\n\r\n")).toEqual([{ event: "ping", data: "{}" }]);
  });

  it("ignores comment lines and keeps the single optional space out of the payload", () => {
    const s = sseSplitter();
    expect(s.push(": keep-alive\ndata:  two spaces\n\n")).toEqual([{ event: undefined, data: " two spaces" }]);
  });

  it("flushes a final event that arrived without its blank line", () => {
    const s = sseSplitter();
    expect(s.push("data: last")).toEqual([]);
    expect(s.flush()).toEqual([{ event: undefined, data: "last" }]);
  });
});

describe("readSse", () => {
  it("reads a streamed body", async () => {
    const res = sseResponse(["data: a\n\n", "data: b\n\n", `data: ${SSE_DONE}\n\n`]);
    const seen: string[] = [];
    for await (const event of readSse(res)) seen.push(event.data);
    expect(seen).toEqual(["a", "b", SSE_DONE]);
  });

  it("falls back to text() when the body is not a stream (a mocked fetch, a buffering proxy)", async () => {
    const res = new Response("data: only\n\n");
    Object.defineProperty(res, "body", { value: null });
    const seen: string[] = [];
    for await (const event of readSse(res)) seen.push(event.data);
    expect(seen).toEqual(["only"]);
  });

  it("stops reading once the signal is aborted", async () => {
    const controller = new AbortController();
    const res = sseResponse(["data: a\n\n", "data: b\n\n"]);
    const seen: string[] = [];
    for await (const event of readSse(res, controller.signal)) {
      seen.push(event.data);
      controller.abort();
    }
    expect(seen).toEqual(["a"]);
  });
});
