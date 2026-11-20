"""The WhisperX STT plugin (M4.5b): `stt.align` and `stt.transcribe`, English only.

Runs in the audio image (python -m cinewright_stt_whisperx.plugin). whisperx and torch are
imported on first use, so the host tests run without them. Single-threaded and with
deterministic algorithms, as the M4.0b spike measured.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, cast

from cinewright_plugin_sdk import Plugin, PluginError, serve
from cinewright_stt_whisperx.align import TokenTime, words_from_tokens
from cinewright_stt_whisperx.normalize import spoken_tokens

SAMPLE_RATE = 16_000  # whisperx loads audio at 16 kHz
ALIGN_MODEL = "WAV2VEC2_ASR_BASE_960H"
MODELS = Path(os.environ.get("CINEWRIGHT_MODELS", "/opt/models"))


def _english(language: object) -> None:
    if not isinstance(language, str) or language.split("-")[0].lower() != "en":
        raise PluginError(
            "unsupported", f"stt_whisperx aligns and transcribes English only, not {language!r}"
        )


class WhisperX(Plugin):
    def __init__(self) -> None:
        self._align: tuple[Any, Any] | None = None
        self._asr: Any = None

    def capabilities(self) -> list[str]:
        return ["stt.align", "stt.transcribe"]

    def call(self, method: str, params: Any) -> Any:
        if not isinstance(params, dict):
            raise PluginError("invalid_request", f"{method} needs an object")
        p = cast(dict[str, Any], params)
        if method == "stt.align":
            return self.align(p)
        if method == "stt.transcribe":
            return self.transcribe(p)
        raise PluginError("unsupported", f"no method {method}")

    def _audio(self, name: object) -> str:
        if (
            not isinstance(name, str)
            or not name
            or name.startswith("/")
            or ".." in Path(name).parts
        ):
            raise PluginError(
                "invalid_request", f"audio must be a path in the work folder, not {name!r}"
            )
        base = self.work_dir or Path.cwd()
        path = base / name
        if not path.is_file():
            raise PluginError("invalid_request", f"no audio file {name} in the work folder")
        return str(path)

    def _torch(self) -> Any:
        import torch  # pyright: ignore[reportMissingImports]

        torch.set_num_threads(1)
        torch.use_deterministic_algorithms(True)
        return torch

    def _align_model(self) -> tuple[Any, Any]:
        if self._align is None:
            import whisperx  # type: ignore[import-not-found]

            self._torch()
            self._align = cast(
                tuple[Any, Any],
                whisperx.load_align_model(language_code="en", device="cpu", model_name=ALIGN_MODEL),
            )
        return self._align

    def _tokens(self, audio: Any, text: str, duration: float) -> list[TokenTime]:
        import whisperx  # type: ignore[import-not-found]

        model, meta = self._align_model()
        segments = [{"start": 0.0, "end": duration, "text": text}]
        self.check_cancelled()
        aligned = whisperx.align(segments, model, meta, audio, "cpu", return_char_alignments=False)
        return [
            cast(TokenTime, {"start": w.get("start"), "end": w.get("end")})
            for w in aligned["word_segments"]
        ]

    def align(self, p: dict[str, Any]) -> dict[str, Any]:
        _english(p.get("language"))
        words = p.get("words")
        if (
            not isinstance(words, list)
            or not words
            or not all(isinstance(w, str) and w for w in words)
        ):
            raise PluginError(
                "invalid_request", "stt.align needs words: a non-empty list of strings"
            )
        spoken = p.get("spoken")
        if spoken is not None and (not isinstance(spoken, list) or len(spoken) != len(words)):
            raise PluginError("invalid_request", "spoken must have one entry per word")
        groups = spoken_tokens(cast(list[str], words), cast(list[str] | None, spoken))
        path = self._audio(p.get("audio"))
        import whisperx  # type: ignore[import-not-found]

        audio = whisperx.load_audio(path)
        duration = len(audio) / SAMPLE_RATE
        tokens = self._tokens(audio, " ".join(t for g in groups for t in g), duration)
        return {
            "words": words_from_tokens(groups, tokens, SAMPLE_RATE),
            "sample_rate": SAMPLE_RATE,
            "model": ALIGN_MODEL,
        }

    def transcribe(self, p: dict[str, Any]) -> dict[str, Any]:
        _english(p.get("language"))
        path = self._audio(p.get("audio"))
        import whisperx  # type: ignore[import-not-found]

        audio = whisperx.load_audio(path)
        if self._asr is None:
            self._torch()
            self._asr = whisperx.load_model(
                str(MODELS / "faster-whisper-small"),
                "cpu",
                compute_type="int8",
                language="en",
                threads=1,
            )
        self.check_cancelled()
        result = self._asr.transcribe(audio, batch_size=1, language="en")
        text = " ".join(str(s["text"]).strip() for s in result["segments"]).strip()
        words: list[dict[str, Any]] = []
        if text:
            model, meta = self._align_model()
            aligned = whisperx.align(
                result["segments"], model, meta, audio, "cpu", return_char_alignments=False
            )
            for w in aligned["word_segments"]:
                start, end = w.get("start"), w.get("end")
                if start is not None and end is not None and start == start and end == end:
                    s = round(start * SAMPLE_RATE)
                    words.append(
                        {
                            "text": str(w["word"]),
                            "start": s,
                            "end": max(s, round(end * SAMPLE_RATE)),
                        }
                    )
        return {"text": text, "words": words, "sample_rate": SAMPLE_RATE, "model": _asr_model_id()}


def _asr_model_id() -> str:
    try:
        lock = json.loads((MODELS / "models.lock.json").read_text(encoding="utf-8"))
        rev = next(m["revision"] for m in lock["models"] if m["name"] == "faster-whisper-small")
        return f"faster-whisper-small@{rev}"
    except (OSError, StopIteration, KeyError, ValueError):
        return "faster-whisper-small"


if __name__ == "__main__":
    serve(WhisperX())
