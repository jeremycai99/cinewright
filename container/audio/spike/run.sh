#!/usr/bin/env bash
# M4.0b audio spike (modelled on M0.2). Runs the mixer in the render image and a Kokoro take
# with its WhisperX alignment and transcript in the audio image, several times at several CPU
# counts, and writes one summary.
#
# Usage: run.sh <render image> <audio image> <out dir>
# Env: RUNS (default 3), MIX_CPUS (default "1 2 4"), TAKE_CPUS (default "1 4").
set -euo pipefail
render="$1"; audio="$2"; out="$(mkdir -p "$3" && cd "$3" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
runs="${RUNS:-3}"
common=(--rm --network none --platform linux/amd64 --read-only --tmpfs /tmp:rw,exec,size=1024m
  --env HOME=/tmp --mount "type=bind,source=$here,target=/spike,readonly"
  --mount "type=bind,source=$out,target=/out")
{ uname -a; lscpu 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null || true; } > "$out/cpu.txt"
for cpus in ${MIX_CPUS:-1 2 4}; do
  for run in $(seq 1 "$runs"); do
    dir="mix-c$cpus-r$run"
    docker run "${common[@]}" --cpus "$cpus" --entrypoint bash "$render" /spike/mix.sh "/out/$dir" > /dev/null
    echo "$dir $(jq -c '{pcm_sha256, mp4_sha256, master_i, master_peak}' "$out/$dir/result.json")"
  done
done
for cpus in ${TAKE_CPUS:-1 4}; do
  for run in $(seq 1 "$runs"); do
    dir="take-c$cpus-r$run"
    docker run "${common[@]}" --cpus "$cpus" --entrypoint python "$audio" /spike/take.py "/out/$dir" > /dev/null
    echo "$dir $(jq -c '{take_f32_sha256, align_sha256, transcript_sha256, rtf, max_native_vs_align_s, untimed_words}' "$out/$dir/result.json")"
  done
done
jq -n '[inputs | {(input_filename | split("/")[-2]): .}] | add' "$out"/*/result.json > "$out/summary.json"
for key in pcm_sha256 mp4_sha256; do
  echo "$key: $(jq -r "[to_entries[] | select(.key | startswith(\"mix\")) | .value.$key] | unique | length" "$out/summary.json") distinct"
done
for key in take_f32_sha256 align_sha256 transcript_sha256; do
  echo "$key: $(jq -r "[to_entries[] | select(.key | startswith(\"take\")) | .value.$key] | unique | length" "$out/summary.json") distinct"
done
