import { defineConfig } from "vite";

/**
 * The embed is ONE self-contained IIFE at `dist/embed/e.js`.
 *
 * WHY these four settings and no plugins:
 *  - `formats: ["iife"]` + `inlineDynamicImports` — the site Worker serves this one file for EVERY
 *    ref (`/e/<ref>.js`), so it must not reference a sibling chunk that the ref-shaped URL would
 *    never resolve. One file, one request, edge-cached for ever.
 *  - `cssCodeSplit: false` and no CSS entry — the panel's styles are a string in
 *    `embed/src/panel/styles.ts`, injected into the closed shadow root. A separate stylesheet would
 *    be a second request that could fail on somebody else's site.
 *  - `target: "es2020"` — the floor at which every browser that has `attachShadow({mode:"closed"})`
 *    and IndexedDB can parse the file without a transpile tax on the byte budget (< 60 KB gz, §10).
 *  - `modulePreload: false` — nothing to preload; this file is the whole product at level 0.
 *
 * The PWA is built by the sibling `vite.config.ts`, which belongs to apps/infinite/src.
 */
export default defineConfig({
  // The PWA's `public/` (icons, the manifest, the service worker) belongs to the PWA build. Copying
  // it here would put a second app's files under `dist/embed/`, which the site Worker serves as `/e/`.
  publicDir: false,
  build: {
    outDir: "dist/embed",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: false,
    modulePreload: false,
    minify: "esbuild",
    reportCompressedSize: true,
    lib: {
      entry: "embed/src/loader.ts",
      name: "InfiniteAgentEmbed",
      formats: ["iife"],
      fileName: () => "e.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
