"""`cinewright-eval snapshot` (M8.2): freeze a tier B run that passed every check for tier A.

The project's files (``cinewright.json``, ``sequences/``, ``log/``) are copied to
``fixtures/benchmark/tier-a/<id>/project/`` and its referenced assets are listed by hash in
``assets.json`` for the maintainer to upload to the CAS remote (A.1). A run with an error finding
open or escalated without a waiver is refused: tier A grows only from good runs.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, cast

from cinewright_eval.cas_export import referenced_assets

TIER_A = Path("fixtures") / "benchmark" / "tier-a"


class SnapshotError(Exception):
    pass


def blocking_findings(project: Path) -> list[str]:
    """Error findings open or escalated without a user's waiver, from ``log/findings.jsonl``."""
    log = project / "log" / "findings.jsonl"
    if not log.is_file():
        return []
    docs: dict[str, dict[str, Any]] = {}
    last: dict[str, str] = {}
    waived: set[str] = set()
    for line in log.read_text().splitlines():
        if not line:
            continue
        e = cast(dict[str, Any], json.loads(line))
        fid = str(e["finding"])
        if e["kind"] == "raised":
            docs[fid] = cast(dict[str, Any], e.get("doc", {}))
            waived.discard(fid)
        if e["kind"] == "waived":
            waived.add(fid)
        last[fid] = str(e["kind"])
    return [
        f"{fid} {docs[fid].get('rule')} {docs[fid].get('entity')}"
        for fid, kind in last.items()
        if kind != "resolved"
        and fid in docs
        and docs[fid].get("severity") == "error"
        and (fid not in waived or str(docs[fid].get("rule", "")).startswith("clearance."))
    ]


def snapshot(project: Path, fixture_id: str, root: Path) -> Path:
    """Write the fixture and add it to the tier A index; returns its folder."""
    if not (project / "cinewright.json").is_file():
        raise SnapshotError(f"no project at {project}")
    blocking = blocking_findings(project)
    if blocking:
        raise SnapshotError("the run has open error findings: " + "; ".join(blocking))
    folder = root / TIER_A / fixture_id
    if folder.exists():
        raise SnapshotError(f"fixture {fixture_id} already exists")
    target = folder / "project"
    target.mkdir(parents=True)
    shutil.copy2(project / "cinewright.json", target / "cinewright.json")
    for sub in ("sequences", "log"):
        if (project / sub).is_dir():
            shutil.copytree(project / sub, target / sub)
    listed: list[dict[str, Any]] = [
        {"hash": str(a["hash"]), "bytes": a["bytes"], "role": a["role"]}
        for a in referenced_assets(project)
    ]
    assets = sorted(listed, key=lambda a: str(a["hash"]))
    (folder / "assets.json").write_text(json.dumps({"assets": assets}, indent=2) + "\n")
    index_path = root / TIER_A / "index.json"
    index: dict[str, Any] = (
        json.loads(index_path.read_text()) if index_path.is_file() else {"fixtures": []}
    )
    fixtures = cast(list[dict[str, Any]], index.setdefault("fixtures", []))
    fixtures.append({"id": fixture_id})
    index_path.write_text(json.dumps(index, indent=2) + "\n")
    return folder
