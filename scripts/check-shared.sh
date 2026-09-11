#!/usr/bin/env sh
# packages/shared here is a COPY of the files 00 Mini needs from the private 00 repository's
# @00/shared (the transitive closure of what the packages and the app import). This pins each copied
# file by sha256 so a drift is a failing check rather than a silent fork.
# `scripts/check-shared.sh --update` rewrites the pins after a deliberate copy.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
pins="$here/packages/shared/PINS.sha256"
if [ "${1:-}" = "--update" ]; then
  (cd "$here" && find packages/shared/src -type f | sort | xargs shasum -a 256) > "$pins"
  echo "pins rewritten: $pins"; exit 0
fi
(cd "$here" && shasum -a 256 -c "$pins" --quiet) && echo "shared copy matches its pins"
