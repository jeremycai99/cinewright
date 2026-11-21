"""Import-boundary check (AGENTS.md §2.3 item 5 and §3 invariant 10).

Four rules:

- ``bpy-outside-blender``: Python code imports ``bpy`` (``import``, ``from ... import``,
  ``importlib.import_module`` or ``__import__`` with a constant name) outside
  ``plugins/backend-blender/``.
- ``personal-fixture-reference``: a string literal in Python, TypeScript or JavaScript
  names the personal fixtures directory. Comments are never scanned.

- ``gpl-import``: Python code imports ``kokoro``, ``misaki`` or ``phonemizer`` outside
  ``plugins/tts-kokoro/`` (GPL-3.0-or-later, audit decision 8) and the audio image's own
  tooling under ``container/audio/``.
- ``plugin-import``: TypeScript or JavaScript under ``cli/`` or ``core/`` imports a plugin
  package (any ``@cinewright/*`` package whose folder is under ``plugins/``, except the plugin
  SDK), or code under ``engine/`` outside its tests imports one statically (invariant 5,
  M5.4a). Plugins are reached through the engine's registry, by manifest.
A Python file that cannot be read or parsed is reported as ``unparseable``.

Known limitation: the TS/JS scanner does not recognise regular-expression literals, so a
path written only inside a regex literal is missed, and a quote character inside one can
desynchronise the scan for the rest of that line.
"""

from __future__ import annotations

import argparse
import ast
import io
import os
import re
import sys
import tokenize
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

PY_SUFFIXES = {".py"}
JS_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
SKIP_DIR_NAMES = {"node_modules", ".venv", "dist", ".git"}
SKIP_PREFIXES = ("fixtures/", "tools/tests/fixtures/")
BLENDER_PREFIX = "plugins/backend-blender/"
GPL_MODULES = ("kokoro", "misaki", "phonemizer")
GPL_ALLOWED = ("plugins/tts-kokoro/", "container/audio/")
PERSONAL_RE = re.compile(r"fixtures[/\\]personal")
STRING_TOKEN_TYPES = {
    getattr(tokenize, name)
    for name in ("STRING", "FSTRING_MIDDLE", "TSTRING_MIDDLE")
    if hasattr(tokenize, name)
}


@dataclass(frozen=True)
class Violation:
    path: str  # repo-relative, POSIX separators
    line: int
    rule: str  # "bpy-outside-blender" | "personal-fixture-reference" | "unparseable"
    detail: str


def find_violations(repo_root: Path) -> list[Violation]:
    """Scan every source file under ``repo_root``; results are sorted by (path, line)."""
    found: list[Violation] = []
    plugins = plugin_packages(repo_root)
    for path in _source_files(repo_root):
        rel = path.relative_to(repo_root).as_posix()
        if path.suffix in PY_SUFFIXES:
            found.extend(_check_python(path, rel))
        else:
            found.extend(_check_js(path, rel))
            found.extend(_plugin_imports(path, rel, plugins))
    return sorted(found, key=lambda v: (v.path, v.line, v.rule))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-boundaries",
        description="Fail if code imports bpy outside the Blender backend, "
        "references the personal fixtures, or imports a plugin package from cli, core or engine.",
    )
    parser.add_argument("repo_root", nargs="?", default=".", type=Path)
    args = parser.parse_args(argv)
    violations = find_violations(args.repo_root)
    for v in violations:
        print(f"{v.path}:{v.line} {v.rule} {v.detail}")
    return 1 if violations else 0


def _source_files(repo_root: Path) -> Iterator[Path]:
    for dirpath, dirnames, filenames in os.walk(repo_root):
        here = Path(dirpath)
        rel_dir = here.relative_to(repo_root).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        dirnames[:] = sorted(
            d
            for d in dirnames
            if d not in SKIP_DIR_NAMES and not f"{rel_dir}{d}/".startswith(SKIP_PREFIXES)
        )
        for name in sorted(filenames):
            path = here / name
            if path.suffix in PY_SUFFIXES or path.suffix in JS_SUFFIXES:
                yield path


def _is_bpy(module: str) -> bool:
    return module == "bpy" or module.startswith("bpy.")


def _check_python(path: Path, rel: str) -> list[Violation]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=rel)
    except (SyntaxError, UnicodeDecodeError, ValueError) as exc:
        line = getattr(exc, "lineno", None) or 1
        return [Violation(rel, line, "unparseable", f"{type(exc).__name__}: {exc}")]

    found: list[Violation] = []
    if not rel.startswith(BLENDER_PREFIX):
        found.extend(_bpy_imports(tree, rel))
    if not rel.startswith(GPL_ALLOWED):
        found.extend(_gpl_imports(tree, rel))
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, SyntaxError) as exc:
        return [Violation(rel, 1, "unparseable", f"{type(exc).__name__}: {exc}")]
    for tok in tokens:
        if tok.type in STRING_TOKEN_TYPES and PERSONAL_RE.search(tok.string):
            found.append(_personal(rel, tok.start[0], tok.string))
    return found


def _bpy_imports(tree: ast.AST, rel: str) -> Iterator[Violation]:
    detail = f"imports bpy (allowed only under {BLENDER_PREFIX})"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(_is_bpy(alias.name) for alias in node.names):
                yield Violation(rel, node.lineno, "bpy-outside-blender", detail)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module is not None and _is_bpy(node.module):
                yield Violation(rel, node.lineno, "bpy-outside-blender", detail)
        elif isinstance(node, ast.Call) and _is_dynamic_import(node.func) and node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                if _is_bpy(first.value):
                    yield Violation(rel, node.lineno, "bpy-outside-blender", detail)


def _is_gpl(module: str) -> bool:
    return any(module == m or module.startswith(f"{m}.") for m in GPL_MODULES)


def _gpl_imports(tree: ast.AST, rel: str) -> Iterator[Violation]:
    detail = "imports a GPL module (allowed only in plugins/tts-kokoro and container/audio)"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(_is_gpl(a.name) for a in node.names):
            yield Violation(rel, node.lineno, "gpl-import", detail)
        elif (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module
            and _is_gpl(node.module)
        ):
            yield Violation(rel, node.lineno, "gpl-import", detail)


def _is_dynamic_import(func: ast.expr) -> bool:
    if isinstance(func, ast.Name):
        return func.id in {"__import__", "import_module"}
    if isinstance(func, ast.Attribute):
        return func.attr == "import_module"
    return False


PLUGIN_SDK = "@cinewright/plugin-sdk"
JS_IMPORT_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](@cinewright/[a-z0-9-]+)["']"""
)


def plugin_packages(repo_root: Path) -> set[str]:
    """Names of the packages under ``plugins/`` (from each package.json), minus the SDK."""
    import json

    names: set[str] = set()
    for manifest in sorted((repo_root / "plugins").glob("*/package.json")):
        try:
            name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
        except (ValueError, OSError):
            continue
        if isinstance(name, str) and name != PLUGIN_SDK:
            names.add(name)
    return names


def _plugin_imports(path: Path, rel: str, plugins: set[str]) -> list[Violation]:
    restricted = rel.startswith(("cli/", "core/")) or (
        rel.startswith("engine/") and not rel.startswith("engine/test/")
    )
    if not restricted or not plugins:
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, ValueError):
        return []
    found: list[Violation] = []
    for number, text in enumerate(lines, start=1):
        if text.lstrip().startswith(("//", "*")):
            continue
        for match in JS_IMPORT_RE.finditer(text):
            if match.group(1) in plugins:
                detail = f"imports {match.group(1)}; reach plugins through the engine registry"
                found.append(Violation(rel, number, "plugin-import", detail))
    return found


def _check_js(path: Path, rel: str) -> list[Violation]:
    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        return [Violation(rel, 1, "unparseable", f"{type(exc).__name__}: {exc}")]
    return [
        _personal(rel, line, text)
        for line, text in _js_string_literals(source)
        if PERSONAL_RE.search(text)
    ]


def _js_string_literals(source: str) -> Iterator[tuple[int, str]]:
    """Yield (start line, contents) for each '…', "…" or `…` literal, skipping comments."""
    i, line, n = 0, 1, len(source)
    while i < n:
        c = source[i]
        if c == "\n":
            line += 1
            i += 1
        elif source.startswith("//", i):
            end = source.find("\n", i)
            i = n if end == -1 else end
        elif source.startswith("/*", i):
            end = source.find("*/", i + 2)
            end = n if end == -1 else end + 2
            line += source.count("\n", i, end)
            i = end
        elif c in "'\"`":
            start_line, j = line, i + 1
            while j < n and source[j] != c:
                if source[j] == "\\":
                    j += 1
                elif source[j] == "\n" and c != "`":
                    break
                j += 1
            text = source[i + 1 : j]
            line += text.count("\n")
            yield start_line, text
            i = j + 1 if j < n and source[j] == c else j
        else:
            i += 1


def _personal(rel: str, line: int, literal: str) -> Violation:
    shown = literal if len(literal) <= 80 else literal[:77] + "..."
    return Violation(rel, line, "personal-fixture-reference", f"string literal {shown!r}")


if __name__ == "__main__":
    sys.exit(main())
