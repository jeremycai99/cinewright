# Third-party notices: Cinewright audio image

This image (`ghcr.io/jeremycai99/cinewright-audio`) bundles third-party software and models. Cinewright's own code in it (`audio_job`) is Apache-2.0. The image is installed at `/usr/share/doc/cinewright-audio/` with this file and `GPL-3.0.txt`.

Not legal advice. Versions are those in `container/audio/uv.lock` and `models.json`; `audio-job versions` reports what the image actually holds.

## GPL components

Kokoro's English front end (misaki) falls back to espeak-ng for out-of-vocabulary words. These two components are GPL. They are loaded only in the process of a plugin that uses them (`plugins/tts-kokoro`, GPL-3.0-or-later; audit decision 8). Core and other plugins reach that process only over JSON-RPC.

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| `phonemizer-fork` (Python) | 3.3.2 | GPL-3.0-or-later | https://pypi.org/project/phonemizer-fork/3.3.2/ (upstream: https://github.com/bootphon/phonemizer) |
| espeak-ng (shared library and data, bundled in the `espeakng-loader` wheel) | 1.52.0, as the library reports | GPL-3.0-or-later | https://github.com/espeak-ng/espeak-ng/tree/1.52.0 (commit 4870adfa25b1a32b4361592f1be8a40337c58d6c) |
| `espeakng-loader` (the Python loader around it) | 0.2.4 | MIT | https://github.com/thewh1teagle/espeakng-loader |

The full text of the GPL-3.0 is in `GPL-3.0.txt`. `audio-job versions` reports the loaded library's path as `espeak_ng_library`.

## Models

| Model | Revision | Licence | Source |
| --- | --- | --- | --- |
| Kokoro-82M, with every published voice | `f3ff3571791e39611d31c381e3a41a3af07b4987` | Apache-2.0 | https://huggingface.co/hexgrad/Kokoro-82M |
| faster-whisper-small (CTranslate2 conversion of OpenAI Whisper small) | `536b0662742c02347bc0e980a01041f333bce120` | MIT | https://huggingface.co/Systran/faster-whisper-small |
| wav2vec 2.0 base, 960 h ASR (torchaudio `WAV2VEC2_ASR_BASE_960H`, from fairseq) | `wav2vec2_fairseq_base_ls960_asr_ls960.pth` | MIT | https://download.pytorch.org/torchaudio/models/ |
| NLTK Punkt sentence tokenizer data (`punkt_tab`, by Jan Strunk) | nltk_data `550b6625bcef1f2abff2ff770a5a0d272c9c6b2a` | Not stated in the nltk_data index | https://github.com/nltk/nltk_data |
| spaCy `en_core_web_sm` (a Python package in the lock) | 3.8.0 | MIT | https://github.com/explosion/spacy-models |
| pyannote VAD segmentation weights (shipped inside the `whisperx` package) | whisperx 3.8.6 | MIT | https://github.com/m-bain/whisperX |

## Other software

- Python 3.12 (PSF-2.0), from the `python:3.12.16-slim-trixie` base image (Debian trixie).
- FFmpeg from Debian (`ffmpeg` 7.1.5, LGPL-2.1-or-later and GPL-2.0-or-later as built by Debian); see `/usr/share/doc/ffmpeg/copyright`.
- PyTorch, torchaudio and torchvision (BSD-3-Clause), CPU builds.
- Kokoro (`kokoro`, Apache-2.0), misaki (Apache-2.0), WhisperX (BSD-2-Clause), faster-whisper (MIT), CTranslate2 (MIT), spaCy (MIT), and their dependencies as locked in `uv.lock`. Each package's own licence is in its `*.dist-info` folder under `/opt/venv/lib/python3.12/site-packages/`.
