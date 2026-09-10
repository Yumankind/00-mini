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
      thresholds: { statements: 96, branches: 91, functions: 97, lines: 96 },
    },
  },
});
