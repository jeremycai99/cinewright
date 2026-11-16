#!/bin/sh
# Render key v1 and determinism (M3.2b): render the M1 reference shot twice from an empty cache,
# check both renders match, check a third run is a cache hit, and record the hashes for the
# cross-runner comparison. Usage: reference-shot.sh <image> <work dir> <record dir>
set -eu
IMAGE=$1
WORK=$2
RECORD=$3
REPO=$(cd "$(dirname "$0")/../.." && pwd)
CW="node $REPO/cli/dist/bin.js"
TIMING="$REPO/cli/test/fixtures/m1-reference/timing.json"
rm -rf "$WORK"
mkdir -p "$WORK" "$RECORD"
cp -R "$REPO/cli/test/fixtures/m1-reference/project" "$WORK/project"
$CW patch apply --project "$WORK/project" --file "$REPO/plugins/backend-hyperframes/test/fixtures/regions.json" > /dev/null
render() {
  $CW render-shot s03.sh01 --deliverable web_landscape --timing "$TIMING" --image "$IMAGE" \
    --project "$WORK/project" --json
}
field() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
first=$(render)
key=$(echo "$first" | field key)
dir=$(echo "$first" | field dir)
cp "$dir/framemd5.txt" "$RECORD/reference-framemd5.txt"
cp "$dir/sha256.txt" "$RECORD/reference-sha256.txt"
rm -rf "$WORK/project/.cinewright/cache/renders"
second=$(render)
[ "$(echo "$second" | field key)" = "$key" ] || { echo "::error::render key changed between runs"; exit 1; }
cmp "$RECORD/reference-framemd5.txt" "$(echo "$second" | field dir)/framemd5.txt" || { echo "::error::reference shot frames differ between renders"; exit 1; }
cmp "$RECORD/reference-sha256.txt" "$(echo "$second" | field dir)/sha256.txt" || { echo "::error::reference shot bytes differ between renders"; exit 1; }
[ "$(render | field hit)" = "True" ] || { echo "::error::an unchanged shot was not a cache hit"; exit 1; }
echo "reference shot: key $key, two identical renders, then a cache hit"
