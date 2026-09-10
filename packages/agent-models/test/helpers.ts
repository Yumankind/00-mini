// Shared fixtures. Not a `.test.ts`, so vitest does not collect it.

/** A streaming answer, as a real `Response` with a real `ReadableStream` body. */
export function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...(init.headers ?? {}) },
    ...init,
  });
}

/** One SSE frame carrying a JSON payload. */
export function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

/** A `fetch` that answers from a queue and records every call it was given. */
export function recordingFetch(answers: (Response | (() => Response | Promise<Response>))[]): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  return {
    calls,
    async fetch(url: string, init?: RequestInit) {
      calls.push({ url, init });
      const next = answers[Math.min(index++, answers.length - 1)];
      if (!next) throw new Error("recordingFetch ran out of answers");
      return typeof next === "function" ? next() : next;
    },
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
