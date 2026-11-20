import math

import pytest

from cinewright_stt_whisperx.align import TokenTime, words_from_tokens


def test_tokens_map_back_onto_script_words() -> None:
    groups = [["In"], ["twenty", "fourteen"], ["it"]]
    tokens: list[TokenTime] = [
        {"start": 0.1, "end": 0.2},
        {"start": 0.25, "end": 0.5},
        {"start": 0.55, "end": 0.9},
        {"start": 1.0, "end": 1.1},
    ]
    assert words_from_tokens(groups, tokens, 16_000) == [
        {"start": 1600, "end": 3200},
        {"start": 4000, "end": 14400},
        {"start": 16000, "end": 17600},
    ]


def test_an_untimed_word_comes_back_none() -> None:
    groups = [["a"], ["b"]]
    tokens: list[TokenTime] = [{"start": 0.1, "end": 0.2}, {"start": None, "end": None}]
    assert words_from_tokens(groups, tokens, 10) == [{"start": 1, "end": 2}, None]
    nan: list[TokenTime] = [{"start": 0.1, "end": 0.2}, {"start": math.nan, "end": math.nan}]
    assert words_from_tokens(groups, nan, 10)[1] is None


def test_a_count_mismatch_is_an_error() -> None:
    with pytest.raises(ValueError, match="1 token times for 2 tokens"):
        words_from_tokens([["a"], ["b"]], [{"start": 0.0, "end": 0.1}], 10)
