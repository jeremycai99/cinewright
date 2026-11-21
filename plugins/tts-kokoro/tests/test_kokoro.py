import json
from pathlib import Path

import pytest

from cinewright_plugin_sdk import PluginError
from cinewright_tts_kokoro.lexicon import apply_lexicon
from cinewright_tts_kokoro.plugin import Kokoro, lang_code


def test_respellings_replace_the_term() -> None:
    lexicon = {"Kubernetes": "KOO-ber-NET-eez"}
    assert apply_lexicon("We run Kubernetes, kubernetes and Kuberneteses.", lexicon) == (
        "We run KOO-ber-NET-eez, KOO-ber-NET-eez and Kuberneteses."
    )


def test_ipa_becomes_an_inline_pronunciation() -> None:
    assert (
        apply_lexicon("Ask Cinewright.", {"Cinewright": "/ˈsɪnəraɪt/"})
        == "Ask [Cinewright](/ˈsɪnəraɪt/)."
    )


def test_longer_terms_win() -> None:
    lexicon = {"New York": "NOO YORK", "York": "YORKE"}
    assert apply_lexicon("New York and York", lexicon) == "NOO YORK and YORKE"


def test_a_binding_without_a_voice_is_invalid() -> None:
    params = {
        "text": "Hi.",
        "words": ["Hi."],
        "language": "en",
        "binding": {},
        "lexicon": {},
        "seed": 1,
        "sample_rate": 48000,
        "output": "a.wav",
    }
    with pytest.raises(PluginError) as raised:
        Kokoro().call("tts.synthesize", params)
    assert raised.value.code == "invalid_request"
    assert "no default" in raised.value.message


def test_other_languages_are_unsupported() -> None:
    assert lang_code("en-GB") == "b"
    assert lang_code("en") == "a"
    with pytest.raises(PluginError) as raised:
        lang_code("fr")
    assert raised.value.code == "unsupported"


def test_capabilities_match_the_manifest() -> None:
    manifest = json.loads((Path(__file__).parents[1] / "manifest.json").read_text())
    assert Kokoro().capabilities() == manifest["capabilities"]
