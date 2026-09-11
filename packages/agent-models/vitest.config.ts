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
      // Re-measured 2026-09-10 with the LiteRT provider (src/litert.ts, src/templates.ts,
      // src/tool-fallback.ts): statements 98.7 · branches 90.8 · functions 98.1 · lines 98.7 —
      // branches went UP, so their floor goes up with them; the other three keep their slack, since
      // the two real dynamic imports (web-llm, MediaPipe) are code no Node run can reach.
      // Re-measured 2026-09-10 with vision (src/image-parts.ts, the prompt segments, the vision rank
      // in the router): statements 98.9 · branches 91.7 · functions 98.0 · lines 98.9 — branches went
      // up again, so their floor goes to 89 and keeps the slack the Linux leg needs.
      // Re-measured 2026-09-11 with the THIRD local provider (src/transformers.ts, 60 tests):
      // statements 98.11 · branches 90.32 · functions 97.37 · lines 98.11 — the three that matter keep
      // their 2-point slack over the floors, and BRANCHES WENT DOWN (91.7 → 90.32), so their floor
      // stays at 89 rather than rising. The new file's own branch coverage is 91.9; what the aggregate
      // lost is the two dynamic imports and one racy mid-drain abort guard that no Node run reaches.
      // Never lower one to make a change pass: fix or delete the change that dropped it.
      thresholds: { statements: 96, branches: 89, functions: 95, lines: 96 },
    },
  },
});
