# critic-media

The media critic (M6.1b): a `critic` plugin, in process, Apache-2.0. One method, `critic.run`.

It grades the **delivered file**, never the master: the profile describes what ships. FFmpeg and ffprobe run in the render image (`--entrypoint ffmpeg`, network off, the M3 run limits); the silence and clipping scan reads the decoded PCM on the host. Measurements are cached in `.cinewright/cache/media/<key>/measure.json`, keyed by the file's SHA-256, the image and `settings.json`, so an unchanged assembly is measured once.

## Rules

| Rule | What is measured | Entity · pointer | Limit |
| --- | --- | --- | --- |
| `audio.loudness` | integrated loudness of the decoded audio, `ebur128=peak=true` | deliverable | profile `loudness.integrated_lufs` ± `tolerance_lu` |
| `audio.true_peak` | true peak of the decoded audio (after AAC, which raises it) | deliverable | profile `loudness.true_peak_dbtp` |
| `audio.silence` (warning) | a run of sample frames with every channel under `silence.floor_dbfs` | the scene where it starts | longer than `silence.max_ms` |
| `audio.clipping` | consecutive samples of one channel at full scale | the scene where it starts | `clipping.min_run` or more |
| `video.blank` | a keyframe still that is one uniform colour, where the mount spec puts a layer on screen | shot | — |
| `video.frozen` | every frame of the shot's body has the same hash, although a layer enters during the body | shot | — |
| `spec.ffprobe` | container, codecs, pixel format, size, frame rate, frame count against the solved timeline, audio presence, sample rate, channels, audio and video ends within `sync_encoder_frames` AAC frames, `max_duration` when the profile sets it | deliverable · `/<field>` | the profile, the timeline, `settings.json` |

Loudness follows ITU-R BS.1770 as the pinned FFmpeg implements it; the targets are profile data, so EBU R 128 or a streaming target is a profile choice, not code.

`video.blank` and `video.frozen` use the stills and `framemd5.txt` already in each shot's render entry, plus the layers in `check/check.json` (M6.1a), so they run no FFmpeg. Threshold filters such as `blackdetect` and `freezedetect` would flag a held title and a dark pack before its first entrance; asking the mount spec what should be on screen does not.

## Limits

- The blank check sees only the keyframe samples; a partial failure that still draws something is the layout critic's and `check`'s to catch.
- Every component animates in unless its enter entry lasts zero frames, so a body with an entering layer and no changing frame is frozen. A layer that entered before the body (during an incoming transition) is not counted.
- A silent programme measures −∞ LUFS; its `audio.loudness` finding carries the limit but no measured value.
