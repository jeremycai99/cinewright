import json
import os
import sys
from pathlib import Path

import pytest

from cinewright_eval.cli import main
from cinewright_eval.tier_b import TierBOptions, compare, run_tier_b

ROOT = Path(__file__).resolve().parents[2]
STUB = Path(__file__).parent / "stubs" / "stub_tier_b_cli.py"


def options(tmp_path: Path, **kw: object) -> TierBOptions:
    env = {**os.environ, "STUB_LOG": str(tmp_path / "calls.jsonl")}
    env.update(kw.pop("env", {}))  # type: ignore[arg-type]
    return TierBOptions(
        root=ROOT,
        cli=[sys.executable, str(STUB)],
        out=tmp_path / "out",
        env=env,
        **kw,  # type: ignore[arg-type]
    )


def report(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "out" / "tier-b.json").read_text())


def test_release_runs_one_home_run_and_one_pack_swap_per_brief(tmp_path: Path) -> None:
    # Decision 11, revised 2026-11-25: 4 briefs x 1 home-pack run + 4 pack-swap runs = 8 runs.
    code = run_tier_b(options(tmp_path, mode="release", month_cap_usd=100, cap_usd=1))
    assert code == 0
    r = report(tmp_path)
    tides = next(b for b in r["briefs"] if b["id"] == "tides_explainer")
    assert [run["pack"] for run in tides["runs"]] == ["neutral", "playful"]
    assert [run["swap"] for run in tides["runs"]] == [False, True]
    assert tides["deterministic_pass_rate"] == 1
    # The pack-swap run is reported under the other pack.
    assert r["by_category"]["pack"]["playful"]["runs"] == 2 * 1 + 2
    assert r["by_category"]["aspect"]["portrait"]["runs"] == 2 + 2
    assert tides["vision"]["legibility"]["mean"] > 0
    assert r["spent_usd"] == 8 * 0.5


def test_runs_use_separate_projects_and_cassette_folders(tmp_path: Path) -> None:
    run_tier_b(options(tmp_path, mode="release", month_cap_usd=100, cap_usd=1, parallel=3))
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    renders = [c for c in calls if c["args"][0] == "render"]
    assert len({c["cassettes"] for c in renders}) == len(renders) == 8
    assert len({c["args"][c["args"].index("--project") + 1] for c in renders}) == 8


def caps_by_project(tmp_path: Path) -> dict[str, float]:
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    return {
        Path(c["args"][c["args"].index("--project") + 1]).parent.name: float(
            c["args"][c["args"].index("--cap") + 1]
        )
        for c in calls
        if c["args"][:2] == ["review", "budget"]
    }


def test_each_run_is_capped_by_its_brief_length(tmp_path: Path) -> None:
    # Decision 11: per-run caps follow target length (15 s $4, 30 s $6, 60 s $10).
    run_tier_b(options(tmp_path, mode="release", month_cap_usd=100))
    assert caps_by_project(tmp_path) == {
        "tides_explainer-0-home": 10.0,
        "tides_explainer-1-swap": 10.0,
        "compost_explainer-0-home": 6.0,
        "compost_explainer-1-swap": 6.0,
        "library_hours_ad-0-home": 4.0,
        "library_hours_ad-1-swap": 4.0,
        "bike_repair_ad-0-home": 6.0,
        "bike_repair_ad-1-swap": 6.0,
    }
    tides = next(b for b in report(tmp_path)["briefs"] if b["id"] == "tides_explainer")
    assert [run["cap_usd"] for run in tides["runs"]] == [10.0, 10.0]


def test_runs_are_admitted_against_the_month_cap_at_their_own_caps(tmp_path: Path) -> None:
    # The tides runs ($10 each) fill a $20 month cap; every other run is skipped.
    code = run_tier_b(options(tmp_path, mode="release", month_cap_usd=20))
    assert code == 1
    skipped = report(tmp_path)["skipped"]
    assert len(skipped) == 6
    assert {x.split("#")[0] for x in skipped} == {
        "compost_explainer",
        "library_hours_ad",
        "bike_repair_ad",
    }


def test_the_default_month_cap_covers_the_release_run(tmp_path: Path) -> None:
    # Decision 11: the month cap at launch covers the sum of the per-run caps ($52).
    code = run_tier_b(options(tmp_path, mode="release"))
    assert code == 0
    assert report(tmp_path)["skipped"] == []


def test_a_paused_run_counts_a_manual_edit_and_fails_the_brief(tmp_path: Path) -> None:
    env = {"STUB_TIER_B": json.dumps({"bike_repair_ad": "paused"})}
    code = run_tier_b(options(tmp_path, mode="release", month_cap_usd=100, cap_usd=1, env=env))
    assert code == 1
    bike = next(b for b in report(tmp_path)["briefs"] if b["id"] == "bike_repair_ad")
    assert all(run["manual_edits"] == 1 for run in bike["runs"])
    assert bike["deterministic_pass_rate"] == 0


def test_the_month_cap_holds_runs_skipped_never_passed(tmp_path: Path) -> None:
    # Cap covers 2.5 briefs' worth of nightly runs (one per brief at $1 each).
    nightly = run_tier_b(options(tmp_path, mode="nightly", month_cap_usd=2.5, cap_usd=1))
    r = report(tmp_path)
    assert nightly == 0
    assert len(r["skipped"]) == 2
    assert r["spent_usd"] <= 2.5
    release = run_tier_b(options(tmp_path, mode="release", month_cap_usd=2.5, cap_usd=1))
    assert release == 1


def test_a_provider_outage_is_not_evaluated_exit_2(tmp_path: Path) -> None:
    outage = {
        b: "provider"
        for b in ["tides_explainer", "compost_explainer", "library_hours_ad", "bike_repair_ad"]
    }
    code = run_tier_b(
        options(
            tmp_path,
            mode="nightly",
            month_cap_usd=100,
            cap_usd=1,
            env={"STUB_TIER_B": json.dumps(outage)},
        )
    )
    assert code == 2


def test_export_findings_fail_deterministically_by_rule(tmp_path: Path) -> None:
    env = {"STUB_TIER_B": json.dumps({"library_hours_ad": "findings"})}
    run_tier_b(options(tmp_path, mode="nightly", month_cap_usd=100, cap_usd=1, env=env))
    lib = next(b for b in report(tmp_path)["briefs"] if b["id"] == "library_hours_ad")
    assert lib["runs"][0]["deterministic"] == {"failed": 1, "by_rule": {"layout.overflow": 1}}


def test_compare_fails_on_one_regressed_category_even_if_the_average_rises() -> None:
    baseline = {
        "by_category": {
            "genre": {"explainer": {"deterministic_pass_rate": 1.0, "vision": {"legibility": 3.5}}},
            "pack": {"playful": {"deterministic_pass_rate": 0.5}},
        }
    }
    report_doc = {
        "by_category": {
            "genre": {"explainer": {"deterministic_pass_rate": 1.0, "vision": {"legibility": 3.2}}},
            "pack": {"playful": {"deterministic_pass_rate": 1.0, "vision": {}}},
        }
    }
    assert compare(report_doc, baseline) == ["genre=explainer: vision legibility 3.2 < 3.5"]
    assert compare({"by_category": {}}, baseline)[0] == "genre=explainer: not run"


def test_the_personal_suite_never_gates(tmp_path: Path) -> None:
    from cinewright_eval.suites import SuiteError, refuse_personal, suite_root

    root = tmp_path / "repo"
    (root / "packs" / "neutral").mkdir(parents=True)
    (root / "packs" / "neutral" / "pack.json").write_text("{}")
    (root / "packs" / "playful").mkdir(parents=True)
    (root / "packs" / "playful" / "pack.json").write_text("{}")
    briefs = root / suite_root("personal") / "tier-b"
    src = ROOT / "fixtures" / "benchmark" / "tier-b" / "bike_repair_ad"
    (briefs / "mine").mkdir(parents=True)
    brief = json.loads((src / "brief.json").read_text())
    (briefs / "mine" / "brief.json").write_text(json.dumps({**brief, "id": "mine"}))
    (briefs / "index.json").write_text(json.dumps({"briefs": [{"id": "mine"}]}))
    env = {"STUB_TIER_B": json.dumps({"mine": "paused"})}
    opts = options(tmp_path, mode="release", month_cap_usd=100, cap_usd=1, env=env)
    opts.root = root
    opts.suite = "personal"
    # Every run pauses, which fails a benchmark brief; the personal suite still exits 0.
    assert run_tier_b(opts) == 0
    assert report(tmp_path)["suite"] == "personal, not gating"
    with pytest.raises(SuiteError, match="cannot record a baseline"):
        refuse_personal("personal", "record a baseline")
    assert (
        main(
            [
                "baseline",
                "record",
                "x.json",
                "--pins",
                "p.json",
                "--out",
                "o.json",
                "--suite",
                "personal",
            ]
        )
        == 2
    )
