import hashlib
import json
from pathlib import Path

import pytest

from cinewright_eval.cas_export import ExportError, cas_path, export
from cinewright_eval.cli import main


def project(tmp_path: Path, blobs: dict[str, bytes], extra_in_cas: bytes | None = None) -> Path:
    root = tmp_path / "p"
    assets = []
    for asset_id, data in blobs.items():
        hash_ = "sha256:" + hashlib.sha256(data).hexdigest()
        path = cas_path(root, hash_)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        assets.append({"id": asset_id, "hash": hash_, "bytes": len(data), "role": "take"})
    if extra_in_cas is not None:
        stray = cas_path(root, "sha256:" + hashlib.sha256(extra_in_cas).hexdigest())
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_bytes(extra_in_cas)
    (root / "cinewright.json").write_text(
        json.dumps({"assets": {"state": "agent", "value": assets}})
    )
    return root


def test_exports_exactly_the_referenced_assets(tmp_path: Path) -> None:
    root = project(tmp_path, {"take_a": b"a", "take_b": b"bb"}, extra_in_cas=b"unreferenced")
    out = tmp_path / "out"
    exported = export(root, out)
    assert sorted(p.name for p in out.iterdir()) == sorted(
        e.hash.removeprefix("sha256:") for e in exported
    )
    assert len(exported) == 2 and all(e.written for e in exported)
    assert all(not e.written for e in export(root, out))


def test_a_missing_object_is_named(tmp_path: Path) -> None:
    root = project(tmp_path, {"take_a": b"a"})
    for f in (root / ".cinewright").rglob("*"):
        if f.is_file():
            f.unlink()
    with pytest.raises(ExportError, match="take_a"):
        export(root, tmp_path / "out")


def test_cli_prints_a_manifest(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = project(tmp_path, {"take_a": b"a"})
    assert main(["cas-export", str(root), "--to", str(tmp_path / "out")]) == 0
    line = json.loads(capsys.readouterr().out.strip())
    assert line == {
        "hash": "sha256:" + hashlib.sha256(b"a").hexdigest(),
        "bytes": 1,
        "role": "take",
    }
