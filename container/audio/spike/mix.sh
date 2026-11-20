#!/usr/bin/env bash
# The M4.0b mixer spike, run inside the render image (entrypoint bash). Three pink-noise
# "speech" bursts made at 24 kHz and resampled to 48 kHz, a chord bed under a sample-exact duck
# envelope, gain to -14 LUFS, a 4x oversampled limiter at -1 dBTP, then raw s24le, WAV and AAC.
# Usage: mix.sh <out dir>. Writes premix.wav, master.s24le, master.wav, master.mp4,
# measure-premix.txt, measure-master.txt and result.json.
set -euo pipefail
out="$1"; mkdir -p "$out"
ff=(ffmpeg -nostdin -hide_banner -loglevel error -y)
target=-14; peak_limit=-1
# Speech spans in seconds; ramps in ms; duck depth and bed level in dB.
spans=("0.5 1.3" "2.2 3.0" "3.9 4.7"); attack=0.08; release=0.25; duck=-12; bed=-6
weights=()
for s in "${spans[@]}"; do
  read -r a b <<<"$s"
  weights+=("clip(min((t-($a-$attack))/$attack\,(($b+$release)-t)/$release)\,0\,1)")
done
w="max(${weights[0]}\,max(${weights[1]}\,${weights[2]}))"
d="pow(10\,$duck/20)"; g="pow(10\,$bed/20)"
gain="$g*(1-(1-$d)*$w)"
"${ff[@]}" -filter_complex "
anoisesrc=color=pink:seed=11:sample_rate=24000:duration=0.8:amplitude=0.25,aresample=48000,adelay=500:all=1[v1];
anoisesrc=color=pink:seed=12:sample_rate=24000:duration=0.8:amplitude=1.0,aresample=48000,adelay=2200:all=1[v2];
anoisesrc=color=pink:seed=13:sample_rate=24000:duration=0.8:amplitude=0.25,aresample=48000,adelay=3900:all=1[v3];
[v1][v2][v3]amix=inputs=3:normalize=0:duration=longest,apad=whole_len=288000,pan=stereo|c0=c0|c1=c0[voice];
sine=frequency=220:sample_rate=48000:duration=6[s1];sine=frequency=277.18:sample_rate=48000:duration=6[s2];sine=frequency=329.63:sample_rate=48000:duration=6[s3];
[s1][s2][s3]amix=inputs=3:normalize=0,aformat=sample_fmts=dbl,aeval=val(0)*$gain:c=same,pan=stereo|c0=c0|c1=c0[bedd];
[voice][bedd]amix=inputs=2:normalize=0:duration=first,atrim=end_sample=288000,aformat=sample_fmts=flt:channel_layouts=stereo[mix]" \
  -map "[mix]" -c:a pcm_f32le "$out/premix.wav"
measure() { ffmpeg -nostdin -hide_banner -i "$1" -af ebur128=peak=true -f null - 2>&1 | sed -n '/Summary:/,$p' > "$2"; }
field() { awk -v k="$2" '$1==k {print $2; exit}' "$1"; }
measure "$out/premix.wav" "$out/measure-premix.txt"
i=$(field "$out/measure-premix.txt" "I:"); p=$(field "$out/measure-premix.txt" "Peak:")
gain_db=$(awk -v t=$target -v i="$i" 'BEGIN{printf "%.4f", t-i}')
need_limit=$(awk -v p="$p" -v g="$gain_db" -v l=$peak_limit 'BEGIN{print (p+g>l)?1:0}')
chain="volume=${gain_db}dB:precision=double"
if [ "$need_limit" = 1 ]; then
  lin=$(awk -v l=$peak_limit 'BEGIN{printf "%.6f", 10^(l/20)}')
  chain="$chain,aresample=192000,alimiter=limit=$lin:level=0:attack=1:release=50:asc=0,aresample=48000"
fi
"${ff[@]}" -i "$out/premix.wav" -af "$chain" -c:a pcm_s24le -f s24le "$out/master.s24le"
"${ff[@]}" -f s24le -ar 48000 -ac 2 -i "$out/master.s24le" -c:a pcm_s24le -fflags +bitexact -flags +bitexact -map_metadata -1 "$out/master.wav"
"${ff[@]}" -i "$out/master.wav" -c:a aac -b:a 384k -fflags +bitexact -flags +bitexact -map_metadata -1 "$out/master.mp4"
measure "$out/master.wav" "$out/measure-master.txt"
mi=$(field "$out/measure-master.txt" "I:"); mp=$(field "$out/measure-master.txt" "Peak:")
cat > "$out/result.json" <<JSON
{"premix_i": $i, "premix_peak": $p, "gain_db": $gain_db, "limited": $need_limit,
 "master_i": $mi, "master_peak": $mp,
 "pcm_sha256": "$(sha256sum "$out/master.s24le" | cut -c1-64)",
 "wav_sha256": "$(sha256sum "$out/master.wav" | cut -c1-64)",
 "mp4_sha256": "$(sha256sum "$out/master.mp4" | cut -c1-64)"}
JSON
cat "$out/result.json"
