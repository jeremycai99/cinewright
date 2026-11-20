"""`audio-job versions`: what the audio image holds, as a flat JSON object of strings.

`cinewright-check-pins --kind audio` compares this report with the tracked pins
(container/audio/pins.json, uv.lock and models.json). Keys it does not compare, such as the
loaded espeak-ng library path, are information for the image's notices.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import platform
import subprocess
from collections.abc import Iterable
from importlib import metadata
from pathlib import Path

PACKAGES = (
    "torch",
    "torchaudio",
    "kokoro",
    "misaki",
    "phonemizer-fork",
    "espeakng-loader",
    "whisperx",
    "ctranslate2",
    "spacy",
    "en-core-web-sm",
)
MODELS_LOCK = Path(os.environ.get("CINEWRIGHT_MODELS", "/opt/models")) / "models.lock.json"


def files_digest(pairs: Iterable[tuple[str, str]]) -> str:
    """SHA-256 over sorted ``path\\0sha256\\n`` lines (as cinewright_tools.container)."""
    digest = hashlib.sha256()
    for rel, file_digest in sorted(pairs):
        digest.update(f"{rel}\0{file_digest}\n".encode())
    return digest.hexdigest()


def espeak_ng() -> tuple[str, str]:
    """The espeak-ng library misaki loads (bundled in espeakng-loader) and its version."""
    import espeakng_loader

    path = espeakng_loader.get_library_path()
    lib = ctypes.CDLL(path)
    lib.espeak_Info.restype = ctypes.c_char_p
    lib.espeak_Info.argtypes = [ctypes.c_void_p]
    raw: bytes = lib.espeak_Info(None)
    return os.path.realpath(path), raw.decode().split()[0]


def dpkg_version(package: str) -> str:
    out = subprocess.run(
        ["dpkg-query", "--showformat=${Version}", "--show", package],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def models(lock_path: Path = MODELS_LOCK) -> dict[str, str]:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    report: dict[str, str] = {}
    for model in lock["models"]:
        name = model["name"]
        report[f"model.{name}"] = model["revision"]
        report[f"model.{name}.sha256"] = files_digest(
            (f["path"], f["sha256"]) for f in model["files"]
        )
    return report


def report() -> dict[str, str]:
    library, version = espeak_ng()
    out = {
        "python": platform.python_version(),
        "ffmpeg": dpkg_version("ffmpeg"),
        "espeak_ng": version,
        "espeak_ng_library": library,
    }
    for name in PACKAGES:
        out[name] = metadata.version(name)
    out.update(models())
    return out
