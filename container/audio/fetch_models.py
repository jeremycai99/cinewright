"""Download the audio image's models at build time and check every sha256 (M4.0a).

Usage: python fetch_models.py models.json /opt/models

Each model's files land in /opt/models/<dir>/<path>. A file whose sha256 differs from
models.json fails the build. Zip files marked `unzip` are extracted and removed. The
verified manifest, without URLs, is written to /opt/models/models.lock.json for
`audio-job versions`. Standard library only: it runs before the Python environment exists.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
import zipfile
from pathlib import Path


def fetch(url: str, dest: Path, sha256: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as response, dest.open("wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != sha256:
        dest.unlink()
        raise SystemExit(f"{url}: sha256 {digest.hexdigest()}, expected {sha256}")


def main(manifest: Path, root: Path) -> None:
    models = json.loads(manifest.read_text(encoding="utf-8"))["models"]
    for model in models:
        base = root / model["dir"]
        for entry in model["files"]:
            dest = base / entry["path"]
            fetch(entry["url"], dest, entry["sha256"])
            if model.get("unzip"):
                with zipfile.ZipFile(dest) as archive:
                    archive.extractall(base)
                dest.unlink()
            print(f"ok {model['name']}: {entry['path']}", flush=True)
        for entry in model["files"]:
            del entry["url"]
    lock = {"models": models}
    (root / "models.lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
