#!/usr/bin/env bash
# Mirror the browser-ready LiteRT model assets to R2 (dl.0-0.chat), streaming each one from
# Hugging Face straight into the bucket AT THE EDGE (scripts/r2-mirror, a tool Worker deployed for
# the run) — nothing lands on this disk, which matters because the largest is 6 GB, the Mac this
# runs on has less free space than that, and `wrangler r2 object put` stops at 300 MiB anyway.
#
# WHY A MIRROR AND NOT HUGGING FACE DIRECTLY (checked 2026-09-10):
#   - the ungated repos DO answer a browser (CORS `*` on the final CDN hop, Range → 206), so direct
#     download works for Gemma 4 — but the URL is a signed redirect with `cache-control: no-store`,
#     anonymous traffic is rate-limited at their discretion, and nothing about it is ours to promise;
#   - the Gemma 3 / 3n / 270m repos are GATED (401 GatedRepo without a token) — a token in a web page
#     is a token for everyone, so those can only reach a browser from a host we run;
#   - R2 egress is free and the custom domain sits behind Cloudflare's cache, so the whole set costs
#     storage only: ~15 GB × $0.015/GB-month ≈ $0.25 a month, reads at $0.36 per million.
#
# Licences travel with the bytes: `litert/catalog.json` names each asset's licence and source commit,
# and the Gemma entries carry Google's Gemma terms (redistribution allowed with the terms attached).
#
# Usage:  scripts/publish-litert-models.sh [--only <substring>] [--dry-run]
#   HF_TOKEN     needed for the gated repos (Gemma 3 / 3n / 270m); spent on this machine only, to
#                resolve the Hub's redirect to its pre-signed CDN URL — it never reaches the Worker.
#   R2_BUCKET    default 00-downloads          DL_URL  default https://dl.0-0.chat
#
# TWO KEY LAYOUTS, one per runtime:
#   litert/<file>                  — FLAT, so `LiteRtProvider({ modelBaseUrl: ".../litert" })` resolves
#                                    `<modelBaseUrl>/<assetFile>` with no per-repo path.
#   onnx/<org>/<repo>/<path>       — the repo's OWN relative layout, because Transformers.js composes
#                                    every URL as `<remoteHost>/<remotePathTemplate>/<file>` and this
#                                    app sets that template to `{model}/`
#                                    (packages/agent-models/src/transformers.ts, `pathTemplateFor`).
# Both prefixes are read-only doors on the site Worker too (apps/infinite-site/src/index.ts).
set -euo pipefail

R2_BUCKET="${R2_BUCKET:-00-downloads}"
DL_URL="${DL_URL:-https://dl.0-0.chat}"; DL_URL="${DL_URL%/}"
ONLY=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

# repo | commit | file | bytes | sha256 (from the Hub's LFS record) | licence | gated | vision | runtime | key prefix
#
# `runtime` and `key prefix` were added on 2026-09-11 with the ONNX rows. Until then every key was
# `litert/<file>` and every row was a LiteRT bundle; both are now explicit, because a Transformers.js
# model is not one bundle but FIFTEEN files under the repo's own relative layout, and its key has to
# carry that layout (`onnx/<org>/<repo>/<path>`) for the library to resolve `{model}/<file>` against it.
#
# Sizes and hashes were read from the Hub API — the LiteRT rows on 2026-09-10, the ONNX ones on
# 2026-09-11 — and the script re-verifies the hash on the way through, so a stale row fails loudly
# rather than mirroring the wrong bytes.
ASSETS='
litert-community/gemma-4-E2B-it-litert-lm|b3ca0d2f|gemma-4-E2B-it-web.task|2003697664|2cbff161177a4d51c9d04360016185976f504517ba5758cd10c1564e5421c5a5|apache-2.0|no|no|litert|litert
litert-community/gemma-4-E4B-it-litert-lm|2eee7ac3|gemma-4-E4B-it-web.task|2964324352|f3bd72fc27627be2a2cc6722199a333599590ed0962ee7047b516a506b7bf086|apache-2.0|no|no|litert|litert
litert-community/gemma-4-12B-it-litert-lm|7a0b1ce0|gemma-4-12B-it-web.litertlm|5986074624|d37f9392b4f093b470b50b72624c9a752cc0b288ed549b769037cbbd04024449|apache-2.0|no|no|litert|litert
google/gemma-3n-E2B-it-litert-lm|c03b6f60|gemma-3n-E2B-it-int4-Web.litertlm|3038117888|b6c8e1081ec80730f14473a5ece941b48da5d8e2a80c97c2963da153f3eff3d2|gemma|yes|yes|litert|litert
google/gemma-3n-E4B-it-litert-lm|297ed759|gemma-3n-E4B-it-int4-Web.litertlm|4275044352|63730ba3225a23a90d3292d89fdeff1a7537cedeb72aa687de9a35732d057e52|gemma|yes|yes|litert|litert
litert-community/gemma-3-270m-it|9d209327|gemma3-270m-it-q4_0-web.task|249233408|a642cc7b183373dbcb186b1d94bf7ac9c0cfff6a2e73a5837ba2ffcffa4ac1ac|gemma|yes|no|litert|litert
litert-community/Gemma3-1B-IT|a6306a4e|gemma3-1b-it-int4-web.task|700383232|74f37adc3f94af1eaa0be70875b10060b2a2e45d533bfb7d5e2c08d3e4050cfe|gemma|yes|no|litert|litert
'

# ── The Transformers.js row: Gemma 4 E2B WITH ITS VISION ENCODER (2026-09-11) ────────────────────
#
# WHY THESE EXIST AT ALL. The LiteRT Gemma 4 web builds above are TEXT ONLY (their cards say so), and
# LiteRT's vision rows are Gemma 3n — a generation behind, and gated. `onnx-community/gemma-4-E2B-it-ONNX`
# is the same Gemma 4 E2B weights exported to ONNX, ungated and Apache-2.0, and Transformers.js runs it
# on WebGPU with the vision encoder attached. That is the only road to "what is in this picture?"
# answered by Gemma 4 in a tab (packages/agent-models/src/transformers.ts).
#
# WHY FIFTEEN FILES AND NOT FOUR. `config.json`'s `transformers.js_config.use_external_data_format`
# gives each of the four q4f16 graphs one `_data` chunk, so every graph is two files; `Gemma4Processor`
# needs `processor_config.json` and `chat_template.jinja`; the tokenizer is two more; and
# `generation_config.json` / `preprocessor_config.json` are the last two. The same list, with the same
# sizes and hashes, is `GEMMA_4_E2B_ONNX_FILES` in the package — the test there adds it up.
#
# WHY THE AUDIO ENCODER IS HERE THOUGH NOTHING SENDS AUDIO. `MODEL_SESSION_CONFIG[ImageAudioTextToText]`
# in the installed library builds `embed_tokens`, `decoder_model_merged`, `vision_encoder` AND
# `audio_encoder` unless the caller loads through a `…ForCausalLM` class, which drops vision with it.
# There is no vision-without-audio load, so 171 MB of the 3.40 GB is capability that is paid for and
# unused. Leaving it out would mean the model does not load at all.
#
# The other five dtypes in that repo (fp16, q4, quantized, and the 12 GB unquantised set) are
# deliberately NOT mirrored: q4f16 is the only one a laptop GPU holds.
ASSETS="$ASSETS"'
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|config.json|5549|5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|generation_config.json|238|e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|preprocessor_config.json|43|4457c6e8a09070d7d5d1cd983fbfb67ebafe602bd98120c3543a024f5d07056b|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|processor_config.json|1689|32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|chat_template.jinja|16317|781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|tokenizer_config.json|18807|06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|tokenizer.json|19439251|47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/embed_tokens_q4f16.onnx|5621|d7ca53f6a169471b5699b2f57ee4c7aa2c73732b0152f3909e64b71384444825|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/embed_tokens_q4f16.onnx_data|1590689792|024b199e6358ed42970f807686add5f9430d7e254ca7ce22fc9c83f015b9c517|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/decoder_model_merged_q4f16.onnx|673231|73c0f1fe04f9a3a048fb3319c0671b6cf0346bf33a3a8624c853bcffe01c24a4|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/decoder_model_merged_q4f16.onnx_data|1519700992|3b27245a7396cb7039a4e4118bd2a8aa35106bae381522edf7c4867b5f22bb10|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/vision_encoder_q4f16.onnx|189124|e0a4e48e519ade4eeddbb4cdadb812a7251aea871f7fb5f50576615fd3af22a3|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/vision_encoder_q4f16.onnx_data|99189440|0835071d2c79c105f8e1b549b7f8dd8c9af07fa95f01ead2e7add280602d3c6d|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/audio_encoder_q4f16.onnx|260446|5e0deb22791685c792d4b8e089deef9670fa4a4cecde434213d6a742e58fc3fa|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/audio_encoder_q4f16.onnx_data|171258112|df58e61a00bafa9449ee5fd52895ce952f158bbdd1fe38df8a68f48f36842e62|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX
'

WRANGLER="${WRANGLER:-wrangler}"
command -v "$WRANGLER" >/dev/null || { echo "wrangler not found (brew install wrangler)" >&2; exit 1; }

# The tool Worker lives for this run only. Its token is minted here and travels as a --var, so a
# deploy nobody is running cannot be called; `trap` takes it down again on any exit.
MIRROR_DIR="$(cd "$(dirname "$0")/r2-mirror" && pwd)"
MIRROR_TOKEN=""; MIRROR_URL=""
deploy_mirror() {
  [ $DRY -eq 1 ] && return 0
  MIRROR_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  local out
  out=$("$WRANGLER" deploy --config "$MIRROR_DIR/wrangler.jsonc" --var "MIRROR_TOKEN:$MIRROR_TOKEN" 2>&1) || { echo "$out" >&2; exit 1; }
  MIRROR_URL=$(echo "$out" | grep -oE 'https://r2-mirror[^ ]*\.workers\.dev' | head -1)
  [ -n "$MIRROR_URL" ] || { echo "could not read the workers.dev URL from wrangler's output:" >&2; echo "$out" >&2; exit 1; }
  # A fresh workers.dev name answers 404 for a few seconds after the deploy. The Worker itself never
  # says 404 — an unauthenticated POST gets ITS 403 — so that is the sign it is really there.
  local i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MIRROR_URL")" = "403" ]; do
    i=$((i + 1)); [ $i -le 30 ] || { echo "mirror worker never came up at $MIRROR_URL" >&2; exit 1; }
    sleep 2
  done
  # Answering 403 is not the same as being settled: the first copy asked within seconds of that
  # answer has come back as a bare Cloudflare 1104 three times, and never once after a short pause.
  sleep 8
  echo "· mirror worker up at $MIRROR_URL"
}
remove_mirror() {
  [ -n "$MIRROR_URL" ] || return 0
  "$WRANGLER" delete --config "$MIRROR_DIR/wrangler.jsonc" --force >/dev/null 2>&1 && echo "· mirror worker removed" || echo "! could not remove the r2-mirror worker — run: wrangler delete --config scripts/r2-mirror/wrangler.jsonc" >&2
  MIRROR_URL=""
}
trap remove_mirror EXIT
deploy_mirror

mirrored=()
while IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix; do
  [ -z "$repo" ] && continue
  # A row written before the 2026-09-11 columns existed would arrive without them; defaulted rather
  # than refused, so this loop keeps working on a table someone edits in a hurry.
  runtime="${runtime:-litert}"; prefix="${prefix:-litert}"
  key="$prefix/$file"
  # Matched against the KEY, not the bare file name: `--only ONNX` has to be able to select a whole
  # repo whose fifteen file names have nothing in common.
  if [ -n "$ONLY" ] && [[ "$key" != *"$ONLY"* ]]; then continue; fi
  url="https://huggingface.co/$repo/resolve/$commit/$file"
  row="$repo|$commit|$file|$bytes|$sha|$licence|$gated|$vision|$runtime|$prefix"

  # Already there with the right size → skip. `curl -sI` on the public URL is the cheapest head we have.
  have=$(curl -sI "$DL_URL/$key" | awk 'tolower($1)=="content-length:"{gsub("\r","",$2);print $2}' | tail -1)
  if [ "${have:-}" = "$bytes" ]; then
    echo "= $key already mirrored ($bytes bytes)"; mirrored+=("$row"); continue
  fi

  # A gated file: the token stays ON THIS MAC. The Hub's resolve URL answers a redirect to a
  # pre-signed CDN URL (good for about an hour, no auth needed), so the token is spent here, once, to
  # learn that URL, and the Worker copies from it exactly as it copies an ungated file. Sending the
  # token through the Worker also tripped Cloudflare's 1042 on the authenticated hop.
  if [ "$gated" = "yes" ]; then
    [ -n "${HF_TOKEN:-}" ] || { echo "! $file is gated on the Hub and HF_TOKEN is not set — skipped" >&2; continue; }
    final=$(curl -sIL -H "Authorization: Bearer $HF_TOKEN" -o /dev/null -w '%{http_code} %{url_effective}' "$url")
    case "$final" in
      "200 https://"*) url=${final#200 } ;;
      *) echo "! $file: the Hub did not hand out a download URL (${final%% *}) — is the token's account approved for $repo?" >&2; continue ;;
    esac
  fi

  echo "→ $key ($((bytes / 1048576)) MB) from $repo@$commit"
  # A dry run still records the row, so the catalogue preview below is the WHOLE catalogue this
  # publish would write rather than only the parts that happened to be mirrored already.
  if [ $DRY -eq 1 ]; then mirrored+=("$row"); continue; fi

  # THE COPY HAPPENS AT THE EDGE. `wrangler r2 object put` refuses anything over 300 MiB, so the bytes
  # never come here: scripts/r2-mirror is a tool Worker with the bucket bound, deployed for this run
  # and deleted at the end, that fetches the Hub URL into a multipart upload and hashes it on the way.
  # The last line of its streamed answer is `ok <key> <bytes> <sha256>` or `error …`.
  # The content type matters for the small files the ONNX rows brought: a weight is opaque bytes, but
  # the tokenizer and the chat template are text a browser's dev tools should be able to show, and the
  # library reads all of them as bytes either way (`getModelFile` → `JSON.parse`, never `response.json()`).
  case "$file" in
    *.json) ctype="application/json; charset=utf-8" ;;
    *.jinja) ctype="text/plain; charset=utf-8" ;;
    *) ctype="application/octet-stream" ;;
  esac
  payload=$(python3 -c 'import json,sys; print(json.dumps({"url":sys.argv[1],"key":sys.argv[2],"sha256":sys.argv[3],"bytes":int(sys.argv[4]),"contentType":sys.argv[5]}))' "$url" "$key" "$sha" "$bytes" "$ctype")
  # Two tries: the first call after a deploy has answered a bare 500 once (the Worker's own errors
  # arrive as an `error …` line with status 200, so a non-200 is the platform, not the copy).
  result=""
  for attempt in 1 2 3; do
    log=$(mktemp -t litert-mirror.XXXXXX)
    # Progress as it happens: every part line is a carriage-return overwrite on stderr, so a 4 GB
    # copy is a moving counter rather than three silent minutes; the verdict lines print whole.
    status=$(curl -sS -N -o >(tee "$log" | awk '/^part /{printf "\r   %s", $0; fflush(); next} {printf "\n%s\n", $0; fflush()}' >&2) \
      -w '%{http_code}' -X POST "$MIRROR_URL" -H "x-mirror-token: $MIRROR_TOKEN" \
      -H "content-type: application/json" --data "$payload" || echo 000)
    wait
    printf '\n' >&2
    # The verdict is the last `ok …` / `error …` line the Worker streamed; a non-200 with no such
    # line is the platform, not the copy (a bare 1104 once), and worth one more try.
    result=$(grep -E '^(ok|error) ' "$log" | tail -1 || true)
    rm -f "$log"
    [ "$status" = "200" ] && [ -n "$result" ] && break
    echo "! attempt $attempt: status $status, ${result:-no verdict} — retrying in 10 s" >&2; sleep 10
  done
  case "$result" in
    "ok $key $bytes $sha") ;;
    *) echo "✘ mirror of $file failed: $result" >&2; exit 1 ;;
  esac
  have=$(curl -sI "$DL_URL/$key" | awk 'tolower($1)=="content-length:"{gsub("\r","",$2);print $2}' | tail -1)
  [ "${have:-}" = "$bytes" ] || { echo "✘ $DL_URL/$key answers $have bytes, expected $bytes" >&2; exit 1; }
  echo "✓ $key sha256 ok, $bytes bytes at $DL_URL/$key"
  mirrored+=("$row")
done <<< "$ASSETS"

# ── The catalogue the app reads beside the files: what is here, from where, under which licence ──
#
# ONE CATALOGUE FOR THREE RUNTIMES (2026-09-11). The app's picker joins ONE list of rows to the
# package's (`mergeMirrorCatalog`), so the Transformers.js model is a row here too — but it is not a
# file, it is a DIRECTORY of fifteen, and `parseMirrorCatalog` deliberately drops any `file` with a
# slash in it (a name that could escape the base URL is not a name). So the fifteen mirrored rows
# collapse into a single asset whose `file` is the repo's directory name, whose `bytes` is their sum,
# and which carries `runtime: "transformers"` so the app knows which provider to build for it.
#
# NO `sha256` ON THAT ROW, and that is the honest answer rather than a gap: fifteen files have fifteen
# hashes and no single one. Each of them WAS verified on the way into the bucket (the Worker refuses a
# mismatch and deletes the object), and the per-file list with its hashes is `GEMMA_4_E2B_ONNX_FILES`
# in packages/agent-models/src/transformers.ts. A made-up aggregate hash would be worse than none.
write_catalog() {
  local dest="$1" first=1 row
  local repo commit file bytes sha licence gated vision runtime prefix lic
  {
    echo '{ "version": 1, "base": "'"$DL_URL"'/litert", "publishedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
    echo '  "notice": "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms",'
    echo '  "noticeUrl": "'"$DL_URL"'/litert/NOTICE.txt", "gemmaTermsUrl": "'"$DL_URL"'/litert/GEMMA_TERMS.md",'
    echo '  "gemmaProhibitedUseUrl": "https://ai.google.dev/gemma/prohibited_use_policy", "assets": ['
    # Pass one: the LiteRT bundles, one asset per file, exactly as before the ONNX rows existed.
    for row in "${mirrored[@]}"; do
      IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix <<< "$row"
      [ "${runtime:-litert}" = "litert" ] || continue
      [ $first -eq 1 ] || echo ','
      first=0
      lic=$(licence_json "$licence")
      printf '  { "file": "%s", "bytes": %s, "sha256": "%s", "source": "https://huggingface.co/%s/blob/%s/%s", %s, "gatedAtSource": %s, "vision": %s }' \
        "$file" "$bytes" "$sha" "$repo" "$commit" "$file" "$lic" "$([ "$gated" = yes ] && echo true || echo false)" "$([ "$vision" = yes ] && echo true || echo false)"
    done
    # Pass two: one asset per Transformers.js repo, with its files added up.
    local groups g_prefix g_repo g_commit g_licence g_vision total count dir
    groups=$(for row in "${mirrored[@]}"; do
      IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix <<< "$row"
      [ "${runtime:-litert}" = "transformers" ] && echo "$prefix|$repo|$commit|$licence|$vision"
    done | sort -u)
    while IFS='|' read -r g_prefix g_repo g_commit g_licence g_vision; do
      [ -z "$g_prefix" ] && continue
      total=0; count=0
      for row in "${mirrored[@]}"; do
        IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix <<< "$row"
        [ "$prefix" = "$g_prefix" ] || continue
        total=$((total + bytes)); count=$((count + 1))
      done
      dir=${g_prefix##*/}
      [ $first -eq 1 ] || echo ','
      first=0
      lic=$(licence_json "$g_licence")
      printf '  { "file": "%s", "bytes": %s, "runtime": "transformers", "files": %s, "source": "https://huggingface.co/%s/tree/%s", %s, "gatedAtSource": false, "vision": %s }' \
        "$dir" "$total" "$count" "$g_repo" "$g_commit" "$lic" "$([ "$g_vision" = yes ] && echo true || echo false)"
    done <<< "$groups"
    echo; echo '] }'
  } > "$dest"
}

# One licence block, named once, so the two passes above cannot disagree about the Gemma terms.
licence_json() {
  case "$1" in
    gemma) echo '"license": "gemma", "licenseName": "Gemma Terms of Use", "licenseUrl": "https://ai.google.dev/gemma/terms", "termsCopyUrl": "'"$DL_URL"'/litert/GEMMA_TERMS.md", "useRestrictionsUrl": "https://ai.google.dev/gemma/prohibited_use_policy"' ;;
    *) echo '"license": "'"$1"'", "licenseName": "Apache License 2.0", "licenseUrl": "https://www.apache.org/licenses/LICENSE-2.0"' ;;
  esac
}

if [ $DRY -eq 1 ]; then
  echo
  echo "── litert/catalog.json this publish would write ─────────────────────────────"
  write_catalog /dev/stdout
  exit 0
fi

# Section 3.1 of the Gemma terms: a NOTICE beside every distribution and a copy of the Agreement for
# every recipient. Both tracked in scripts/litert-notices/ and put up on every run, so a stale copy
# in the bucket cannot outlive an edit here.
NOTICES_DIR="$(cd "$(dirname "$0")/litert-notices" && pwd)"
"$WRANGLER" r2 object put "$R2_BUCKET/litert/NOTICE.txt" --file "$NOTICES_DIR/NOTICE.txt" --remote \
  --content-type "text/plain; charset=utf-8" --cache-control "public, max-age=3600" >/dev/null
"$WRANGLER" r2 object put "$R2_BUCKET/litert/GEMMA_TERMS.md" --file "$NOTICES_DIR/GEMMA_TERMS.md" --remote \
  --content-type "text/markdown; charset=utf-8" --cache-control "public, max-age=3600" >/dev/null
echo "✓ $DL_URL/litert/NOTICE.txt and GEMMA_TERMS.md"

cat_json=$(mktemp -t litert-catalog.XXXXXX.json)
write_catalog "$cat_json"
"$WRANGLER" r2 object put "$R2_BUCKET/litert/catalog.json" --file "$cat_json" --remote --content-type application/json \
  --cache-control "public, max-age=300" >/dev/null
rm -f "$cat_json"
echo "✓ $DL_URL/litert/catalog.json lists ${#mirrored[@]} assets"
