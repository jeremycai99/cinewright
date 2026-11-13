import shutil
from pathlib import Path

import pytest

from cinewright_tools.container import INPUT_FILES, RUNNER_DIR

REPO = Path(__file__).resolve().parents[2]

# Files the render image is built from (see cinewright_tools.container.inputs_hash).
CONTAINER_INPUTS = [*INPUT_FILES, RUNNER_DIR]


@pytest.fixture
def tmp_repo(tmp_path: Path) -> Path:
    """A temporary copy of the render image's inputs."""
    root = tmp_path / "repo"
    for rel in CONTAINER_INPUTS:
        src, dst = REPO / rel, root / rel
        if src.is_dir():
            shutil.copytree(
                src, dst, ignore=shutil.ignore_patterns("node_modules", "dist", "*.tsbuildinfo")
            )
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return root
