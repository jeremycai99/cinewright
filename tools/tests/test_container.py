import platform
import shutil
from collections.abc import Sequence
from pathlib import Path

import pytest

from cinewright_tools.container import inputs_hash, main, run_render

FIXTURES = Path(__file__).resolve().parents[2] / "container/fixtures"
HELLO = FIXTURES / "hello-world"
REMOTE = FIXTURES / "remote-url"


def test_inputs_hash_is_stable_and_sensitive(tmp_repo: Path) -> None:
    h = inputs_hash(tmp_repo)
    assert h == inputs_hash(tmp_repo)
    (tmp_repo / "container/pins.json").write_text("{}\n")
    assert inputs_hash(tmp_repo) != h


def test_inputs_hash_ignores_local_build_artifacts(tmp_repo: Path) -> None:
    h = inputs_hash(tmp_repo)
    runner = tmp_repo / "container/render-runner"
    (runner / "tsconfig.tsbuildinfo").write_text("{}")
    (runner / "dist").mkdir(exist_ok=True)
    (runner / "dist/cli.js").write_text("")
    assert inputs_hash(tmp_repo) == h


def test_missing_docker_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _: None)
    assert main(["--image", "x", "--in", ".", "--out", "o"]) == 2
    assert "Docker is not available" in capsys.readouterr().err


def test_non_amd64_host_warns(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    fake_docker: list[Sequence[str]],
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(platform, "machine", lambda: "arm64")
    main(["--image", "x", "--in", ".", "--out", str(tmp_path / "o")])
    assert "not a baseline" in capsys.readouterr().err


def test_docker_command_is_a_list_with_network_off(
    fake_docker: list[Sequence[str]], tmp_path: Path
) -> None:
    odd = tmp_path / "hello, world é"
    shutil.copytree(HELLO, odd)
    run_render("img", odd, tmp_path / "out")
    command = list(fake_docker[-1])
    assert command[:2] == ["/usr/bin/docker", "run"]
    assert command[command.index("--network") + 1] == "none"
    assert command[command.index("--platform") + 1] == "linux/amd64"
    assert any(f'"source={odd.resolve()}"' in arg for arg in command)
    assert command[-6:] == ["--in", "/job/in", "--out", "/job/out", "--format", "mp4"]


@pytest.mark.container
def test_hello_world_is_deterministic(image: str, tmp_path: Path) -> None:
    a = run_render(image, HELLO, tmp_path / "a")
    b = run_render(image, HELLO, tmp_path / "b")
    assert a.exit_code == b.exit_code == 0, a.stderr + b.stderr
    assert a.framemd5 is not None and a.framemd5 == b.framemd5
    assert a.sha256 is not None and a.sha256 == b.sha256


@pytest.mark.container
def test_path_with_spaces_and_non_ascii(image: str, tmp_path: Path) -> None:
    odd = tmp_path / "hello world é"
    shutil.copytree(HELLO, odd)
    odd_result = run_render(image, odd, tmp_path / "o")
    plain_result = run_render(image, HELLO, tmp_path / "p")
    assert odd_result.exit_code == plain_result.exit_code == 0, odd_result.stderr
    assert odd_result.framemd5 == plain_result.framemd5


@pytest.mark.container
def test_remote_url_fails_and_names_it(image: str, tmp_path: Path) -> None:
    r = run_render(image, REMOTE, tmp_path / "o")
    assert r.exit_code == 3, r.stderr
    assert "blocked network request: https://example.com/cinewright-network-probe.png" in r.stderr
