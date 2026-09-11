import { defineConfig } from "vite";

/**
 * The THREE lazy modules, `dist/embed/m/*.js` — everything the embed is allowed to have but must
 * not carry (§5.2.3, §10). Was `vite.model.config.ts`, which built the model alone.
 *
 *   m/brain.js    — the agent loop (@00/agent-runtime, @00/agent-fs) and the local model pair
 *                   (@00/agent-models: LiteRT, then web-llm). Fetched when somebody presses
 *                   "Load local AI" or a site has a brain configured.
 *   m/setup.js    — the owner's setup wizard. Fetched when the gear is pressed.
 *   m/registry.js — the registry client, the ed25519 device key, the public-bundle reader. Fetched
 *                   on the first call that genuinely needs the registry, and never at level 0.
 *
 * WHY THIS IS THE EXACT OPPOSITE BUILD to `vite.embed.config.ts`: ES modules with code splitting,
 * megabytes of WebGPU runtime in one of them, and nothing about any of it belongs in a script that
 * every page load of every site fetches. The loader reaches them by COMPUTED URL against its own
 * origin (`embed/src/modules.ts`), so a shared chunk beside them resolves and the site Worker
 * already serves the whole of `/m/*` with `Cross-Origin-Resource-Policy: cross-origin`
 * (apps/infinite-site/src/headers.ts) — the header that lets a third-party page load them at all.
 *
 * `emptyOutDir` is FALSE and deliberately so: `vite.embed.config.ts` empties `dist/embed` and must
 * therefore run FIRST. Both `pnpm build:embed` and apps/infinite-site/scripts/build-site.sh keep
 * that order.
 *
 * Run it from apps/infinite, not from this folder — vite's `root` is the working directory, and every
 * path below is relative to it:
 *     npx vite build --config embed/vite.modules.config.ts
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/embed/m",
    emptyOutDir: false,
    target: "es2020",
    minify: "esbuild",
    reportCompressedSize: true,
    lib: {
      entry: {
        brain: "embed/src/entries/brain.ts",
        setup: "embed/src/entries/setup.ts",
        registry: "embed/src/entries/registry.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
  },
});
