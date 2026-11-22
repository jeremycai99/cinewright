import json
from pathlib import Path

import pytest

from cinewright_eval.baseline import Run, check, record, run_from_report, threshold
from cinewright_eval.cli import main


def runs(pack: str, values: list[float], fixture: str = "fx") -> list[Run]:
    return [Run(fixture, pack, "web", {"legibility": [v]}) for v in values]


def test_threshold_is_mean_minus_two_sd_floored() -> None:
    # mean 4, sample sd 1: 4 - 2 = 2, floored at floor + 1 = 3.
    assert threshold([3, 4, 5], floor=2) == 3
    # mean 4.5, sd 0.57735 (rounded to 6 places): 4.5 - 1.1547 = 3.3453.
    assert threshold([4, 4, 5, 5], floor=2) == pytest.approx(3.3453, abs=1e-6)
    # One run: sd 0, so the mean.
    assert threshold([4], floor=2) == 4


def test_a_run_reads_vision_scores_from_a_report_mean_over_targets() -> None:
    report = {
        "deliverable": "web",
        "measured": {
            "vision.evaluated": 1,
            "vision.legibility.s01.sh01": 4,
            "vision.legibility.s01.sh02": 2,
            "vision.rhythm.s01": 5,
            "critic_layout.boxes": 9,
        },
    }
    run = run_from_report(report, "fx", "neutral")
    assert run.scores == {"legibility": [4.0, 2.0], "rhythm": [5.0]}
    assert run.value("legibility") == 3


def test_record_stores_cells_and_per_pack_thresholds_with_pins() -> None:
    baseline = record(
        runs("neutral", [4, 4, 5, 5]) + runs("playful", [5, 5, 5], "fy"),
        {"critic_pin": "critic-2026-11", "rubric_version": "craft@1"},
        floor=2,
    )
    assert baseline["fixtures"]["fx"]["web"]["legibility"] == {"mean": 4.5, "sd": 0.57735, "n": 4}
    assert baseline["thresholds"]["neutral"]["legibility"] == pytest.approx(3.3453, abs=1e-6)
    assert baseline["thresholds"]["playful"]["legibility"] == 5
    assert baseline["pins"]["rubric_version"] == "craft@1"


def test_check_passes_at_or_over_the_threshold_and_fails_under_it() -> None:
    baseline = {"thresholds": {"neutral": {"legibility": 3.5}}}
    assert check(runs("neutral", [3, 4]), baseline)[0]["pass"] is True
    assert check(runs("neutral", [3, 3.5]), baseline)[0] == {
        "pack": "neutral",
        "criterion": "legibility",
        "mean": 3.25,
        "threshold": 3.5,
        "pass": False,
    }
    # A pack the baseline never recorded cannot pass.
    assert check(runs("other", [5]), baseline)[0]["pass"] is False


def test_cli_records_and_checks(tmp_path: Path) -> None:
    files = []
    for i, v in enumerate([4, 4, 5, 5]):
        f = tmp_path / f"run{i}.json"
        f.write_text(
            json.dumps(
                {
                    "fixture": "fx",
                    "pack": "neutral",
                    "deliverable": "web",
                    "scores": {"legibility": [v]},
                }
            )
        )
        files.append(str(f))
    pins = tmp_path / "pins.json"
    pins.write_text(json.dumps({"critic_pin": "p"}))
    out = tmp_path / "baseline.json"
    assert main(["baseline", "record", *files, "--pins", str(pins), "--out", str(out)]) == 0
    assert json.loads(out.read_text())["thresholds"]["neutral"]["legibility"] > 3
    assert main(["baseline", "check", *files, "--against", str(out)]) == 0
    low = tmp_path / "low.json"
    low.write_text(
        json.dumps(
            {
                "fixture": "fx",
                "pack": "neutral",
                "deliverable": "web",
                "scores": {"legibility": [1]},
            }
        )
    )
    assert main(["baseline", "check", str(low), "--against", str(out)]) == 1
