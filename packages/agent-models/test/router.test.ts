import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.js";
import { LiteRtProvider } from "../src/litert.js";
import { classActuallyUsed, localProviders, ModelRouter, providerClasses } from "../src/router.js";
import type { ModelClass, SwitchEvent } from "../src/router.js";
import type { ChatChunk, ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "../src/types.js";
import { WebLLMProvider } from "../src/webllm.js";
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
  /** What its catalogue offers. Absent means an EMPTY catalogue, which reads as `strong`. */
  classes?: ModelClass[];
  /** A `models()` that throws — also `strong`, since a catalogue read is not a second door. */
  modelsThrows?: boolean;
}

function fake(options: FakeOptions): ModelProvider & { seen: ChatRequest[]; modelsCalls: () => number } {
  const seen: ChatRequest[] = [];
  let modelsCalls = 0;
  const response = (): ChatResponse => ({ message: { role: "assistant", content: options.answer ?? options.id }, finishReason: "stop" });
  return {
    id: options.id,
    seen,
    modelsCalls: () => modelsCalls,
    async models(): Promise<ModelInfo[]> {
      modelsCalls++;
      if (options.modelsThrows) throw new Error(`${options.id} cannot list its models`);
      return (options.classes ?? []).map((cls) => ({
        id: `${options.id}-${cls}`,
        label: options.id,
        class: cls,
        local: false,
        supportsTools: true,
      }));
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

// ── The two local brains ────────────────────────────────────────────────────────────────────────

describe("localProviders", () => {
  it("puts LiteRT first and WebLLM behind it, which is the whole of the ruling", () => {
    const litert = new LiteRtProvider({ modelBaseUrl: "https://models.example/litert", createTask: async () => ({ async generateResponse() { return ""; } }) });
    const webllm = new WebLLMProvider();
    expect(localProviders({ litert, webllm }).map((p) => p.id)).toEqual(["local-litert", "local"]);
    expect(localProviders({ webllm, litert }).map((p) => p.id)).toEqual(["local-litert", "local"]);
    expect(localProviders({ webllm }).map((p) => p.id)).toEqual(["local"]);
    expect(localProviders({})).toEqual([]);
  });

  it("falls through to WebLLM when LiteRT cannot run here, and the turn still happens", async () => {
    // No `navigator.gpu` is stubbed, so the REAL readiness gate of both providers runs: LiteRT
    // answers `unsupported`, which is what a browser with no WebGPU — or no served wasm folder —
    // looks like from the router's side.
    const litert = new LiteRtProvider({ modelBaseUrl: "https://models.example/litert" });
    await expect(litert.readiness()).resolves.toMatchObject({ ready: false, reason: "unsupported" });

    const webllm = fake({ id: "local", answer: "from web-llm" });
    const switches: SwitchEvent[] = [];
    const router = new ModelRouter({
      providers: localProviders({ litert, webllm }),
      preference: { small: ["local-litert", "local"], strong: [] },
      onSwitch: (event) => switches.push(event),
    });
    await expect(router.chat({ messages: [] }, "small")).resolves.toMatchObject({ message: { content: "from web-llm" } });
    expect(switches).toEqual([{ cls: "small", from: "local-litert", to: "local", reason: "readiness" }]);
  });

  it("says `no_brain` naming both when neither local brain can run", async () => {
    const litert = new LiteRtProvider({ modelBaseUrl: "https://models.example/litert" });
    const webllm = new WebLLMProvider();
    const router = new ModelRouter({
      providers: localProviders({ litert, webllm }),
      preference: { small: ["local-litert", "local"], strong: [] },
    });
    await expect(router.chat({ messages: [] }, "small")).rejects.toMatchObject({
      code: "no_brain",
      message: expect.stringContaining("local-litert (unsupported), local (unsupported)"),
    });
  });

  it("unloads both, twice, without complaint — which is what a settings screen does", async () => {
    const litert = new LiteRtProvider({ modelBaseUrl: "https://models.example/litert" });
    const webllm = new WebLLMProvider();
    for (const provider of localProviders({ litert, webllm })) {
      await provider.unload?.();
      await provider.unload?.();
    }
    await expect(litert.readiness()).resolves.toMatchObject({ ready: false });
    await expect(webllm.readiness()).resolves.toMatchObject({ ready: false });
  });
});

describe("unloadAll (contract revision 2026-09-10)", () => {
  it("releases every provider it holds — including ones no preference list names", async () => {
    const unloaded: string[] = [];
    const holding = (id: string): ModelProvider => ({
      ...fake({ id }),
      unload: async () => void unloaded.push(id),
    });
    const router = new ModelRouter({
      providers: [holding("local-litert"), holding("local"), fake({ id: "sponsored" })],
      // `local` is in no list, and is exactly the one still sitting on the GPU after a switch.
      preference: { small: ["local-litert"], strong: ["sponsored"] },
    });
    await router.unloadAll();
    expect(unloaded.sort()).toEqual(["local", "local-litert"]);
  });

  it("keeps going when one provider throws on the way out", async () => {
    const unloaded: string[] = [];
    const router = new ModelRouter({
      providers: [
        { ...fake({ id: "angry" }), unload: async () => { throw new Error("the GPU said no"); } },
        { ...fake({ id: "calm" }), unload: async () => void unloaded.push("calm") },
      ],
      preference: { small: [], strong: [] },
    });
    await expect(router.unloadAll()).resolves.toBeUndefined();
    expect(unloaded).toEqual(["calm"]);
  });
});

// ── Class-aware routing (§6, 2026-09-10) ────────────────────────────────────────────────────────

describe("providerClasses", () => {
  it("answers with the classes the catalogue's rows carry", async () => {
    expect([...(await providerClasses(fake({ id: "a", classes: ["small"] })))]).toEqual(["small"]);
    expect([...(await providerClasses(fake({ id: "b", classes: ["strong", "small"] })))].sort()).toEqual(["small", "strong"]);
  });

  it("reads an EMPTY catalogue as strong — that is what a cloud brain with no rows is", async () => {
    expect([...(await providerClasses(fake({ id: "byok:openai" })))]).toEqual(["strong"]);
  });

  it("reads a `models()` that throws as strong rather than dropping the provider", async () => {
    expect([...(await providerClasses(fake({ id: "overblast", modelsThrows: true })))]).toEqual(["strong"]);
  });
});

describe("classActuallyUsed", () => {
  const both = new Set<ModelClass>(["small", "strong"]);
  it("is the asked class when the provider offers it", () => {
    expect(classActuallyUsed(both, "small")).toBe("small");
    expect(classActuallyUsed(both, "strong")).toBe("strong");
    expect(classActuallyUsed(new Set<ModelClass>(["small"]), "small")).toBe("small");
  });

  it("is the class the provider does offer when it does not offer the asked one", () => {
    expect(classActuallyUsed(new Set<ModelClass>(["small"]), "strong")).toBe("small");
    expect(classActuallyUsed(new Set<ModelClass>(["strong"]), "small")).toBe("strong");
  });

  it("falls back to the asked class when the provider offers nothing at all", () => {
    expect(classActuallyUsed(new Set<ModelClass>(), "small")).toBe("small");
  });
});

describe("no preference list: the provider order IS the preference", () => {
  it("ranks the providers that offer the class first, keeping the caller's order", async () => {
    const cloud = fake({ id: "overblast", classes: ["strong"] });
    const local = fake({ id: "local-litert", classes: ["small"] });
    const router = new ModelRouter({ providers: [cloud, local] });
    expect((await router.pick("small")).id).toBe("local-litert");
    expect((await router.pick("strong")).id).toBe("overblast");
  });

  it("ranks rather than filters, so the wrong class still answers when nothing else can", async () => {
    const local = fake({ id: "local-litert", classes: ["small"] });
    const router = new ModelRouter({ providers: [local] });
    expect((await router.pick("strong")).id).toBe("local-litert");
    expect((await router.chat({ messages: [] }, "strong")).message.content).toBe("local-litert");
  });

  it("keeps the caller's order among equals, both ways round", async () => {
    const a = fake({ id: "local-litert", classes: ["small"] });
    const b = fake({ id: "local", classes: ["small"] });
    expect((await new ModelRouter({ providers: [a, b] }).pick("small")).id).toBe("local-litert");
    expect((await new ModelRouter({ providers: [b, a] }).pick("small")).id).toBe("local");
  });

  it("still skips a provider that is not ready, whatever class it offers", async () => {
    const sleeping = fake({ id: "local-litert", classes: ["small"], readiness: { ready: false, reason: "download" } });
    const awake = fake({ id: "local", classes: ["small"] });
    expect((await new ModelRouter({ providers: [sleeping, awake] }).pick("small")).id).toBe("local");
  });

  it("reads each catalogue once, however many picks a router serves", async () => {
    const cloud = fake({ id: "overblast", classes: ["strong"] });
    const local = fake({ id: "local-litert", classes: ["small"] });
    const router = new ModelRouter({ providers: [cloud, local] });
    await router.pick("small");
    await router.pick("strong");
    await router.pick("small");
    expect(cloud.modelsCalls()).toBe(1);
    expect(local.modelsCalls()).toBe(1);
  });

  it("`candidates` answers with everyone, in the caller's order — it says who is behind the door", () => {
    const cloud = fake({ id: "overblast", classes: ["strong"] });
    const local = fake({ id: "local-litert", classes: ["small"] });
    const router = new ModelRouter({ providers: [cloud, local] });
    expect(router.candidates("small").map((p) => p.id)).toEqual(["overblast", "local-litert"]);
    expect(router.candidates("strong").map((p) => p.id)).toEqual(["overblast", "local-litert"]);
  });

  it("streams from the class it was asked for", async () => {
    const cloud = fake({ id: "overblast", classes: ["strong"], answer: "cloud" });
    const local = fake({ id: "local-litert", classes: ["small"], answer: "local" });
    const router = new ModelRouter({ providers: [cloud, local] });
    const chunks = await collect(router.stream({ messages: [] }, "small"));
    expect(chunks[0]).toEqual({ type: "text", delta: "local" });
  });

  it("behaves exactly as before with ONE provider, whatever class is asked", async () => {
    const only = fake({ id: "local-litert", classes: ["small"] });
    const router = new ModelRouter({ providers: [only] });
    expect((await router.pick("small")).id).toBe("local-litert");
    expect((await router.pick("strong")).id).toBe("local-litert");
    expect((await router.chat({ messages: [] })).message.content).toBe("local-litert");
  });
});

describe("an explicit preference list is trusted as written", () => {
  it("does not re-rank a named list against the catalogues", async () => {
    // `overblast` is a STRONG brain and the caller nonetheless named it first for small work — a
    // deliberate list stays deliberate, or naming one stops meaning anything.
    const cloud = fake({ id: "overblast", classes: ["strong"] });
    const local = fake({ id: "local-litert", classes: ["small"] });
    const router = new ModelRouter({
      providers: [cloud, local],
      preference: { small: ["overblast", "local-litert"], strong: ["overblast"] },
    });
    expect((await router.pick("small")).id).toBe("overblast");
  });

  it("does not read a catalogue at all when it was given a list", async () => {
    const cloud = fake({ id: "overblast", classes: ["strong"] });
    const router = new ModelRouter({ providers: [cloud], preference: { small: ["overblast"], strong: ["overblast"] } });
    await router.pick("small");
    expect(cloud.modelsCalls()).toBe(0);
  });
});
