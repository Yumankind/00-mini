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
      // The ratchet of docs/testing.md: measured 2026-09-10 evening (54.4 / 84.7 / 74.5 / 54.4) minus
      // slack. Low on statements because the DOM-bound modules (panel, bridges, OPFS glue) are counted
      // and cannot run in node; raise as pure modules split out of them.
      thresholds: { statements: 51, branches: 81, functions: 70, lines: 51 },
    },
  },
});
