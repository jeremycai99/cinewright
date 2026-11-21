# Audio image

`ghcr.io/jeremycai99/cinewright-audio` holds the Python TTS and STT stacks and their models (M4.0a, audit decision 7). It is separate from the render image so torch stays out of the image that carries the render determinism baseline. The mixer runs in the render image (M4 plan, G16), not here.

What is in it:

- Python 3.12 from `python:3.12.16-slim-trixie`, pinned by digest.
- FFmpeg from the render image's Debian snapshot, at the same version.
- A virtual environment at `/opt/venv`, installed with `uv sync --frozen` from `uv.lock`: CPU-only torch, torchaudio and torchvision 2.8 / 0.23, `kokoro` 0.9.4 with `misaki[en]` 0.9.4, `whisperx` 3.8.6, and spaCy's `en_core_web_sm`.
- Models under `/opt/models`, each downloaded at build time and checked against `models.json` by sha256 (`fetch_models.py`):
  - Kokoro-82M with every published voice (`/opt/models/kokoro-82m`);
  - `Systran/faster-whisper-small` (`/opt/models/faster-whisper-small`);
  - torchaudio's `WAV2VEC2_ASR_BASE_960H` checkpoint (`$TORCH_HOME/hub/checkpoints`), WhisperX's English alignment model;
  - NLTK `punkt_tab` (`$NLTK_DATA`), which WhisperX's alignment loads.
- `audio-job`, the entry point (`audio_job/`).
- Notices and licences in `/usr/share/doc/cinewright-audio/` (`NOTICES.md`, `GPL-3.0.txt`).

Plugin code is not in the image. The plugin host (M4.5a) mounts each plugin's folder at `/plugins/<id>` read-only, so a plugin change needs no rebuild.

Every run has the network off. `/tmp` must be a tmpfs mounted with `exec`: phonemizer copies the espeak-ng library there and loads it (the run limits already mount it so). The image sets `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HF_HOME`, `TORCH_HOME` and `NLTK_DATA` so nothing tries to download.

## Commands

```bash
uv run cinewright-build-image --kind audio --tag cinewright-audio:dev
uv run cinewright-check-pins --kind audio --image cinewright-audio:dev
docker run --rm --network none --platform linux/amd64 cinewright-audio:dev versions
docker run --rm --network none --platform linux/amd64 cinewright-audio:dev imports
uv run cinewright-check-image-lock --kind audio
```

- `audio-job versions` prints, as JSON: Python, FFmpeg, torch, torchaudio, kokoro, misaki, `phonemizer-fork`, `espeakng-loader`, whisperx, ctranslate2, spaCy and `en-core-web-sm` versions; the espeak-ng version the loaded library reports and its path; and each model's revision and a digest over its files' sha256 values. `cinewright-check-pins --kind audio` compares it with `pins.json`, `uv.lock` and `models.json`.
- `audio-job imports` imports kokoro, misaki's English G2P (with the espeak-ng fallback) and whisperx with every socket connection refused, and fails if any of them tried one.

## Pins and lock

| File | What it pins |
| --- | --- |
| `pins.json` | Base image digest and its Python version, the uv image used to install, the Debian snapshot and FFmpeg version (both equal to the render image's), and the espeak-ng version bundled in `espeakng-loader`. |
| `pyproject.toml`, `uv.lock` | Python packages, resolved only for linux/amd64 and CPython 3.12, with hashes. torch, torchaudio and torchvision come from the PyTorch CPU index. Lock with `uv lock` in this folder. This project is not a member of the root uv workspace. |
| `models.json` | Each model's source, revision, licence and files (URL, sha256, size). |
| `image.lock.json` | The published image's digest and inputs hash. `null` until the first publish. |

The inputs hash covers this folder's build context: every file here except `README.md`, `image.lock.json`, `spike/` and caches (see `.dockerignore`, and `AUDIO_EXCLUDED` in `tools/src/cinewright_tools/container.py`).

Publishing works like the render image: `audio-image.yml` builds and pushes on main when the inputs change, and a follow-up PR records the digest. `audio-smoke.yml` builds the image on PRs that change its inputs and runs its container tests.

## Licences

`phonemizer-fork` and the espeak-ng library are GPL-3.0-or-later. They load only in the process of a plugin that uses them (the Kokoro plugin, GPL-3.0-or-later). See `NOTICES.md`.

## Build measurements

Recorded on 2026-11-20.

| Where | Build time | Image size |
| --- | --- | --- |
| MacBook (arm64, colima 6 CPUs, amd64 under emulation), cold cache | 490 s | 2.22 GB (2,223,217,538 bytes, as colima's image store reports it) |
| GitHub `ubuntu-24.04` runner, 2 CPUs, cold cache | 190 s | 5.15 GB (5,146,028,037 bytes, uncompressed) |

## Determinism

The M4.0b spike (`spike/`, modelled on M0.2) measured, on 2026-11-20:
- the **mixer** in the render image (`spike/mix.sh`): three pink-noise "speech" bursts made at 24 kHz and resampled to 48 kHz, a chord bed under a sample-exact duck envelope, gain to −14 LUFS, a 4× oversampled limiter at −1 dBTP, then raw s24le, WAV and AAC 384 kb/s in MP4;
- a **Kokoro take** of "In 2014 it cost £13.60, and the bridge opened two years later." (voice `af_heart`, seed 1234, one thread, deterministic algorithms), its **WhisperX alignment** and its **transcript**, in the audio image (`spike/take.py`).

Each was run 3 times per CPU count: 1, 2 and 4 CPUs locally, and 1 and 2 on two CI runners (which have 2 CPUs). Reproduce with `spike/run.sh <render image> <audio image> <out dir>`.

| Machine | Mixer PCM (s24le) sha256 | MP4 sha256 | Kokoro take (f32) sha256 | Alignment | Transcript |
| --- | --- | --- | --- | --- | --- |
| Apple M2 Max, amd64 under emulation | `f3a05015…62064` | `b829325a…39a27` | `df4f0c80…ba5a6` | `72b087f1…7045e` | `2a44cf10…40047` |
| CI runner a: Intel Xeon 6975P-C (AVX-512) | `f3a05015…62064` | `b829325a…39a27` | `59ee997b…59e74` | `72b087f1…7045e` | `2a44cf10…40047` |
| CI runner b: AMD EPYC 9V45 (AVX-512) | `f3a05015…62064` | `b829325a…39a27` | `78d23b4d…bee8f` | `72b087f1…7045e` | `2a44cf10…40047` |

Within each machine, every run at every CPU count gave the same hash in every column.

- **Mixer: one PCM hash and one MP4 hash on all three machines.** No `-cpuflags` restriction was needed. The PCM contract (D33) holds across these runner classes, and the mixer settings are in `plugins/audio-ffmpeg/settings.json`. The master measured −14.2 LUFS integrated and −1.0 dBTP true peak after the limiter: within a 1 LU tolerance, and at the peak target.
- **Kokoro: the same take on one machine, a different one on each machine.** torch's float kernels differ by CPU. That is acceptable: takes are frozen assets in the CAS and are never regenerated without a re-take (D33), so tier A never synthesizes.
- **WhisperX: the same alignment (to the millisecond) and transcript everywhere.** It is still frozen (`aligned_by` on takes, `transcript` assets).

**Real-time factor** (processing time ÷ audio length, 6.475 s of speech):

| Machine | Kokoro | Alignment | Transcription |
| --- | --- | --- | --- |
| CI runners, 1–2 CPUs | 0.51–0.53 | 0.24–0.28 | 0.65–0.69 |
| Apple M2 Max, under emulation | 4.6–4.7 | 1.4–1.5 | 3.9–4.2 |

Emulation is about 9× slower, and above the plan's threshold of 2, so a native `linux/arm64` build of this image is **allowed** (the plan's rule). It is not built yet; it waits until local plugin work needs the speed.

### Alignment needs the spoken form

Forced alignment matches letters to speech. Given the written text, WhisperX squeezed every word of the 6.5 s take into its first 2.4 s: "2014" and "£13.60" are spoken as "twenty fourteen" and "thirteen pounds and sixty pence", and the unmatched speech derails the alignment of the whole line. Leaving those words out of the text did not help: the alignment then ended at 2.2 s. Given the spoken form, every word lands where it is spoken. So `stt.align` takes an optional `spoken` form per word, and the WhisperX plugin spells numerals, years, currency, percentages and ordinals itself when none is given (`plugins/stt-whisperx`).

### Kokoro's own word times

Kokoro reports a time per token, computed from its predicted durations. Against the spoken-form alignment, its starts are 55–136 ms early on every word, and its ends run up to 0.33 s late where a pause follows (they include the pause). That is not within one frame (33 ms at 30 fps), so by the plan's rule (G26) the Kokoro plugin returns no word times, and the narration job aligns its takes with WhisperX.
