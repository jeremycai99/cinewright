"""The tier A report (`tier-a.json`) and its summary (`tier-a.md`, the job summary in CI)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

Json = dict[str, object]


def failures(report: Json) -> list[str]:
    """Every failure by name: errors, findings (rule · fixture · deliverable), hash mismatches."""
    out: list[str] = []
    for f in cast(list[Json], report["fixtures"]):
        fid = f["id"]
        if f.get("error"):
            out.append(f"{fid}: {f['error']}")
        for finding in cast(list[Json], f.get("findings", [])):
            out.append(
                f"{finding['rule']} · {fid} · {finding.get('deliverable')}: "
                f"{finding.get('entity')}: {finding.get('message', '')}"
            )
        for d in cast(list[Json], f.get("deliverables", [])):
            if not d.get("match"):
                out.append(f"hashes · {fid} · {d['id']}: differ from expected")
    return out


def summary(report: Json) -> str:
    title = f"# Tier A ({report['runner_class']})"
    if report.get("suite"):
        title += f": {report['suite']}"
    lines = [title, ""]
    failed = failures(report)
    lines += ["## Failures", ""]
    lines += [f"- {f}" for f in failed] if failed else ["None."]
    lines += [
        "",
        "## Fixtures",
        "",
        "| Fixture | Deliverable | Hashes | Errors | Steps hit/miss |",
        "| --- | --- | --- | --- | --- |",
    ]
    for f in cast(list[Json], report["fixtures"]):
        steps = cast(Json, f.get("steps", {}))
        for d in cast(list[Json], f.get("deliverables", [])) or [{"id": "—", "match": False}]:
            errors = sum(
                1
                for x in cast(list[Json], f.get("findings", []))
                if x.get("deliverable") == d["id"]
            )
            lines.append(
                f"| {f['id']} | {d['id']} | {'match' if d.get('match') else 'DIFFER'} | {errors} "
                f"| {steps.get('hit', 0)}/{steps.get('miss', 0)} |"
            )
    lines += [
        "",
        "## Checks",
        "",
        "| Rule | Run | Failed | Pass rate |",
        "| --- | --- | --- | --- |",
    ]
    totals: dict[str, list[int]] = {}
    for f in cast(list[Json], report["fixtures"]):
        for rule, c in cast(dict[str, Json], f.get("checks", {})).items():
            t = totals.setdefault(rule, [0, 0])
            t[0] += cast(int, c["run"])
            t[1] += cast(int, c["failed"])
    for rule, (run, fail) in sorted(totals.items()):
        rate = f"{round(100 * (run - fail) / run)}%" if run else "—"
        lines.append(f"| {rule} | {run} | {fail} | {rate} |")
    return "\n".join(lines) + "\n"


def write_reports(report: Json, out: Path) -> bool:
    """Write both files; True when nothing failed."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "tier-a.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (out / "tier-a.md").write_text(summary(report))
    return not failures(report)
