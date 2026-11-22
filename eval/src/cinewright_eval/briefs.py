"""Benchmark briefs (M8.2): validate them and their coverage, and make a project for one.

Coverage follows decision 11's reduced v0.1 scope: at least 4 briefs; 2 explainers and 2 ads;
each length (15, 30, 60 s) at least once; both aspect ratios across the set; at least 1 brief asking
for both; 2 briefs on each pack. A brief's text is neutral: no pack id, token name, hex colour or
font name (AGENTS.md §2.3).
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, cast

TIER_B = Path("fixtures") / "benchmark" / "tier-b"
GENRES = ("explainer", "ad")
LENGTHS = (15, 30, 60)
PROFILES = {"landscape_web": "landscape", "vertical_social": "portrait"}
REQUIRED = ("id", "genre", "target_seconds", "deliverables", "pack", "brief", "narrator", "author")
TOKEN = re.compile(
    r"\b(palette|type|motion|layout|density|contrast|sound|camera|transition)\.[a-z_]+\b"
)
HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
FONTS = ("Helvetica", "Arial", "Inter", "Roboto", "Futura", "Garamond", "Georgia", "Montserrat")


def pack_ids(root: Path) -> list[str]:
    """The packs in the repository (`packs/<id>/pack.json`)."""
    return sorted(p.parent.name for p in (root / "packs").glob("*/pack.json"))


def load(root: Path) -> list[dict[str, Any]]:
    """The briefs in `index.json` order."""
    index = json.loads((root / TIER_B / "index.json").read_text())
    out: list[dict[str, Any]] = []
    for entry in cast(list[dict[str, Any]], index["briefs"]):
        path = root / TIER_B / str(entry["id"]) / "brief.json"
        out.append(cast(dict[str, Any], json.loads(path.read_text())))
    return out


def brief_errors(brief: dict[str, Any], packs: list[str]) -> list[str]:
    """What is wrong with one brief: missing fields, bad values, and taste in its text."""
    name = str(brief.get("id", "?"))
    errors = [f"{name}: missing {k}" for k in REQUIRED if k not in brief]
    if brief.get("genre") not in GENRES:
        errors.append(f"{name}: genre must be one of {', '.join(GENRES)}")
    if brief.get("target_seconds") not in LENGTHS:
        errors.append(f"{name}: target_seconds must be one of {LENGTHS}")
    for d in cast(list[str], brief.get("deliverables", [])):
        if d not in PROFILES:
            errors.append(f"{name}: unknown deliverable profile {d}")
    if brief.get("pack") not in packs:
        errors.append(f"{name}: pack {brief.get('pack')} is not installed")
    text = str(brief.get("brief", ""))
    for pack in packs:
        if re.search(rf"\b{re.escape(pack)}\b", text, re.IGNORECASE):
            errors.append(f"{name}: the brief names pack {pack}")
    for m in TOKEN.finditer(text):
        errors.append(f"{name}: the brief names token {m.group(0)}")
    for m in HEX.finditer(text):
        errors.append(f"{name}: the brief names colour {m.group(0)}")
    for font in FONTS:
        if re.search(rf"\b{font}\b", text):
            errors.append(f"{name}: the brief names font {font}")
    return errors


def coverage_gaps(briefs: list[dict[str, Any]], packs: list[str]) -> list[str]:
    """The coverage rules a set of briefs misses, each named."""
    gaps: list[str] = []
    if len(briefs) < 4:
        gaps.append(f"coverage: {len(briefs)} briefs; at least 4 are needed")
    for genre in GENRES:
        if sum(b.get("genre") == genre for b in briefs) < 2:
            gaps.append(f"coverage: fewer than 2 {genre} briefs")
    for length in LENGTHS:
        if not any(b.get("target_seconds") == length for b in briefs):
            gaps.append(f"coverage: no {length} s brief")
    aspects = {PROFILES.get(d) for b in briefs for d in cast(list[str], b.get("deliverables", []))}
    for aspect in ("landscape", "portrait"):
        if aspect not in aspects:
            gaps.append(f"coverage: no {aspect} deliverable")
    if not any(len(cast(list[str], b.get("deliverables", []))) > 1 for b in briefs):
        gaps.append("coverage: no brief asks for both aspect ratios")
    used = [p for p in packs if any(b.get("pack") == p for b in briefs)]
    counts = {p: sum(b.get("pack") == p for b in briefs) for p in used}
    if len(used) < 2 or len(set(counts.values())) > 1:
        gaps.append(f"coverage: briefs must split evenly across the packs ({counts})")
    return gaps


def matrix(briefs: list[dict[str, Any]]) -> str:
    rows = ["id | genre | length | deliverables | pack"]
    for b in briefs:
        rows.append(
            f"{b['id']} | {b['genre']} | {b['target_seconds']} s | "
            f"{', '.join(cast(list[str], b['deliverables']))} | {b['pack']}"
        )
    return "\n".join(rows)


def check(root: Path) -> tuple[list[str], str]:
    """Every brief's errors and the coverage gaps, then the coverage matrix."""
    packs = pack_ids(root)
    briefs = load(root)
    errors = [e for b in briefs for e in brief_errors(b, packs)] + coverage_gaps(briefs, packs)
    return errors, matrix(briefs)


def init_project(root: Path, brief_id: str, to: Path, cli: list[str], pack: str | None) -> int:
    """`cinewright init` with the brief's deliverables and pack, then one user patch setting the
    brief, the narrator and the Auto preset. Returns the CLI's exit code."""
    brief = json.loads((root / TIER_B / brief_id / "brief.json").read_text())
    profiles = cast(list[str], brief["deliverables"])
    args = [*cli, "init", str(to), "--id", brief_id, "--pack", pack or str(brief["pack"])]
    for profile in profiles:
        args += ["--deliverable", f"{PROFILES[profile]}={profile}"]
    done = subprocess.run(args, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        print(done.stderr, end="")
        return done.returncode
    narrator = cast(dict[str, str], brief["narrator"])
    patch = {
        "base_revision": 0,
        "author": {"kind": "user"},
        "mode": "apply",
        "reason": f"the brief {brief_id}",
        "ops": [
            {"op": "set", "entity": brief_id, "path": "/brief", "value": brief["brief"]},
            {"op": "set", "entity": brief_id, "path": "/autonomy", "value": "auto"},
            {
                "op": "insert",
                "entity": brief_id,
                "path": "/cast",
                "value": {
                    "id": "narrator",
                    "role": "narrator",
                    "display_name": "Narrator",
                    "voice": {"description": {"language": narrator["language"]}},
                    "performance": {"baseline": narrator["description"]},
                    "on_screen": False,
                },
            },
        ],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(patch, f)
        patch_file = f.name
    done = subprocess.run(
        [*cli, "patch", "apply", "--file", patch_file, "--project", str(to)],
        capture_output=True,
        text=True,
        check=False,
    )
    Path(patch_file).unlink(missing_ok=True)
    if done.returncode != 0:
        print(done.stderr, end="")
    return done.returncode
