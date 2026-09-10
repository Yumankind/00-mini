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
      // The ratchet of docs/testing.md, from the package's first commit: floors ~1-2 points under the
      // measured value. Floors only ever go up — a change that drops below one is fixed or reverted,
      // never accommodated by lowering the number. The slack absorbs the Linux leg, which takes the
      // other side of every platform gate.
      // Raised 2026-09-10 with the gap-audit round (B9–B17): measured 99.1 / 93.3 / 99.1 / 99.1 on
      // macOS with 341 tests. Branches stays at 92 rather than 93 — the new modules are full of
      // "and when the host wired none of this" arms that a browser exercises and a test does not.
      thresholds: { statements: 98, lines: 98, branches: 92, functions: 98 },
    },
  },
});
