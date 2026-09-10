import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.js";
import { ModelRouter } from "../src/router.js";
import type { SwitchEvent } from "../src/router.js";
import type { ChatChunk, ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "../src/types.js";
import { collect } from "./helpers.js";

type Readiness = Awaited<ReturnType<ModelProvider["readiness"]>>;

interface FakeOptions {
  id: string;
  readiness?: Readiness | (() => Promise<Readiness>);
  answer?: string;
  fail?: () => never;
  chunks?: ChatChunk[];
  /** Emits one chunk, then fails — the case a stream may NOT fall through on. */
  failAfterChunk?: () => never;
}

function fake(options: FakeOptions): ModelProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  const response = (): ChatResponse => ({ message: { role: "assistant", content: options.answer ?? options.id }, finishReason: "stop" });
  return {
    id: options.id,
    seen,
    async models(): Promise<ModelInfo[]> {
      return [];
    },
    async readiness() {
      const r = options.readiness ?? { ready: true as const };
      return typeof r === "function" ? r() : r;
    },
    async chat(req) {
      seen.push(req);
      if (options.fail) options.fail();
      return response();
    },
    async *stream(req) {
      seen.push(req);
      if (options.fail) options.fail();
      if (options.failAfterChunk) {
        yield { type: "text", delta: "half" };
        options.failAfterChunk();
      }
      for (const chunk of options.chunks ?? [{ type: "text", delta: options.answer ?? options.id }]) yield chunk;
      yield { type: "done", response: response() };
    },
  };
}

const credentialDead = () => {
  throw new ProviderError({ status: 401, code: "credential", message: "key revoked", providerId: "x" });
};
const walletEmpty = () => {
  throw new ProviderError({ status: 402, code: "insufficient_credits", message: "no credits", providerId: "x" });
};

describe("pick", () => {
  it("takes the first ready provider in the preference list", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "local" }), fake({ id: "overblast" })],
      preference: { small: ["local", "overblast"], strong: ["overblast", "local"] },
    });
    expect((await router.pick("small")).id).toBe("local");
    expect((await router.pick("strong")).id).toBe("overblast");
  });

  it("walks past a provider that is not ready, and says why it switched", async () => {
    const events: SwitchEvent[] = [];
    const router = new ModelRouter({
      providers: [
        fake({ id: "local", readiness: { ready: false, reason: "download" } }),
        fake({ id: "sponsored", readiness: { ready: false, reason: "credential" } }),
        fake({ id: "overblast" }),
      ],
      preference: { small: ["local", "sponsored", "overblast"], strong: [] },
      onSwitch: (e) => events.push(e),
    });
    expect((await router.pick("small")).id).toBe("overblast");
    expect(events).toEqual([{ cls: "small", from: "sponsored", to: "overblast", reason: "readiness" }]);
  });

  it("skips a preference id no provider answers to", async () => {
    const router = new ModelRouter({ providers: [fake({ id: "local" })], preference: { small: ["ghost", "local"], strong: [] } });
    expect(router.candidates("small").map((p) => p.id)).toEqual(["local"]);
    expect((await router.pick("small")).id).toBe("local");
  });

  it("raises `no_brain` when nothing is ready, and names what it tried", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "local", readiness: { ready: false, reason: "unsupported" } })],
      preference: { small: ["local"], strong: [] },
    });
    await expect(router.pick("small")).rejects.toMatchObject({ code: "no_brain", status: 0 });
    await expect(router.pick("small")).rejects.toThrow(/local \(unsupported\)/);
  });

  it("raises `no_brain` when the class has no providers configured at all", async () => {
    const router = new ModelRouter({ providers: [], preference: { small: [], strong: [] } });
    await expect(router.pick("strong")).rejects.toThrow(/No brain is configured for strong work/);
  });

  it("treats a readiness check that throws as not ready", async () => {
    const router = new ModelRouter({
      providers: [
        fake({
          id: "local",
          readiness: () => {
            throw new Error("engine exploded");
          },
        }),
        fake({ id: "overblast" }),
      ],
      preference: { small: ["local", "overblast"], strong: [] },
    });
    expect((await router.pick("small")).id).toBe("overblast");
  });
});

describe("chat", () => {
  it("answers from the first ready provider and tells the UI which", async () => {
    const events: SwitchEvent[] = [];
    const router = new ModelRouter({
      providers: [fake({ id: "overblast", answer: "from the cloud" })],
      preference: { small: [], strong: ["overblast"] },
      onSwitch: (e) => events.push(e),
    });
    const res = await router.chat({ messages: [] }, "strong");
    expect(res.message.content).toBe("from the cloud");
    expect(events[0]).toMatchObject({ to: "overblast", reason: "initial" });
  });

  it("falls through on a 402 and says the purse was empty", async () => {
    const events: SwitchEvent[] = [];
    const router = new ModelRouter({
      providers: [fake({ id: "overblast", fail: walletEmpty }), fake({ id: "local", answer: "from the laptop" })],
      preference: { small: [], strong: ["overblast", "local"] },
      onSwitch: (e) => events.push(e),
    });
    await expect(router.chat({ messages: [] }, "strong")).resolves.toMatchObject({ message: { content: "from the laptop" } });
    expect(events.map((e) => e.reason)).toEqual(["initial", "insufficient_credits", "readiness"]);
    expect(events[1]?.detail).toBe("no credits");
  });

  it("falls through on a 401", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "byok:openai", fail: credentialDead }), fake({ id: "local" })],
      preference: { small: [], strong: ["byok:openai", "local"] },
    });
    await expect(router.chat({ messages: [] }, "strong")).resolves.toMatchObject({ message: { content: "local" } });
  });

  it("does NOT fall through on a 429 or a 500 — a retry fixes those, a switch does not", async () => {
    for (const code of ["rate_limited", "server_error", "network"] as const) {
      const second = fake({ id: "local" });
      const router = new ModelRouter({
        providers: [
          fake({
            id: "overblast",
            fail: () => {
              throw new ProviderError({ status: 429, code, message: code });
            },
          }),
          second,
        ],
        preference: { small: [], strong: ["overblast", "local"] },
      });
      await expect(router.chat({ messages: [] }, "strong")).rejects.toMatchObject({ code });
      expect(second.seen).toHaveLength(0);
    }
  });

  it("never falls through on an abort — the person said stop", async () => {
    const second = fake({ id: "local" });
    const router = new ModelRouter({
      providers: [
        fake({
          id: "overblast",
          fail: () => {
            throw new ProviderError({ status: 0, code: "aborted", message: "cancelled" });
          },
        }),
        second,
      ],
      preference: { small: [], strong: ["overblast", "local"] },
    });
    await expect(router.chat({ messages: [] }, "strong")).rejects.toMatchObject({ code: "aborted" });
    expect(second.seen).toHaveLength(0);
  });

  it("hands the request, signal and all, to the provider it chose", async () => {
    const controller = new AbortController();
    const local = fake({ id: "local" });
    const router = new ModelRouter({ providers: [local], preference: { small: ["local"], strong: [] } });
    const req: ChatRequest = { messages: [{ role: "user", content: "hi" }], signal: controller.signal };
    await router.chat(req, "small");
    expect(local.seen[0]?.signal).toBe(controller.signal);
  });

  it("raises `no_brain` when every candidate refused with a switchable error", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "a", fail: walletEmpty }), fake({ id: "b", fail: credentialDead })],
      preference: { small: [], strong: ["a", "b"] },
    });
    await expect(router.chat({ messages: [] }, "strong")).rejects.toMatchObject({ code: "no_brain" });
  });

  it("does not let a throwing onSwitch listener take the turn down", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "local", answer: "fine" })],
      preference: { small: ["local"], strong: [] },
      onSwitch: () => {
        throw new Error("the UI blew up");
      },
    });
    await expect(router.chat({ messages: [] }, "small")).resolves.toMatchObject({ message: { content: "fine" } });
  });

  it("defaults to the strong class when none is named", async () => {
    const router = new ModelRouter({ providers: [fake({ id: "strong-one" })], preference: { small: [], strong: ["strong-one"] } });
    await expect(router.chat({ messages: [] })).resolves.toMatchObject({ message: { content: "strong-one" } });
  });
});

describe("stream", () => {
  it("falls through before the first chunk", async () => {
    const onSwitch = vi.fn();
    const router = new ModelRouter({
      providers: [fake({ id: "sponsored", fail: walletEmpty }), fake({ id: "local", answer: "local text" })],
      preference: { small: ["sponsored", "local"], strong: [] },
      onSwitch,
    });
    const out = await collect(router.stream({ messages: [] }, "small"));
    expect(out.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta)).toEqual(["local text"]);
    expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ reason: "insufficient_credits", from: "sponsored" }));
  });

  it("does NOT fall through once a chunk is out — half an answer plus a whole one is a corrupt turn", async () => {
    const second = fake({ id: "local" });
    const router = new ModelRouter({
      providers: [fake({ id: "sponsored", failAfterChunk: walletEmpty }), second],
      preference: { small: ["sponsored", "local"], strong: [] },
    });
    const seen: ChatChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of router.stream({ messages: [] }, "small")) seen.push(chunk);
      })(),
    ).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(seen).toEqual([{ type: "text", delta: "half" }]);
    expect(second.seen).toHaveLength(0);
  });

  it("skips a provider that is not ready", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "local", readiness: { ready: false, reason: "download" } }), fake({ id: "overblast", answer: "cloud" })],
      preference: { small: ["local", "overblast"], strong: [] },
    });
    const out = await collect(router.stream({ messages: [] }, "small"));
    expect(out.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta)).toEqual(["cloud"]);
  });

  it("propagates an abort rather than switching", async () => {
    const second = fake({ id: "local" });
    const router = new ModelRouter({
      providers: [
        fake({
          id: "sponsored",
          fail: () => {
            throw Object.assign(new Error("stop"), { name: "AbortError" });
          },
        }),
        second,
      ],
      preference: { small: ["sponsored", "local"], strong: [] },
    });
    await expect(collect(router.stream({ messages: [] }, "small"))).rejects.toMatchObject({ name: "AbortError" });
    expect(second.seen).toHaveLength(0);
  });

  it("raises `no_brain` when nothing can stream", async () => {
    const router = new ModelRouter({
      providers: [fake({ id: "local", readiness: { ready: false, reason: "offline" } })],
      preference: { small: ["local"], strong: [] },
    });
    await expect(collect(router.stream({ messages: [] }, "small"))).rejects.toMatchObject({ code: "no_brain" });
  });
});

describe("chat, past a provider that is not ready", () => {
  it("skips it without spending a request on it", async () => {
    const asleep = fake({ id: "local", readiness: { ready: false, reason: "download" } });
    const router = new ModelRouter({
      providers: [asleep, fake({ id: "overblast", answer: "cloud" })],
      preference: { small: ["local", "overblast"], strong: [] },
    });
    await expect(router.chat({ messages: [] }, "small")).resolves.toMatchObject({ message: { content: "cloud" } });
    expect(asleep.seen).toHaveLength(0);
  });
});
