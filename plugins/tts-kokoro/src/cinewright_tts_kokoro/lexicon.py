"""The project lexicon in Kokoro's terms (D29).

A respelling (`KOO-ber-NET-eez`) replaces the term in the text. A value in slashes is IPA, given
to misaki as an inline pronunciation, `[term](/ipa/)`. Matching is case-insensitive and never
inside a longer word, as in core's `lexiconUsed`.
"""

from __future__ import annotations

import re


def apply_lexicon(text: str, lexicon: dict[str, str]) -> str:
    """The text Kokoro should read, with every lexicon term replaced in one pass, so a
    replacement is never matched again by a shorter term; longer terms win."""
    if not lexicon:
        return text
    by_key = {term.lower(): value.strip() for term, value in lexicon.items()}
    terms = sorted(lexicon, key=len, reverse=True)
    pattern = re.compile(
        r"(?<![\w])(" + "|".join(re.escape(t) for t in terms) + r")(?![\w])", re.IGNORECASE
    )

    def replace(match: re.Match[str]) -> str:
        value = by_key[match.group(0).lower()]
        if value.startswith("/") and value.endswith("/") and len(value) > 2:
            return f"[{match.group(0)}]({value})"
        return value

    return pattern.sub(replace, text)
