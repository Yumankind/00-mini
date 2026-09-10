import { describe, expect, it } from "vitest";
import {
  canonicalRequest,
  bodyHashHex,
  DEVICE_MESSAGE,
  DEVICE_SIGN_PARAMS,
  generateDeviceKeypair,
  HEADER_APP,
  HEADER_DEVICE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MemoryDeviceKeyStore,
} from "../src/device-key.js";
import type { StoredDevice, WindowLike } from "../src/index.js";
import {
  DeviceRegistrationError,
  registerDevice,
  SPONSOR_FOOTER_LEAD,
  SPONSOREDTOKENS_API_BASE,
  SponsoredDeviceTransport,
  sponsoredFooterExtractor,
  sponsoredProvider,
} from "../src/sponsored.js";
import type { ModelInfo } from "../src/types.js";
import { collect, frame, jsonResponse, recordingFetch, sseResponse } from "./helpers.js";

const CATALOG: ModelInfo[] = [{ id: "sponsored/small", label: "Sponsored small", class: "small", local: false, supportsTools: true }];

async function storeWithDevice(appId = "app_7f3k"): Promise<{ store: MemoryDeviceKeyStore; device: StoredDevice }> {
  const store = new MemoryDeviceKeyStore();
  const pair = await generateDeviceKeypair();
  const device: StoredDevice = {
    appId,
    deviceId: "dev_9q2m",
    privateKey: pair.privateKey,
    publicKeyJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    createdAt: "2026-09-10T00:00:00.000Z",
  };
  await store.put(device);
  return { store, device };
}

describe("SponsoredDeviceTransport", () => {
  it("signs the request the way the worker verifies it, and sends no bearer", async () => {
    const { store, device } = await storeWithDevice();
    const { fetch, calls } = recordingFetch([jsonResponse({ ok: true })]);
    const transport = new SponsoredDeviceTransport({ appId: "app_7f3k", store, fetch, now: () => 1757340000_000 });

    const body = JSON.stringify({ model: "sponsored/small", messages: [] });
    await transport.fetch(`${SPONSOREDTOKENS_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-st-should-not-travel" },
      body,
    });

    const headers = calls[0]?.init?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get(HEADER_APP)).toBe("app_7f3k");
    expect(headers.get(HEADER_DEVICE)).toBe("dev_9q2m");
    expect(headers.get(HEADER_TIMESTAMP)).toBe("1757340000");

    const raw = headers.get(HEADER_SIGNATURE) ?? "";
    const bin = atob(raw);
    const signature = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    expect(signature).toHaveLength(64);
    const verifyKey = await crypto.subtle.importKey("jwk", device.publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const canonical = canonicalRequest("POST", "/api/v1/chat/completions", "1757340000", await bodyHashHex(body));
    await expect(
      crypto.subtle.verify(DEVICE_SIGN_PARAMS, verifyKey, signature as unknown as ArrayBuffer, new TextEncoder().encode(canonical) as unknown as ArrayBuffer),
    ).resolves.toBe(true);
  });

  it("refuses with a typed credential error when this browser holds no device", async () => {
    const transport = new SponsoredDeviceTransport({ appId: "app_7f3k", store: new MemoryDeviceKeyStore() });
    await expect(transport.fetch("https://sponsoredtokens.com/api/v1/models")).rejects.toMatchObject({
      code: "credential",
      status: 401,
      vendorCode: "no_device",
    });
  });

  it("refuses a body it cannot hash by name rather than signing the empty string", async () => {
    const { store } = await storeWithDevice();
    const transport = new SponsoredDeviceTransport({ appId: "app_7f3k", store, fetch: async () => jsonResponse({}) });
    const stream = new ReadableStream();
    await expect(
      transport.fetch("https://sponsoredtokens.com/api/v1/chat/completions", { method: "POST", body: stream as unknown as BodyInit }),
    ).rejects.toMatchObject({ vendorCode: "unsupported_body" });
  });

  it("reports readiness from the store", async () => {
    const empty = new SponsoredDeviceTransport({ appId: "app_7f3k", store: new MemoryDeviceKeyStore() });
    await expect(empty.readiness()).resolves.toMatchObject({ ready: false, reason: "credential" });
    const { store } = await storeWithDevice();
    await expect(new SponsoredDeviceTransport({ appId: "app_7f3k", store }).readiness()).resolves.toEqual({ ready: true });
  });

  it("keeps working when passed around as a bare function", async () => {
    const { store } = await storeWithDevice();
    const { fetch, calls } = recordingFetch([jsonResponse({})]);
    const transport = new SponsoredDeviceTransport({ appId: "app_7f3k", store, fetch });
    const bare = transport.fetch;
    await bare("https://sponsoredtokens.com/api/v1/models");
    expect(calls).toHaveLength(1);
  });
});

// ── The popup handshake ─────────────────────────────────────────────────────────────────────────

/** A `window` and a popup that talk to each other, so the flow runs with no DOM at all. */
function fakeWindow(script: (post: (event: { origin: string; data: unknown }) => void, sent: unknown[]) => void): WindowLike & { opened: string[] } {
  const handlers: ((event: MessageEvent) => void)[] = [];
  const sent: unknown[] = [];
  const opened: string[] = [];
  const post = (event: { origin: string; data: unknown }) => {
    for (const handler of handlers.slice()) handler(event as unknown as MessageEvent);
  };
  return {
    opened,
    open(url: string) {
      opened.push(url);
      queueMicrotask(() => script(post, sent));
      return {
        postMessage(data: unknown) {
          sent.push(data);
        },
      };
    },
    addEventListener(_type: "message", handler: (event: MessageEvent) => void) {
      handlers.push(handler);
    },
    removeEventListener(_type: "message", handler: (event: MessageEvent) => void) {
      const at = handlers.indexOf(handler);
      if (at !== -1) handlers.splice(at, 1);
    },
    setTimeout(handler: () => void, ms: number) {
      return Number(setTimeout(handler, ms));
    },
    clearTimeout(id: number) {
      clearTimeout(id);
    },
  };
}

const ORIGIN = "https://sponsoredtokens.com";

describe("registerDevice", () => {
  it("does the ready → key → registered handshake and files the device", async () => {
    const store = new MemoryDeviceKeyStore();
    const win = fakeWindow((post, sent) => {
      post({ origin: ORIGIN, data: { type: DEVICE_MESSAGE.ready } });
      // The opener answered with a PUBLIC jwk and nothing else.
      const key = sent[0] as { type: string; appId: string; publicKeyJwk: JsonWebKey };
      expect(key.type).toBe(DEVICE_MESSAGE.key);
      expect(key.appId).toBe("app_7f3k");
      expect(key.publicKeyJwk).toMatchObject({ kty: "EC", crv: "P-256" });
      expect(key.publicKeyJwk.d).toBeUndefined();
      post({ origin: ORIGIN, data: { type: DEVICE_MESSAGE.registered, deviceId: "dev_new" } });
    });

    const device = await registerDevice({ appId: "app_7f3k", store, window: win });
    expect(device.deviceId).toBe("dev_new");
    expect(device.privateKey.extractable).toBe(false);
    expect(win.opened[0]).toBe(`${ORIGIN}/apps/connect/device?app_id=app_7f3k`);
    await expect(store.get("app_7f3k")).resolves.toBe(device);
  });

  it("ignores every message that is not from the handshake origin", async () => {
    const store = new MemoryDeviceKeyStore();
    const win = fakeWindow((post, sent) => {
      // An unrelated page shouting into the opener. The key must not be posted to it, and its
      // claim of a device id must not be believed.
      post({ origin: "https://evil.example", data: { type: DEVICE_MESSAGE.ready } });
      post({ origin: "https://evil.example", data: { type: DEVICE_MESSAGE.registered, deviceId: "dev_evil" } });
      expect(sent).toHaveLength(0);
      post({ origin: ORIGIN, data: { type: DEVICE_MESSAGE.ready } });
      post({ origin: ORIGIN, data: { type: DEVICE_MESSAGE.registered, deviceId: "dev_real" } });
    });
    const device = await registerDevice({ appId: "app_7f3k", store, window: win });
    expect(device.deviceId).toBe("dev_real");
  });

  it("is idempotent: a browser that already holds a device opens no popup", async () => {
    const { store } = await storeWithDevice();
    const win = fakeWindow(() => {
      throw new Error("the popup must not open");
    });
    const device = await registerDevice({ appId: "app_7f3k", store, window: win });
    expect(device.deviceId).toBe("dev_9q2m");
    expect(win.opened).toHaveLength(0);
  });

  it("names a blocked pop-up rather than letting it look like a network failure", async () => {
    const win = { ...fakeWindow(() => {}), open: () => null } as WindowLike;
    await expect(registerDevice({ appId: "a", store: new MemoryDeviceKeyStore(), window: win })).rejects.toMatchObject({ code: "popup_blocked" });
  });

  it("passes the worker's own refusal code through", async () => {
    const win = fakeWindow((post) => {
      post({ origin: ORIGIN, data: { type: DEVICE_MESSAGE.error, error: "device_limited", message: "Too many devices from this address today." } });
    });
    await expect(registerDevice({ appId: "a", store: new MemoryDeviceKeyStore(), window: win })).rejects.toMatchObject({
      name: "DeviceRegistrationError",
      code: "device_limited",
    });
  });

  it("gives up after the timeout", async () => {
    const win = fakeWindow(() => {
      /* the popup never answers */
    });
    await expect(registerDevice({ appId: "a", store: new MemoryDeviceKeyStore(), window: win, timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("refuses outside a browser", async () => {
    await expect(registerDevice({ appId: "a", store: new MemoryDeviceKeyStore() })).rejects.toBeInstanceOf(DeviceRegistrationError);
  });

  it("appends its app_id to a popup URL that already has a query", async () => {
    const win = fakeWindow((post) => {
      post({ origin: "https://staging.example", data: { type: DEVICE_MESSAGE.ready } });
      post({ origin: "https://staging.example", data: { type: DEVICE_MESSAGE.registered, deviceId: "dev_s" } });
    });
    await registerDevice({ appId: "a b", store: new MemoryDeviceKeyStore(), window: win, popupUrl: "https://staging.example/connect?x=1" });
    expect(win.opened[0]).toBe("https://staging.example/connect?x=1&app_id=a%20b");
  });
});

// ── The provider ────────────────────────────────────────────────────────────────────────────────

describe("sponsoredFooterExtractor", () => {
  it("lifts the pipeline's own credit line and nothing else", () => {
    expect(sponsoredFooterExtractor(null, { content: `the answer\n\n${SPONSOR_FOOTER_LEAD}Acme · $0.42` })).toBe(
      `${SPONSOR_FOOTER_LEAD}Acme · $0.42`,
    );
    expect(sponsoredFooterExtractor(null, { content: "the answer" })).toBeUndefined();
  });

  it("pins the lead byte for byte against worker/src/sponsored/config.ts::FOOTER_LEAD", () => {
    expect(SPONSOR_FOOTER_LEAD).toBe("— sponsored by ");
  });
});

describe("sponsoredProvider", () => {
  it("is not ready until a device is registered, then answers with the footer lifted out", async () => {
    const store = new MemoryDeviceKeyStore();
    const answer = jsonResponse({
      choices: [{ message: { role: "assistant", content: `Here it is.\n\n${SPONSOR_FOOTER_LEAD}Acme · $0.42` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 6, cost: 0.005 },
    });
    const { fetch, calls } = recordingFetch([answer]);
    const provider = sponsoredProvider({ appId: "app_7f3k", deviceKeyStore: store, catalog: CATALOG, fetch });

    await expect(provider.readiness()).resolves.toMatchObject({ ready: false, reason: "credential" });

    const pair = await generateDeviceKeypair();
    await store.put({
      appId: "app_7f3k",
      deviceId: "dev_9q2m",
      privateKey: pair.privateKey,
      publicKeyJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
      createdAt: "now",
    });
    await expect(provider.readiness()).resolves.toEqual({ ready: true });

    const res = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.message.content).toBe("Here it is.");
    expect(res.footer).toBe(`${SPONSOR_FOOTER_LEAD}Acme · $0.42`);
    expect(res.usage?.costCents).toBe(0.5);
    expect(calls[0]?.url).toBe("https://sponsoredtokens.com/api/v1/chat/completions");
    expect((calls[0]?.init?.headers as Headers).get(HEADER_APP)).toBe("app_7f3k");
  });

  it("keeps the footer in the deltas but out of the message it files", async () => {
    const { store } = await storeWithDevice();
    const { fetch } = recordingFetch([
      sseResponse([
        frame({ choices: [{ delta: { content: "Here it is." } }] }),
        frame({ choices: [{ delta: { content: `\n\n${SPONSOR_FOOTER_LEAD}Acme · $0.42` } }] }),
        frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const provider = sponsoredProvider({ appId: "app_7f3k", deviceKeyStore: store, catalog: CATALOG, fetch });
    const chunks = await collect(provider.stream({ messages: [{ role: "user", content: "hi" }] }));
    const shown = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");
    expect(shown).toContain(SPONSOR_FOOTER_LEAD);
    const done = chunks.at(-1) as { response: { message: { content: string }; footer?: string } };
    expect(done.response.message.content).toBe("Here it is.");
    expect(done.response.footer).toBe(`${SPONSOR_FOOTER_LEAD}Acme · $0.42`);
  });
});
