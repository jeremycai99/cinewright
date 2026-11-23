from pathlib import Path

import pytest

from cinewright_tools.setup_doc import REQUIRED_STEPS, missing_steps, parse_guide, run_guide

REPO = Path(__file__).resolve().parents[2]

GUIDE = """# Setup

Some prose.

<!-- setup: first -->
```bash
GREETING=hello
```

```bash
echo "untagged blocks never run" > untagged.txt
```

<!-- setup: second -->

```bash
echo "$GREETING" > out.txt
```

```json
{"not": "shell"}
```
"""


def write(tmp: Path, text: str) -> Path:
    guide = tmp / "SETUP.md"
    guide.write_text(text)
    return guide


def test_parse_finds_tagged_bash_blocks_in_order() -> None:
    steps = parse_guide(GUIDE)
    assert [s.name for s in steps] == ["first", "second"]
    assert steps[0].code.strip() == "GREETING=hello"
    assert steps[1].line == 16


def test_runs_blocks_in_one_shell_from_the_repo(tmp_path: Path) -> None:
    guide = write(tmp_path, GUIDE)
    code = run_guide(guide, tmp_path, required=("first", "second"))
    assert code == 0
    assert (tmp_path / "out.txt").read_text() == "hello\n"
    assert not (tmp_path / "untagged.txt").exists()


def test_fails_when_a_block_fails_and_names_the_step(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    text = GUIDE.replace("GREETING=hello", "GREETING=hello\nfalse")
    code = run_guide(write(tmp_path, text), tmp_path, required=("first", "second"))
    assert code != 0
    assert "step first failed" in capfd.readouterr().err
    assert not (tmp_path / "out.txt").exists()


def test_fails_when_a_pipeline_stage_fails(tmp_path: Path) -> None:
    text = GUIDE.replace("GREETING=hello", "GREETING=hello\nfalse | cat")
    assert run_guide(write(tmp_path, text), tmp_path, required=("first", "second")) != 0


def test_fails_when_a_required_step_has_no_block(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = run_guide(write(tmp_path, GUIDE), tmp_path, required=("first", "second", "third"))
    assert code == 2
    assert "no block for step third" in capsys.readouterr().err
    assert not (tmp_path / "out.txt").exists()


def test_skips_a_named_step(tmp_path: Path) -> None:
    text = GUIDE.replace('echo "$GREETING"', 'echo "${GREETING:-none}"')
    code = run_guide(write(tmp_path, text), tmp_path, required=("first", "second"), skip={"first"})
    assert code == 0
    assert (tmp_path / "out.txt").read_text() == "none\n"


def test_refuses_to_skip_a_step_the_guide_does_not_have(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = run_guide(write(tmp_path, GUIDE), tmp_path, required=("first",), skip={"nope"})
    assert code == 2
    assert "nope" in capsys.readouterr().err


def test_the_real_guide_has_every_required_step() -> None:
    steps = parse_guide((REPO / "docs" / "SETUP.md").read_text())
    assert missing_steps(steps, REQUIRED_STEPS) == []
