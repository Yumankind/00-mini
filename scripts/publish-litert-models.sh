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
# Keys are FLAT under litert/ so `LiteRtProvider({ modelBaseUrl: "https://dl.0-0.chat/litert" })`
# resolves `<modelBaseUrl>/<assetFile>` with no per-repo path (packages/agent-models/src/litert.ts).
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

# repo | commit | file | bytes | sha256 (from the Hub's LFS record) | licence | gated | vision
# Sizes and hashes were read from the Hub API on 2026-09-10; the script re-verifies the hash on the
# way through, so a stale row fails loudly rather than mirroring the wrong bytes.
ASSETS='
litert-community/gemma-4-E2B-it-litert-lm|b3ca0d2f|gemma-4-E2B-it-web.task|2003697664|2cbff161177a4d51c9d04360016185976f504517ba5758cd10c1564e5421c5a5|apache-2.0|no|no
litert-community/gemma-4-E4B-it-litert-lm|2eee7ac3|gemma-4-E4B-it-web.task|2964324352|f3bd72fc27627be2a2cc6722199a333599590ed0962ee7047b516a506b7bf086|apache-2.0|no|no
litert-community/gemma-4-12B-it-litert-lm|7a0b1ce0|gemma-4-12B-it-web.litertlm|5986074624|d37f9392b4f093b470b50b72624c9a752cc0b288ed549b769037cbbd04024449|apache-2.0|no|no
google/gemma-3n-E2B-it-litert-lm|c03b6f60|gemma-3n-E2B-it-int4-Web.litertlm|3038117888|b6c8e1081ec80730f14473a5ece941b48da5d8e2a80c97c2963da153f3eff3d2|gemma|yes|yes
google/gemma-3n-E4B-it-litert-lm|297ed759|gemma-3n-E4B-it-int4-Web.litertlm|4275044352|63730ba3225a23a90d3292d89fdeff1a7537cedeb72aa687de9a35732d057e52|gemma|yes|yes
litert-community/gemma-3-270m-it|9d209327|gemma3-270m-it-q4_0-web.task|249233408|a642cc7b183373dbcb186b1d94bf7ac9c0cfff6a2e73a5837ba2ffcffa4ac1ac|gemma|yes|no
litert-community/Gemma3-1B-IT|a6306a4e|gemma3-1b-it-int4-web.task|700383232|74f37adc3f94af1eaa0be70875b10060b2a2e45d533bfb7d5e2c08d3e4050cfe|gemma|yes|no
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
while IFS='|' read -r repo commit file bytes sha licence gated vision; do
  [ -z "$repo" ] && continue
  if [ -n "$ONLY" ] && [[ "$file" != *"$ONLY"* ]]; then continue; fi
  key="litert/$file"
  url="https://huggingface.co/$repo/resolve/$commit/$file"

  # Already there with the right size → skip. `curl -sI` on the public URL is the cheapest head we have.
  have=$(curl -sI "$DL_URL/$key" | awk 'tolower($1)=="content-length:"{gsub("\r","",$2);print $2}' | tail -1)
  if [ "${have:-}" = "$bytes" ]; then
    echo "= $key already mirrored ($bytes bytes)"; mirrored+=("$repo|$commit|$file|$bytes|$sha|$licence|$gated|$vision"); continue
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

  echo "→ $file ($((bytes / 1048576)) MB) from $repo@$commit"
  [ $DRY -eq 1 ] && continue

  # THE COPY HAPPENS AT THE EDGE. `wrangler r2 object put` refuses anything over 300 MiB, so the bytes
  # never come here: scripts/r2-mirror is a tool Worker with the bucket bound, deployed for this run
  # and deleted at the end, that fetches the Hub URL into a multipart upload and hashes it on the way.
  # The last line of its streamed answer is `ok <key> <bytes> <sha256>` or `error …`.
  payload=$(python3 -c 'import json,sys; print(json.dumps({"url":sys.argv[1],"key":sys.argv[2],"sha256":sys.argv[3],"bytes":int(sys.argv[4]),"contentType":"application/octet-stream"}))' "$url" "$key" "$sha" "$bytes")
  # Two tries: the first call after a deploy has answered a bare 500 once (the Worker's own errors
  # arrive as an `error …` line with status 200, so a non-200 is the platform, not the copy).
  result=""
  for attempt in 1 2 3; do
    log=$(mktemp -t litert-mirror.XXXXXX)
    status=$(curl -sS -o "$log" -w '%{http_code}' -X POST "$MIRROR_URL" -H "x-mirror-token: $MIRROR_TOKEN" \
      -H "content-type: application/json" --data "$payload" || echo 000)
    grep -v '^part ' "$log" >&2 || true
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
  mirrored+=("$repo|$commit|$file|$bytes|$sha|$licence|$gated|$vision")
done <<< "$ASSETS"

[ $DRY -eq 1 ] && exit 0

# Section 3.1 of the Gemma terms: a NOTICE beside every distribution and a copy of the Agreement for
# every recipient. Both tracked in scripts/litert-notices/ and put up on every run, so a stale copy
# in the bucket cannot outlive an edit here.
NOTICES_DIR="$(cd "$(dirname "$0")/litert-notices" && pwd)"
"$WRANGLER" r2 object put "$R2_BUCKET/litert/NOTICE.txt" --file "$NOTICES_DIR/NOTICE.txt" --remote \
  --content-type "text/plain; charset=utf-8" --cache-control "public, max-age=3600" >/dev/null
"$WRANGLER" r2 object put "$R2_BUCKET/litert/GEMMA_TERMS.md" --file "$NOTICES_DIR/GEMMA_TERMS.md" --remote \
  --content-type "text/markdown; charset=utf-8" --cache-control "public, max-age=3600" >/dev/null
echo "✓ $DL_URL/litert/NOTICE.txt and GEMMA_TERMS.md"

# The catalog the app can read beside the files: what is here, from where, under which licence.
cat_json=$(mktemp -t litert-catalog.XXXXXX.json)
{
  echo '{ "version": 1, "base": "'"$DL_URL"'/litert", "publishedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
  echo '  "notice": "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms",'
  echo '  "noticeUrl": "'"$DL_URL"'/litert/NOTICE.txt", "gemmaTermsUrl": "'"$DL_URL"'/litert/GEMMA_TERMS.md",'
  echo '  "gemmaProhibitedUseUrl": "https://ai.google.dev/gemma/prohibited_use_policy", "assets": ['
  first=1
  for row in "${mirrored[@]}"; do
    IFS='|' read -r repo commit file bytes sha licence gated vision <<< "$row"
    [ $first -eq 1 ] || echo ','
    first=0
    case "$licence" in
      gemma) lic='"license": "gemma", "licenseName": "Gemma Terms of Use", "licenseUrl": "https://ai.google.dev/gemma/terms", "termsCopyUrl": "'"$DL_URL"'/litert/GEMMA_TERMS.md", "useRestrictionsUrl": "https://ai.google.dev/gemma/prohibited_use_policy"' ;;
      *) lic='"license": "'"$licence"'", "licenseName": "Apache License 2.0", "licenseUrl": "https://www.apache.org/licenses/LICENSE-2.0"' ;;
    esac
    printf '  { "file": "%s", "bytes": %s, "sha256": "%s", "source": "https://huggingface.co/%s/blob/%s/%s", %s, "gatedAtSource": %s, "vision": %s }' \
      "$file" "$bytes" "$sha" "$repo" "$commit" "$file" "$lic" "$([ "$gated" = yes ] && echo true || echo false)" "$([ "$vision" = yes ] && echo true || echo false)"
  done
  echo; echo '] }'
} > "$cat_json"
"$WRANGLER" r2 object put "$R2_BUCKET/litert/catalog.json" --file "$cat_json" --remote --content-type application/json \
  --cache-control "public, max-age=300" >/dev/null
rm -f "$cat_json"
echo "✓ $DL_URL/litert/catalog.json lists ${#mirrored[@]} assets"
