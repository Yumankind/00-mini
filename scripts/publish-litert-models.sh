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

# repo | commit | file | bytes | sha256 (from the Hub's LFS record) | licence | gated | vision | runtime | key prefix | hosts
#
# `hosts` (2026-09-11, Bruno: "gate the models to the compatible harness") is a comma-separated list of
# the harnesses a row may be OFFERED on — `browser-desktop`, `browser-phone`, `mac`, `headless`. It
# travels into `catalog.json` per asset and is the ONE gate the app's picker asks; the vocabulary is
# `Host` in packages/shared/src/models.ts, shared with the Mac side. A row that names none is read by
# the app as desktop-only (`DEFAULT_HOSTS`), which is the conservative reading — so every row here
# names its own rather than relying on it.
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
litert-community/gemma-4-E2B-it-litert-lm|b3ca0d2f|gemma-4-E2B-it-web.task|2003697664|2cbff161177a4d51c9d04360016185976f504517ba5758cd10c1564e5421c5a5|apache-2.0|no|no|litert|litert|browser-desktop
litert-community/gemma-4-E4B-it-litert-lm|2eee7ac3|gemma-4-E4B-it-web.task|2964324352|f3bd72fc27627be2a2cc6722199a333599590ed0962ee7047b516a506b7bf086|apache-2.0|no|no|litert|litert|browser-desktop
litert-community/gemma-4-12B-it-litert-lm|7a0b1ce0|gemma-4-12B-it-web.litertlm|5986074624|d37f9392b4f093b470b50b72624c9a752cc0b288ed549b769037cbbd04024449|apache-2.0|no|no|litert|litert|browser-desktop
google/gemma-3n-E2B-it-litert-lm|c03b6f60|gemma-3n-E2B-it-int4-Web.litertlm|3038117888|b6c8e1081ec80730f14473a5ece941b48da5d8e2a80c97c2963da153f3eff3d2|gemma|yes|yes|litert|litert|browser-desktop
google/gemma-3n-E4B-it-litert-lm|297ed759|gemma-3n-E4B-it-int4-Web.litertlm|4275044352|63730ba3225a23a90d3292d89fdeff1a7537cedeb72aa687de9a35732d057e52|gemma|yes|yes|litert|litert|browser-desktop
litert-community/gemma-3-270m-it|9d209327|gemma3-270m-it-q4_0-web.task|249233408|a642cc7b183373dbcb186b1d94bf7ac9c0cfff6a2e73a5837ba2ffcffa4ac1ac|gemma|yes|no|litert|litert|browser-desktop,browser-phone
litert-community/Gemma3-1B-IT|a6306a4e|gemma3-1b-it-int4-web.task|700383232|74f37adc3f94af1eaa0be70875b10060b2a2e45d533bfb7d5e2c08d3e4050cfe|gemma|yes|no|litert|litert|browser-desktop,browser-phone
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
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|config.json|5549|5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|generation_config.json|238|e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|preprocessor_config.json|43|4457c6e8a09070d7d5d1cd983fbfb67ebafe602bd98120c3543a024f5d07056b|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|processor_config.json|1689|32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|chat_template.jinja|16317|781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|tokenizer_config.json|18807|06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|tokenizer.json|19439251|47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/embed_tokens_q4f16.onnx|5621|d7ca53f6a169471b5699b2f57ee4c7aa2c73732b0152f3909e64b71384444825|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/embed_tokens_q4f16.onnx_data|1590689792|024b199e6358ed42970f807686add5f9430d7e254ca7ce22fc9c83f015b9c517|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/decoder_model_merged_q4f16.onnx|673231|73c0f1fe04f9a3a048fb3319c0671b6cf0346bf33a3a8624c853bcffe01c24a4|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/decoder_model_merged_q4f16.onnx_data|1519700992|3b27245a7396cb7039a4e4118bd2a8aa35106bae381522edf7c4867b5f22bb10|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/vision_encoder_q4f16.onnx|189124|e0a4e48e519ade4eeddbb4cdadb812a7251aea871f7fb5f50576615fd3af22a3|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/vision_encoder_q4f16.onnx_data|99189440|0835071d2c79c105f8e1b549b7f8dd8c9af07fa95f01ead2e7add280602d3c6d|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/audio_encoder_q4f16.onnx|260446|5e0deb22791685c792d4b8e089deef9670fa4a4cecde434213d6a742e58fc3fa|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
onnx-community/gemma-4-E2B-it-ONNX|9f4bef82ea6e296bc69f8a2f5939f73af81b07a6|onnx/audio_encoder_q4f16.onnx_data|171258112|df58e61a00bafa9449ee5fd52895ce952f158bbdd1fe38df8a68f48f36842e62|apache-2.0|no|yes|transformers|onnx/onnx-community/gemma-4-E2B-it-ONNX|browser-desktop
'

# ── Qwen3.5 0.8B — THE FIRST PHONE ROW THAT SEES (2026-09-11) ────────────────────────────────────
#
# Three q4f16 graphs (embed_tokens, decoder_model_merged, vision_encoder) and no audio encoder: its
# `model_type` is `qwen3_5`, which the installed library maps to `Qwen3_5ForConditionalGeneration` in
# `MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING_NAMES`, and plain `ImageTextToText` builds no audio session
# (unlike Gemma 4's `ImageAudioTextToText`, above). 0.67 GB in total, which is why it is the one ONNX
# row `hosts` offers to a phone — beside Gemma 3 270m, which is smaller and cannot see.
# Apache-2.0 is declared on the export itself, with a link to the base model's LICENSE.
ASSETS="$ASSETS"'
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|config.json|2849|36fed6a902ccd06ef19a452bd5a0750bd88fe347d06ab75ef515615bac5b296d|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|generation_config.json|248|dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|preprocessor_config.json|336|6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|processor_config.json|1300|14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|chat_template.jinja|7755|273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|tokenizer_config.json|9161|fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|tokenizer.json|19226111|89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|onnx/embed_tokens_q4f16.onnx|1064|8218531ac44ae9978d50647f1d907c53c308f758514b992504238c77843c254d|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|onnx/embed_tokens_q4f16.onnx_data|147005440|ec4a1f13ff942653b52000a7a0ec40504110d8be9a0ecab2da4d3063588ed563|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|onnx/decoder_model_merged_q4f16.onnx|1036898|34e17c8e2035919df86ab1f52b41999a1bd18ba96b49dba6ac8d340aae652006|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|onnx/decoder_model_merged_q4f16.onnx_data|436662272|468cf83a51e81e27ffb4210268b1b09979e68dd128ad5fe347e5d08721cecc41|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|onnx/vision_encoder_q4f16.onnx|212694|38af0f1a2ef1d1d9c80ba4fd3bb59db8481b03b5e062999b4d6d9d14e9e0fc7b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
onnx-community/Qwen3.5-0.8B-ONNX|c0d619322dad7c4441a8841a53fc59772ddddcc0|onnx/vision_encoder_q4f16.onnx_data|61919744|0847376fcef41cb3874a21f0eb1b75428502537e16f360bdbf854e71ef552319|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-0.8B-ONNX|browser-desktop,browser-phone
'
# ── Qwen3.5 2B and 4B — the same three graphs, larger, desktop only ──────────────────────────────
#
# THEIR LICENCE IS VERIFIED AT THE BASE MODEL. Both `-OPT` exports have README front matter that names
# `base_model:` and NO `license:` at all; `Qwen/Qwen3.5-2B` and `Qwen/Qwen3.5-4B` both answer
# `apache-2.0` with a LICENSE file beside their weights (Hub model API, read 2026-09-11). The 4B's
# decoder is the one q4f16 graph in this table with TWO external-data chunks
# (`use_external_data_format: { "decoder_model_merged_q4f16.onnx": 2 }`), and its second chunk is
# byte-identical to its embed_tokens data — the same sha256, which the Hub stores once and serves twice.
ASSETS="$ASSETS"'
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|config.json|2993|b028de63b0ed8b37107acaaf1475d40d6d4feb5721153674e7d1d0bdbfd0f258|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|generation_config.json|248|dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|preprocessor_config.json|336|6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|processor_config.json|1300|14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|chat_template.jinja|7755|273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|tokenizer_config.json|9161|fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|tokenizer.json|19226111|89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|onnx/embed_tokens_q4f16.onnx|1064|802a072ff21f540eda7f343aa71dbb0354c8859caaf34f09b3bf8117725d7de8|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|onnx/embed_tokens_q4f16.onnx_data|294010880|650aa8eb39b7404ca2c908d78243c82b6fd88321feeb8fca175745806c6b3a81|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|onnx/decoder_model_merged_q4f16.onnx|707377|c567d4d34dc97185e85bb40c9c30d6f73133858b1f8a32b90166b7fea4b653bf|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|onnx/decoder_model_merged_q4f16.onnx_data|1088892928|06dd7841f90e5c4ecc029193a29478750ae9dcbfeaf8cfb223cf8b69cc5666d6|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|onnx/vision_encoder_q4f16.onnx|394142|2999a8fb031d394a0697c5413eb0bb624e45e4c3aacefd67524d4627679423d5|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-2B-ONNX-OPT|2ea7886f48b926aca97de8b0e041ffca7e3ebaa9|onnx/vision_encoder_q4f16.onnx_data|196945920|c54ed06141904a99fa05a9ffaf460ee05441d50dde54f784ec2ae71a43c58314|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-2B-ONNX-OPT|browser-desktop
'
ASSETS="$ASSETS"'
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|config.json|3198|c6f9834460177e3821e035900320fa24bd11ad1c9f14bfe2e78e4398e38c4937|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|generation_config.json|248|dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|preprocessor_config.json|336|6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|processor_config.json|1300|14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|chat_template.jinja|7756|a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|tokenizer_config.json|9162|2de621ec071dd61438efdd6d0183bd3d612e98d05ac10d19ed75f1fef9299bc9|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|tokenizer.json|19226111|89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/embed_tokens_q4f16.onnx|1064|0e5fe965e5575b6428b7dea82661ed09bf7abadf29450c279e46e8113745110e|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/embed_tokens_q4f16.onnx_data|367513600|fc1bb145d8839272a87c71e0cb4d34832a0d7bb4de06ab4fb74fea1aa6ddf7e5|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/decoder_model_merged_q4f16.onnx|933554|8f159924389ced435ff445b9aaf1604d7de7756961299568f106990415bedcbb|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/decoder_model_merged_q4f16.onnx_data|2065635328|83a2b12931978d2a3577f1f1a19e7ec42b87a760e87567dd26313fd933dcddd3|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/decoder_model_merged_q4f16.onnx_data_1|367513600|fc1bb145d8839272a87c71e0cb4d34832a0d7bb4de06ab4fb74fea1aa6ddf7e5|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/vision_encoder_q4f16.onnx|394142|68b093637448ec24a8f364546be8ce1d7ce6712b2c6df3de033e38382138ba32|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
onnx-community/Qwen3.5-4B-ONNX-OPT|57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7|onnx/vision_encoder_q4f16.onnx_data|198159360|c52931db472718a0b045b03487497e01b29a63028944bcc57019c20ef4ea15ff|apache-2.0|no|yes|transformers|onnx/onnx-community/Qwen3.5-4B-ONNX-OPT|browser-desktop
'
# ── The two TEXT rows: one graph each, and a different door in the library ───────────────────────
#
# `Phi3ForCausalLM` and `LlamaForCausalLM` are `DecoderOnly` in the library's session config: ONE
# `model` graph, no embed_tokens and no encoders, which is why these lists are five and six files
# rather than thirteen. Both load through `AutoTokenizer` + `AutoModelForCausalLM`
# (packages/agent-models/src/transformers.ts, `loadPromptSide`). Neither ships a processor config, so
# neither could load through the vision door at all.
#
# Phi-4-mini's export carries no licence tag either; `microsoft/Phi-4-mini-instruct` answers `mit`.
ASSETS="$ASSETS"'
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|config.json|2735|13f196a6d99bfe053c183adf47a8ff772b1d70802a1927206a705d3fd99b132f|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|generation_config.json|168|4d8c499900ee9a4c4b1bca1887bc5a5c5ac9b01a57a364f30c583cdd1019cc72|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|chat_template.jinja|423|febf589225c9728ab791f52e8897d7607a823d45368f0a4c92fa68997b40cce9|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|tokenizer_config.json|766|e263ca0b737a5e1ffc6bcb8ca1b0c85ae7febc90ecbf1aac968170f0f79b4feb|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|tokenizer.json|13303196|9ca5aa723a31a7a122497e059bd48dd67a5bd03ad16b3ffcf16093fd3021c1eb|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|onnx/model_q4f16.onnx|26270832|ca26127777adf1df99b5fc1a3b4d1e0c426a6bf56626889873bfc4a6a095b4fc|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|onnx/model_q4f16.onnx_data|2087043072|385526d648e4b3e361f3117564a6bd3cad7712a5c06fa23401763187674fd46c|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
onnx-community/Phi-4-mini-instruct-ONNX|e61f45fc5fabba2aee31ff85ba4cf99219b4bf28|onnx/model_q4f16.onnx_data_1|438239232|b9a5d6f40fde30e9155d671dc630d2ea554f903f01c4ef8bbdc64c5b38035923|mit|no|no|transformers|onnx/onnx-community/Phi-4-mini-instruct-ONNX|browser-desktop
'
# Llama 3.2 is the one row here with an obligation beyond a link: the Community License asks that
# "Built with Llama" be displayed (§1.b.i) and incorporates an Acceptable Use Policy (§5). Both
# verbatim copies are published beside the weights from scripts/litert-notices/, the catalogue row
# carries their URLs and the attribution line, and the app shows all three before the download.
ASSETS="$ASSETS"'
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|config.json|1162|93104420bd10292f1db7f2a0d940f431d760096b46bfa5de64cd6efa613a9e5c|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|generation_config.json|218|8baea8f248b53e37390f42aa732068b887668357bc09fd1a3361ba91e7b67cda|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|chat_template.jinja|3827|5816fce10444e03c2e9ee1ef8a4a1ea61ae7e69e438613f3b17b69d0426223a4|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|special_tokens_map.json|296|6f38c73729248f6c127296386e3cdde96e254636cc58b4169d3fd32328d9a8ec|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|tokenizer_config.json|54557|fb8e113b6240ab997fe87464b8b58697cc769a8df40699356e8524d0dfc60c0e|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|tokenizer.json|11574638|3a223ade375cc1d13b04e897ce1d36a04f50140e1ba3d107021ea68d4b5e614c|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|onnx/model_q4f16.onnx|260899|43648be8ff45ed7bc75c75ea0d495beffa8a8632910e53d3aa824d6bfffaae46|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|onnx/model_q4f16.onnx_data|2095929344|0669c8c258ea5437b82cc17e5ca87bb91a9ede5b2f5ff80675c0b8e51f1b6043|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
onnx-community/Llama-3.2-3B-Instruct-ONNX|cab364e7d0e1de7aa09e3abc932be92361c5b55f|onnx/model_q4f16.onnx_data_1|311427072|63b1b82298ad66f940b4f918f81c386fbe4e15a4e178efb14bc558d127185113|llama3.2|no|no|transformers|onnx/onnx-community/Llama-3.2-3B-Instruct-ONNX|browser-desktop
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
while IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix hosts; do
  [ -z "$repo" ] && continue
  # A row written before the 2026-09-11 columns existed would arrive without them; defaulted rather
  # than refused, so this loop keeps working on a table someone edits in a hurry. `hosts` defaults to
  # the desktop, which is the same conservative reading the app applies to a row that names none.
  runtime="${runtime:-litert}"; prefix="${prefix:-litert}"; hosts="${hosts:-browser-desktop}"
  key="$prefix/$file"
  # Matched against the KEY, not the bare file name: `--only ONNX` has to be able to select a whole
  # repo whose fifteen file names have nothing in common.
  if [ -n "$ONLY" ] && [[ "$key" != *"$ONLY"* ]]; then continue; fi
  url="https://huggingface.co/$repo/resolve/$commit/$file"
  row="$repo|$commit|$file|$bytes|$sha|$licence|$gated|$vision|$runtime|$prefix|$hosts"

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
  local repo commit file bytes sha licence gated vision runtime prefix hosts lic
  {
    echo '{ "version": 1, "base": "'"$DL_URL"'/litert", "publishedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
    echo '  "notice": "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms",'
    echo '  "noticeUrl": "'"$DL_URL"'/litert/NOTICE.txt", "gemmaTermsUrl": "'"$DL_URL"'/litert/GEMMA_TERMS.md",'
    echo '  "gemmaProhibitedUseUrl": "https://ai.google.dev/gemma/prohibited_use_policy", "assets": ['
    # Pass one: the LiteRT bundles, one asset per file, exactly as before the ONNX rows existed.
    for row in "${mirrored[@]}"; do
      IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix hosts <<< "$row"
      [ "${runtime:-litert}" = "litert" ] || continue
      [ $first -eq 1 ] || echo ','
      first=0
      lic=$(licence_json "$licence")
      printf '  { "file": "%s", "bytes": %s, "sha256": "%s", "source": "https://huggingface.co/%s/blob/%s/%s", %s, "hosts": %s, "gatedAtSource": %s, "vision": %s }' \
        "$file" "$bytes" "$sha" "$repo" "$commit" "$file" "$lic" "$(hosts_json "$hosts")" "$([ "$gated" = yes ] && echo true || echo false)" "$([ "$vision" = yes ] && echo true || echo false)"
    done
    # Pass two: one asset per Transformers.js repo, with its files added up.
    local groups g_prefix g_repo g_commit g_licence g_vision g_hosts total count dir
    # `awk '!seen[$0]++'` rather than `sort -u`: the de-duplication must keep THE TABLE'S OWN ORDER,
    # because that order is what the picker draws (the app takes the mirror's order as given). Sorted,
    # the list would open on whichever repo's name happens to come first in the alphabet.
    groups=$(for row in "${mirrored[@]}"; do
      IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix hosts <<< "$row"
      [ "${runtime:-litert}" = "transformers" ] && echo "$prefix|$repo|$commit|$licence|$vision|$hosts"
    done | awk '!seen[$0]++')
    while IFS='|' read -r g_prefix g_repo g_commit g_licence g_vision g_hosts; do
      [ -z "$g_prefix" ] && continue
      total=0; count=0
      for row in "${mirrored[@]}"; do
        IFS='|' read -r repo commit file bytes sha licence gated vision runtime prefix hosts <<< "$row"
        [ "$prefix" = "$g_prefix" ] || continue
        total=$((total + bytes)); count=$((count + 1))
      done
      dir=${g_prefix##*/}
      [ $first -eq 1 ] || echo ','
      first=0
      lic=$(licence_json "$g_licence")
      printf '  { "file": "%s", "bytes": %s, "runtime": "transformers", "files": %s, "source": "https://huggingface.co/%s/tree/%s", %s, "hosts": %s, "gatedAtSource": false, "vision": %s }' \
        "$dir" "$total" "$count" "$g_repo" "$g_commit" "$lic" "$(hosts_json "$g_hosts")" "$([ "$g_vision" = yes ] && echo true || echo false)"
    done <<< "$groups"
    echo; echo '] }'
  } > "$dest"
}

# One licence block per licence, named once, so the two passes above cannot disagree about what a row
# carries. Two of these ask for more than a link and say so in the fields the app reads:
#   · `useRestrictionsUrl` — a policy the person must be pointed at before the download;
#   · `termsCopyUrl`       — the verbatim copy published beside the weights (Gemma §3.1, Llama §1.b);
#   · `attribution`        — a LINE TO DISPLAY, which is Llama 3.2 §1.b.i and nothing else here.
licence_json() {
  case "$1" in
    gemma) echo '"license": "gemma", "licenseName": "Gemma Terms of Use", "licenseUrl": "https://ai.google.dev/gemma/terms", "termsCopyUrl": "'"$DL_URL"'/litert/GEMMA_TERMS.md", "useRestrictionsUrl": "https://ai.google.dev/gemma/prohibited_use_policy"' ;;
    llama3.2) echo '"license": "llama3.2", "licenseName": "Llama 3.2 Community License", "licenseUrl": "https://www.llama.com/llama3_2/license/", "termsCopyUrl": "'"$DL_URL"'/litert/LLAMA_3_2_LICENSE.txt", "useRestrictionsUrl": "https://www.llama.com/llama3_2/use-policy", "attribution": "Built with Llama"' ;;
    mit) echo '"license": "mit", "licenseName": "MIT License", "licenseUrl": "https://opensource.org/license/mit"' ;;
    *) echo '"license": "'"$1"'", "licenseName": "Apache License 2.0", "licenseUrl": "https://www.apache.org/licenses/LICENSE-2.0"' ;;
  esac
}

# `browser-desktop,browser-phone` → `["browser-desktop","browser-phone"]`. The app validates every
# word against its own four and drops what it does not know, so a typo here narrows a row rather than
# breaking a catalogue — but it is still a typo, and `--dry-run` prints what this writes.
hosts_json() {
  local out="" word
  for word in ${1//,/ }; do
    [ -n "$word" ] || continue
    out="$out${out:+,}\"$word\""
  done
  echo "[$out]"
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
# Llama 3.2 §1.b: the Agreement travels with the Materials, and §5 incorporates the use policy. Both
# are verbatim copies of the files in the ONNX repo itself, tracked beside the Gemma ones.
"$WRANGLER" r2 object put "$R2_BUCKET/litert/LLAMA_3_2_LICENSE.txt" --file "$NOTICES_DIR/LLAMA_3_2_LICENSE.txt" --remote \
  --content-type "text/plain; charset=utf-8" --cache-control "public, max-age=3600" >/dev/null
"$WRANGLER" r2 object put "$R2_BUCKET/litert/LLAMA_3_2_USE_POLICY.md" --file "$NOTICES_DIR/LLAMA_3_2_USE_POLICY.md" --remote \
  --content-type "text/markdown; charset=utf-8" --cache-control "public, max-age=3600" >/dev/null
echo "✓ $DL_URL/litert/NOTICE.txt, GEMMA_TERMS.md, LLAMA_3_2_LICENSE.txt and LLAMA_3_2_USE_POLICY.md"

cat_json=$(mktemp -t litert-catalog.XXXXXX.json)
write_catalog "$cat_json"
"$WRANGLER" r2 object put "$R2_BUCKET/litert/catalog.json" --file "$cat_json" --remote --content-type application/json \
  --cache-control "public, max-age=300" >/dev/null
rm -f "$cat_json"
echo "✓ $DL_URL/litert/catalog.json lists ${#mirrored[@]} assets"
