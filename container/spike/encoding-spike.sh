#!/usr/bin/env bash
# Temporary (Task 9): render hello-world 3x per encode mode, plus HyperFrames' encode at two
# CPU quotas, and report framemd5 / sha256 / keyframe positions. Removed after the decision.
# Usage: container/spike/encoding-spike.sh IMAGE OUT_DIR
set -euo pipefail
image=$1; out=$(mkdir -p "$2" && cd "$2" && pwd)
repo=$(cd "$(dirname "$0")/../.." && pwd)
settings="$repo/container/render-runner/render-settings.json"
target=/opt/cinewright/app/container/render-runner/render-settings.json

render() { # name encode extra-docker-args...
  local name=$1 encode=$2; shift 2
  mkdir -p "$out/$name"
  sed "s/\"encode\": \"[a-z]*\"/\"encode\": \"$encode\"/" "$settings" > "$out/$name.settings.json"
  docker run --rm --network none --platform linux/amd64 --user "$(id -u):$(id -g)" --env HOME=/tmp "$@" \
    --mount "type=bind,source=$repo/container/fixtures/hello-world,target=/job/in,readonly" \
    --mount "type=bind,source=$out/$name,target=/job/out" \
    --mount "type=bind,source=$out/$name.settings.json,target=$target,readonly" \
    "$image" --in /job/in --out /job/out > "$out/$name.log" 2>&1 \
    || { printf '| %s | FAILED: %s | | | |\n' "$name" "$(tail -1 "$out/$name.log")"; return 0; }
  local keyframes
  keyframes=$(docker run --rm --network none --platform linux/amd64 --entrypoint ffprobe \
    --mount "type=bind,source=$out/$name,target=/v,readonly" "$image" \
    -v error -select_streams v:0 -show_entries frame=key_frame -of csv=p=0 /v/output.mp4 \
    | grep -n '^1' | cut -d: -f1 | awk '{printf "%s%d", sep, $1-1; sep=","}')
  local bframes
  bframes=$(docker run --rm --network none --platform linux/amd64 --entrypoint ffprobe \
    --mount "type=bind,source=$out/$name,target=/v,readonly" "$image" \
    -v error -select_streams v:0 -show_entries stream=has_b_frames -of csv=p=0 /v/output.mp4)
  printf '| %s | %s | %s | %s | %s |\n' "$name" \
    "$(sha256sum "$out/$name/framemd5.txt" | cut -c1-16)" \
    "$(sha256sum "$out/$name/output.mp4" | cut -c1-16)" "$keyframes" "$bframes"
}

echo "host: $(uname -m), $(nproc) CPUs; image: $image"
echo
echo '| run | sha256(framemd5.txt) | sha256(output.mp4) | keyframes (frame index) | has_b_frames |'
echo '| --- | --- | --- | --- | --- |'
for i in 1 2 3; do render "hyperframes-$i" hyperframes; done
for i in 1 2 3; do render "ffmpeg-$i" ffmpeg; done
render hyperframes-cpus1 hyperframes --cpus 1
render hyperframes-cpus2 hyperframes --cpus 2
render ffmpeg-cpus1 ffmpeg --cpus 1
