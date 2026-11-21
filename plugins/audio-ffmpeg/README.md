# audio_ffmpeg

The mixer (M4.4). Apache-2.0. It runs FFmpeg in the **render image** (not the audio image), so the PCM contract (D33) rests on the image that carries the determinism baseline.

- **`planMix({ ir, deliverableId, pack, solved })`** is pure. It gives the clips (asset hash, bus, start sample on the project timeline including each sequence's offset, trim, loop), the bus gains, the duck spans, the profile's loudness targets, the sample rate and the length (total frames × rate / fps).
  - Takes start at their line's start: the solver spans each line over its whole take. A start before the timeline is trimmed.
  - A sequence's music bed (`sequence.music`) fills the sequence, looped if shorter, and fades out over `sound.duck.release`.
  - Sound effects start at their scene's start, at `sound.bus.sfx_db`.
  - The music is at `sound.bus.music_db`, ducked during each line by the scene's `duck_under_vo_db`, else `sound.duck.depth_db`, with linear ramps of `sound.duck.attack` before and `sound.duck.release` after. The envelope is computed on the host, one float32 per sample, and applied with `amultiply`: sample-exact.
- **`renderMix({ plan, cas, image, cacheDir })`** follows `settings.json` (from the M4.0b spike):
  1. premix every clip to float at the project rate, exactly `length` samples;
  2. measure it (`ebur128=peak=true`, parsed on the host);
  3. apply the gain to the integrated target, and, if the true peak would exceed its target, a limiter on a 4× oversampled signal;
  4. write raw s24le (whose sha256 is the PCM hash) and a bit-exact WAV;
  5. measure again. Missing the target by more than `tolerance_lu`, or the true peak at all, is `mix.loudness_unmet`, and nothing is cached.

  A premix quieter than −69 LUFS is treated as silence: no gain and no target.
- **Cache:** `.cinewright/cache/mixes/<mix key>/` holds `master.wav`, `master.s24le.sha256`, `measure.json` and `plan.json`. The key is the JCS hash of the plan, the render image id and the mixer version. It is disposable (D37); an unchanged plan is a hit and runs no container.

`cinewright mix --deliverable <id>` drives it. The container tests (`test/mix.container.test.ts`) run on both `render-smoke` runners, and `smoke-compare` checks that the mix's PCM hash matches across them.
