from pathlib import Path

import pytest

from cinewright_plugin_sdk import PluginError
from cinewright_stt_whisperx.plugin import WhisperX


def test_capabilities_match_the_manifest() -> None:
    import json

    manifest = json.loads((Path(__file__).parents[1] / "manifest.json").read_text())
    assert sorted(WhisperX().capabilities()) == sorted(manifest["capabilities"])


def test_other_languages_are_unsupported() -> None:
    with pytest.raises(PluginError) as raised:
        WhisperX().call(
            "stt.align", {"audio": "a.wav", "text": "Hola", "words": ["Hola"], "language": "es"}
        )
    assert raised.value.code == "unsupported"
    assert "'es'" in raised.value.message


def test_audio_must_stay_in_the_work_folder(tmp_path: Path) -> None:
    plugin = WhisperX()
    plugin.work_dir = tmp_path
    for audio in ("/etc/passwd", "../x.wav", "missing.wav"):
        with pytest.raises(PluginError) as raised:
            plugin.call("stt.transcribe", {"audio": audio, "language": "en"})
        assert raised.value.code == "invalid_request"
