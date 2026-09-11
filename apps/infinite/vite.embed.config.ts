import { defineConfig, transformWithEsbuild, type Plugin } from "vite";

/**
 * The ONE plugin, and what it earns: `src/mini/mini-css.ts` is 24.7 KB of readable, commented CSS —
 * a quarter of everything a visitor downloads — and it is a STRING, so esbuild's JS minifier never
 * looks inside it. This runs esbuild's CSS minifier over the template literal at build time, in the
 * EMBED build only: 24.7 KB → 20.7 KB, and 6.3 KB → 4.7 KB gzipped, measured 2026-09-11.
 *
 * The file on disk keeps its comments and its indentation — it is the stylesheet two implementations
 * read (DESIGN.md), and the app's own build still takes it verbatim. Only the copy inlined into
 * `e.js` is squeezed, and only the ONE declaration is rewritten, so anything else that module grows
 * passes through untouched. A shape it cannot recognise is a hard error rather than a silent 4 KB.
 */
function minifyMiniCss(): Plugin {
  return {
    name: "embed:minify-mini-css",
    enforce: "pre",
    async transform(code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/src/mini/mini-css.ts")) return null;
      const found = /export const MINI_CSS = `([\s\S]*?)`;/.exec(code);
      if (!found) throw new Error("embed:minify-mini-css — MINI_CSS is no longer one plain template literal");
      const minified = await transformWithEsbuild(found[1]!, "mini-css.css", { loader: "css", minify: true });
      return { code: code.replace(found[0], `export const MINI_CSS = ${JSON.stringify(minified.code)};`), map: null };
    },
  };
}

/**
 * The embed is ONE self-contained IIFE at `dist/embed/e.js`.
 *
 * WHY these four settings (and the one plugin, which is below and earns its place in bytes):
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
  plugins: [minifyMiniCss()],
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
