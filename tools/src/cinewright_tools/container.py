"""Host side of the render container: the inputs hash and the render runner.

The engine and CLI never render on the host. They start the pinned image, whose only
process is ``render-job``, with the network disabled.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

IMAGE_PLATFORM = "linux/amd64"
BASELINE_MACHINES = frozenset({"x86_64", "amd64", "AMD64"})

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


@dataclass(frozen=True)
class RenderResult:
    exit_code: int
    out_dir: Path
    framemd5: str | None
    sha256: str | None
    stderr: str


class DockerUnavailableError(RuntimeError):
    pass


def run_render(image: str, composition: Path, out_dir: Path, fmt: str = "mp4") -> RenderResult:
    """Render ``composition`` in ``image`` with the network off; outputs land in ``out_dir``."""
    docker = shutil.which("docker")
    if docker is None:
        raise DockerUnavailableError("Docker is not available")
    out_dir.mkdir(parents=True, exist_ok=True)
    command = [docker, "run", "--rm", "--network", "none", "--platform", IMAGE_PLATFORM]
    if hasattr(os, "getuid"):
        # Outputs belong to the host user; HOME must be writable for Chrome.
        command += ["--user", f"{os.getuid()}:{os.getgid()}", "--env", "HOME=/tmp"]
    command += ["--mount", _bind(composition, "/job/in", readonly=True)]
    command += ["--mount", _bind(out_dir, "/job/out", readonly=False)]
    command += [image, "--in", "/job/in", "--out", "/job/out", "--format", fmt]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    return RenderResult(
        exit_code=result.returncode,
        out_dir=out_dir,
        framemd5=_read(out_dir / "framemd5.txt"),
        sha256=_read(out_dir / "sha256.txt"),
        stderr=result.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-render-in-container",
        description="Render a composition in the pinned render image with the network off.",
    )
    parser.add_argument("--image", required=True)
    parser.add_argument("--in", dest="composition", required=True, type=Path)
    parser.add_argument("--out", dest="out_dir", required=True, type=Path)
    parser.add_argument("--format", default="mp4", choices=["mp4", "png-sequence"])
    args = parser.parse_args(argv)
    if shutil.which("docker") is None:
        print("Docker is not available: install a Docker runtime and start it", file=sys.stderr)
        return 2
    machine = platform.machine()
    if machine not in BASELINE_MACHINES:
        print(
            f"warning: this host is {machine}, so the {IMAGE_PLATFORM} image runs under "
            "emulation; its hashes are a different runner class and not a baseline",
            file=sys.stderr,
        )
    result = run_render(args.image, args.composition, args.out_dir, args.format)
    sys.stderr.write(result.stderr)
    if result.exit_code == 0 and result.sha256 is not None:
        print(result.sha256, end="")
    return result.exit_code


def _bind(source: Path, target: str, *, readonly: bool) -> str:
    """A ``--mount`` value. CSV quoting keeps commas, spaces and quotes in paths intact."""
    fields = ["type=bind", _csv_quote(f"source={source.resolve()}"), f"target={target}"]
    if readonly:
        fields.append("readonly")
    return ",".join(fields)


def _csv_quote(field: str) -> str:
    return '"' + field.replace('"', '""') + '"'


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.is_file() else None


if __name__ == "__main__":
    sys.exit(main())
