/**
 * The local-AI offer: the twin guard, the two branches, the provider order, and the one-host rule.
 *
 * WHY these four and not a mock of MediaPipe: nothing here can load a model — node has no WebGPU
 * and no Cache Storage — so what is testable is the PROMISE the panel makes before the download
 * (a size, a name, a licence, an order) and the rule that keeps the mirror in one place. Every one
 * of those is a thing that silently rots: a catalogue row changes, a fallback stops being reached,
 * a base URL gets copied into a second file, and the first symptom is a 404 on somebody's website.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LITERT_CATALOG, LITERT_VERSION, WEBLLM_CATALOG, localProviders, type LocalProvider } from "@00/agent-models";
import {
  LITERT_EMBED_MODEL_ID,
  LITERT_MODEL_BASE_URL,
  LITERT_OFFER,
  LITERT_WASM_BASE_URL,
  LOCAL_AI_OFFERS,
  MEDIAPIPE_VERSION,
  NO_WEBGPU_NOTE,
  WEBLLM_EMBED_MODEL_ID,
  WEBLLM_OFFER,
  hasWebGpu,
  localAiOffer,
} from "../../embed/src/local-ai.js";
import { pickLocalProvider, progressLine } from "../../embed/src/model-entry.js";

const here = dirname(fileURLToPath(import.meta.url));
const embedSrc = join(here, "../../embed/src");

describe("the offer the visitor is shown (§5.2.3)", () => {
  it("promises Gemma 3 270m from the mirror when the browser has WebGPU", () => {
    const offer = localAiOffer({ gpu: {} });
    expect(offer.provider).toBe("litert");
    expect(offer.sizeMb).toBe(250);
    expect(offer.model.name).toBe("Gemma 3 270m");
    expect(offer.model.licenseName).toBe("Gemma Terms of Use");
    // The Prohibited Use Policy is what makes the Gemma terms showable rather than merely linked.
    expect(offer.model.useRestrictionsUrl).toBe("https://ai.google.dev/gemma/prohibited_use_policy");
    expect(offer.note).toBeUndefined();
  });

  it("shows the fallback's facts, and says why, when the browser has no WebGPU", () => {
    const offer = localAiOffer({});
    expect(offer.provider).toBe("webllm");
    expect(offer.sizeMb).toBe(879);
    expect(offer.model.name).toBe("Llama 3.2 1B");
    expect(offer.model.useRestrictionsUrl).toBeUndefined();
    expect(offer.note).toBe(NO_WEBGPU_NOTE);
    expect(offer.note).toContain("WebGPU");
  });

  it("probes the real navigator when nobody hands it one", () => {
    // Node 24 has a `navigator`; it has no `gpu`, which is the honest answer for this environment.
    expect(hasWebGpu()).toBe(false);
    expect(localAiOffer().provider).toBe("webllm");
    expect(hasWebGpu({ gpu: {} })).toBe(true);
  });
});

describe("the twin guard: the offer against the real catalogues", () => {
  it("names a LiteRT row that exists, with that row's licence", () => {
    const row = LITERT_CATALOG.find((m) => m.id === LITERT_EMBED_MODEL_ID);
    expect(row, `${LITERT_EMBED_MODEL_ID} is gone from LITERT_CATALOG`).toBeDefined();
    expect(LITERT_OFFER.model.licenseName).toBe(row!.license.name);
    expect(LITERT_OFFER.model.licenseUrl).toBe(row!.license.url);
    expect(LITERT_OFFER.model.useRestrictionsUrl).toBe(row!.license.useRestrictionsUrl);
    // The asset the mirror must hold, under the base URL named in local-ai.ts.
    expect(row!.assetFile).toBe("gemma3-270m-it-q4_0-web.task");
  });

  it("names a WebLLM row that exists, and the number that row publishes", () => {
    const row = WEBLLM_CATALOG.find((m) => m.id === WEBLLM_EMBED_MODEL_ID);
    expect(row, `${WEBLLM_EMBED_MODEL_ID} is gone from WEBLLM_CATALOG`).toBeDefined();
    expect(WEBLLM_OFFER.sizeMb).toBe(row!.vramMb);
    expect(WEBLLM_OFFER.model.name).toBe(row!.label);
  });

  it("pins 250 MB to the mirror's own byte count", () => {
    // `LITERT_CATALOG` carries `vramMb`, not bytes — MediaPipe publishes no download size — so the
    // number on the button is checked against the mirror catalogue snapshot that the publish script
    // sha256-verified (docs/HANDOFF-infinite-agent.md §12.7). If that fixture ever moves, this
    // assertion is the one to re-point; it is not a licence to invent a number.
    const fixture = join(here, "../../../../packages/agent-models/test/fixtures/litert-mirror-catalog.json");
    const catalog = JSON.parse(readFileSync(fixture, "utf8")) as {
      base: string;
      assets: { file: string; bytes: number }[];
    };
    expect(catalog.base).toBe(LITERT_MODEL_BASE_URL);
    const asset = catalog.assets.find((a) => a.file === "gemma3-270m-it-q4_0-web.task");
    expect(asset).toBeDefined();
    expect(Math.ceil(asset!.bytes / 1e6)).toBe(LITERT_OFFER.sizeMb);
  });
});

describe("the provider order and the fallthrough (§6.1's ruling)", () => {
  const fake = (id: string, readiness: unknown, load?: () => Promise<unknown>): LocalProvider =>
    ({
      id,
      async models() {
        return [];
      },
      async chat() {
        throw new Error("not used");
      },
      async *stream() {
        throw new Error("not used");
      },
      async readiness() {
        return readiness as never;
      },
      ...(load ? { load } : {}),
    }) as unknown as LocalProvider;

  it("puts LiteRT first and web-llm behind it", () => {
    const litert = fake("local-litert", { ready: true });
    const webllm = fake("local", { ready: true });
    expect(localProviders({ litert, webllm }).map((p) => p.id)).toEqual(["local-litert", "local"]);
    // The pair as the embed builds it, in the same order.
    expect(LOCAL_AI_OFFERS.map((o) => o.provider)).toEqual(["litert", "webllm"]);
  });

  it("takes LiteRT when it comes up", async () => {
    const picked = await pickLocalProvider({
      providers: [
        { provider: fake("local-litert", { ready: false, reason: "download" }, async () => undefined), offer: LITERT_OFFER },
        { provider: fake("local", { ready: true }), offer: WEBLLM_OFFER },
      ],
    });
    expect(picked?.providerId).toBe("local-litert");
    expect(picked?.offer.model.name).toBe("Gemma 3 270m");
  });

  it("walks on to web-llm when LiteRT says unsupported", async () => {
    const picked = await pickLocalProvider({
      providers: [
        { provider: fake("local-litert", { ready: false, reason: "unsupported" }), offer: LITERT_OFFER },
        { provider: fake("local", { ready: true }), offer: WEBLLM_OFFER },
      ],
    });
    expect(picked?.providerId).toBe("local");
    expect(picked?.offer.model.name).toBe("Llama 3.2 1B");
  });

  it("walks on when LiteRT is ready but will not LOAD — the wasm fileset, the GPU delegate", async () => {
    // Both providers gate `readiness()` on `navigator.gpu`, so on the machines this fallback exists
    // for readiness answers the same for both. The difference shows up at load, and the walk has to
    // reach it or the fallback is decoration.
    const picked = await pickLocalProvider({
      providers: [
        {
          provider: fake("local-litert", { ready: false, reason: "download" }, async () => {
            throw new Error("the fileset could not be created");
          }),
          offer: LITERT_OFFER,
        },
        { provider: fake("local", { ready: true }, async () => undefined), offer: WEBLLM_OFFER },
      ],
    });
    expect(picked?.providerId).toBe("local");
  });

  it("answers null, with a line for the button, when neither can run", async () => {
    const lines: string[] = [];
    const picked = await pickLocalProvider({
      onProgress: (l) => lines.push(l),
      providers: [
        { provider: fake("local-litert", { ready: false, reason: "unsupported" }), offer: LITERT_OFFER },
        {
          provider: fake("local", { ready: false, reason: "download" }, async () => {
            throw new Error("no adapter");
          }),
          offer: WEBLLM_OFFER,
        },
      ],
    });
    expect(picked).toBeNull();
    expect(lines.join(" ")).toContain("no adapter");
  });

  it("reads both progress shapes, and the one that is still arriving upstream", () => {
    expect(progressLine({ text: "Downloading gemma3-270m-it-q4_0-web…" })).toContain("Downloading");
    expect(progressLine({ progress: 0.4, timeElapsed: 3 })).toBe("40%");
    expect(progressLine({ loadedBytes: 12_500_000 })).toBe("13 MB");
    // A readiness that grows a `progress` field, or anything else unexpected, must not throw.
    expect(progressLine({ ready: false, reason: "download", progress: undefined })).toBe("Loading…");
    expect(progressLine(undefined)).toBe("Loading…");
  });
});

describe("one host, one place (§12.7)", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(embedSrc);

  /** Comments first: a host named in prose is documentation, not a fetch. */
  const code = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const name = relative(embedSrc, file);
    it(`names no network host in ${name}`, () => {
      const hosts = [...code(readFileSync(file, "utf8")).matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!);
      const unique = [...new Set(hosts)];
      if (name === "local-ai.ts") {
        // The one module allowed to know where things live: the mirror, and the two licences it
        // must point a person at before they download the weights.
        expect(unique.filter((h) => !["dl.0-0.chat", "ai.google.dev", "www.llama.com"].includes(h))).toEqual([]);
        return;
      }
      // Everywhere else: only the two literals that never reach the network — the base a relative
      // URL is parsed against, and a placeholder in an input box.
      expect(unique.filter((h) => !["x.invalid", "example.com"].includes(h))).toEqual([]);
      expect(unique).not.toContain("dl.0-0.chat");
    });
  }

  it("keeps the mirror's two base URLs on the one host, and pins the wasm version", () => {
    expect(new URL(LITERT_MODEL_BASE_URL).host).toBe("dl.0-0.chat");
    expect(new URL(LITERT_WASM_BASE_URL).host).toBe("dl.0-0.chat");
    // Cross-origin on purpose: an embed has no origin of its own on the page it runs on.
    expect(LITERT_WASM_BASE_URL).toBe(`https://dl.0-0.chat/mediapipe/genai/${MEDIAPIPE_VERSION}/wasm`);
    // The folder on the mirror is a RELEASE's folder: the version the provider was written against
    // is the version whose wasm it must be handed, or the fileset loads a loader for another build.
    expect(MEDIAPIPE_VERSION).toBe(LITERT_VERSION);
  });
});
