"""Map an aligner's per-token times back onto the script's words."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import TypedDict


class Span(TypedDict):
    start: int
    end: int


class TokenTime(TypedDict, total=False):
    start: float | None
    end: float | None


def words_from_tokens(
    groups: Sequence[Sequence[str]], tokens: Sequence[TokenTime], sample_rate: int
) -> list[Span | None]:
    """One time per script word: the span of its tokens that the aligner timed, else None.

    `groups[i]` are word i's tokens; `tokens` are the aligner's results for every token in
    order (one per space-separated token of the aligned text). Seconds become samples.
    """
    total = sum(len(g) for g in groups)
    if len(tokens) != total:
        raise ValueError(f"the aligner returned {len(tokens)} token times for {total} tokens")
    out: list[Span | None] = []
    at = 0
    for group in groups:
        mine = tokens[at : at + len(group)]
        at += len(group)
        starts = [s for t in mine if _timed(s := t.get("start"))]
        ends = [e for t in mine if _timed(e := t.get("end"))]
        if not starts or not ends:
            out.append(None)
            continue
        start = round(min(starts) * sample_rate)  # type: ignore[type-var]
        end = round(max(ends) * sample_rate)  # type: ignore[type-var]
        out.append({"start": start, "end": max(start, end)})
    return out


def _timed(value: float | None) -> bool:
    """A time the aligner gave: not missing, not NaN."""
    return value is not None and not math.isnan(value)
