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


def _plugin_repo(tmp_path: Path) -> Path:
    write(tmp_path, "plugins/backend-x/package.json", '{"name": "@cinewright/backend-x"}')
    write(tmp_path, "plugins/sdk-ts/package.json", '{"name": "@cinewright/plugin-sdk"}')
    return tmp_path


def test_flags_plugin_imports_from_cli_and_core(tmp_path: Path) -> None:
    root = _plugin_repo(tmp_path)
    write(root, "cli/src/a.ts", 'import { renderShot } from "@cinewright/backend-x";\n')
    write(root, "core/src/b.ts", 'const m = await import("@cinewright/backend-x");\n')
    write(root, "cli/src/ok.ts", 'import { loadPlugin } from "@cinewright/plugin-sdk";\n')
    assert [(v.path, v.rule) for v in find_violations(root)] == [
        ("cli/src/a.ts", "plugin-import"),
        ("core/src/b.ts", "plugin-import"),
    ]


def test_engine_may_import_plugins_only_in_tests(tmp_path: Path) -> None:
    root = _plugin_repo(tmp_path)
    write(root, "engine/src/a.ts", 'export { x } from "@cinewright/backend-x";\n')
    write(root, "engine/test/a.test.ts", 'import { x } from "@cinewright/backend-x";\n')
    write(root, "plugins/backend-y/src/a.ts", 'import { x } from "@cinewright/backend-x";\n')
    assert [v.path for v in find_violations(root)] == ["engine/src/a.ts"]


def test_the_repository_has_no_plugin_imports() -> None:
    repo = Path(__file__).resolve().parents[2]
    assert [v for v in find_violations(repo) if v.rule == "plugin-import"] == []


MODEL = "claude-" + "opus-5-5"  # split, so this test file is not itself a violation
VENDOR = "@anthropic" + "-ai/sdk"


def test_flags_model_ids_and_vendor_sdk_outside_the_llm_plugin(tmp_path: Path) -> None:
    write(tmp_path, "engine/src/agent.ts", f'export const M = "{MODEL}";\n')
    write(tmp_path, "engine/src/client.ts", f'import Anthropic from "{VENDOR}";\n')
    write(tmp_path, "core/src/lazy.ts", f'const m = await import("{VENDOR}/resources");\n')
    write(tmp_path, "agents/roles/writer/role.json", f'{{"model": "{MODEL}"}}\n')
    write(tmp_path, "tools/src/x.py", f'MODEL = "{MODEL}"\nimport anthropic\n')
    found = sorted((v.path, v.rule) for v in find_violations(tmp_path))
    assert found == [
        ("agents/roles/writer/role.json", "model-id"),
        ("core/src/lazy.ts", "vendor-sdk"),
        ("engine/src/agent.ts", "model-id"),
        ("engine/src/client.ts", "vendor-sdk"),
        ("tools/src/x.py", "model-id"),
        ("tools/src/x.py", "vendor-sdk"),
    ]


def test_allows_them_in_the_llm_plugin_docs_comments_and_locks(tmp_path: Path) -> None:
    write(
        tmp_path,
        "plugins/llm-anthropic/src/plugin.ts",
        f'import A from "{VENDOR}";\nconst m = "{MODEL}";\n',
    )
    write(
        tmp_path, "plugins/llm-anthropic/settings.json", f'{{"tiers": {{"frontier": "{MODEL}"}}}}\n'
    )
    write(tmp_path, "docs/plans/m7.md", f"The frontier tier is {MODEL}.\n")
    write(tmp_path, "engine/src/note.ts", f"// the plugin maps tiers to {MODEL}\nexport {{}};\n")
    write(tmp_path, "pnpm-lock.yaml", f"  {VENDOR}:\n")
    write(
        tmp_path,
        "plugins/llm-anthropic/package.json",
        f'{{"dependencies": {{"{VENDOR}": "1.0.0"}}}}\n',
    )
    assert find_violations(tmp_path) == []


def test_the_repository_names_no_model_outside_the_llm_plugin() -> None:
    root = Path(__file__).resolve().parents[2]
    bad = [v for v in find_violations(root) if v.rule in ("model-id", "vendor-sdk")]
    assert bad == []
