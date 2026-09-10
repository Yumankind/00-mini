import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * WHY A HAND-WRITTEN SERVICE WORKER, AND WHY A PLUGIN AROUND IT.
 *
 * The PWA must serve its own shell offline (docs/HANDOFF-infinite-agent.md §4.1: "0 ms shell paints,
 * offline-capable after this"), and `vite-plugin-pwa` is not installed and is not worth a dependency
 * for one precache list. `public/sw.js` is therefore the tracked source, written by hand — but it
 * cannot know the hashed asset names, and a stale precache list is a shell that boots into a blank
 * page after a deploy. So the build substitutes them: this plugin reads the emitted bundle, writes the
 * real file list and a build id into the copy that lands in `dist/`, and leaves the source alone. The
 * build id is what makes an update actually replace the old cache instead of joining it.
 */
function serviceWorkerPrecache(): Plugin {
  const assets: string[] = [];
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "infinite-sw-precache",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    generateBundle(_options, bundle) {
      // ONLY THE SHELL. A lazy chunk is not part of the shell, and the local brain's is six
      // megabytes of WebGPU runtime that a person who never asks for a local model should never
      // download. Those are hashed, so the fetch handler caches them the first time they are
      // actually used — which is the correct moment.
      for (const [file, chunk] of Object.entries(bundle)) {
        const isEntryChunk = chunk.type === "chunk" && chunk.isEntry;
        const isStylesheet = chunk.type === "asset" && file.endsWith(".css");
        if (isEntryChunk || isStylesheet) assets.push(`/${file}`);
      }
    },
    closeBundle() {
      const src = resolve(root, "public/sw.js");
      const dest = resolve(root, outDir, "sw.js");
      if (!existsSync(src)) return;
      const precache = ["/", "/manifest.webmanifest", "/icon.svg", ...assets].filter(
        (p, i, all) => all.indexOf(p) === i,
      );
      // A HASH, not a prefix of the list: the first sixteen characters of these paths are identical
      // in every build, so slicing the encoded string would have produced one id forever — and a
      // service worker whose cache name never changes never replaces its cache. The asset names are
      // content-hashed, so hashing the list is hashing the shell.
      const buildId = `ia-${createHash("sha256").update(precache.join("|")).digest("hex").slice(0, 12)}`;
      const out = readFileSync(src, "utf8")
        .replace('"__PRECACHE__"', JSON.stringify(precache, null, 2))
        .replace('"__BUILD_ID__"', JSON.stringify(buildId));
      writeFileSync(dest, out);
    },
  };
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), serviceWorkerPrecache()],
  // The owned agent lives on ONE product origin (§3.1: OPFS and the push subscription are per origin),
  // so the app is always served from the root and every path here is absolute.
  base: "/",
  server: { port: 5273 },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
