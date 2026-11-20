"""Image pins: build args for the render and audio images, and a check that an image matches."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from cinewright_tools.container import AUDIO_DIR, ImageKind, files_digest, inputs_hash

PINS_FILE = "container/pins.json"
RUNNER_MANIFEST = "container/render-runner/package.json"
DOCKERFILE = "container/Dockerfile"

AUDIO_PINS = f"{AUDIO_DIR}/pins.json"
AUDIO_LOCK = f"{AUDIO_DIR}/uv.lock"
AUDIO_MODELS = f"{AUDIO_DIR}/models.json"
AUDIO_DOCKERFILE = f"{AUDIO_DIR}/Dockerfile"
# Python packages `audio-job versions` reports, checked against the audio image's uv.lock.
AUDIO_PACKAGES = (
    "torch",
    "torchaudio",
    "kokoro",
    "misaki",
    "phonemizer-fork",
    "espeakng-loader",
    "whisperx",
    "ctranslate2",
    "spacy",
    "en-core-web-sm",
)
KINDS: tuple[ImageKind, ...] = ("render", "audio")

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


def expected_pins(repo_root: Path, image: ImageKind = "render") -> dict[str, Pin]:
    """What the image must report, with the tracked file each value comes from."""
    if image == "audio":
        return _expected_audio_pins(repo_root)
    pins = _read_json(repo_root / PINS_FILE)
    apt = cast(dict[str, str], pins["apt"])
    deps = cast(dict[str, str], _read_json(repo_root / RUNNER_MANIFEST)["dependencies"])
    expected = {
        "node": Pin(
            (repo_root / ".node-version").read_text(encoding="utf-8").strip(), ".node-version"
        ),
        "hyperframes": Pin(deps["hyperframes"], RUNNER_MANIFEST),
        "chrome_headless_shell": Pin(str(pins["chrome_headless_shell"]), PINS_FILE),
    }
    for key, package in APT_REPORT_KEYS.items():
        expected[key] = Pin(apt[package], PINS_FILE)
    return expected


def _expected_audio_pins(repo_root: Path) -> dict[str, Pin]:
    pins = _read_json(repo_root / AUDIO_PINS)
    apt = cast(dict[str, str], pins["apt"])
    lock = tomllib.loads((repo_root / AUDIO_LOCK).read_text(encoding="utf-8"))
    locked = {
        str(package["name"]): str(package["version"])
        for package in cast(list[dict[str, object]], lock["package"])
    }
    expected = {
        "python": Pin(str(pins["python"]), AUDIO_PINS),
        "espeak_ng": Pin(str(pins["espeak_ng"]), AUDIO_PINS),
        "ffmpeg": Pin(apt["ffmpeg"], AUDIO_PINS),
    }
    for name in AUDIO_PACKAGES:
        expected[name] = Pin(locked[name], AUDIO_LOCK)
    models = cast(list[dict[str, object]], _read_json(repo_root / AUDIO_MODELS)["models"])
    for model in models:
        name = str(model["name"])
        files = cast(list[dict[str, str]], model["files"])
        expected[f"model.{name}"] = Pin(str(model["revision"]), AUDIO_MODELS)
        expected[f"model.{name}.sha256"] = Pin(
            files_digest((f["path"], f["sha256"]) for f in files), AUDIO_MODELS
        )
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


def docker_build_args(repo_root: Path, image: ImageKind = "render") -> list[str]:
    """``--build-arg`` pairs for the image's Dockerfile, read from the tracked pin files."""
    if image == "audio":
        pins = _read_json(repo_root / AUDIO_PINS)
        apt = cast(dict[str, str], pins["apt"])
        values = {
            "BASE_IMAGE": str(pins["base_image"]),
            "UV_IMAGE": str(pins["uv_image"]),
            "DEBIAN_SNAPSHOT": str(pins["debian_snapshot"]),
            "FFMPEG_VERSION": apt["ffmpeg"],
            "INPUTS_HASH": inputs_hash(repo_root, "audio"),
        }
    else:
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


def platform(repo_root: Path, image: ImageKind = "render") -> str:
    pins_file = AUDIO_PINS if image == "audio" else PINS_FILE
    return str(_read_json(repo_root / pins_file)["platform"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-pins",
        description="Run an image offline and compare its versions to the pins.",
    )
    parser.add_argument("--image", required=True, help="the image reference to check")
    parser.add_argument("--kind", choices=KINDS, default="render")
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    kind: ImageKind = args.kind
    docker = shutil.which("docker")
    if docker is None:
        print("Docker is not available", file=sys.stderr)
        return 2
    command = [docker, "run", "--rm", "--network", "none", "--platform", platform(args.repo, kind)]
    report = "versions" if kind == "audio" else "--versions"
    command += [args.image, report]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        job = "audio-job" if kind == "audio" else "render-job"
        print(f"{job} {report} failed (exit {result.returncode}):", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        return 2
    reported = cast(dict[str, str], json.loads(result.stdout))
    expected = expected_pins(args.repo, kind)
    problems = compare_pins(expected, reported)
    for problem in problems:
        print(problem)
    if not problems:
        print(f"ok: {len(expected)} pins match ({', '.join(sorted(expected))})")
    return 1 if problems else 0


def build_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-build-image",
        description="Build an image with docker buildx, every version from the pin files.",
    )
    parser.add_argument("--tag", required=True)
    parser.add_argument("--kind", choices=KINDS, default="render")
    parser.add_argument("--push", action="store_true", help="push instead of loading locally")
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    docker = shutil.which("docker")
    if docker is None:
        print("Docker is not available", file=sys.stderr)
        return 2
    repo: Path = args.repo
    kind: ImageKind = args.kind
    dockerfile, context = (
        (repo / AUDIO_DOCKERFILE, repo / AUDIO_DIR)
        if kind == "audio"
        else (repo / DOCKERFILE, repo)
    )
    command = [docker, "buildx", "build", "--platform", platform(repo, kind)]
    command += ["--file", str(dockerfile), "--tag", args.tag]
    command += docker_build_args(repo, kind)
    command += ["--push" if args.push else "--load", str(context)]
    return subprocess.run(command, check=False).returncode


def _read_json(path: Path) -> dict[str, object]:
    return cast(dict[str, object], json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    sys.exit(main())
