/**
 * The public surface, asserted as a list.
 *
 * Every other package in the runtime imports this one through `src/index.ts`; a name that quietly
 * stops being exported is a build break in `agent-runtime`, not here, and this is the cheapest
 * place to catch it.
 */
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const EXPECTED = [
  // errors
  "ProviderError",
  "isSwitchable",
  "isAborted",
  "parseErrorBody",
  "classifyStatus",
  "providerErrorFromResponse",
  "providerErrorFromThrow",
  "contextOverflowOf",
  "contextOverflowSentence",
  "isContextOverflow",
  "throwIfAborted",
  // sse
  "readSse",
  "sseSplitter",
  "SSE_DONE",
  // pictures (gap B10)
  "IMAGE_MAX_BYTES",
  "IMAGE_MIME_TYPES",
  "IMAGE_FALLBACK_MIME",
  "NO_VISION_REASON",
  "NON_USER_IMAGE_REASON",
  "sniffImageMime",
  "imageTooLarge",
  "fromBase64",
  "decodeImage",
  "imageBase64",
  "imageDataUrl",
  "hasImages",
  "droppedImagesNote",
  "withoutImages",
  "rowVision",
  // the OpenAI-compatible peer
  "OpenAICompatibleProvider",
  "TOOL_RESULT_IMAGE_REASON",
  "parseToolArguments",
  "mapFinishReason",
  "mapUsage",
  "splitFooter",
  // the device key
  "HEADER_APP",
  "HEADER_DEVICE",
  "HEADER_TIMESTAMP",
  "HEADER_SIGNATURE",
  "SPONSOREDTOKENS_ORIGIN",
  "CONNECT_DEVICE_PATH",
  "DEVICE_MESSAGE",
  "DEVICE_KEY_PARAMS",
  "DEVICE_SIGN_PARAMS",
  "requestPath",
  "canonicalRequest",
  "toBase64",
  "toHex",
  "bodyBytes",
  "bodyHashHex",
  "signedHeaders",
  "generateDeviceKeypair",
  "MemoryDeviceKeyStore",
  "IndexedDbDeviceKeyStore",
  // sponsored
  "SPONSOR_FOOTER_LEAD",
  "SPONSOREDTOKENS_API_BASE",
  "SponsoredDeviceTransport",
  "DeviceRegistrationError",
  "registerDevice",
  "sponsoredFooterExtractor",
  "sponsoredProvider",
  // anthropic and the factories
  "AnthropicProvider",
  "ANTHROPIC_VERSION",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_MAX_TOKENS",
  "toAnthropicMessages",
  "readAnthropicContent",
  "overblastProvider",
  "byokProvider",
  "BYOK_BASE_URLS",
  // the local brains
  "WebLLMProvider",
  "WEBLLM_VERSION",
  "WEBLLM_CATALOG",
  "WEBLLM_DEFAULT_MODEL_ID",
  "WEBLLM_NATIVE_TOOL_MODEL_IDS",
  "webllmCatalogFor",
  "supportsNativeTools",
  "LiteRtProvider",
  "LITERT_VERSION",
  "LITERT_NATIVE_TOOLS",
  "LITERT_MODEL_CACHE",
  "LITERT_PART_BYTES",
  "LITERT_DEFAULT_WASM_PATH",
  "LITERT_CATALOG",
  "LITERT_DEFAULT_MODEL_ID",
  "LITERT_MAX_IMAGES",
  "LITERT_UNVERIFIED_ASSETS",
  "GEMMA_TERMS",
  "APACHE_2",
  "litertCatalogFor",
  "litertAssetUrl",
  // the mirror's catalogue and the join (contract revision 2026-09-10)
  "parseMirrorCatalog",
  "mergeMirrorCatalog",
  // the shared prompt-based tool fallback and the turn formats
  "fallbackToolPrompt",
  "parseFallbackToolCalls",
  // the compact signatures the fallback emits (2026-09-11, the 4096-token regression)
  "toolSignature",
  "FALLBACK_SCHEMAS_MIN_CONTEXT",
  "FALLBACK_DESC_MAX",
  "FALLBACK_ARGS_SHOWN",
  "GEMMA_MARKERS",
  "PROMPT_TEMPLATES",
  "PROMPT_SEGMENT_TEMPLATES",
  "renderPromptSegments",
  "TURN_MARKER_MAX_LENGTH",
  "renderPrompt",
  "turnMarkerIndex",
  "stopAtTurnEnd",
  // the router
  "ModelRouter",
  "localProviders",
  // class-aware routing (§6, 2026-09-10)
  "providerClasses",
  "classActuallyUsed",
  // vision-aware routing (gap B10, 2026-09-10)
  "providerVision",
  "visionActuallyUsed",
  // the brain that thinks on the person's own Mac (§8.4, 2026-09-10)
  "RemoteBrainProvider",
  "REMOTE_PROVIDER_ID",
  "REMOTE_MODEL_ID",
  "REMOTE_DEFAULT_LABEL",
  "REMOTE_BUSY",
  "NO_REMOTE_VISION",
  "TOOL_RESULT_HEADER",
  "renderRemotePrompt",
  "remoteErrorCode",
  "isRemoteBusy",
] as const;

describe("the package's public API", () => {
  it("exports every name the other packages import", () => {
    const missing = EXPECTED.filter((name) => !(name in api));
    expect(missing).toEqual([]);
  });

  it("adds nothing to the surface without a decision", () => {
    // `types.ts` is types only, so it contributes no runtime names — the frozen contract is checked
    // by `tsc`, not here.
    expect(Object.keys(api).sort()).toEqual([...EXPECTED].sort());
  });

  it("holds no key, token or secret of the platform's, anywhere in its constants", () => {
    // The browser NEVER holds a platform key (§6). A literal that looks like one would be a
    // catastrophic mistake to ship, so it is asserted rather than trusted.
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== "string") continue;
      expect(value, `${name} looks like a credential`).not.toMatch(/^(sk-|pk_|ob_live_|Bearer )/);
    }
  });
});
