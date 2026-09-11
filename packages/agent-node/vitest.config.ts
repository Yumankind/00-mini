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
      // Floors from the first commit (docs/HANDOFF-infinite-agent.md §10), set just under the
      // measured numbers: a new module under src/ with no test lands in the denominator at 0% and
      // fails the gate, which is the whole job they do.
      // Measured 2026-09-11 with the four layers in place (core modules, the loader, the fs backend
      // and its SharedArrayBuffer channel, the process model, the npm client): 97.0 / 89.4 / 95.1 /
      // 97.0 on macOS with 182 tests. The floors stay where they are — they exist to catch a new
      // module with no test, not to ratchet against a good day.
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
