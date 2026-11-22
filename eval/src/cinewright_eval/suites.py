"""Fixture suites (M8.4, AGENTS.md §4.1): the neutral benchmark, which gates, and the maintainer's
personal fixtures, which never do.

This module is the only place outside docs that names the personal folder (the boundary check
allows it here alone). A personal suite reports under "personal, not gating", always exits 0, and
may not update expected hashes or record a baseline.
"""

from __future__ import annotations

from pathlib import Path

SUITES = {
    "benchmark": Path("fixtures") / "benchmark",
    "personal": Path("fixtures") / "personal",
}


class SuiteError(Exception):
    pass


def suite_root(name: str) -> Path:
    """The suite's folder, relative to the repository root."""
    if name not in SUITES:
        raise SuiteError(f"unknown suite {name}; use one of {', '.join(SUITES)}")
    return SUITES[name]


def gating(name: str) -> bool:
    """Only the benchmark gates merges and releases."""
    return name == "benchmark"


def refuse_personal(name: str, action: str) -> None:
    """Personal fixtures may not change what the benchmark is judged against."""
    if not gating(name):
        raise SuiteError(f"the {name} suite cannot {action}: it never gates")
