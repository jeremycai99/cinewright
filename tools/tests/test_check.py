"""render-job check from the host, and the component specimen checks (M2.4b)."""

import json
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from cinewright_tools import specimens
from cinewright_tools.container import CheckResult, check_main, run_check

REPO = Path(__file__).resolve().parents[2]


def test_check_command_is_a_list_with_network_off(
    fake_docker: list[Sequence[str]], tmp_path: Path
) -> None:
    result = run_check("img", REPO / "container/fixtures/hello-world", tmp_path / "out", [0.5, 1.5])
    command = list(fake_docker[-1])
    assert command[command.index("--network") + 1] == "none"
    assert command[-8:] == [
        "img",
        "check",
        "--in",
        "/job/in",
        "--out",
        "/job/out",
        "--at",
        "0.5,1.5",
    ]
    assert result.failures == []


def test_check_reads_failures(fake_docker: list[Sequence[str]], tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    failure = {"section": "contrast", "code": "contrast_aa_failure", "severity": "warning"}
    (out / "failures.json").write_text(json.dumps([failure]))
    result = run_check("img", REPO / "container/fixtures/hello-world", out, [1])
    assert result.failures == [failure]


def test_check_main_needs_times(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        check_main(["--image", "x", "--in", ".", "--out", "o"])
    assert "--at" in capsys.readouterr().err


def test_check_specimens_reports_each_failure_and_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    for name in ("a", "b"):
        d = tmp_path / "neutral" / name
        d.mkdir(parents=True)
        (d / "samples.json").write_text(
            json.dumps({"fps": {"num": 30, "den": 1}, "samples": [0.5, 1.0], "layers": []})
        )

    def fake_check(_image: str, composition: Path, out: Path, at: list[float]) -> CheckResult:
        bad = composition.name == "b"
        fails: list[dict[str, object]] = (
            [{"section": "layout", "code": "text_overflow", "severity": "error"}] if bad else []
        )
        return CheckResult(exit_code=5 if bad else 0, out_dir=out, failures=fails, stderr="")

    monkeypatch.setattr(specimens, "run_check", fake_check)
    monkeypatch.setattr(specimens, "render_stills", lambda *_args: None)
    monkeypatch.setattr(shutil, "which", lambda _: "/usr/bin/docker")
    assert specimens.main(["--image", "img", str(tmp_path)]) == 1
    out = capsys.readouterr().out
    assert "neutral/b: layout error text_overflow" in out
    assert "neutral/a: ok" in out
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["failed"] == ["neutral/b"]


def test_contact_sheet_selects_the_sample_frames() -> None:
    assert specimens.select_filter([0.5, 1.0, 2.0], {"num": 30, "den": 1}) == (
        r"select='eq(n\,15)+eq(n\,30)+eq(n\,60)',scale=480:-1,tile=3x1"
    )


def test_generated_assets_are_made_with_the_image_ffmpeg(
    fake_docker: list[Sequence[str]], tmp_path: Path
) -> None:
    (tmp_path / "generated.json").write_text(
        json.dumps([{"path": "assets/plate/testsrc.mp4", "lavfi": "testsrc2=size=64x36:rate=30"}])
    )
    specimens.generate_assets("img", tmp_path)
    command = list(fake_docker[-1])
    assert command[command.index("--network") + 1] == "none"
    assert command[command.index("--entrypoint") + 1] == "ffmpeg"
    assert "lavfi" in command and "testsrc2=size=64x36:rate=30" in command
    assert command[-1] == "/w/assets/plate/testsrc.mp4"
    assert (tmp_path / "assets/plate").is_dir()


def _build(out: Path, *extra: str) -> list[Path]:
    """Build specimens with the components CLI (needs Node and a built workspace)."""
    command = ["pnpm", "--filter", "@cinewright/components", "specimens", "--", "--out", str(out)]
    result = subprocess.run(
        [*command, *extra], cwd=REPO, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr + result.stdout
    return sorted(p.parent for p in out.glob("*/*/samples.json"))


def _samples(directory: Path) -> list[float]:
    return json.loads((directory / "samples.json").read_text())["samples"]


@pytest.mark.container
def test_kinetic_title_passes_in_every_pack_and_aspect(image: str, tmp_path: Path) -> None:
    dirs = _build(tmp_path / "s", "--component", "kinetic_title")
    assert len(dirs) >= 2
    for d in dirs:
        result = run_check(image, d, tmp_path / "check" / d.parent.name / d.name, _samples(d))
        assert result.exit_code == 0 and result.failures == [], (d, result.failures, result.stderr)


@pytest.mark.container
def test_an_override_that_breaks_contrast_fails_naming_the_element(
    image: str, tmp_path: Path
) -> None:
    examples = tmp_path / "examples.json"
    examples.write_text(
        json.dumps(
            [
                {
                    "name": "low_contrast",
                    "template": "title",
                    "region": "title",
                    "duration_ms": 2000,
                    "props": {"text": "Hard to read"},
                    "overrides": {"palette.ink": {"token": "palette.bg"}},
                }
            ]
        )
    )
    built = _build(
        tmp_path / "s",
        "--component",
        "kinetic_title",
        "--pack",
        "neutral",
        "--profile",
        "landscape_1080p30",
        "--examples",
        str(examples),
    )
    result = run_check(image, built[0], tmp_path / "check", _samples(built[0]))
    assert result.exit_code == 5, result.stderr
    codes = {(f["section"], f["code"]) for f in result.failures}
    assert ("contrast", "contrast_aa_failure") in codes
    assert any("span" in str(f.get("selector", "")) for f in result.failures)
