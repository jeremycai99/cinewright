"""`cinewright-eval tier-b` (M8.3b): briefs through live agents and providers, capped, per category.

Each run is a fresh project for one brief (`briefs init`), capped with `review budget --cap`, run
with `render --approve-final --vision --json`, exported, and read back with `status --json` and the
critique reports. Runs of one brief execute in parallel up to a limit, each in its own folder with
its own cassette folder and caches. Before a run starts, the month cap is checked: a run that could
cross it is skipped and reported as skipped, never as passed.

Decision 11 (reduced v0.1 scope): release mode runs 2 runs per brief in its home pack plus 1
pack-swap run in the other pack; nightly mode runs 1 home run. A run counts as complete only with
no manual edit (a pause for a person or a gate other than the final one fails it).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from cinewright_eval.briefs import PROFILES, init_project, load, pack_ids

Json = dict[str, Any]

#: Exit codes of `cinewright` that matter here (cli/src/exit-codes.ts).
PAUSED, BUDGET, PROVIDER, FINDINGS = 11, 12, 9, 10


@dataclass
class TierBOptions:
    root: Path
    cli: list[str]
    out: Path
    mode: str = "release"
    briefs: list[str] = field(default_factory=lambda: list[str]())
    runs: int | None = None
    cap_usd: float = 3.0
    month_cap_usd: float = 25.0
    parallel: int = 2
    env: dict[str, str] | None = None


@dataclass
class Planned:
    brief: Json
    pack: str
    index: int
    swap: bool


def _stats(values: list[float]) -> Json:
    if not values:
        return {"mean": None, "sd": None, "max": None}
    mean = sum(values) / len(values)
    sd = (
        math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))
        if len(values) > 1
        else 0.0
    )
    return {"mean": round(mean, 6), "sd": round(sd, 6), "max": round(max(values), 6)}


def _call(opts: TierBOptions, args: list[str], env: dict[str, str]) -> tuple[int, Json | None, str]:
    done = subprocess.run([*opts.cli, *args], capture_output=True, text=True, env=env, check=False)
    try:
        out = cast(Json, json.loads(done.stdout)) if done.stdout.strip() else None
    except json.JSONDecodeError:
        out = None
    return done.returncode, out, done.stderr


def _vision(project: Path) -> Json:
    """The newest critique report's vision scores: the mean per criterion over targets."""
    reports = sorted(
        (project / ".cinewright" / "cache" / "reports").glob("*.json"),
        key=lambda p: p.stat().st_mtime,
    )
    if not reports:
        return {}
    measured = cast(Json, json.loads(reports[-1].read_text()).get("measured", {}))
    by: dict[str, list[float]] = {}
    for name, value in measured.items():
        if name.startswith("vision.") and name != "vision.evaluated":
            by.setdefault(name.split(".")[1], []).append(float(value))
    return {k: round(sum(v) / len(v), 6) for k, v in by.items()}


def _run(opts: TierBOptions, plan: Planned, folder: Path) -> Json:
    brief = plan.brief
    started = time.monotonic()
    project = folder / "project"
    env = {**(opts.env or dict(os.environ)), "CINEWRIGHT_CASSETTES": str(folder / "cassettes")}
    result: Json = {
        "pack": plan.pack,
        "swap": plan.swap,
        "completed": False,
        "manual_edits": 0,
        "deterministic": {"failed": 0, "by_rule": {}},
        "vision": {},
        "cost_usd": 0.0,
        "escalated": 0,
        "hashes": {},
    }
    if init_project(opts.root, str(brief["id"]), project, opts.cli, plan.pack) != 0:
        result["error"] = "init"
        return result
    p = ["--project", str(project)]
    _call(opts, ["review", "budget", "--cap", str(opts.cap_usd), *p, "--json"], env)
    code, out, stderr = _call(opts, ["render", "--approve-final", "--vision", *p, "--json"], env)
    if code in (PAUSED, BUDGET):
        result["manual_edits"] = 1
        result["pause"] = (out or {}).get("pause")
    elif code == PROVIDER:
        result["error"] = "provider_error"
    elif code != 0:
        result["error"] = f"render exit {code}: {stderr.strip()[-300:]}"
    else:
        code, exported, stderr = _call(
            opts, ["export", "--to", str(folder / "export"), *p, "--json"], env
        )
        if code == 0 and exported:
            result["completed"] = True
            result["hashes"] = exported.get("deliverables", {})
        elif code == FINDINGS:
            findings = cast(list[Json], (exported or {}).get("findings", []))
            result["deterministic"]["failed"] = len(findings)
            for f in findings:
                rule = str(f.get("rule"))
                result["deterministic"]["by_rule"][rule] = (
                    result["deterministic"]["by_rule"].get(rule, 0) + 1
                )
        else:
            result["error"] = f"export exit {code}: {stderr.strip()[-300:]}"
    _, status, _ = _call(opts, ["status", *p, "--json"], env)
    if status:
        result["cost_usd"] = float(cast(Json, status.get("cost", {})).get("spent_usd", 0.0))
        result["escalated"] = int(cast(Json, status.get("findings", {})).get("escalated", 0))
    result["vision"] = _vision(project)
    result["seconds"] = round(time.monotonic() - started, 1)
    return result


def plan_runs(opts: TierBOptions, briefs: list[Json], packs: list[str]) -> list[Planned]:
    n = opts.runs if opts.runs is not None else (2 if opts.mode == "release" else 1)
    out: list[Planned] = []
    for b in briefs:
        home = str(b["pack"])
        out += [Planned(b, home, i, False) for i in range(n)]
        if opts.mode == "release":
            other = next((p for p in packs if p != home), home)
            out.append(Planned(b, other, n, True))
    return out


def summarise(briefs: list[Json], runs: dict[str, list[Json]]) -> Json:
    rows: list[Json] = []
    categories: dict[str, dict[str, list[Json]]] = {
        "genre": {},
        "seconds": {},
        "pack": {},
        "aspect": {},
    }
    for b in briefs:
        mine = runs.get(str(b["id"]), [])
        passed = [
            r
            for r in mine
            if r["completed"] and r["manual_edits"] == 0 and r["deterministic"]["failed"] == 0
        ]
        criteria = sorted({c for r in mine for c in cast(Json, r["vision"])})
        rows.append(
            {
                "id": b["id"],
                "genre": b["genre"],
                "seconds": b["target_seconds"],
                "pack": b["pack"],
                "runs": mine,
                "deterministic_pass_rate": round(len(passed) / len(mine), 6) if mine else None,
                "vision": {
                    c: _stats([float(r["vision"][c]) for r in mine if c in r["vision"]])
                    for c in criteria
                },
                "cost_usd": _stats([float(r["cost_usd"]) for r in mine]),
                "seconds_wall": _stats([float(r.get("seconds", 0)) for r in mine]),
            }
        )
        for r in mine:
            aspects = {PROFILES[d] for d in cast(list[str], b["deliverables"])}
            keys = {
                "genre": [str(b["genre"])],
                "seconds": [str(b["target_seconds"])],
                "pack": [str(r["pack"])],
                "aspect": sorted(aspects),
            }
            for cat, values in keys.items():
                for v in values:
                    categories[cat].setdefault(v, []).append(r)
    by_category: Json = {}
    for cat, groups in categories.items():
        by_category[cat] = {}
        for value, rs in groups.items():
            ok = [
                r
                for r in rs
                if r["completed"] and r["manual_edits"] == 0 and r["deterministic"]["failed"] == 0
            ]
            criteria = sorted({c for r in rs for c in cast(Json, r["vision"])})
            by_category[cat][value] = {
                "runs": len(rs),
                "deterministic_pass_rate": round(len(ok) / len(rs), 6),
                "vision": {
                    c: _stats([float(r["vision"][c]) for r in rs if c in r["vision"]])["mean"]
                    for c in criteria
                },
            }
    return {"briefs": rows, "by_category": by_category}


def run_tier_b(opts: TierBOptions) -> int:
    """Run the briefs; write `tier-b.json`. Exit 0 on a clean (or nightly) run, 1 when release mode
    has a failing or skipped brief, 2 when every run failed on the provider (not evaluated)."""
    packs = pack_ids(opts.root)
    briefs = [b for b in load(opts.root) if not opts.briefs or b["id"] in opts.briefs]
    planned = plan_runs(opts, briefs, packs)
    spent = 0.0
    skipped: list[str] = []
    results: dict[str, list[Json]] = {}
    with tempfile.TemporaryDirectory(prefix="cw-tier-b-") as scratch:
        # Admit runs against the month cap before starting them: each may spend up to its cap.
        admitted: list[Planned] = []
        for plan in planned:
            if spent + opts.cap_usd > opts.month_cap_usd + 1e-9:
                skipped.append(f"{plan.brief['id']}#{plan.index}{'-swap' if plan.swap else ''}")
                continue
            spent += opts.cap_usd
            admitted.append(plan)
        with ThreadPoolExecutor(max_workers=max(1, opts.parallel)) as pool:
            futures = [
                (
                    plan,
                    pool.submit(
                        _run,
                        opts,
                        plan,
                        Path(scratch)
                        / f"{plan.brief['id']}-{plan.index}-{'swap' if plan.swap else 'home'}",
                    ),
                )
                for plan in admitted
            ]
            for plan, future in futures:
                results.setdefault(str(plan.brief["id"]), []).append(future.result())
    summary = summarise(briefs, results)
    all_runs = [r for rs in results.values() for r in rs]
    report: Json = {
        "mode": opts.mode,
        "briefs": summary["briefs"],
        "by_category": summary["by_category"],
        "skipped": skipped,
        "spent_usd": round(sum(float(r["cost_usd"]) for r in all_runs), 6),
    }
    opts.out.mkdir(parents=True, exist_ok=True)
    (opts.out / "tier-b.json").write_text(json.dumps(report, indent=2) + "\n")
    if all_runs and all(r.get("error") == "provider_error" for r in all_runs):
        print("cinewright-eval tier-b: every run failed on the provider: not evaluated")
        return 2
    if opts.mode == "nightly":
        return 0
    failing = [b["id"] for b in summary["briefs"] if b["deterministic_pass_rate"] != 1]
    for f in failing:
        print(f"cinewright-eval tier-b: {f} did not pass every run")
    for s in skipped:
        print(f"cinewright-eval tier-b: skipped {s} (month cap)")
    return 1 if failing or skipped else 0


def compare(report: Json, baseline: Json) -> list[str]:
    """Each category that regressed against the baseline: a lower deterministic pass rate, or a
    vision mean under its recorded threshold. One regressed category fails even when the average
    rises."""
    problems: list[str] = []
    for cat, groups in cast(Json, baseline.get("by_category", {})).items():
        for value, want in cast(Json, groups).items():
            got = cast(Json | None, report.get("by_category", {}).get(cat, {}).get(value))
            if got is None:
                problems.append(f"{cat}={value}: not run")
                continue
            if float(got["deterministic_pass_rate"]) < float(
                want.get("deterministic_pass_rate", 1.0)
            ):
                rate, need = got["deterministic_pass_rate"], want["deterministic_pass_rate"]
                problems.append(f"{cat}={value}: deterministic pass rate {rate} < {need}")
            for criterion, threshold in cast(Json, want.get("vision", {})).items():
                mean = cast(Json, got.get("vision", {})).get(criterion)
                if mean is None or float(mean) < float(threshold):
                    problems.append(f"{cat}={value}: vision {criterion} {mean} < {threshold}")
    return problems
