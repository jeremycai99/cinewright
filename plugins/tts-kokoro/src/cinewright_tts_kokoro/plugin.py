"""The Kokoro TTS plugin (M4.1c): `tts.synthesize`, English, 24 kHz mono.

Runs in the audio image (python -m cinewright_tts_kokoro.plugin). kokoro and torch are imported
on first use, so the host tests run without them. One thread, deterministic algorithms and the
request's seed, as the M4.0b spike measured; takes still differ across CPUs, which is fine
because they are frozen. It returns no word times: Kokoro's own are not within a frame of
alignment (M4.0b, G26), so the narration job aligns its takes with stt_whisperx.
"""

from __future__ import annotations

import json
import os
import wave
from pathlib import Path
from typing import Any, cast

from cinewright_plugin_sdk import Plugin, PluginError, serve
from cinewright_tts_kokoro.lexicon import apply_lexicon

SAMPLE_RATE = 24_000
REPO = "hexgrad/Kokoro-82M"
MODELS = Path(os.environ.get("CINEWRIGHT_MODELS", "/opt/models"))
KOKORO = MODELS / "kokoro-82m"
LANG_CODES = {"en": "a", "en-us": "a", "en-gb": "b"}
LICENSE_TERMS = (
    "Speech generated locally with Kokoro-82M (Apache-2.0 weights); no restriction on the output"
)


def lang_code(language: object) -> str:
    if not isinstance(language, str):
        raise PluginError("invalid_request", "tts.synthesize needs a language")
    tag = language.lower()
    code = LANG_CODES.get(tag) or LANG_CODES.get(tag.split("-")[0])
    if code is None:
        raise PluginError("unsupported", f"tts_kokoro speaks English only, not {language!r}")
    return code


def voice_file(binding: object) -> Path:
    voice = binding.get("voice") if isinstance(binding, dict) else None  # type: ignore[union-attr]
    if not isinstance(voice, str) or not voice:
        raise PluginError(
            "invalid_request",
            "the speaker's tts_kokoro binding names no voice; there is no default",
        )
    if "/" in voice or voice.startswith("."):
        raise PluginError("invalid_request", f"not a Kokoro voice name: {voice!r}")
    return KOKORO / "voices" / f"{voice}.pt"


def model_id() -> str:
    try:
        lock = json.loads((MODELS / "models.lock.json").read_text(encoding="utf-8"))
        rev = next(m["revision"] for m in lock["models"] if m["name"] == "kokoro-82m")
        return f"Kokoro-82M@{rev}"
    except (OSError, StopIteration, KeyError, ValueError):
        return "Kokoro-82M"


class Kokoro(Plugin):
    def __init__(self) -> None:
        self._pipelines: dict[str, Any] = {}
        self._model: Any = None

    def capabilities(self) -> list[str]:
        return ["tts.synthesize"]

    def call(self, method: str, params: Any) -> Any:
        if method != "tts.synthesize":
            raise PluginError("unsupported", f"no method {method}")
        if not isinstance(params, dict):
            raise PluginError("invalid_request", "tts.synthesize needs an object")
        return self.synthesize(cast(dict[str, Any], params))

    def _output(self, name: object) -> Path:
        if (
            not isinstance(name, str)
            or not name
            or name.startswith("/")
            or ".." in Path(name).parts
        ):
            raise PluginError(
                "invalid_request", f"output must be a path in the work folder, not {name!r}"
            )
        return (self.work_dir or Path.cwd()) / name

    def _pipeline(self, code: str) -> Any:
        import torch  # pyright: ignore[reportMissingImports]
        from kokoro import KModel, KPipeline  # type: ignore[import-not-found]

        torch.set_num_threads(1)
        torch.use_deterministic_algorithms(True)
        if self._model is None:
            config, weights = str(KOKORO / "config.json"), str(KOKORO / "kokoro-v1_0.pth")
            self._model = KModel(repo_id=REPO, config=config, model=weights).eval()
        if code not in self._pipelines:
            self._pipelines[code] = KPipeline(lang_code=code, repo_id=REPO, model=self._model)
        return self._pipelines[code]

    def synthesize(self, p: dict[str, Any]) -> dict[str, Any]:
        code = lang_code(p.get("language"))
        voice = voice_file(p.get("binding"))
        text = p.get("text")
        if not isinstance(text, str) or not text.strip():
            raise PluginError("invalid_request", "tts.synthesize needs text")
        lexicon = p.get("lexicon") or {}
        if not isinstance(lexicon, dict):
            raise PluginError("invalid_request", "lexicon must be an object")
        seed = p.get("seed", 0)
        output = self._output(p.get("output"))
        if not voice.is_file():
            raise PluginError("invalid_request", f"no Kokoro voice {voice.stem} in the audio image")
        spoken = apply_lexicon(text, cast(dict[str, str], lexicon))
        binding = cast(dict[str, Any], p.get("binding"))
        settings = cast(dict[str, Any], binding.get("settings") or {})
        speed = float(settings.get("speed", 1.0))

        import numpy as np  # pyright: ignore[reportMissingImports]
        import torch  # pyright: ignore[reportMissingImports]

        pipeline = self._pipeline(code)
        torch.manual_seed(int(seed))
        chunks = []
        for result in pipeline(spoken, voice=str(voice), speed=speed):
            self.check_cancelled()
            if result.audio is not None:
                chunks.append(result.audio.numpy())
        if not chunks:
            raise PluginError("provider_error", "Kokoro produced no audio")
        audio = np.concatenate(chunks)
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        output.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm.tobytes())
        return {
            "file": p["output"],
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "words": None,
            "model": model_id(),
            "plan_tier": "local",
            "request": {"voice": voice.stem, "text": spoken, "seed": int(seed), "speed": speed},
            "license": {
                "terms": LICENSE_TERMS,
                "commercial_use": True,
            },
        }


if __name__ == "__main__":
    serve(Kokoro())
