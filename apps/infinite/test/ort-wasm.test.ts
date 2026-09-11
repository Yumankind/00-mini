/**
 * ONNX RUNTIME WEB'S WASM, SERVED BY US — the build step the third local brain cannot run without.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Transformers.js DEFAULTS its `wasmPaths` to jsdelivr
 * (`src/backends/onnx.js`), so the provider overrides it with `ONNX_DEFAULT_WASM_PATH` — and that
 * override is only correct while the app actually serves those files from that path. Three things have
 * to agree, and nothing at runtime would notice if they stopped: the package's constant, the plugin's
 * URL prefix, and the file names ONNX Runtime Web ships. When they disagree the failure is a fetch of
 * a 22 MB binary that 404s, in the middle of a three-gigabyte model load, and the message a person
 * sees is about a wasm module rather than about a missing file.
 *
 * It also holds the SIZE line. These files ship as ordinary static assets, which is only allowed
 * because each is under Cloudflare's 25 MiB cap; MediaPipe's runtime is in R2 for exactly that reason.
 * The largest is 22.5 MiB today — real headroom, but not so much that nobody should be watching.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ONNX_DEFAULT_WASM_PATH } from "@00/agent-models";

const here = dirname(fileURLToPath(import.meta.url));
/** The same resolution the plugin does, and for the same reason: pnpm links the package, not its dep. */
const pkgLink = resolve(here, "../../../packages/agent-models/node_modules/@huggingface/transformers");
const distDir = resolve(realpathSync(pkgLink), "../../onnxruntime-web/dist");

/** Cloudflare refuses a static asset over this. */
const ASSET_CAP = 25 * 1024 * 1024;

/** The names the webgpu bundle can ask for; the plugin's list must be exactly these. */
const EXPECTED = [
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

describe("the /ort/ wasm the ONNX local brain loads", () => {
  it("is served from the path the package's constant names", async () => {
    expect(ONNX_DEFAULT_WASM_PATH).toBe("/ort/");
    // A PREFIX: ORT appends its own file name, and a prefix with no trailing slash silently becomes
    // part of that name.
    expect(ONNX_DEFAULT_WASM_PATH.endsWith("/")).toBe(true);
    const config = readFileSync(resolve(here, "../vite.config.ts"), "utf8");
    expect(config).toContain('const URL_PREFIX = "/ort/"');
  });

  it("is wired into the build, beside the other two wasm plugins", async () => {
    const mod = (await import("../vite.config.js")) as { default: { plugins?: unknown[] } };
    const names = (mod.default.plugins ?? [])
      .flat(3)
      .map((p) => (p && typeof p === "object" ? (p as { name?: string }).name : undefined))
      .filter((n): n is string => Boolean(n));
    expect(names).toContain("infinite-ort-wasm");
    expect(names).toContain("infinite-mediapipe-wasm");
    expect(names).toContain("infinite-esbuild-wasm");
  });

  it("names files the installed onnxruntime-web actually ships", () => {
    expect(existsSync(distDir), distDir).toBe(true);
    const config = readFileSync(resolve(here, "../vite.config.ts"), "utf8");
    for (const name of EXPECTED) {
      expect(existsSync(join(distDir, name)), `${name} in ${distDir}`).toBe(true);
      expect(config, `${name} in the plugin's list`).toContain(name);
    }
  });

  it("keeps every one of them under Cloudflare's static-asset cap", () => {
    for (const name of EXPECTED) {
      const bytes = statSync(join(distDir, name)).size;
      expect(bytes, `${name} is ${Math.round(bytes / 1048576)} MiB`).toBeLessThan(ASSET_CAP);
    }
  });

  it("does not need the jsep or jspi builds, which are 40 MB the webgpu bundle never asks for", () => {
    // The claim the list rests on: `ort.webgpu.bundle.min.mjs` — what `onnxruntime-web/webgpu`
    // resolves to under the default export condition — names the asyncify pair and nothing else. Since
    // the provider hands ORT a string PREFIX, the name ORT appends is one of these.
    const bundle = readFileSync(join(distDir, "ort.webgpu.bundle.min.mjs"), "utf8");
    const referenced = new Set(bundle.match(/ort-wasm-simd-threaded[A-Za-z0-9._-]*/g) ?? []);
    expect([...referenced].sort()).toEqual(["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]);
    for (const unwanted of ["jsep", "jspi"]) expect(bundle).not.toContain(`ort-wasm-simd-threaded.${unwanted}`);
  });

  it("carries the Safari pair too, because that is the one Transformers.js names for Safari", () => {
    // The other two files are not dead weight: `src/backends/onnx.js` sets `wasmPaths` to the PLAIN
    // pair on Safari and the asyncify pair everywhere else. That branch only fires when nothing has set
    // `wasmPaths` — and we always set it — but copying both pairs costs 12 MB in `dist` and is what
    // keeps a future object-form `wasmPaths` (or a Safari-only ORT change) from 404ing on a deploy.
    const backend = readFileSync(join(realpathSync(pkgLink), "src/backends/onnx.js"), "utf8");
    expect(backend).toContain("IS_SAFARI");
    expect(backend).toContain("ort-wasm-simd-threaded.mjs");
    expect(backend).toContain("ort-wasm-simd-threaded.asyncify.wasm");
  });
});
