"""Vision baselines (M6.2, D36): record per-criterion means and spreads, check runs against them.

A *run* is one vision scoring of one fixture's deliverable: ``{fixture, pack, deliverable,
scores: {criterion: [score, ...]}}``, its scores read from a critique report's ``measured``
(``vision.<criterion>.<target>``). A run's value for a criterion is the mean over its targets.

A baseline records, per fixture, deliverable and criterion, the mean and sample standard deviation
over runs, and per pack and criterion a threshold: ``mean - 2 * sd`` over the pack's runs,
floored at ``floor + 1``. Thresholds are written when the baseline is recorded and never computed
at check time (Open issue 12). A later run passes when its mean over runs meets the threshold.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

VISION_PREFIX = "vision."


@dataclass(frozen=True)
class Run:
    fixture: str
    pack: str
    deliverable: str
    scores: dict[str, list[float]]

    def value(self, criterion: str) -> float | None:
        values = self.scores.get(criterion) or []
        return sum(values) / len(values) if values else None


def run_from_report(report: dict[str, Any], fixture: str, pack: str) -> Run:
    """A run from a critique report: its ``vision.<criterion>.<target>`` measurements."""
    scores: dict[str, list[float]] = defaultdict(list)
    for name, value in report.get("measured", {}).items():
        if not name.startswith(VISION_PREFIX) or name == "vision.evaluated":
            continue
        criterion = name[len(VISION_PREFIX) :].split(".", 1)[0]
        scores[criterion].append(float(value))
    return Run(fixture, pack, str(report.get("deliverable", "")), dict(scores))


def _stats(values: list[float]) -> dict[str, float | int]:
    n = len(values)
    mean = sum(values) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1)) if n > 1 else 0.0
    return {"mean": round(mean, 6), "sd": round(sd, 6), "n": n}


def threshold(values: list[float], floor: int) -> float:
    """``mean - 2 * sd`` over the values, never under ``floor + 1``."""
    stats = _stats(values)
    return round(max(float(stats["mean"]) - 2 * float(stats["sd"]), floor + 1), 6)


def record(runs: list[Run], pins: dict[str, Any], floor: int) -> dict[str, Any]:
    """A baseline document from the runs, with the pins it was recorded under."""
    by_cell: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    by_pack: dict[tuple[str, str], list[float]] = defaultdict(list)
    for run in runs:
        for criterion in run.scores:
            value = run.value(criterion)
            if value is None:
                continue
            by_cell[(run.fixture, run.deliverable, criterion)].append(value)
            by_pack[(run.pack, criterion)].append(value)
    fixtures: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(dict))
    for (fixture, deliverable, criterion), values in sorted(by_cell.items()):
        fixtures[fixture][deliverable][criterion] = _stats(values)
    thresholds: dict[str, dict[str, float]] = defaultdict(dict)
    for (pack, criterion), values in sorted(by_pack.items()):
        thresholds[pack][criterion] = threshold(values, floor)
    return {
        "pins": pins,
        "floor": floor,
        "fixtures": {f: dict(d) for f, d in fixtures.items()},
        "thresholds": dict(thresholds),
    }


def check(runs: list[Run], baseline: dict[str, Any]) -> list[dict[str, Any]]:
    """Per pack and criterion: the runs' mean, the recorded threshold, and whether it passes."""
    by_pack: dict[tuple[str, str], list[float]] = defaultdict(list)
    for run in runs:
        for criterion in run.scores:
            value = run.value(criterion)
            if value is not None:
                by_pack[(run.pack, criterion)].append(value)
    out: list[dict[str, Any]] = []
    for (pack, criterion), values in sorted(by_pack.items()):
        limit = baseline.get("thresholds", {}).get(pack, {}).get(criterion)
        mean = round(sum(values) / len(values), 6)
        out.append(
            {
                "pack": pack,
                "criterion": criterion,
                "mean": mean,
                "threshold": limit,
                "pass": limit is not None and mean >= limit,
            }
        )
    return out


def load_runs(paths: list[Path]) -> list[Run]:
    """Runs from files: each a run object or a list of them."""
    runs: list[Run] = []
    for path in paths:
        doc: Any = json.loads(path.read_text())
        items = cast(list[dict[str, Any]], doc if isinstance(doc, list) else [doc])
        for item in items:
            runs.append(
                Run(
                    str(item["fixture"]),
                    str(item["pack"]),
                    str(item["deliverable"]),
                    {str(k): [float(v) for v in vs] for k, vs in item["scores"].items()},
                )
            )
    return runs
