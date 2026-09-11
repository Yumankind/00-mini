// @00/agent-models — the brains of the browser runtime: three remote peers and THREE local ones
// behind the single `ModelProvider` door of docs/HANDOFF-infinite-agent.md §6, plus the router that
// picks. The browser NEVER holds a platform key: what lives here is a device signature, an Overblast
// device token, or the person's own key. See src/sponsored.ts for the first and src/providers.ts for
// the rest.
//
// ── THE THREE LOCAL BRAINS (level 0: needs nothing, works offline, costs nothing) ────────────────
//
// `LiteRtProvider` (`local-litert`, src/litert.ts) is PREFERRED, `TransformersProvider`
// (`local-onnx`, src/transformers.ts) is the one that SEES, and `WebLLMProvider` (`local`,
// src/webllm.ts) is the fallback behind both. The ruling of 2026-09-10 (§6.1): LiteRT — Google's
// MediaPipe LLM Inference API over WebGPU, the Gemma family — is faster and more stable than
// web-llm's Gemma builds, and web-llm errors outright on some Windows machines. Transformers.js on
// ONNX Runtime Web joined on 2026-09-11 because LiteRT's Gemma 4 web builds are TEXT ONLY and its
// vision rows are a generation behind and gated: `onnx-community/gemma-4-E2B-it-ONNX` is Gemma 4 E2B
// with its vision encoder, ungated and Apache-2.0, at 3.4 GB and slower. `localProviders()` in
// src/router.ts returns them in that order; when one answers `unsupported` the router walks on and
// the turn still happens, and a turn that carries a picture ranks the sighted peer first on its own
// (`ModelRouter.ordered()`). None of the three calls tools natively as installed and configured, so
// all three go through the one marked prompt fallback in src/tool-fallback.ts.
//
// WHAT THE APP MUST SERVE FOR THE ONNX ROW — the same two things, neither of them a CDN:
// ONNX Runtime Web's wasm pair from `/ort/` on the app's own origin (apps/infinite/vite.config.ts
// copies it out of the installed package), and the fifteen model files from a `modelBaseUrl` the
// owner hosts. `GEMMA_4_E2B_ONNX_FILES` is the exact list, with the Hub's sizes and hashes.
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
export * from "./transformers.js";
export * from "./remote.js";
export * from "./router.js";
