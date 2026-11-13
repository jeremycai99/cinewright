"""Host side of the render container: the inputs hash and (Task 7) the render runner."""

from __future__ import annotations

import hashlib
from pathlib import Path

# Every file in the image's build context (see .dockerignore) plus the Dockerfile.
INPUT_FILES = (
    ".dockerignore",
    ".node-version",
    "container/Dockerfile",
    "container/pins.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
)
RUNNER_DIR = "container/render-runner"
RUNNER_EXCLUDED_DIRS = frozenset({"node_modules", "dist", "test"})
RUNNER_EXCLUDED_SUFFIXES = (".tsbuildinfo",)  # local build artifacts, ignored by git


def inputs_hash(repo_root: Path) -> str:
    """SHA-256 over sorted (relative path, sha256 of bytes) pairs of the image inputs."""
    files = [repo_root / rel for rel in INPUT_FILES]
    runner = repo_root / RUNNER_DIR
    for path in runner.rglob("*"):
        rel_parts = path.relative_to(runner).parts
        if (
            path.is_file()
            and rel_parts[0] not in RUNNER_EXCLUDED_DIRS
            and not path.name.endswith(RUNNER_EXCLUDED_SUFFIXES)
        ):
            files.append(path)
    pairs = sorted(
        (path.relative_to(repo_root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest())
        for path in files
    )
    digest = hashlib.sha256()
    for rel, file_digest in pairs:
        digest.update(f"{rel}\0{file_digest}\n".encode())
    return digest.hexdigest()
