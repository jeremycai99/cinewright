"""`cinewright-eval tier-a`: render every alpha fixture and grade it (M8.3a, AGENTS.md §4.2).

Each fixture's project is copied to a scratch folder and rendered with `cinewright render --json`
in the tier A environment (`env.tier_a_env`). The run fails on any error finding, any hash that
differs from `expected/<runner class>.json`, a fixture that is missing, skipped or does not render,
and a paid plugin starting. Pass rates are reported per rule and per fixture, never averaged.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from cinewright_eval.env import tier_a_env
from cinewright_eval.report import write_reports
from cinewright_eval.suites import gating, refuse_personal, suite_root

HASH_FIELDS = ("sha256", "framemd5", "pcm_sha256")
#: The benchmark suite's index; another suite's is under its own root (M8.4).
INDEX = Path("fixtures") / "benchmark" / "tier-a" / "index.json"

Json = dict[str, object]


@dataclass
class TierAOptions:
    root: Path
    cli: list[str]
    out: Path
    #: Each fixture's render cache lives here, outside the scratch copy (CI restores it).
    cache: Path = Path(".tier-a-cache")
    runner_class: str = "linux-amd64"
    fixtures: list[str] = field(default_factory=lambda: list[str]())
    update_expected: bool = False
    suite: str = "benchmark"
    env: dict[str, str] = field(default_factory=lambda: dict(os.environ))


def _load(path: Path) -> Json:
    return cast(Json, json.loads(path.read_text(encoding="utf-8")))


def _commit(root: Path) -> str | None:
    try:
        done = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    return done.stdout.strip() or None


def _render(opts: TierAOptions, project: Path) -> tuple[int, Json | None, str]:
    done = subprocess.run(
        [*opts.cli, "render", "--project", str(project), "--json"],
        capture_output=True,
        text=True,
        env=tier_a_env(opts.env),
        check=False,
    )
    try:
        report = cast(Json, json.loads(done.stdout)) if done.stdout.strip() else None
    except json.JSONDecodeError:
        report = None
    return done.returncode, report, done.stderr


def _grade(opts: TierAOptions, entry: Json, folder: Path, critics: dict[str, Json]) -> Json:
    fixture_id = str(entry["id"])
    result: Json = {
        "id": fixture_id,
        "deliverables": [],
        "checks": {},
        "findings": [],
        "steps": {"hit": 0, "miss": 0},
    }
    if entry.get("skip"):
        result["error"] = "tier A may not skip a fixture"
        return result
    project = folder / "project"
    if not (project / "cinewright.json").is_file():
        result["error"] = f"no project at {project}"
        return result
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="cw-tier-a-") as scratch:
        copy = Path(scratch) / "project"
        shutil.copytree(project, copy, ignore=shutil.ignore_patterns("cache"))
        cache = (opts.cache / fixture_id).resolve()
        cache.mkdir(parents=True, exist_ok=True)
        (copy / ".cinewright").mkdir(exist_ok=True)
        (copy / ".cinewright" / "cache").symlink_to(cache, target_is_directory=True)
        code, report, stderr = _render(opts, copy)
        result["seconds"] = round(time.monotonic() - started, 1)
        if code not in (0, 10) or report is None:
            message = str((report or {}).get("message") or "")
            tail = " | ".join(line for line in stderr.strip().splitlines()[-3:] if line)
            result["error"] = f"render exited {code}: {message or tail}"
            return result
        steps = cast(list[Json], report.get("steps", []))
        result["steps"] = {
            "hit": sum(1 for s in steps if s.get("hit")),
            "miss": sum(1 for s in steps if not s.get("hit")),
        }
        expected_file = folder / "expected" / f"{opts.runner_class}.json"
        expected = cast(
            dict[str, Json],
            (_load(expected_file) if expected_file.is_file() else {}).get("deliverables", {}),
        )
        checks: dict[str, Json] = {}
        findings: list[Json] = []
        rows: list[Json] = []
        actual: dict[str, Json] = {}
        for deliverable, d in sorted(cast(dict[str, Json], report.get("deliverables", {})).items()):
            hashes = {k: d.get(k) for k in HASH_FIELDS}
            actual[deliverable] = hashes
            want = expected.get(deliverable)
            rows.append(
                {"id": deliverable, "hashes": hashes, "expected": want, "match": want == hashes}
            )
            critique = cast(Json | None, d.get("critique"))
            if critique is None:
                result["error"] = f"{deliverable} was not critiqued"
                continue
            saved = _load(Path(str(critique["file"])))
            for c in cast(list[Json], saved.get("critics", [])):
                baseline = cast(Json, c.get("baseline") or {})
                critics[str(c["id"])] = {
                    "id": c["id"],
                    "version": c["version"],
                    "settings_hash": baseline.get("settings"),
                    **(
                        {"hyperframes": baseline["hyperframes"]}
                        if "hyperframes" in baseline
                        else {}
                    ),
                }
            errors = [
                f
                for f in cast(list[Json], saved.get("findings", []))
                if f.get("severity") == "error"
            ]
            for rule in cast(list[str], saved.get("rules", [])):
                check = checks.setdefault(rule, {"run": 0, "failed": 0})
                check["run"] = cast(int, check["run"]) + 1
                if any(f.get("rule") == rule for f in errors):
                    check["failed"] = cast(int, check["failed"]) + 1
            findings.extend({**f, "deliverable": deliverable} for f in errors)
        if opts.update_expected:
            expected_file.parent.mkdir(parents=True, exist_ok=True)
            expected_file.write_text(
                json.dumps({"deliverables": actual}, indent=2, sort_keys=True) + "\n"
            )
            for row in rows:
                row["expected"], row["match"] = row["hashes"], True
        for row in rows:
            if not row["match"]:
                for k in HASH_FIELDS:
                    got = cast(Json, row["hashes"]).get(k)
                    want = cast(Json, row["expected"] or {}).get(k)
                    if got != want:
                        print(f"{fixture_id} {row['id']} {k}: expected {want}, got {got}")
        result.update(deliverables=rows, checks=dict(sorted(checks.items())), findings=findings)
    return result


def run_tier_a(opts: TierAOptions) -> int:
    """Render and grade the fixtures; write `tier-a.json` and `tier-a.md` to `opts.out`.
    Returns 0 when every fixture passes, 1 otherwise."""
    if opts.update_expected:
        refuse_personal(opts.suite, "update expected hashes")
    index_file = opts.root / suite_root(opts.suite) / "tier-a" / "index.json"
    if not index_file.is_file():
        print(f"cinewright-eval tier-a: no fixture index at {index_file}")
        return 1
    index = cast(list[Json], _load(index_file).get("fixtures", []))
    known = {str(f["id"]) for f in index}
    unknown = [f for f in opts.fixtures if f not in known]
    chosen = [f for f in index if not opts.fixtures or str(f["id"]) in opts.fixtures]
    critics: dict[str, Json] = {}
    fixtures: list[Json] = [
        _grade(opts, entry, index_file.parent / str(entry["path"]), critics) for entry in chosen
    ]
    for f in unknown:
        missing: Json = {
            "id": f,
            "error": "no such fixture in index.json",
            "deliverables": [],
            "checks": {},
            "findings": [],
            "steps": {"hit": 0, "miss": 0},
        }
        fixtures.append(missing)
    hyperframes = sorted(
        {str(c.pop("hyperframes")) for c in critics.values() if "hyperframes" in c}
    )
    report: Json = {
        "commit": _commit(opts.root),
        "runner_class": opts.runner_class,
        "image": {
            "render": opts.env.get("CINEWRIGHT_IMAGE"),
            "audio": opts.env.get("CINEWRIGHT_AUDIO_IMAGE"),
        },
        "critics": [critics[k] for k in sorted(critics)],
        "hyperframes": ",".join(hyperframes) or None,
        "fixtures": fixtures,
    }
    if not gating(opts.suite):
        report["suite"] = f"{opts.suite}, not gating"
    passed = write_reports(report, opts.out)
    if not gating(opts.suite):
        print(f"cinewright-eval tier-a: {opts.suite}, not gating")
        return 0
    return 0 if passed else 1
