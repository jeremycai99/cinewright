import json
import shutil
import subprocess
from pathlib import Path

import pytest

from cinewright_eval.briefs import brief_errors, check, coverage_gaps, load, pack_ids
from cinewright_eval.cli import main
from cinewright_eval.snapshot import SnapshotError, snapshot

ROOT = Path(__file__).resolve().parents[2]
PACKS = pack_ids(ROOT)
CLI = ROOT / "cli" / "dist" / "bin.js"


def test_the_v01_briefs_pass_the_checks_and_print_the_matrix(
    capsys: pytest.CaptureFixture[str],
) -> None:
    errors, table = check(ROOT)
    assert errors == []
    assert "tides_explainer | explainer | 60 s" in table
    assert main(["briefs", "check", "--root", str(ROOT)]) == 0
    assert "compost_explainer" in capsys.readouterr().out


def test_coverage_names_each_gap() -> None:
    briefs = load(ROOT)
    assert coverage_gaps(briefs[:3], PACKS) == [
        "coverage: 3 briefs; at least 4 are needed",
        "coverage: fewer than 2 ad briefs",
        "coverage: briefs must split evenly across the packs ({'neutral': 1, 'playful': 2})",
    ]
    single = [{**b, "deliverables": b["deliverables"][:1]} for b in briefs]
    assert "coverage: no brief asks for both aspect ratios" in coverage_gaps(single, PACKS)
    no60 = [{**b, "target_seconds": 30} for b in briefs]
    assert "coverage: no 60 s brief" in coverage_gaps(no60, PACKS)


def test_a_brief_naming_a_pack_a_token_a_colour_or_a_font_fails() -> None:
    brief = load(ROOT)[0]
    tainted = {
        **brief,
        "brief": f"{brief['brief']} Use the Playful pack, palette.accent, #ff8800 and Helvetica.",
    }
    errors = brief_errors(tainted, PACKS)
    assert any("names pack playful" in e for e in errors)
    assert any("names token palette.accent" in e for e in errors)
    assert any("names colour #ff8800" in e for e in errors)
    assert any("names font Helvetica" in e for e in errors)


@pytest.mark.skipif(not CLI.is_file(), reason="the CLI is not built")
def test_briefs_init_makes_a_project_whose_brief_and_pack_are_the_users(tmp_path: Path) -> None:
    to = tmp_path / "p"
    assert main(["briefs", "init", "compost_explainer", "--to", str(to), "--root", str(ROOT)]) == 0
    doc = json.loads((to / "cinewright.json").read_text())
    assert doc["brief"]["state"] == "user"
    assert doc["style"]["pack"] == {"state": "user", "value": "playful"}
    assert doc["autonomy"] == {"state": "user", "value": "auto"}
    assert sorted(d["id"] for d in doc["deliverables"]["value"]) == ["landscape", "portrait"]
    shown = subprocess.run(
        ["node", str(CLI), "status", "--project", str(to), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(shown.stdout)["revision"] == 1


def _project(tmp_path: Path, findings: list[dict[str, object]]) -> Path:
    project = tmp_path / "run"
    (project / "log").mkdir(parents=True)
    (project / "sequences").mkdir()
    (project / "cinewright.json").write_text(
        json.dumps(
            {
                "assets": {
                    "state": "user",
                    "value": [{"hash": "sha256:" + "a" * 64, "bytes": 3, "role": "take"}],
                }
            }
        )
    )
    (project / "log" / "patches.jsonl").write_text("{}\n")
    (project / "log" / "findings.jsonl").write_text("".join(json.dumps(f) + "\n" for f in findings))
    return project


def test_snapshot_refuses_an_open_error_and_freezes_a_clean_run(tmp_path: Path) -> None:
    raised = {
        "kind": "raised",
        "finding": "f_000000000001",
        "doc": {"rule": "layout.overflow", "entity": "s01.sh01", "severity": "error"},
    }
    root = tmp_path / "repo"
    root.mkdir()
    with pytest.raises(SnapshotError, match="open error findings: f_000000000001 layout.overflow"):
        snapshot(_project(tmp_path, [raised]), "fx", root)
    shutil.rmtree(tmp_path / "run")
    clean = _project(tmp_path, [raised, {"kind": "resolved", "finding": "f_000000000001"}])
    folder = snapshot(clean, "tides_neutral", root)
    assert (folder / "project" / "cinewright.json").is_file()
    assert (folder / "project" / "log" / "patches.jsonl").is_file()
    assert (
        json.loads((folder / "assets.json").read_text())["assets"][0]["hash"]
        == "sha256:" + "a" * 64
    )
    index = json.loads((root / "fixtures" / "benchmark" / "tier-a" / "index.json").read_text())
    assert index == {"fixtures": [{"id": "tides_neutral"}]}
    with pytest.raises(SnapshotError, match="already exists"):
        snapshot(clean, "tides_neutral", root)
