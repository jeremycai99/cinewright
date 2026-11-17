import json
from pathlib import Path

from cinewright_tools.pins import Pin, compare_pins, docker_build_args, expected_pins

REPO = Path(__file__).resolve().parents[2]


def test_matching_pins_pass() -> None:
    assert compare_pins({"node": Pin("24.22.3", ".node-version")}, {"node": "24.22.3"}) == []


def test_mismatch_names_key_values_and_source() -> None:
    assert compare_pins({"node": Pin("24.22.3", ".node-version")}, {"node": "24.22.2"}) == [
        "node: expected 24.22.3 (from .node-version), image reports 24.22.2"
    ]


def test_missing_key_is_reported() -> None:
    expected = {"hyperframes": Pin("0.9.58", "container/render-runner/package.json")}
    assert compare_pins(expected, {}) == [
        "hyperframes: expected 0.9.58 (from container/render-runner/package.json),"
        " image reports nothing"
    ]


def test_build_args_come_from_pins(tmp_repo: Path) -> None:
    args = docker_build_args(tmp_repo)
    pins = json.loads((tmp_repo / "container/pins.json").read_text())
    assert "BASE_IMAGE=" + pins["base_image"] in args
    assert any(a.startswith("INPUTS_HASH=") for a in args)


def test_expected_pins_reads_repo_files() -> None:
    pins = expected_pins(REPO)
    assert pins["node"] == Pin("24.22.3", ".node-version")
    assert pins["hyperframes"] == Pin("0.9.58", "container/render-runner/package.json")
    assert pins["chrome_headless_shell"] == Pin("152.0.7977.30", "container/pins.json")
    assert pins["ffmpeg"].source == "container/pins.json"


def test_gsap_is_not_pinned_or_vendored() -> None:
    assert "gsap" not in expected_pins(REPO)
    deps = json.loads((REPO / "container/render-runner/package.json").read_text())["dependencies"]
    assert "gsap" not in deps
    assert "gsap" not in (REPO / "container/Dockerfile").read_text().lower()
