/**
 * SERVER-SENT EVENTS, read off a `Response` — the one parser both streaming providers share.
 *
 * WHY it is written here rather than taken from a library: a token stream is the hot path of the
 * whole runtime, this package may not add a dependency, and the format is twelve lines. The subtle
 * parts are the ones a naive `split("\n\n")` gets wrong and a test would never catch until a slow
 * network showed up: an event may arrive split across chunk boundaries mid-word, `data:` may repeat
 * inside one event (the spec joins them with a newline, and Anthropic's JSON never does but a proxy
 * that re-wraps it might), and line endings are CRLF from some edges and LF from others.
 *
 * It yields the RAW payload, not JSON: the OpenAI dialect ends a stream with the sentinel string
 * `[DONE]`, which is not JSON, and the Anthropic dialect carries the event name on its own line.
 */

/** One SSE event: the `event:` name where the dialect uses one, and the joined `data:` payload. */
export interface SseEvent {
  event?: string;
  data: string;
}

/** The OpenAI dialect's end-of-stream sentinel. Not JSON, and not an error. */
export const SSE_DONE = "[DONE]";

function emit(lines: string[]): SseEvent | null {
  let name: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon is part of the framing, not of the payload.
    const value = colon === -1 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && name === undefined) return null;
  return { event: name, data: data.join("\n") };
}

/** Split a text stream into SSE events. Feed it chunks in order; it holds the partial tail. */
export function sseSplitter(): { push(chunk: string): SseEvent[]; flush(): SseEvent[] } {
  let buffer = "";
  const drain = (final: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    // Normalise line endings first, so an event boundary is always exactly "\n\n".
    buffer = buffer.replace(/\r\n?/g, "\n");
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const event = emit(buffer.slice(0, index).split("\n"));
      if (event) out.push(event);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) {
      // A stream that ended without its blank line still owes us its last event. Some edges close
      // the connection the instant the terminal chunk is written.
      const event = emit(buffer.split("\n"));
      if (event) out.push(event);
      buffer = "";
    }
    return out;
  };
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): SseEvent[] {
      return drain(true);
    },
  };
}

/**
 * Read a `Response` body as SSE events.
 *
 * A body with no `getReader` is read whole with `text()`: that is what a mocked fetch in a test
 * hands back, and what a proxy that buffered the answer hands back on a real network. Both are
 * legitimate; a parser that only understood streams would make the buffered case look like an
 * empty answer.
 */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const body: unknown = res.body;
  const splitter = sseSplitter();
  const reader =
    body && typeof (body as ReadableStream<Uint8Array>).getReader === "function"
      ? (body as ReadableStream<Uint8Array>).getReader()
      : null;
  if (!reader) {
    for (const event of splitter.push(await res.text())) yield event;
    for (const event of splitter.flush()) yield event;
    return;
  }
  const decoder = new TextDecoder();
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of splitter.push(decoder.decode(value, { stream: true }))) yield event;
    }
    for (const event of splitter.flush()) yield event;
  } finally {
    // Cancelling releases the socket when a consumer walks away mid-stream (a `break` in a
    // `for await`, or an abort). Without it the connection is held until the server gives up.
    try {
      await reader.cancel();
    } catch {
      /* the stream was already closed; nothing to release */
    }
  }
}
