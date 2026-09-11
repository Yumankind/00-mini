#!/usr/bin/env sh
# Fills public/ from apps/infinite: the embed loader as /e.js, the PWA as everything else.
#
# WHY a shell script and not an npm script: this folder has no package.json and no node_modules on
# purpose (see README). The two builds belong to apps/infinite, which IS a pnpm workspace member, so
# this script runs them there with the workspace's own vite and copies the output here.
#
# It never installs anything. If apps/infinite has no node_modules, it says so and stops — installing
# is a deliberate act in this repo, never a side effect of a build (see the root CLAUDE.md).
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
app="$(cd "$here/../infinite" && pwd)"
public="$here/public"

if [ ! -d "$app/node_modules" ]; then
  echo "apps/infinite has no node_modules. Run 'pnpm install' at the repo root yourself, then re-run this." >&2
  exit 1
fi

# The PWA FIRST and the embed second, and in that order for a reason: the PWA's outDir is `dist`,
# which vite empties, taking `dist/embed` with it. Same order as apps/infinite's own `build` script.
if [ -f "$app/vite.config.ts" ]; then
  echo "→ building the PWA (apps/infinite → dist)"
  (cd "$app" && npx vite build)
else
  echo "! apps/infinite/vite.config.ts is not there yet — skipping the PWA half."
fi

echo "→ building the embed (apps/infinite → dist/embed/e.js)"
(cd "$app" && npx vite build --config vite.embed.config.ts)

# The three lazy modules, each its own bundle and none of them in e.js: the brain (the agent loop and
# the WebGPU model pair, megabytes), the owner's setup wizard, and the registry client. The loader
# fetches one ONLY when a person asks for it — "Load local AI", the gear, the first message to the
# owner — so none of them costs a page load. AFTER the embed build, which empties dist/embed.
echo "→ building the lazy modules (apps/infinite → dist/embed/m/)"
(cd "$app" && npx vite build --config embed/vite.modules.config.ts)

mkdir -p "$public"
# public/ is entirely generated. Clearing it keeps a file deleted upstream from living on here.
find "$public" -mindepth 1 -delete

if [ -d "$app/dist" ]; then
  # Everything except dist/embed (the loader, one file below) and dist/mediapipe (MediaPipe's wasm:
  # three ~27 MB binaries, each over Cloudflare's 25 MiB per-asset cap, so they cannot be static assets
  # here — the Worker serves /mediapipe/genai/wasm/* from R2 instead; see the README).
  (cd "$app/dist" && find . -mindepth 1 -maxdepth 1 ! -name embed ! -name mediapipe -exec cp -R {} "$public/" \;)
fi

cp "$app/dist/embed/e.js" "$public/e.js"
if [ -d "$app/dist/embed/m" ]; then
  mkdir -p "$public/m"
  cp -R "$app/dist/embed/m/." "$public/m/"
fi

echo
echo "public/ now holds:"
ls -la "$public"
echo
echo "the loader is $(wc -c < "$public/e.js" | tr -d ' ') bytes, $(gzip -9 -c "$public/e.js" | wc -c | tr -d ' ') gzipped"
echo "that is what a level-0 visitor downloads. The lazy modules under m/ are fetched only when"
echo "somebody asks for one (a brain, the gear, the registry):"
for m in "$public"/m/*.js; do
  [ -f "$m" ] || continue
  echo "  m/$(basename "$m") — $(wc -c < "$m" | tr -d ' ') bytes, $(gzip -9 -c "$m" | wc -c | tr -d ' ') gzipped"
done
echo "mediapipe/ and litert/ are NOT here: the Worker serves them from R2 (00-downloads) at"
echo "  /mediapipe/genai/wasm/*  and  /litert/*  — see src/index.ts and README.md"
