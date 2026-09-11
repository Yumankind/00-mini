/**
 * THE THREE SEAMS, WALKED WITH A FAKE LOADER (§5.2.3, §5.2.4, §9.1).
 *
 * `bundle-budget.test.ts` pins that the brain, the wizard and the registry client are NOT in `e.js`.
 * This one pins the other half of that bargain: that they are still reachable, that nothing fetches
 * one before a person has asked, and that a module which will not load is a sentence rather than an
 * exception on somebody else's page.
 *
 * Every case swaps `modules.ts`'s importer, which is the single door all three go through.
 */

import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_MODULE, REGISTRY_MODULE, SETUP_MODULE, loadModule, resetModuleCache, useModuleImporter } from "../../embed/src/modules.js";
import { hasModelProvider, loadBrainModule, loadLocalProvider, useModelProvider } from "../../embed/src/brain.js";
import { SETUP_FAILED, SETUP_LOADING, loadSetupModule } from "../../embed/src/panel/setup-seam.js";
import { createRegistryGate } from "../../embed/src/registry/gate.js";
import { MemoryStore } from "../../embed/src/index/store.js";
import { bundleKey, claimUrlFor } from "../../embed/src/registry/local.js";
import { EMPTY_STATE } from "../../embed/src/registry/state.js";
import { scratchFs } from "../../embed/src/tools/scratch-fs.js";
import type { ModelProvider } from "@00/agent-models";

const HOST = "https://infinite.example";

/** A loader that records what was asked for, and answers with whatever the case wants. */
function fakeImporter(answers: Record<string, unknown>): { asked: string[] } {
  const asked: string[] = [];
  useModuleImporter(async (url) => {
    asked.push(new URL(url).pathname);
    const answer = answers[new URL(url).pathname];
    if (!answer) throw new Error("404");
    return answer;
  });
  return { asked };
}

afterEach(() => {
  useModuleImporter(null);
  resetModuleCache();
  useModelProvider(null);
});

describe("the one door every lazy module goes through", () => {
  it("resolves against the PRODUCT host, not the site the embed is sitting on", async () => {
    const { asked } = fakeImporter({ "/m/setup.js": { renderSetup: () => ({}) } });
    await loadModule(HOST, SETUP_MODULE);
    expect(asked).toEqual(["/m/setup.js"]);
  });

  it("fetches one module once, however many times it is asked for", async () => {
    const { asked } = fakeImporter({ "/m/setup.js": { renderSetup: () => ({}) } });
    await Promise.all([loadModule(HOST, SETUP_MODULE), loadModule(HOST, SETUP_MODULE)]);
    await loadModule(HOST, SETUP_MODULE);
    expect(asked).toEqual(["/m/setup.js"]);
  });

  it("answers null with a sentence when it cannot be had, and lets the next press try again", async () => {
    const said: string[] = [];
    const { asked } = fakeImporter({});
    expect(await loadModule(HOST, SETUP_MODULE, (m) => said.push(m))).toBeNull();
    expect(said.join(" ")).toContain("did not load");
    // A failure is NOT remembered: the owner whose network came back gets a second attempt.
    expect(await loadModule(HOST, SETUP_MODULE)).toBeNull();
    expect(asked).toEqual(["/m/setup.js", "/m/setup.js"]);
  });
});

describe("the gear", () => {
  it("says what it is doing, and says what happened when nothing does", async () => {
    // The two lines the panel puts in the transcript. Pinned as strings because the panel itself
    // needs a document and this suite is node (vitest.config.ts says why).
    expect(SETUP_LOADING).toMatch(/setup/i);
    expect(SETUP_FAILED).toContain("connection");

    const said: string[] = [];
    fakeImporter({});
    expect(await loadSetupModule(HOST, (m) => said.push(m))).toBeNull();
    expect(said).toEqual([SETUP_FAILED]);
  });

  it("hands back the wizard when the module is there", async () => {
    const handle = { open: () => {}, close: () => {} };
    fakeImporter({ "/m/setup.js": { renderSetup: () => handle } });
    const mod = await loadSetupModule(HOST);
    expect(mod?.renderSetup(null as never, null as never)).toBe(handle);
  });
});

describe("the brain", () => {
  const provider = { id: "fake" } as unknown as ModelProvider;

  it("is not fetched until somebody asks for one", async () => {
    const { asked } = fakeImporter({ "/m/brain.js": { createBrain: () => ({}), pickLocalProvider: async () => null } });
    expect(asked).toEqual([]);
    await loadBrainModule(HOST);
    expect(asked).toEqual([BRAIN_MODULE]);
  });

  it("carries the loop AND the model, so the press costs one request", async () => {
    const { asked } = fakeImporter({
      "/m/brain.js": {
        createBrain: () => ({ tag: "brain" }),
        pickLocalProvider: async () => ({ provider, providerId: "local", offer: { model: { name: "Fake" } } }),
      },
    });
    const picked = await loadLocalProvider(HOST);
    const mod = await loadBrainModule(HOST);
    expect(picked?.provider).toBe(provider);
    expect(mod?.createBrain(null as never)).toEqual({ tag: "brain" });
    expect(asked).toEqual([BRAIN_MODULE]);
  });

  it("says so, and stays a site search, when the browser cannot run one", async () => {
    const said: string[] = [];
    fakeImporter({ "/m/brain.js": { createBrain: () => ({}), pickLocalProvider: async () => null } });
    expect(await loadLocalProvider(HOST, (l) => said.push(l))).toBeNull();
    expect(said.join(" ")).toContain("cannot run a local model");
  });

  it("takes an injected provider without fetching anything", async () => {
    const { asked } = fakeImporter({});
    useModelProvider(() => provider);
    expect(hasModelProvider()).toBe(true);
    expect((await loadLocalProvider(HOST))?.provider).toBe(provider);
    expect(asked).toEqual([]);
  });
});

describe("the registry gate", () => {
  const gateFor = (store = new MemoryStore(), answers: Record<string, unknown> = {}) => {
    const asked = fakeImporter(answers).asked;
    const gate = createRegistryGate({
      origin: "https://shop.example",
      ref: "ia_test",
      store,
      fetchImpl: (() => {
        throw new Error("the gate must not fetch");
      }) as unknown as typeof fetch,
      productHost: HOST,
      linkPub: () => null,
      base: "https://registry.example/infinite",
    });
    return { gate, asked, store };
  };

  it("reads this browser's own record with no module and no call", async () => {
    const store = new MemoryStore();
    await store.set("registry:https://shop.example:ia_test", { appId: "iaa_x", status: "claimed", hasPublicBundle: true });
    const { gate, asked } = gateFor(store);
    const known = await gate.load();
    expect(known.appId).toBe("iaa_x");
    expect(known.status).toBe("claimed");
    expect(gate.state().hasPublicBundle).toBe(true);
    expect(asked).toEqual([]);
    expect(gate.loaded()).toBe(false);
  });

  it("reads carrier 1's cached bundle with no module and no call", async () => {
    const store = new MemoryStore();
    await store.set(bundleKey("https://shop.example", "ia_test"), {
      etag: "W/\"1\"",
      siteFile: { intro: { name: "Shop" } },
      files: { "persona.md": "hello" },
      at: 5,
    });
    const { gate, asked } = gateFor(store);
    const held = await gate.cachedBundle();
    expect(held?.files["persona.md"]).toBe("hello");
    expect(asked).toEqual([]);
  });

  it("builds the claim link out of what this browser already knows", async () => {
    const state = { ...EMPTY_STATE, appId: "iaa_x", claimNonce: "n1", claimOrigin: "https://shop.example" };
    const url = claimUrlFor(state, "https://www.shop.example", HOST);
    expect(url).toContain("claim=iaa_x");
    expect(url).toContain("nonce=n1");
    // The REGISTRATION origin, not this page's — the claim is signed over the one the worker holds.
    expect(url).toContain(encodeURIComponent("https://shop.example"));
    expect(claimUrlFor({ ...EMPTY_STATE }, "https://shop.example", HOST)).toBeNull();
  });

  it("fetches the client on the first call that needs the network, and once", async () => {
    const seen: unknown[] = [];
    const { gate, asked } = gateFor(new MemoryStore(), {
      "/m/registry.js": {
        createRegistryClient: (opts: unknown) => {
          seen.push(opts);
          return { postInbox: async () => ({ ok: true, mid: "m1" }), pollMessages: async () => ({ ok: true, messages: [] }) };
        },
      },
    });
    expect(await gate.postInbox({ kind: "message", text: "hi" })).toEqual({ ok: true, mid: "m1" });
    expect(await gate.pollMessages()).toEqual({ ok: true, messages: [] });
    expect(asked).toEqual([REGISTRY_MODULE]);
    expect(gate.loaded()).toBe(true);
    // The state store the gate has already read is handed over, so the record is not read twice.
    expect((seen[0] as { state?: unknown }).state).toBeDefined();
  });

  it("refuses in the registry's own shape when the module will not load", async () => {
    const { gate } = gateFor(new MemoryStore(), {});
    const refusal = await gate.postInbox({ kind: "message", text: "hi" });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.code).toBe("network");
    expect(refusal.ok === false && refusal.message).toContain("could not be reached");
  });
});

describe("the panel's scratch filesystem", () => {
  it("is a real AgentFs, without the package", async () => {
    const fs = scratchFs(() => 7);
    expect(await fs.stat("notes.md")).toBeNull();
    await fs.writeFile("notes/a.md", "one");
    await fs.writeFile("notes/b.md", "two");
    expect(await fs.readText("notes/a.md")).toBe("one");
    expect((await fs.stat("notes/a.md"))?.mtime).toBe(7);
    expect((await fs.stat("notes"))?.kind).toBe("dir");
    expect((await fs.readdir("notes")).map((e) => e.name)).toEqual(["a.md", "b.md"]);
    await fs.rename("notes/a.md", "notes/c.md");
    expect(await fs.readText("notes/c.md")).toBe("one");
    const walked: string[] = [];
    for await (const entry of fs.walk("notes")) walked.push(entry.path);
    expect(walked.sort()).toEqual(["b.md", "c.md"]);
    await fs.remove("notes");
    expect(await fs.stat("notes/b.md")).toBeNull();
  });

  it("refuses a path that climbs out of the thread folder", async () => {
    const fs = scratchFs();
    await expect(fs.readFile("../secrets")).rejects.toThrow(/invalid path/);
    await expect(fs.writeFile("/etc/passwd", "x")).rejects.toThrow(/invalid path/);
  });
});

describe("the module entries are the contract the seams expect", () => {
  it("each exports what its seam calls", async () => {
    const brain = await import("../../embed/src/entries/brain.js");
    expect(typeof brain.createBrain).toBe("function");
    expect(typeof brain.pickLocalProvider).toBe("function");

    const setup = await import("../../embed/src/entries/setup.js");
    expect(typeof setup.renderSetup).toBe("function");

    const registry = await import("../../embed/src/entries/registry.js");
    expect(typeof registry.createRegistryClient).toBe("function");
  });
});
