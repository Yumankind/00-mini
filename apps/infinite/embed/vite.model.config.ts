import { defineConfig } from "vite";

/**
 * The optional local-model module, `dist/embed/m/m.js` — loaded ONLY when a visitor presses
 * "Load local AI" (embed/src/brain.ts). Kept out of `vite.embed.config.ts` because it is the exact
 * opposite build: ES modules with code splitting, megabytes of WebGPU runtime, and nothing about it
 * belongs in a script that every page load fetches.
 *
 * Run it from apps/infinite, not from this folder — vite's `root` is the working directory, and both
 * paths below are relative to it:
 *     npx vite build --config embed/vite.model.config.ts
 * apps/infinite-site/scripts/build-site.sh does exactly that and copies the result to `public/m/`.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/embed/m",
    emptyOutDir: true,
    target: "es2020",
    minify: "esbuild",
    lib: { entry: "embed/src/model-entry.ts", formats: ["es"], fileName: () => "m.js" },
  },
});
