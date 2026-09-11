import { defineConfig } from "vitest/config";

// Node environment on purpose: browser-only APIs (OPFS, WebGPU, WebAuthn) sit behind adapters, and the
// tests run against the in-memory adapters plus what Node 24 shares with browsers (WebCrypto,
// CompressionStream, TextEncoder, structuredClone). The day a test needs a document is the day it has
// stopped testing the runtime. Same runner version as apps/00d and web-vue.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: { TZ: "UTC" },
    coverage: {
      enabled: process.env.COVERAGE === "1",
      provider: "v8",
      include: ["src/**/*.ts", "embed/src/**/*.ts"],
      reporter: ["text-summary"],
      // The ratchet of docs/testing.md: measured 2026-09-11 (75.3 / 82.0 / 79.1 / 75.3) minus slack. Low on statements because the DOM-bound modules (panel, bridges, OPFS glue) are counted
      // and cannot run in node; raise as pure modules split out of them.
      // Re-measured 2026-09-11 later the same day, with the ONNX local brain's wiring and its tests
      // (the /onnx/ R2 door, the /ort/ wasm plugin, the picker's runtime row): 75.8 / 83.6 / 80.18 /
      // 75.8 — every axis up, so every floor goes up with them, keeping the two points of slack the
      // Linux leg needs on the browser-API gates.
      thresholds: { statements: 73, branches: 81, functions: 78, lines: 73 },
    },
  },
});
