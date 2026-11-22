import json
import sys
from pathlib import Path
from typing import Any

import pytest

from cinewright_eval.env import tier_a_env
from cinewright_eval.tier_a import TierAOptions, run_tier_a

STUB = Path(__file__).parent / "stubs" / "stub_cli.py"
HASHES = {"sha256": "s1", "framemd5": "f1", "pcm_sha256": "p1"}


def finding(rule: str, severity: str = "error") -> dict[str, object]:
    return {
        "id": "f_000000000001",
        "rule": rule,
        "severity": severity,
        "entity": "s01.sh01.title",
        "message": "m",
    }


def setup(
    tmp_path: Path,
    scenario: dict[str, Any],
    fixtures: list[dict[str, object]] | None = None,
    expected: dict[str, dict[str, str]] | None = None,
) -> TierAOptions:
    root = tmp_path / "repo"
    tier = root / "fixtures" / "benchmark" / "tier-a"
    listed = fixtures or [
        {"id": "explainer_01_neutral", "path": "explainer_01_neutral", "deliverables": ["web"]}
    ]
    for f in listed:
        if f.get("missing"):
            continue
        folder = tier / str(f["path"])
        (folder / "project").mkdir(parents=True)
        (folder / "project" / "cinewright.json").write_text("{}")
        (folder / "expected").mkdir()
        (folder / "expected" / "linux-amd64.json").write_text(
            json.dumps({"deliverables": expected if expected is not None else {"web": HASHES}})
        )
    tier.mkdir(parents=True, exist_ok=True)
    clean = [{k: v for k, v in f.items() if k != "missing"} for f in listed]
    (tier / "index.json").write_text(json.dumps({"fixtures": clean}))
    scenario_file = tmp_path / "scenario.json"
    scenario_file.write_text(json.dumps(scenario))
    return TierAOptions(
        root=root,
        cli=[sys.executable, str(STUB)],
        out=tmp_path / "out",
        cache=tmp_path / "cache",
        runner_class="linux-amd64",
        env={
            "PATH": "/usr/bin",
            "STUB_SCENARIO": str(scenario_file),
            "STUB_ENV_OUT": str(tmp_path / "env.json"),
            "ELEVENLABS_API_KEY": "sk-secret",
            "ANTHROPIC_API_KEY": "sk-ant",
            "SOME_SERVICE_TOKEN": "t",
            "CINEWRIGHT_CAS_REMOTE": "https://example.org/cas/{hex}",
        },
    )


def clean_run(findings: list[dict[str, object]] | None = None, code: int = 0) -> dict[str, object]:
    return {
        "project": {
            "code": code,
            "deliverables": {"web": {**HASHES, "findings": findings or []}},
            "steps": [{"id": "render:s01.sh01@web", "hit": True}, {"id": "mix@web", "hit": False}],
        }
    }


def read(out: Path) -> tuple[Any, str]:
    return json.loads((out / "tier-a.json").read_text()), (out / "tier-a.md").read_text()


def test_a_passing_run_exits_0_and_lists_every_rule(tmp_path: Path) -> None:
    opts = setup(tmp_path, clean_run())
    assert run_tier_a(opts) == 0
    report, summary = read(opts.out)
    fixture = report["fixtures"][0]
    assert fixture["id"] == "explainer_01_neutral"
    assert fixture["checks"] == {
        rule: {"run": 1, "failed": 0}
        for rule in ["audio.loudness", "captions.sync", "layout.overflow", "stt.mismatch"]
    }
    assert fixture["deliverables"] == [
        {"id": "web", "hashes": HASHES, "expected": HASHES, "match": True}
    ]
    assert fixture["steps"] == {"hit": 1, "miss": 1}
    assert report["critics"] == [
        {"id": "clearance", "version": "0.1.0", "settings_hash": None},
        {"id": "critic_layout", "version": "0.1.0", "settings_hash": "sha256:aa"},
    ]
    assert report["hyperframes"] == "0.9.58"
    assert "| layout.overflow | 1 | 0 | 100% |" in summary


def test_one_failure_names_the_rule_fixture_and_deliverable_first(tmp_path: Path) -> None:
    opts = setup(
        tmp_path,
        clean_run([finding("layout.overflow"), finding("captions.sync", "warning")], code=10),
    )
    assert run_tier_a(opts) == 1
    report, summary = read(opts.out)
    assert report["fixtures"][0]["checks"]["layout.overflow"] == {"run": 1, "failed": 1}
    assert report["fixtures"][0]["checks"]["captions.sync"] == {"run": 1, "failed": 0}
    first = summary.split("\n## ")[1]
    assert first.startswith("Failures")
    assert "layout.overflow · explainer_01_neutral · web" in first


def test_a_hash_mismatch_prints_both_and_update_expected_rewrites_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    opts = setup(tmp_path, clean_run(), expected={"web": {**HASHES, "framemd5": "f0"}})
    assert run_tier_a(opts) == 1
    out = capsys.readouterr().out
    assert "framemd5" in out and "f0" in out and "f1" in out
    opts.update_expected = True
    assert run_tier_a(opts) == 0
    saved = json.loads(
        (
            opts.root / "fixtures/benchmark/tier-a/explainer_01_neutral/expected/linux-amd64.json"
        ).read_text()
    )
    assert saved["deliverables"]["web"] == HASHES


def test_a_missing_or_skipped_fixture_fails(tmp_path: Path) -> None:
    fixtures = [
        {"id": "explainer_01_neutral", "path": "explainer_01_neutral", "deliverables": ["web"]},
        {"id": "gone", "path": "gone", "deliverables": ["web"], "missing": True},
    ]
    opts = setup(tmp_path, clean_run(), fixtures)
    (tmp_path / "scenario.json").write_text(json.dumps(clean_run()))
    assert run_tier_a(opts) == 1
    _, summary = read(opts.out)
    assert "gone" in summary.split("\n## ")[1]
    skipped = [
        {
            "id": "explainer_01_neutral",
            "path": "explainer_01_neutral",
            "deliverables": ["web"],
            "skip": True,
        }
    ]
    opts2 = setup(tmp_path / "b", clean_run(), skipped)
    assert run_tier_a(opts2) == 1


def test_an_unknown_fixture_id_fails(tmp_path: Path) -> None:
    opts = setup(tmp_path, clean_run())
    opts.fixtures = ["nope"]
    assert run_tier_a(opts) == 1


def test_provider_keys_are_removed_and_paid_plugins_refused(tmp_path: Path) -> None:
    opts = setup(tmp_path, clean_run())
    assert run_tier_a(opts) == 0
    seen = json.loads((tmp_path / "env.json").read_text())
    assert "ELEVENLABS_API_KEY" not in seen
    assert "ANTHROPIC_API_KEY" not in seen
    assert "SOME_SERVICE_TOKEN" not in seen
    assert seen["CINEWRIGHT_FREE_ONLY"] == "1"
    assert seen["CINEWRIGHT_CAS_REMOTE"] == "https://example.org/cas/{hex}"


def test_a_paid_plugin_starting_fails_the_run(tmp_path: Path) -> None:
    scenario = {
        "project": {
            "code": 9,
            "stderr": "elevenlabs: unsupported: a paid plugin may not run "
            "with CINEWRIGHT_FREE_ONLY=1",
        }
    }
    opts = setup(tmp_path, scenario)
    assert run_tier_a(opts) == 1
    report, summary = read(opts.out)
    assert "CINEWRIGHT_FREE_ONLY" in report["fixtures"][0]["error"]
    assert "explainer_01_neutral" in summary.split("\n## ")[1]


def test_tier_a_env_keeps_the_rest() -> None:
    env = tier_a_env(
        {"HOME": "/h", "OPENAI_API_KEY": "x", "CINEWRIGHT_IMAGE": "img", "DB_PASSWORD": "p"}
    )
    assert env == {"HOME": "/h", "CINEWRIGHT_IMAGE": "img", "CINEWRIGHT_FREE_ONLY": "1"}


def test_the_cli_subcommand_runs_the_harness(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cinewright_eval.cli import main

    opts = setup(tmp_path, clean_run())
    for k, v in opts.env.items():
        monkeypatch.setenv(k, v)
    cli = f"{sys.executable} {STUB}"
    code = main(["tier-a", "--root", str(opts.root), "--cli", cli, "--out", str(opts.out)])
    assert code == 0
    assert (opts.out / "tier-a.md").is_file()


def test_the_render_cache_outlives_the_scratch_copy(tmp_path: Path) -> None:
    opts = setup(tmp_path, clean_run())
    assert run_tier_a(opts) == 0
    assert (tmp_path / "cache" / "explainer_01_neutral" / "reports" / "web.json").is_file()
    fixture = opts.root / "fixtures/benchmark/tier-a/explainer_01_neutral/project"
    assert not (fixture / ".cinewright").exists()


def test_no_fixture_index_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    opts = TierAOptions(root=tmp_path, cli=["true"], out=tmp_path / "out")
    assert run_tier_a(opts) == 1
    assert "no fixture index" in capsys.readouterr().out


def test_the_personal_suite_reports_not_gating_and_never_updates_expected(tmp_path: Path) -> None:
    from cinewright_eval.suites import SuiteError, suite_root

    opts = setup(tmp_path, clean_run([finding("layout.overflow")]))
    # Move the fixtures into the personal suite: the default suite no longer sees them.
    bench = opts.root / "fixtures" / "benchmark" / "tier-a"
    personal = opts.root / suite_root("personal") / "tier-a"
    personal.parent.mkdir(parents=True)
    bench.rename(personal)
    assert run_tier_a(opts) == 1  # no benchmark index
    opts.suite = "personal"
    assert run_tier_a(opts) == 0  # a failing personal fixture still exits 0
    report, md = read(opts.out)
    assert report["suite"] == "personal, not gating"
    assert "personal, not gating" in md
    opts.update_expected = True
    with pytest.raises(SuiteError, match="cannot update expected hashes"):
        run_tier_a(opts)
