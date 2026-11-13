"""Render-image pins: build args for the image and a check that the image matches them."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from cinewright_tools.container import inputs_hash

PINS_FILE = "container/pins.json"
RUNNER_MANIFEST = "container/render-runner/package.json"
DOCKERFILE = "container/Dockerfile"

# Report key (from `render-job --versions`) -> Debian package in pins.json "apt".
APT_REPORT_KEYS = {
    "ffmpeg": "ffmpeg",
    "libx264": "libx264-164",
    "python": "python3.13",
    "fonts-noto-core": "fonts-noto-core",
}
# Dockerfile build arg -> Debian package in pins.json "apt".
APT_BUILD_ARGS = {
    "FFMPEG_VERSION": "ffmpeg",
    "LIBX264_VERSION": "libx264-164",
    "PYTHON_VERSION": "python3.13",
    "FONTS_NOTO_CORE_VERSION": "fonts-noto-core",
}


@dataclass(frozen=True)
class Pin:
    value: str
    source: str  # file the expected value came from


def expected_pins(repo_root: Path) -> dict[str, Pin]:
    """What the image must report, with the tracked file each value comes from."""
    pins = _read_json(repo_root / PINS_FILE)
    apt = cast(dict[str, str], pins["apt"])
    deps = cast(dict[str, str], _read_json(repo_root / RUNNER_MANIFEST)["dependencies"])
    expected = {
        "node": Pin(
            (repo_root / ".node-version").read_text(encoding="utf-8").strip(), ".node-version"
        ),
        "hyperframes": Pin(deps["hyperframes"], RUNNER_MANIFEST),
        "gsap": Pin(deps["gsap"], RUNNER_MANIFEST),
        "chrome_headless_shell": Pin(str(pins["chrome_headless_shell"]), PINS_FILE),
    }
    for key, package in APT_REPORT_KEYS.items():
        expected[key] = Pin(apt[package], PINS_FILE)
    return expected


def compare_pins(expected: Mapping[str, Pin], reported: Mapping[str, str]) -> list[str]:
    """One line per pin the image does not match, sorted by key."""
    problems: list[str] = []
    for key in sorted(expected):
        pin = expected[key]
        got = reported.get(key)
        if got != pin.value:
            shown = "nothing" if got is None else got
            problems.append(
                f"{key}: expected {pin.value} (from {pin.source}), image reports {shown}"
            )
    return problems


def docker_build_args(repo_root: Path) -> list[str]:
    """``--build-arg`` pairs for container/Dockerfile, read from the tracked pin files."""
    pins = _read_json(repo_root / PINS_FILE)
    apt = cast(dict[str, str], pins["apt"])
    manager = str(_read_json(repo_root / "package.json")["packageManager"])
    values = {
        "BASE_IMAGE": str(pins["base_image"]),
        "DEBIAN_SNAPSHOT": str(pins["debian_snapshot"]),
        **{arg: apt[package] for arg, package in APT_BUILD_ARGS.items()},
        "CHROME_HEADLESS_SHELL": str(pins["chrome_headless_shell"]),
        "PNPM_VERSION": manager.removeprefix("pnpm@").split("+")[0],
        "INPUTS_HASH": inputs_hash(repo_root),
    }
    args: list[str] = []
    for name, value in values.items():
        args += ["--build-arg", f"{name}={value}"]
    return args


def platform(repo_root: Path) -> str:
    return str(_read_json(repo_root / PINS_FILE)["platform"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-pins",
        description="Run the render image offline and compare its versions to the pins.",
    )
    parser.add_argument("--image", required=True)
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    docker = shutil.which("docker")
    if docker is None:
        print("Docker is not available", file=sys.stderr)
        return 2
    command = [docker, "run", "--rm", "--network", "none", "--platform", platform(args.repo)]
    command += [args.image, "--versions"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"render-job --versions failed (exit {result.returncode}):", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        return 2
    reported = cast(dict[str, str], json.loads(result.stdout))
    expected = expected_pins(args.repo)
    problems = compare_pins(expected, reported)
    for problem in problems:
        print(problem)
    if not problems:
        print(f"ok: {len(expected)} pins match ({', '.join(sorted(expected))})")
    return 1 if problems else 0


def build_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-build-image",
        description="Build the render image with docker buildx, every version from the pin files.",
    )
    parser.add_argument("--tag", required=True)
    parser.add_argument("--push", action="store_true", help="push instead of loading locally")
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    docker = shutil.which("docker")
    if docker is None:
        print("Docker is not available", file=sys.stderr)
        return 2
    repo: Path = args.repo
    command = [docker, "buildx", "build", "--platform", platform(repo)]
    command += ["--file", str(repo / DOCKERFILE), "--tag", args.tag]
    command += docker_build_args(repo)
    command += ["--push" if args.push else "--load", str(repo)]
    return subprocess.run(command, check=False).returncode


def _read_json(path: Path) -> dict[str, object]:
    return cast(dict[str, object], json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    sys.exit(main())
