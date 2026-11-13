from pathlib import Path

from cinewright_tools.container import inputs_hash


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
