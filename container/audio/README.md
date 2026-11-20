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

Every run has the network off. The image sets `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HF_HOME`, `TORCH_HOME` and `NLTK_DATA` so nothing tries to download.

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
| MacBook (arm64, colima, amd64 under emulation), cold cache | MEASURE | MEASURE |
