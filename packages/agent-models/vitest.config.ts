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
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
      // THE RATCHET (docs/testing.md): floors only ever go up, and they sit a point or two under the
      // measured value — the slack absorbs the Linux leg, which takes the other side of every
      // `navigator`/WebGPU gate in this package. Measured on macOS 2026-09-10, first commit:
      // statements 99.0 · branches 89.0 · functions 98.3 · lines 99.0.
      // Never lower one to make a change pass: fix or delete the change that dropped it.
      thresholds: { statements: 96, branches: 85, functions: 95, lines: 96 },
    },
  },
});
