from pathlib import Path

import pytest

from cinewright_tools.boundaries import find_violations, main

# Built from parts so this file does not trip the check it tests.
PERSONAL = "fixtures/" + "personal"


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_flags_bpy_import_forms(tmp_path: Path) -> None:
    write(
        tmp_path,
        "core/a.py",
        "import bpy as b\n"
        "from bpy import ops\n"
        "import importlib\n"
        "importlib.import_module('bpy.types')\n"
        "__import__('bpy')\n",
    )
    assert [(v.line, v.rule) for v in find_violations(tmp_path)] == [
        (1, "bpy-outside-blender"),
        (2, "bpy-outside-blender"),
        (4, "bpy-outside-blender"),
        (5, "bpy-outside-blender"),
    ]


def test_allows_bpy_in_blender_backend(tmp_path: Path) -> None:
    write(tmp_path, "plugins/backend-blender/x.py", "import bpy\n")
    assert find_violations(tmp_path) == []


def test_ignores_bpy_lookalikes(tmp_path: Path) -> None:
    write(tmp_path, "core/a.py", "# import bpy\nimport bpy_helpers\ns = 'bpy is great'\n")
    assert find_violations(tmp_path) == []


def test_flags_personal_fixture_references(tmp_path: Path) -> None:
    write(
        tmp_path,
        "core/src/a.ts",
        f'import x from "../../{PERSONAL}/brief.js";\n'
        f"const y = await import(`../{PERSONAL}/b`);\n"
        f'const z = require("{PERSONAL}/c");\n',
    )
    write(tmp_path, "tools/src/b.py", f"PATH = '{PERSONAL}/d.json'\n")
    assert [(v.path, v.line) for v in find_violations(tmp_path)] == [
        ("core/src/a.ts", 1),
        ("core/src/a.ts", 2),
        ("core/src/a.ts", 3),
        ("tools/src/b.py", 1),
    ]


def test_ignores_personal_path_in_comments(tmp_path: Path) -> None:
    write(
        tmp_path,
        "core/src/a.ts",
        f"// never read {PERSONAL}/\n/* {PERSONAL} */\nconst url = 'https://x//y';\n",
    )
    assert find_violations(tmp_path) == []


def test_skips_fixture_dirs_and_reports_unparseable(tmp_path: Path) -> None:
    write(tmp_path, f"{PERSONAL}/a.py", "import bpy\n")
    write(tmp_path, "core/bad.py", "def (:\n")
    assert [(v.path, v.rule) for v in find_violations(tmp_path)] == [("core/bad.py", "unparseable")]


def test_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main([str(tmp_path)]) == 0
    write(tmp_path, "core/a.py", "import bpy\n")
    assert main([str(tmp_path)]) == 1
    assert "core/a.py:1 bpy-outside-blender" in capsys.readouterr().out
