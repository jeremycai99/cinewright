import os
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from cinewright_tools.container import INPUT_FILES, RUNNER_DIR

REPO = Path(__file__).resolve().parents[2]

# Files the render image is built from (see cinewright_tools.container.inputs_hash).
CONTAINER_INPUTS = [*INPUT_FILES, RUNNER_DIR]


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("CINEWRIGHT_CONTAINER_TESTS") == "1":
        return
    skip = pytest.mark.skip(
        reason="needs Docker and the render image; set CINEWRIGHT_CONTAINER_TESTS=1"
    )
    for item in items:
        if "container" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def image() -> str:
    return os.environ.get("CINEWRIGHT_IMAGE", "cinewright-render:dev")


@pytest.fixture
def tmp_repo(tmp_path: Path) -> Path:
    """A temporary copy of the render image's inputs."""
    root = tmp_path / "repo"
    ignore = shutil.ignore_patterns("node_modules", "dist", "*.tsbuildinfo")
    for rel in CONTAINER_INPUTS:
        src, dst = REPO / rel, root / rel
        if src.is_dir():
            shutil.copytree(src, dst, ignore=ignore)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return root


@pytest.fixture
def fake_docker(monkeypatch: pytest.MonkeyPatch) -> list[Sequence[str]]:
    """Pretend Docker exists; record each command instead of running it."""
    calls: list[Sequence[str]] = []

    def fake_run(command: Sequence[str], **_: Any) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(shutil, "which", lambda _: "/usr/bin/docker")
    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls
