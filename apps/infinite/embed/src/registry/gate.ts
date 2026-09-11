/**
 * THE REGISTRY, AS THE LOADER HOLDS IT — a door, not a client (§9.1).
 *
 * `client.ts` already promised that nothing reaches the registry until a person reaches for it.
 * This file makes the same promise about the BYTES: the client, the ed25519 device key and the
 * bundle reader are `m/registry.js`, fetched on the first call that genuinely needs the network,
 * and a site whose owner never registered never fetches them.
 *
 * WHAT THE GATE ANSWERS BY ITSELF, with no module and no call:
 *   · `configured()` — a build-time fact (`api-base.ts`), false when this build points nowhere;
 *   · `state()` / `load()` — this browser's own record, an IndexedDB read (`state.ts`);
 *   · `cachedBundle()` — carrier 1 of §5.1, an IndexedDB read (`local.ts`);
 *   · `claimUrl()` — three strings and a `URL` (`local.ts`).
 *
 * EVERYTHING ELSE FETCHES THE MODULE FIRST, and the state store it has already read is handed to
 * the client rather than re-read, so a browser that registers reads its record once.
 *
 * A MODULE THAT WILL NOT LOAD IS A REFUSAL, NOT AN EXCEPTION. This runs on somebody else's page:
 * `network` is the code, the sentence names what happened, and the panel says it once. It is the
 * same shape the client answers with when the registry itself is unreachable, which is the same
 * situation from the visitor's side.
 */

import { infiniteApiBase, registryConfigured } from "./api-base.js";
import { createRegistryState, type RegistryState, type RegistryStateStore } from "./state.js";
import { claimUrlFor, readCachedBundle, type CachedBundle } from "./local.js";
import { REGISTRY_MODULE, loadModule } from "../modules.js";
import type { Store } from "../index/store.js";
import type {
  AppCardResult,
  BundleResult,
  ClaimNonceResult,
  ClientOptions,
  DeviceResult,
  InboxInput,
  InboxResult,
  MessagesResult,
  RegisterResult,
  RegistryClient,
  Refusal,
} from "./client.js";

/** The shape `m/registry.js` exposes. */
export interface RegistryModule {
  createRegistryClient(opts: ClientOptions): RegistryClient;
}

export interface GateOptions {
  origin: string;
  ref: string;
  store: Store;
  fetchImpl: typeof fetch;
  /** The product host the loader's own `<script src>` came from — where `m/registry.js` lives. */
  productHost: string;
  linkPub: () => string | null;
  base?: string;
}

/**
 * Everything the loader and the panel ask of the registry. The read-only half is the client's own
 * interface; the rest is the same names with the same answers, one module fetch later.
 */
export interface RegistryGate {
  configured(): boolean;
  state(): RegistryState;
  load(): Promise<RegistryState>;
  cachedBundle(): Promise<CachedBundle | null>;
  claimUrl(productOrigin: string): string | null;
  register(): Promise<RegisterResult>;
  requestClaimNonce(): Promise<ClaimNonceResult>;
  getApp(appId: string): Promise<AppCardResult>;
  registerDevice(): Promise<DeviceResult>;
  postInbox(input: InboxInput): Promise<InboxResult>;
  pollMessages(since?: string | null): Promise<MessagesResult>;
  getPublicBundle(): Promise<BundleResult>;
  /** For a test, and for nothing else: has the module been fetched yet? */
  loaded(): boolean;
}

const unreachable = (detail: string): Refusal => ({
  ok: false,
  code: "network",
  message: `The registry could not be reached (${detail}).`,
});

export function createRegistryGate(opts: GateOptions): RegistryGate {
  const state: RegistryStateStore = createRegistryState({ store: opts.store, origin: opts.origin, ref: opts.ref });
  const base = (opts.base ?? infiniteApiBase()).replace(/\/+$/, "");
  let client: RegistryClient | null = null;
  let failure = "";

  /**
   * The module, then the client, then the call. Built ONCE and kept, with the state store the gate
   * has already read — `client.ts` takes it rather than making a second one, so `state()` in this
   * file and `state()` inside the client are the same object.
   */
  const reach = async (): Promise<RegistryClient | null> => {
    if (client) return client;
    const mod = await loadModule<RegistryModule>(opts.productHost, REGISTRY_MODULE, (message) => {
      failure = message;
    });
    if (!mod) return null;
    client = mod.createRegistryClient({
      origin: opts.origin,
      ref: opts.ref,
      store: opts.store,
      fetchImpl: opts.fetchImpl,
      linkPub: opts.linkPub,
      state,
      ...(opts.base ? { base: opts.base } : {}),
    });
    return client;
  };

  /** One call, or the refusal that says the code for it never arrived. */
  const call = async <T>(fn: (c: RegistryClient) => Promise<T>): Promise<T | Refusal> => {
    const reached = await reach();
    if (!reached) return unreachable(failure || "the registry module did not load");
    return fn(reached);
  };

  return {
    configured: () => (opts.base ? !opts.base.includes(".invalid") : registryConfigured()) && !base.includes(".invalid"),
    state: () => state.current(),
    load: () => state.read(),
    cachedBundle: () => readCachedBundle(opts.store, opts.origin, opts.ref),
    claimUrl: (productOrigin) => claimUrlFor(state.current(), opts.origin, productOrigin),
    loaded: () => client != null,
    register: () => call((c) => c.register()) as Promise<RegisterResult>,
    requestClaimNonce: () => call((c) => c.requestClaimNonce()) as Promise<ClaimNonceResult>,
    getApp: (appId) => call((c) => c.getApp(appId)) as Promise<AppCardResult>,
    registerDevice: () => call((c) => c.registerDevice()) as Promise<DeviceResult>,
    postInbox: (input) => call((c) => c.postInbox(input)) as Promise<InboxResult>,
    pollMessages: (since) => call((c) => c.pollMessages(since)) as Promise<MessagesResult>,
    getPublicBundle: () => call((c) => c.getPublicBundle()) as Promise<BundleResult>,
  };
}
