import json
import os
import sys
from pathlib import Path

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


def test_release_runs_two_home_runs_and_one_pack_swap_per_brief(tmp_path: Path) -> None:
    code = run_tier_b(options(tmp_path, mode="release", month_cap_usd=100, cap_usd=1))
    assert code == 0
    r = report(tmp_path)
    tides = next(b for b in r["briefs"] if b["id"] == "tides_explainer")
    assert [run["pack"] for run in tides["runs"]] == ["neutral", "neutral", "playful"]
    assert [run["swap"] for run in tides["runs"]] == [False, False, True]
    assert tides["deterministic_pass_rate"] == 1
    # The pack-swap run is reported under the other pack.
    assert r["by_category"]["pack"]["playful"]["runs"] == 2 * 2 + 2
    assert r["by_category"]["aspect"]["portrait"]["runs"] == 3 + 3
    assert tides["vision"]["legibility"]["mean"] > 0
    assert r["spent_usd"] == 12 * 0.5


def test_runs_use_separate_projects_and_cassette_folders(tmp_path: Path) -> None:
    run_tier_b(options(tmp_path, mode="release", month_cap_usd=100, cap_usd=1, parallel=3))
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    renders = [c for c in calls if c["args"][0] == "render"]
    assert len({c["cassettes"] for c in renders}) == len(renders) == 12
    assert len({c["args"][c["args"].index("--project") + 1] for c in renders}) == 12


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
