// @00/agent-models — the brains of the browser runtime: three remote peers and TWO local ones behind
// the single `ModelProvider` door of docs/HANDOFF-infinite-agent.md §6, plus the router that picks.
// The browser NEVER holds a platform key: what lives here is a device signature, an Overblast device
// token, or the person's own key. See src/sponsored.ts for the first and src/providers.ts for the rest.
//
// ── THE TWO LOCAL BRAINS (level 0: needs nothing, works offline, costs nothing) ──────────────────
//
// `LiteRtProvider` (`local-litert`, src/litert.ts) is PREFERRED, and `WebLLMProvider` (`local`,
// src/webllm.ts) is the fallback behind it. The ruling of 2026-09-10 (§6.1): LiteRT — Google's
// MediaPipe LLM Inference API over WebGPU, the Gemma family — is faster and more stable than
// web-llm's Gemma builds, and web-llm errors outright on some Windows machines. `localProviders()`
// in src/router.ts returns the pair in that order; when LiteRT answers `unsupported` the router
// walks on to WebLLM and the turn still happens. Neither can call tools natively at the installed
// versions, so both go through the one marked prompt fallback in src/tool-fallback.ts.
//
// WHAT THE APP MUST SERVE FOR LITERT TO WORK OFFLINE — two things, neither of them a CDN:
//
//   1. THE WASM FOLDER. Copy `node_modules/@mediapipe/tasks-genai/wasm/` (≈27 MB per binary, three
//      of them) into what the app serves and point `wasmBaseUrl` at it; the default is
//      `/mediapipe/genai/wasm` on the app's own origin, so the service worker can cache it. Without
//      this the task cannot be created at all — and a jsdelivr URL, which every Google sample uses,
//      is a local model that stops working on a plane.
//   2. THE MODEL ASSETS. `modelBaseUrl` is a REQUIRED option and this package hardcodes no host:
//      where Gemma's weights are served from is the owner's decision, and Gemma's terms travel with
//      whoever redistributes them. The file names are in `LITERT_CATALOG` (`assetFile`); the asset
//      is fetched once with progress, kept in Cache Storage under `LITERT_MODEL_CACHE`, and handed
//      to the task as a buffer. `clearCache()` gives the disk back.
export * from "./types.js";
export * from "./errors.js";
export * from "./sse.js";
export * from "./image-parts.js";
export * from "./openai-compatible.js";
export * from "./device-key.js";
export * from "./sponsored.js";
export * from "./anthropic.js";
export * from "./providers.js";
export * from "./tool-fallback.js";
export * from "./templates.js";
export * from "./webllm.js";
export * from "./litert.js";
export * from "./remote.js";
export * from "./router.js";
