"""Host side of the render container: the inputs hash and the render runner.

The engine and CLI never render on the host. They start the pinned image, whose only
process is ``render-job``, with the network disabled.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ImageKind = Literal["render", "audio"]

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


# The audio image's build context is its own folder (container/audio), minus what its
# .dockerignore excludes. Keep the two in step.
AUDIO_DIR = "container/audio"
AUDIO_EXCLUDED = frozenset({"README.md", "image.lock.json", "spike", "__pycache__", ".venv"})


def inputs_hash(repo_root: Path, image: ImageKind = "render") -> str:
    """SHA-256 over sorted (relative path, sha256 of bytes) pairs of the image's inputs."""
    files = _audio_inputs(repo_root) if image == "audio" else _render_inputs(repo_root)
    return files_digest(
        (path.relative_to(repo_root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest())
        for path in files
    )


def files_digest(pairs: Iterable[tuple[str, str]]) -> str:
    """SHA-256 over sorted ``path\0sha256\n`` lines: one digest for a set of files."""
    digest = hashlib.sha256()
    for rel, file_digest in sorted(pairs):
        digest.update(f"{rel}\0{file_digest}\n".encode())
    return digest.hexdigest()


def _render_inputs(repo_root: Path) -> list[Path]:
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
    return files


def _audio_inputs(repo_root: Path) -> list[Path]:
    audio = repo_root / AUDIO_DIR
    return [
        path
        for path in audio.rglob("*")
        if path.is_file() and not AUDIO_EXCLUDED.intersection(path.relative_to(audio).parts)
    ]


@dataclass(frozen=True)
class RenderResult:
    exit_code: int
    out_dir: Path
    framemd5: str | None
    sha256: str | None
    stderr: str


class DockerUnavailableError(RuntimeError):
    pass


# A run that outlives its timeout is stopped by container name (audit G7); killing the
# docker CLI process alone would leave the container running.
DEFAULT_TIMEOUT_S = 1800
TIMEOUT_EXIT = 124


@dataclass(frozen=True)
class _Run:
    returncode: int
    stderr: str


def _run_named(docker: str, command: list[str], timeout: float) -> _Run:
    """Run ``command`` (a ``docker run``) under a unique name, killing it at ``timeout``."""
    name = f"cinewright-render-{uuid.uuid4().hex[:12]}"
    command = [*command[:2], "--name", name, *command[2:]]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, check=False, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        subprocess.run([docker, "kill", name], capture_output=True, text=True, check=False)
        return _Run(
            TIMEOUT_EXIT, f"container {name} timed out after {timeout:g} s and was killed\n"
        )
    return _Run(result.returncode, result.stderr)


def run_render(
    image: str,
    composition: Path,
    out_dir: Path,
    fmt: str = "mp4",
    timeout: float = DEFAULT_TIMEOUT_S,
) -> RenderResult:
    """Render ``composition`` in ``image`` with the network off; outputs land in ``out_dir``."""
    docker = shutil.which("docker")
    if docker is None:
        raise DockerUnavailableError("Docker is not available")
    out_dir.mkdir(parents=True, exist_ok=True)
    command = docker_run_base(docker)
    command += ["--mount", bind_mount(composition, "/job/in", readonly=True)]
    command += ["--mount", bind_mount(out_dir, "/job/out", readonly=False)]
    command += [image, "--in", "/job/in", "--out", "/job/out", "--format", fmt]
    result = _run_named(docker, command, timeout)
    return RenderResult(
        exit_code=result.returncode,
        out_dir=out_dir,
        framemd5=_read(out_dir / "framemd5.txt"),
        sha256=_read(out_dir / "sha256.txt"),
        stderr=result.stderr,
    )


@dataclass(frozen=True)
class CheckResult:
    exit_code: int
    out_dir: Path
    failures: list[dict[str, object]]
    stderr: str


# Limits on every container run (audit F17), the same as plugins/backend-hyperframes/src/limits.ts.
RUN_LIMITS = [
    "--memory",
    "4096m",
    "--memory-swap",
    "4096m",
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=2048m",
]


def docker_run_base(docker: str) -> list[str]:
    command = [docker, "run", "--rm", "--network", "none", "--platform", IMAGE_PLATFORM]
    command += RUN_LIMITS
    if hasattr(os, "getuid"):
        # Outputs belong to the host user; HOME must be writable for Chrome.
        command += ["--user", f"{os.getuid()}:{os.getgid()}", "--env", "HOME=/tmp"]
    return command


def run_check(
    image: str,
    composition: Path,
    out_dir: Path,
    at: list[float],
    timeout: float = DEFAULT_TIMEOUT_S,
) -> CheckResult:
    """Run ``render-job check`` (HyperFrames check, M2.4b) on ``composition`` at ``at`` seconds.

    Outputs land in ``out_dir``: ``check.json``, ``failures.json``, ``check-log.txt``.
    """
    docker = shutil.which("docker")
    if docker is None:
        raise DockerUnavailableError("Docker is not available")
    out_dir.mkdir(parents=True, exist_ok=True)
    command = docker_run_base(docker)
    command += ["--mount", bind_mount(composition, "/job/in", readonly=True)]
    command += ["--mount", bind_mount(out_dir, "/job/out", readonly=False)]
    times = ",".join(f"{t:g}" for t in at)
    command += [image, "check", "--in", "/job/in", "--out", "/job/out", "--at", times]
    result = _run_named(docker, command, timeout)
    raw = _read(out_dir / "failures.json")
    failures: list[dict[str, object]] = json.loads(raw) if raw else []
    return CheckResult(
        exit_code=result.returncode, out_dir=out_dir, failures=failures, stderr=result.stderr
    )


def check_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-in-container",
        description="Check a composition (layout, contrast, runtime) in the pinned render image.",
    )
    parser.add_argument("--image", required=True)
    parser.add_argument("--in", dest="composition", required=True, type=Path)
    parser.add_argument("--out", dest="out_dir", required=True, type=Path)
    parser.add_argument("--at", required=True, help="seconds to audit, comma-separated")
    args = parser.parse_args(argv)
    if shutil.which("docker") is None:
        print("Docker is not available: install a Docker runtime and start it", file=sys.stderr)
        return 2
    at = [float(t) for t in args.at.split(",")]
    result = run_check(args.image, args.composition, args.out_dir, at)
    sys.stderr.write(result.stderr)
    return result.exit_code


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


def bind_mount(source: Path, target: str, *, readonly: bool) -> str:
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
