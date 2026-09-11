/// <reference types="vite/client" />

/**
 * Build-time constants the vite plugins in vite.config.ts define. Declared here so the source that
 * reads them typechecks; the value is inlined by vite, and a test that imports such a module sees
 * `undefined` unless it defines the constant itself.
 */
/** `/esbuild/<version>/esbuild.wasm` on this origin — the `esbuildWasm()` plugin reads the version from the package. */
declare const __ESBUILD_WASM_URL__: string | undefined;
