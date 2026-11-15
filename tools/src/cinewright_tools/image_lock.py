"""The render image's digest lock (container/image.lock.json).

CI publishes the image on main; a follow-up PR records its digest and inputs hash here.
The check ties the three together: the locked digest, the inputs-hash label baked into that
image, and the inputs hash of the tree being tested.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from cinewright_tools.container import inputs_hash

LOCK_FILE = "container/image.lock.json"
LABEL = "org.cinewright.inputs-hash"


def check_image_lock(
    lock: Mapping[str, str | None], label_inputs_hash: str | None, tree_inputs_hash: str
) -> list[str]:
    """Problems with the lock, or an empty list. An unpublished lock (both null) passes.

    A tree whose inputs moved on since the locked image is not a problem here; see
    ``stale_lock_notice``.
    """
    digest = lock.get("digest")
    locked = lock.get("inputs_hash")
    if digest is None and locked is None:
        return []
    if digest is None or locked is None:
        return [f"{LOCK_FILE} must set both digest and inputs_hash, or neither"]
    problems: list[str] = []
    if label_inputs_hash != locked:
        built_from = label_inputs_hash or "unknown inputs (no label)"
        problems.append(f"image {digest} was built from inputs {built_from}, lock says {locked}")
    return problems


def stale_lock_notice(lock: Mapping[str, str | None], tree_inputs_hash: str) -> str | None:
    """A notice when the tree's container inputs differ from the locked image's, else None.

    Not a failure: a PR that changes a container input (a lockfile, for example) cannot
    publish. ``render-image`` publishes after merge, and a follow-up PR updates the lock.
    Until then the smoke jobs build the image from the tree.
    """
    locked = lock.get("inputs_hash")
    if locked is None or tree_inputs_hash == locked:
        return None
    return (
        f"container inputs changed ({tree_inputs_hash}) since the locked image ({locked}): "
        f"publish and update {LOCK_FILE}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-image-lock",
        description="Pull the locked render image and check its inputs-hash label and the tree.",
    )
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    lock = cast(
        dict[str, str | None], json.loads((args.repo / LOCK_FILE).read_text(encoding="utf-8"))
    )
    tree = inputs_hash(args.repo)
    label: str | None = None
    if lock.get("digest") is not None:
        docker = shutil.which("docker")
        if docker is None:
            print("Docker is not available", file=sys.stderr)
            return 2
        ref = f"{lock['image']}@{lock['digest']}"
        pulled = subprocess.run([docker, "pull", "--platform", "linux/amd64", ref], check=False)
        if pulled.returncode != 0:
            print(f"cannot pull {ref}", file=sys.stderr)
            return 2
        inspect = [
            docker,
            "image",
            "inspect",
            ref,
            "--format",
            f'{{{{index .Config.Labels "{LABEL}"}}}}',
        ]
        out = subprocess.run(inspect, capture_output=True, text=True, check=False).stdout.strip()
        label = out or None
    problems = check_image_lock(lock, label, tree)
    for problem in problems:
        print(problem)
    notice = stale_lock_notice(lock, tree)
    if notice:
        # GitHub Actions shows ::warning:: lines as annotations; elsewhere they read as text.
        print(f"::warning::{notice}")
    if not problems:
        if lock.get("digest") is None:
            print("image lock: unpublished")
        else:
            print(f"image lock ok: {lock['inputs_hash']}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
