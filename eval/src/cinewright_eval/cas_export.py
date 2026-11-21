"""Export the CAS objects a project references, as flat files named by hex (alpha gate A.1).

The maintainer uploads the folder to the read-only remote (`CINEWRIGHT_CAS_REMOTE`); no tool
writes the remote itself, so none needs a credential.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import cast


@dataclass(frozen=True)
class Exported:
    hash: str
    bytes: int
    role: str
    written: bool


class ExportError(Exception):
    pass


def referenced_assets(project: Path) -> list[dict[str, object]]:
    """The project's asset registry: every asset the IR references (AGENTS.md §6)."""
    doc = cast(
        dict[str, object], json.loads((project / "cinewright.json").read_text(encoding="utf-8"))
    )
    assets = cast(dict[str, object], doc.get("assets") or {})
    return cast(list[dict[str, object]], assets.get("value") or [])


def cas_path(project: Path, hash_: str) -> Path:
    hex_ = hash_.removeprefix("sha256:")
    return project / ".cinewright" / "cas" / "sha256" / hex_[:2] / hex_[2:]


def export(project: Path, to: Path) -> list[Exported]:
    """Copy each referenced object to `to/<hex>`, verified; an existing correct file is kept."""
    to.mkdir(parents=True, exist_ok=True)
    out: list[Exported] = []
    for asset in sorted(referenced_assets(project), key=lambda a: str(a["hash"])):
        hash_ = str(asset["hash"])
        source = cas_path(project, hash_)
        if not source.is_file():
            raise ExportError(f"asset {asset['id']} ({hash_}) is not in the project's CAS")
        data = source.read_bytes()
        if "sha256:" + hashlib.sha256(data).hexdigest() != hash_:
            raise ExportError(f"asset {asset['id']}: the CAS object does not hash to {hash_}")
        target = to / hash_.removeprefix("sha256:")
        written = not (target.is_file() and target.read_bytes() == data)
        if written:
            shutil.copyfile(source, target)
        out.append(Exported(hash_, len(data), str(asset.get("role", "")), written))
    return out
