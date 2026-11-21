# export_mp4

The assembler (M5.1, D34). Apache-2.0. It turns cached parts into one MP4 per deliverable, in the **render image**, with no video re-encode.

- **`planAssembly({ ir, deliverableId, solved, parts, mix })`** (pure). The parts are shot bodies and transition segments, in timeline order. Their frames must add up to the solved timeline (`assemble.frame_mismatch`), and the mix must be exactly `frames × rate / fps` samples (`assemble.length_mismatch`). Audio codec, bitrate and loudness targets come from the deliverable's profile.
- **`assemble({ plan, image, cacheDir })`**:
  1. Every part must carry the same codec parameters (`ffprobe` with the extradata hash), or `assemble.incompatible_part` names the part.
  2. **Video:** the concat demuxer, `-c copy`, into `video.mp4`.
  3. **Mux:** `video.mp4` plus the mix's `master.wav`. Video `-c:v copy`; audio encoded once with the profile's codec and bitrate; `-map_metadata -1`, bitexact, `+faststart`.
  4. **Checks:** the film has exactly the timeline's frames, and each frame's hash equals its part's frame hash, in order. The decoded audio is within two AAC frames (2048 samples) of the mix. The delivered audio meets the profile's integrated target (± `tolerance_lu`) and true-peak ceiling (`assemble.loudness_unmet`).
- **Cache:** `.cinewright/cache/assemblies/<key>/` holds `video.mp4`, `<deliverable>.mp4`, `framemd5.txt`, `sha256.txt`, `result.json` and `inputs.json`. The key is the ordered parts (kind, cache key, frames), the mix key, the audio encoding, the container flags, the render image and the exporter version; host paths are left out. It is committed with core's `commitCacheDir`, and nothing is cached on failure.
- **`probe(file, image)`:** container, codecs, pixel format, size, frame rate, frame count, sample rate and channels. M6.1b's spec check reuses it.
- **Plugin method `export.mp4`:** `{ project, deliverable, timing, parts, mix, image }` → `Assembled`.

## Spike (2026-11-21)

The M3 reference project plus a scene-4 shot joined by a dissolve, rendered by the backend plugin in `cinewright-render:m3top` (amd64 under emulation on Apple Silicon), assembled with the mix of a master that the M4 mixer normalized. `test/assemble.container.test.ts` repeats every check.

| Question | Result |
| --- | --- |
| Is the concat demuxer frame-exact for these x264 parts (B-frames)? | **Yes**, for a 12-frame and a 13-frame dissolve: 207 frames, equal to the timeline, and each frame's hash equals its part's, in order. The Annex B fallback is not needed. |
| Do all parts share codec parameters? | Yes: bodies and segments use the render settings' encoder. A part re-encoded with another profile is refused, naming it. |
| How long is the decoded AAC audio? | 331,776 samples for a 331,200-sample mix: 576 more (encoder priming and padding), inside the two-frame allowance. |
| Does the AAC encode raise the true peak? | **Yes, by about 0.1 dB:** a master limited at −1.0 dBTP was delivered at −0.9 dBTP, past the target. So the mixer now limits at the target minus `encode_headroom_db` = 0.5 dB (`plugins/audio-ffmpeg/settings.json`), and the delivered file measured −1.1 dBTP. |
| Is the output byte-stable? | Two runs give byte-identical MP4s with the same frame hashes; an unchanged plan is a cache hit. CI compares the assembled film's hash across both `render-smoke` runners. |

Two mixer changes came out of the spike (mixer version 0.2.0, so mix keys changed): the headroom above, and one corrective gain pass when heavy limiting leaves the master short of its loudness target. Sound shorter than the limiter's 1 ms attack (a 0.5 ms click) still passes the ceiling, and the mixer refuses it as `mix.loudness_unmet`, as designed.
