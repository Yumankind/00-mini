/**
 * THE NAMED BRAINS — factories, not classes, because the difference between them is a base URL.
 *
 * Levels 2 and 3 of §6.1: the Overblast workspace's credits (`sk-obd` device token, base
 * `<worker>/ai/v1`) and the person's own keys. Each is one call to `OpenAICompatibleProvider` with
 * the right base and the right credential — except Anthropic, whose wire needs its own provider.
 *
 * NO CATALOG IS HARDCODED HERE. The house rule is that the platform ships mechanisms and the
 * vocabulary is configuration, so a catalog is a parameter: Overblast's models come from the mint
 * call's own `models` / `defaultModel` fields (cloud-agents contract §3b), OpenRouter's from its
 * live list, and a custom host's from whatever the person points it at. A default list baked in
 * here would be a list that is wrong the week after it is written.
 */

import { AnthropicProvider } from "./anthropic.js";
import type { AnthropicProviderOptions } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { FetchLike } from "./openai-compatible.js";
import type { ModelInfo, ModelProvider } from "./types.js";

export interface OverblastProviderOptions {
  /** The OpenAI-compatible base, INCLUDING `/v1` — `https://<worker>/ai/v1`. */
  baseUrl: string;
  /** The device token, `sk-obd-<keyId>.<secret>`, minted per browser and revocable per browser. */
  token?: string;
  catalog: ModelInfo[];
  defaultModel?: string;
  fetch?: FetchLike;
  id?: string;
}

/**
 * The Overblast credits brain.
 *
 * The bearer is a DEVICE token, never the container secret and never a platform key: one browser is
 * one revocable credential, exactly as one laptop is (contract §3b). A 402 from this base carries
 * `insufficient_credits` and the relative `topUp` paths, which `errors.ts` turns into the typed
 * refusal the router falls through on and the UI draws a button from.
 */
export function overblastProvider(options: OverblastProviderOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: options.id ?? "overblast",
    baseUrl: options.baseUrl,
    apiKey: options.token,
    catalog: options.catalog,
    // The mint call returns the list strongest-first and its default is always `models[0]`, so the
    // same rule is kept here rather than inventing a second one.
    defaultModel: options.defaultModel ?? options.catalog[0]?.id ?? "",
    fetch: options.fetch,
  });
}

export type ByokVendor = "openai" | "anthropic" | "openrouter" | "custom";

export interface ByokProviderOptions {
  vendor: ByokVendor;
  apiKey: string;
  /** Required for `custom`; overrides the vendor default for the rest (a proxy, a staging host). */
  baseUrl?: string;
  catalog?: ModelInfo[];
  defaultModel?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  id?: string;
  /** Anthropic only: the `max_tokens` every request carries when the caller names none. */
  maxTokens?: number;
}

/** The vendor bases, with their version segment, since `/chat/completions` is appended to them. */
export const BYOK_BASE_URLS: Record<Exclude<ByokVendor, "custom">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/**
 * The person's own key, in the person's own browser.
 *
 * OpenRouter gets `usage: { include: true }` in the body: without it the answer carries token counts
 * but no `cost`, and a session that cannot price itself cannot show a person what they are spending.
 * Its dollars become `Usage.costCents` in `openai-compatible.ts`, once, in one place.
 *
 * The key never leaves this browser and never reaches an embedded agent — §4.5's vault holds it and
 * §13 says the boundary out loud. This factory is handed a key; it stores nothing.
 */
export function byokProvider(options: ByokProviderOptions): ModelProvider {
  const catalog = options.catalog ?? [];
  const id = options.id ?? `byok:${options.vendor}`;
  if (options.vendor === "anthropic") {
    const anthropic: AnthropicProviderOptions = {
      id,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      headers: options.headers,
      fetch: options.fetch,
      catalog,
      defaultModel: options.defaultModel ?? catalog[0]?.id ?? "",
      maxTokens: options.maxTokens,
    };
    return new AnthropicProvider(anthropic);
  }
  const baseUrl = options.baseUrl ?? (options.vendor === "custom" ? "" : BYOK_BASE_URLS[options.vendor]);
  if (!baseUrl) throw new Error("A custom BYOK provider needs a baseUrl — the OpenAI-compatible base, including /v1.");
  return new OpenAICompatibleProvider({
    id,
    baseUrl,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: options.fetch,
    catalog,
    defaultModel: options.defaultModel ?? catalog[0]?.id ?? "",
    extraBody: options.vendor === "openrouter" ? { usage: { include: true } } : undefined,
  });
}
