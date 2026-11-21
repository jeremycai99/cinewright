"""The audio image (M4.0a): its pins, inputs hash, lock and versions report."""

import importlib.util
import json
import os
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from cinewright_tools import image_lock, pins
from cinewright_tools.container import files_digest, inputs_hash
from cinewright_tools.pins import Pin, docker_build_args, expected_pins

REPO = Path(__file__).resolve().parents[2]
AUDIO = REPO / "container/audio"


def _versions_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("audio_versions", AUDIO / "audio_job/versions.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def audio_repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    shutil.copytree(AUDIO, root / "container/audio", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(REPO / "container/pins.json", root / "container/pins.json")
    return root


def test_audio_inputs_hash_covers_exactly_the_build_context(audio_repo: Path) -> None:
    audio = audio_repo / "container/audio"
    h = inputs_hash(audio_repo, "audio")
    assert h != inputs_hash(REPO, "render")
    # Files outside the build context do not count.
    for rel in ("README.md", "image.lock.json"):
        (audio / rel).write_text("changed\n")
    (audio / "spike").mkdir(exist_ok=True)
    (audio / "spike/run.sh").write_text("echo\n")
    (audio / "audio_job/__pycache__").mkdir(exist_ok=True)
    (audio / "audio_job/__pycache__/cli.cpython-312.pyc").write_bytes(b"x")
    assert inputs_hash(audio_repo, "audio") == h
    # Files inside it do.
    for rel in ("Dockerfile", "pins.json", "models.json", "uv.lock", "audio_job/cli.py"):
        copy = audio_repo.parent / "copy"
        shutil.copytree(audio_repo, copy)
        (copy / "container/audio" / rel).write_text("changed\n")
        assert inputs_hash(copy, "audio") != h, rel
        shutil.rmtree(copy)


def test_dockerignore_matches_the_inputs_hash() -> None:
    lines = (AUDIO / ".dockerignore").read_text().splitlines()
    ignored = {line for line in lines if line and not line.startswith("#")}
    assert ignored == {"README.md", "image.lock.json", "spike", "**/__pycache__", ".venv"}


def test_audio_apt_comes_from_the_render_snapshot() -> None:
    render = json.loads((REPO / "container/pins.json").read_text())
    audio = json.loads((AUDIO / "pins.json").read_text())
    assert audio["debian_snapshot"] == render["debian_snapshot"]
    assert audio["apt"]["ffmpeg"] == render["apt"]["ffmpeg"]
    assert audio["platform"] == "linux/amd64"


def test_audio_expected_pins() -> None:
    expected = expected_pins(REPO, "audio")
    lock = "container/audio/uv.lock"
    assert expected["python"] == Pin("3.12.16", "container/audio/pins.json")
    assert expected["kokoro"] == Pin("0.9.4", lock)
    assert expected["misaki"] == Pin("0.9.4", lock)
    assert expected["whisperx"] == Pin("3.8.6", lock)
    assert expected["torch"].value.startswith("2.8.") and expected["torch"].source == lock
    for name in ("torchaudio", "phonemizer-fork", "espeakng-loader", "ctranslate2", "spacy"):
        assert expected[name].source == lock
    assert expected["en-core-web-sm"] == Pin("3.8.0", lock)
    assert expected["espeak_ng"].source == "container/audio/pins.json"
    assert expected["ffmpeg"].source == "container/audio/pins.json"
    models = json.loads((AUDIO / "models.json").read_text())["models"]
    for model in models:
        assert expected[f"model.{model['name']}"] == Pin(
            model["revision"], "container/audio/models.json"
        )
        assert expected[f"model.{model['name']}.sha256"].value == files_digest(
            (f["path"], f["sha256"]) for f in model["files"]
        )


def test_every_published_kokoro_voice_is_baked() -> None:
    models = {m["name"]: m for m in json.loads((AUDIO / "models.json").read_text())["models"]}
    paths = [f["path"] for f in models["kokoro-82m"]["files"]]
    assert {"config.json", "kokoro-v1_0.pth"} <= set(paths)
    assert len([p for p in paths if p.startswith("voices/")]) == 54
    for model in models.values():
        for f in model["files"]:
            assert len(f["sha256"]) == 64 and f["url"].startswith("https://")
            assert model["revision"] in f["url"] or model["name"] == "wav2vec2-asr-base-960h"


def test_report_side_digest_matches_the_check_side() -> None:
    versions = _versions_module()
    pairs = [("b.pt", "2" * 64), ("a.json", "1" * 64)]
    assert versions.files_digest(pairs) == files_digest(pairs)


def test_render_pins_are_unchanged() -> None:
    assert expected_pins(REPO) == expected_pins(REPO, "render")
    assert "kokoro" not in expected_pins(REPO, "render")


def test_audio_build_args(audio_repo: Path) -> None:
    args = docker_build_args(audio_repo, "audio")
    audio = json.loads((AUDIO / "pins.json").read_text())
    assert "BASE_IMAGE=" + audio["base_image"] in args
    assert "UV_IMAGE=" + audio["uv_image"] in args
    assert "DEBIAN_SNAPSHOT=" + audio["debian_snapshot"] in args
    assert "FFMPEG_VERSION=" + audio["apt"]["ffmpeg"] in args
    assert "INPUTS_HASH=" + inputs_hash(audio_repo, "audio") in args


def test_check_pins_runs_audio_job_versions(
    fake_docker: list[Sequence[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    reported = {k: p.value for k, p in expected_pins(REPO, "audio").items()}

    def fake_run(command: Sequence[str], **_: Any) -> subprocess.CompletedProcess[str]:
        fake_docker.append(command)
        return subprocess.CompletedProcess(command, 0, json.dumps(reported), "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert pins.main(["--kind", "audio", "--image", "img", "--repo", str(REPO)]) == 0
    command = list(fake_docker[-1])
    assert command[command.index("--network") + 1] == "none"
    assert command[-2:] == ["img", "versions"]


def test_build_image_uses_the_audio_context(fake_docker: list[Sequence[str]]) -> None:
    assert pins.build_main(["--kind", "audio", "--tag", "t", "--repo", str(REPO)]) == 0
    command = list(fake_docker[-1])
    assert command[command.index("--file") + 1] == str(REPO / "container/audio/Dockerfile")
    assert command[-1] == str(REPO / "container/audio")


def test_audio_lock_names_the_image_and_sets_both_fields_or_neither() -> None:
    lock = json.loads((AUDIO / "image.lock.json").read_text())
    assert lock["image"] == "ghcr.io/jeremycai99/cinewright-audio"
    assert (lock["digest"] is None) == (lock["inputs_hash"] is None)
    assert image_lock.check_image_lock(lock, lock["inputs_hash"], "tree") == []


@pytest.fixture
def audio_image() -> str:
    return os.environ.get("CINEWRIGHT_AUDIO_IMAGE", "cinewright-audio:dev")


@pytest.mark.container
def test_audio_image_matches_its_pins(audio_image: str) -> None:
    assert pins.main(["--kind", "audio", "--image", audio_image, "--repo", str(REPO)]) == 0


@pytest.mark.container
def test_audio_stacks_import_offline(audio_image: str) -> None:
    command = ["docker", "run", "--rm", "--network", "none", "--platform", "linux/amd64"]
    # exec: phonemizer copies the espeak-ng library into /tmp and loads it from there.
    command += ["--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--env", "HOME=/tmp"]
    command += [audio_image, "imports"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert "import offline" in result.stdout
