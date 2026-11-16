#!/bin/sh
# Builds the M1 reference project (the spec's scene and cast examples) using only the CLI:
# init, patch apply, one propose + approve, and show. Usage: build.sh <output dir>
# CINEWRIGHT is the command to run (default: the built CLI in this repository).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
CW=${CINEWRIGHT:-"node $REPO/cli/dist/bin.js"}
OUT=$1
PROFILES="$REPO/core/test/fixtures/profiles"
export CINEWRIGHT_SESSION_ID=m1-reference
export CINEWRIGHT_FIXED_TIME=2026-11-13T00:00:00Z

$CW init "$OUT" --id demo --title "Why pipelines break" --pack neutral \
  --deliverable "web_landscape=$PROFILES/landscape_1080p30.json" \
  --deliverable "social_portrait=$PROFILES/portrait_1080p30.json"
for patch in "$HERE"/patches/0[1-7]-*.json; do
  case "$patch" in *" "*) continue ;; esac # patch names have no spaces; skip stray copies
  $CW patch apply --project "$OUT" --file "$patch"
done
$CW patch propose --project "$OUT" --file "$HERE/patches/08-proposal.json"
$CW patch approve p1 --project "$OUT"
$CW show s03_the_problem --project "$OUT" > /dev/null
