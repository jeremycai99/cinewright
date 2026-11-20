"""Spoken forms of script words, for forced alignment (M4.0b finding).

Forced alignment matches characters to speech, so it needs the words as spoken: "2014" is
"twenty fourteen", "£13.60" is "thirteen pounds and sixty pence". Given the written digits,
or with them left out, the alignment of the whole line goes wrong (container/audio/README.md
§Determinism). English only, like the aligner.
"""

from __future__ import annotations

import re

from num2words import num2words  # type: ignore[import-untyped]

_EDGE = re.compile(r"^[\"'“‘(\[]+|[\"'”’)\].,;:!?…]+$")
_CURRENCY = {
    "£": ("pound", "pounds", "penny", "pence"),
    "$": ("dollar", "dollars", "cent", "cents"),
    "€": ("euro", "euros", "cent", "cents"),
}
_SYMBOLS = {"&": "and", "+": "plus", "=": "equals", "@": "at", "%": "percent"}


def _n(value: int | float, to: str = "cardinal") -> str:
    return str(num2words(value, lang="en", to=to))  # pyright: ignore[reportArgumentType]


def spoken_form(word: str) -> str:
    """How an English word is spoken, as plain words; the word itself when nothing applies."""
    core = _EDGE.sub("", word)
    if not core:
        return word
    if core in _SYMBOLS:
        return _SYMBOLS[core]
    money = re.fullmatch(r"([£$€])(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?", core)
    if money:
        one, many, sub_one, sub_many = _CURRENCY[money.group(1)]
        whole = int(money.group(2).replace(",", ""))
        out = f"{_n(whole)} {one if whole == 1 else many}"
        if money.group(3) and int(money.group(3)):
            cents = int(money.group(3))
            out += f" and {_n(cents)} {sub_one if cents == 1 else sub_many}"
        return out
    percent = re.fullmatch(r"(\d+(?:\.\d+)?)%", core)
    if percent:
        return f"{_number(percent.group(1))} percent"
    ordinal = re.fullmatch(r"(\d+)(st|nd|rd|th)", core)
    if ordinal:
        return _n(int(ordinal.group(1)), to="ordinal")
    if re.fullmatch(r"1[1-9]\d\d|20\d\d", core):
        return _n(int(core), to="year")
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?", core):
        return _number(core.replace(",", ""))
    return word


def _number(text: str) -> str:
    return _n(float(text)) if "." in text else _n(int(text))


def spoken_tokens(words: list[str], spoken: list[str] | None) -> list[list[str]]:
    """For each script word, the space-separated tokens the aligner should match."""
    forms = spoken if spoken is not None else [spoken_form(w) for w in words]
    return [form.split() or [word] for form, word in zip(forms, words, strict=True)]
