# M0 — Repo and Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub monorepo with pinned TypeScript and Python toolchains, required CI checks, and a pinned Linux render container that renders a HyperFrames composition deterministically with the network disabled.

**Architecture:** One repository holds a pnpm workspace (TypeScript) and a uv workspace (Python), with every pin in a tracked file. Small Python checks (`cinewright-tools`) enforce the boundaries and pins in CI. A single amd64 render image, built from `container/Dockerfile` and recorded by digest, runs one entry point (`render-job`). The host starts it with `--network none`.

**Tech Stack:** Node 24.22.3, pnpm 12.18.0, TypeScript 7.0.2, Vitest 5.1.0, Biome 2.6.7, Python 3.13, uv 0.13.8, pytest 9.2.0, Ruff 0.17.5, Pyright 1.1.414, Docker, GitHub Actions, GHCR, HyperFrames 0.9.41, Debian 13 (trixie) with FFmpeg 7.1.5.

**Spec:** `docs/V0_1_PLAN.md` §M0 (M0.0–M0.3), with `AGENTS.md` §2.3, §3 (invariants 7 and 10) and §7, and `docs/DESIGN_SPEC.md` D2, D3, D6, D21, D33 and D41.

## Decisions this plan makes

Versions were read from npm, PyPI, nodejs.org, Docker Hub and sources.debian.org on 2026-11-13.

| Choice | Value | Why |
| --- | --- | --- |
| Node | 24.22.3 (LTS "Krypton", supported to 2028-04) | Every M0/M1 tool supports it. Node 26 became LTS on 2026-10-28; native modules arriving at M7 (`better-sqlite3`) are safer on 24. |
| pnpm | 12.18.0 via `packageManager` | Current release. Installed by `pnpm/action-setup` in CI and `npm install -g` in the image, both reading `packageManager`. |
| TypeScript | 7.0.2 | Current `latest`. Used only as `tsc -b`; no M0 tool calls the compiler's JS API. **Fallback:** if `tsc -b` with project references fails under 7.0.2, pin 6.0.3 and record it in the PR. |
| Lint and format (TS, JS, JSON) | Biome 2.6.7 | One tool for both jobs, no typescript-eslint dependency on the TS version. |
| Tests (TS) | Vitest 5.1.0 | Supports Node 24. |
| Python | 3.13 (`.python-version`); image uses Debian's 3.13.5 | Floor for `datamodel-code-generator` (M1.6) is 3.11. 3.13 is the VFX-platform line. The exact patch is reported by the pin check. |
| uv | 0.13.8 via `[tool.uv] required-version` | Current release. `astral-sh/setup-uv` reads it through `version-file`. |
| Lint, format, types (Python) | Ruff 0.17.5, Pyright 1.1.414 (npm, so one lockfile pins it) | M1.6 needs a Python type checker. |
| Import-boundary check | A Python script in `cinewright-tools` | No dependency risk; tested like any code. |
| Base image | `node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0`, `--platform=linux/amd64` | Node comes from the base; the digest freezes it. |
| System packages | Debian snapshot archive at one recorded timestamp; exact versions `ffmpeg=7:7.1.5-0+deb13u1`, `libx264-164=2:0.164.3108+git31e19f9-2`, `python3.13=3.13.5-2+deb13u5`, `fonts-noto-core` (version resolved and recorded in Task 6) | apt verifies package checksums through the signed snapshot index, which meets "version and build source with checksum". |
| Browser | chrome-headless-shell at the build id that the locked `puppeteer-core` declares, installed with `@puppeteer/browsers` to `/opt/chrome-headless-shell`, selected with `HYPERFRAMES_BROWSER_PATH` | It stays in step with the HyperFrames version; linux64 only. |
| Software rendering | `--no-browser-gpu` (SwiftShader) | HyperFrames documents it as the deterministic capture mode. |
| Animation runtime (hello world) | GSAP from the lockfile, copied into the image at `/opt/cinewright/vendor/gsap.min.js` | HyperFrames' documented path. Open issue 6 (GSAP licence) still decides M2.4; if GSAP leaves core, the fixture moves to a WAAPI adapter. |
| PR order | M0.1 → M0.3 → M0.2 | CI and required checks exist before the container work, so M0.2 adds the render smoke job. |
| Image digest record | Publish on main, then a follow-up PR writes `container/image.lock.json`; a check pulls that digest and compares its inputs-hash label | Avoids a bot token. A `GITHUB_TOKEN` PR would not trigger the required checks. |
| arm64 hosts | No arm64 image in v0.1. Apple Silicon runs the amd64 image under emulation; those renders are a different runner class and never set baselines | chrome-headless-shell is published for linux64 only. |

**Approved 2026-11-13** for execution in the maintainer's Claude Code session, including the deviation below.

**Owner and visibility (decided 2026-11-13):** `jeremycai99/cinewright`, **private**. Consequences: GitHub Free gives no rulesets or branch protection on private repositories (the API returns 403), so Task 5's ruleset cannot be applied until the repository is public or on GitHub Pro; Actions minutes count against the account's monthly quota; the GHCR image is private, and CI pulls it with `GITHUB_TOKEN` (`packages: read`).

**Deviation (approved):** M0.3's AC asks for a fork PR to be shown. You can't fork a repository into the account that owns it, so Task 5 checks fork safety statically (`cinewright-check-workflows`). A real fork PR is shown only if a second account or an org is available.

## Global Constraints

- Every pin lives in a tracked file that CI and the Dockerfile read: `.node-version`, `package.json` `packageManager` and `engines`, `.python-version`, `pyproject.toml` `[tool.uv] required-version`, `pnpm-lock.yaml`, `uv.lock`, `container/pins.json`. No floating versions and no hand-copied versions.
- Installs are frozen: `pnpm install --frozen-lockfile` and `uv sync --locked`.
- ESM only (`"type": "module"`); TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module`/`moduleResolution` `nodenext`.
- No package may assume one Python for the whole repo. `plugins/backend-blender` (v0.3) will be a separate uv project outside this workspace.
- Core code never imports `bpy` outside `plugins/backend-blender`, and no source outside `fixtures/` references `fixtures/personal/` (AGENTS.md §2.3 item 5, §3 invariant 10).
- The engine and CLI run on the host and only start the image; `render-job` is the only process inside it. Never use HyperFrames' own `--docker` flag (it builds an unpinned image).
- Renders run with `--network none`, telemetry off (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, D21) and preview discovery off (`HYPERFRAMES_NO_PREVIEW_DISCOVERY=1`).
- Render settings are explicit, never auto, and live in one file: `container/render-runner/render-settings.json`.
- Runner class = CPU architecture + image digest + render settings. Baselines use linux/amd64 in CI.
- If byte-identity (D33) cannot be met, stop and raise it. Do not weaken the check.
- GitHub Actions are pinned by full commit SHA with a version comment. Workflows triggered by `pull_request` request no write permissions and use no secrets.
- Commits end with the `Co-Authored-By` trailer the harness specifies. Pushing, opening PRs, changing rulesets and publishing images each need the maintainer's go-ahead at execution time.

## Review Focus

1. **Docker missing or not running.** `cinewright-render-in-container` exits 2 with "Docker is not available" instead of a traceback. Test in Task 7.
2. **Apple Silicon host.** A render on a non-amd64 host prints a warning that its hashes are not baselines. Test in Task 7.
3. **A pin bumped in one place only** (for example `.node-version` without a new base image). The pin check names the key, both values and the file each came from. Test in Task 6.
4. **Boundary-check blind spots.** `import bpy as b`, `from bpy import ops`, `importlib.import_module("bpy")`, `require("../fixtures/personal/x")` and dynamic `import()` are caught; `bpy` in a comment and `import bpy_helpers` are not. Tests in Task 3.
5. **Paths with spaces or non-ASCII characters.** A composition in `hello world é/` renders the same as one in `hello/`. Test in Task 7.

---

## File structure

```
.gitignore  .gitattributes  .node-version  .python-version  LICENSE  CONTRIBUTING.md
package.json            # root: private, packageManager, engines, scripts, devDependencies
pnpm-workspace.yaml     # packages: core, cli, plugins/sdk-ts, container/render-runner
tsconfig.base.json  tsconfig.json   # shared compiler options; project references
biome.json
pyproject.toml          # virtual uv workspace root; ruff, pytest, pyright config; dev group
uv.lock  pnpm-lock.yaml
core/                   # @cinewright/core (TS): IR schema, store, patch engine (M1)
  package.json tsconfig.json src/index.ts test/index.test.ts
  py/                   # cinewright-ir (Python): generated models (M1.6)
    pyproject.toml src/cinewright_ir/__init__.py tests/test_package.py
cli/                    # @cinewright/cli (TS): the `cinewright` binary (M1.9)
plugins/
  sdk-ts/               # @cinewright/plugin-sdk (TS): manifest, loader, host, kit (M1.8)
  sdk-py/               # cinewright-plugin-sdk (Python): subprocess plugin SDK (M1.8b)
tools/                  # cinewright-tools (Python): repo checks and the container runner
  pyproject.toml
  src/cinewright_tools/{boundaries,workflows,pins,container}.py
  tests/  tests/fixtures/
container/
  Dockerfile  pins.json  image.lock.json  README.md
  render-runner/        # @cinewright/render-runner (TS, private): the image's entry point
    package.json tsconfig.json render-settings.json src/{cli,settings,render,versions}.ts test/
  fixtures/hello-world/index.html  fixtures/remote-url/index.html
.github/
  rulesets/main.json
  workflows/checks.yml  workflows/render-smoke.yml  workflows/render-image.yml
```

Every package starts at version `0.0.0` and exports `VERSION = "0.0.0"`. Engine, agents, packs, components, eval and studio packages arrive with their milestones.

---

## Task 0: Create the repository (M0.0)

Maintainer action, with Claude running the commands after a go-ahead. No PR.

- [ ] **Step 1:** In `cinewright/cinewright/`, run `git init -b main`. Add `.gitignore` (`node_modules/`, `dist/`, `.venv/`, `.cinewright/`, `out/`, `*.mp4`, `*.mov`, `*.wav`, `.DS_Store`) and `.gitattributes` (`* text=auto eol=lf`).
- [ ] **Step 2:** Commit the existing docs: `git add -A && git commit -m "docs: design handoff and v0.1 plan"`.
- [ ] **Step 3:** Run `gh repo create <owner>/cinewright --<visibility> --source . --push`, then `gh repo view --json defaultBranchRef` and confirm the default branch is `main`.

## Task 1: TypeScript workspace (PR M0.1, branch `m0.1-scaffold`)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.node-version`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `LICENSE` (Apache-2.0 text), `CONTRIBUTING.md`
- Create: `core/`, `cli/` and `plugins/sdk-ts/`, each with `package.json`, `tsconfig.json`, `src/index.ts` and `test/index.test.ts`

**Interfaces:**
- Produces: root scripts `lint` (`biome ci .`), `format` (`biome format --write .`), `typecheck` (`tsc -b`) and `test` (`pnpm -r --if-present test`); each package's `test` runs `vitest run`. Package names `@cinewright/core`, `@cinewright/cli` (bin `cinewright` → `dist/bin.js`) and `@cinewright/plugin-sdk`, each exporting `export const VERSION = "0.0.0"`.

- [ ] **Step 1: Write the failing placeholder tests**, one per package:

```ts
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
describe("package wiring", () => {
  it("exports its version", () => { expect(VERSION).toBe("0.0.0"); });
});
```

- [ ] **Step 2:** Write the root config. `.node-version` = `24.22.3`; `package.json` has `"packageManager": "pnpm@12.18.0"`, `"engines": { "node": "24.22.3" }`, engine-strict on (the setting's location in pnpm 12 is in its docs), and exact devDependencies `typescript@7.0.2`, `vitest@5.1.0`, `@biomejs/biome@2.6.7`, `pyright@1.1.414`. `tsconfig.base.json` carries the Global Constraints options plus `composite`, `declaration` and `outDir: dist`. The root `tsconfig.json` references the three packages.
- [ ] **Step 3:** Run `pnpm install`, then `pnpm test`. Expected: FAIL, because `src/index.ts` does not exist yet.
- [ ] **Step 4:** Add `src/index.ts` (`export const VERSION = "0.0.0";`) to each package, and `cli/src/bin.ts`, which prints `cinewright <VERSION>`.
- [ ] **Step 5:** Run `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass, 3 tests. If `tsc -b` fails because of TypeScript 7, apply the fallback in Decisions.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "build: TypeScript workspace with pinned toolchain"`.

## Task 2: Python workspace (PR M0.1)

**Files:**
- Create: `.python-version` (`3.13`) and `pyproject.toml` (virtual workspace root: `[tool.uv] required-version = "==0.13.8"`, `[tool.uv.workspace] members = ["core/py", "plugins/sdk-py", "tools"]`, `[dependency-groups] dev = ["pytest==9.2.0", "ruff==0.17.5"]`, `[tool.pytest.ini_options] testpaths`, `[tool.ruff]` with `target-version = "py313"`, `[tool.pyright]` with `strict` for `tools/src`, `core/py/src` and `plugins/sdk-py/src`)
- Create: `core/py/`, `plugins/sdk-py/` and `tools/`, each with `pyproject.toml` (`requires-python = ">=3.13"`), `src/<module>/__init__.py` and `tests/test_package.py`

**Interfaces:**
- Produces: distributions `cinewright-ir` (`cinewright_ir`), `cinewright-plugin-sdk` (`cinewright_plugin_sdk`) and `cinewright-tools` (`cinewright_tools`), each with `__version__ = "0.0.0"`.

- [ ] **Step 1: Write the failing tests**: `def test_version(): assert cinewright_ir.__version__ == "0.0.0"`, and the same for the other two modules.
- [ ] **Step 2:** Run `uv sync && uv run pytest`. Expected: FAIL (ImportError).
- [ ] **Step 3:** Add `__version__ = "0.0.0"` to each `__init__.py`.
- [ ] **Step 4:** Run `uv sync --locked && uv run ruff check . && uv run ruff format --check . && pnpm exec pyright && uv run pytest`. Expected: all pass, 3 tests.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "build: Python uv workspace with pinned toolchain"`.

## Task 3: Import-boundary check (PR M0.1)

**Files:**
- Create: `tools/src/cinewright_tools/boundaries.py`, `tools/tests/test_boundaries.py`
- Modify: `tools/pyproject.toml` (script `cinewright-check-boundaries = "cinewright_tools.boundaries:main"`)

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True)
class Violation:
    path: str    # repo-relative, POSIX separators
    line: int
    rule: str    # "bpy-outside-blender" | "personal-fixture-reference" | "unparseable"
    detail: str

def find_violations(repo_root: Path) -> list[Violation]   # sorted by (path, line)
def main(argv: list[str] | None = None) -> int            # prints "path:line rule detail"; 1 if any
```

Scope: files ending in `.py`, `.ts`, `.tsx`, `.js`, `.mjs` or `.cjs` under `repo_root`, skipping `node_modules`, `.venv`, `dist`, `.git`, `fixtures/` and `tools/tests/fixtures/`. `bpy` is allowed only under `plugins/backend-blender/`.

- [ ] **Step 1: Write the failing tests.** Each test builds a tree in `tmp_path`.

```python
def test_flags_bpy_import_forms(tmp_path):
    write(tmp_path, "core/a.py", "import bpy as b\nfrom bpy import ops\nimport importlib\nimportlib.import_module('bpy.types')\n__import__('bpy')\n")
    assert [(v.line, v.rule) for v in find_violations(tmp_path)] == [
        (1, "bpy-outside-blender"), (2, "bpy-outside-blender"),
        (4, "bpy-outside-blender"), (5, "bpy-outside-blender")]

def test_allows_bpy_in_blender_backend(tmp_path):
    write(tmp_path, "plugins/backend-blender/x.py", "import bpy\n")
    assert find_violations(tmp_path) == []

def test_ignores_bpy_lookalikes(tmp_path):
    write(tmp_path, "core/a.py", "# import bpy\nimport bpy_helpers\ns = 'bpy is great'\n")
    assert find_violations(tmp_path) == []

def test_flags_personal_fixture_references(tmp_path):
    write(tmp_path, "core/src/a.ts", 'import x from "../../fixtures/personal/brief.js";\nconst y = await import(`../fixtures/personal/b`);\nconst z = require("fixtures/personal/c");\n')
    write(tmp_path, "tools/src/b.py", "PATH = 'fixtures/personal/d.json'\n")
    assert [(v.path, v.line) for v in find_violations(tmp_path)] == [
        ("core/src/a.ts", 1), ("core/src/a.ts", 2), ("core/src/a.ts", 3), ("tools/src/b.py", 1)]

def test_ignores_personal_path_in_comments(tmp_path):
    write(tmp_path, "core/src/a.ts", "// never read fixtures/personal/\n/* fixtures/personal */\nconst url = 'https://x//y';\n")
    assert find_violations(tmp_path) == []

def test_skips_fixture_dirs_and_reports_unparseable(tmp_path):
    write(tmp_path, "fixtures/personal/a.py", "import bpy\n")
    write(tmp_path, "core/bad.py", "def (:\n")
    assert [(v.path, v.rule) for v in find_violations(tmp_path)] == [("core/bad.py", "unparseable")]

def test_main_exit_codes(tmp_path, capsys):
    assert main([str(tmp_path)]) == 0
    write(tmp_path, "core/a.py", "import bpy\n")
    assert main([str(tmp_path)]) == 1
    assert "core/a.py:1 bpy-outside-blender" in capsys.readouterr().out
```

- [ ] **Step 2:** Run `uv run pytest tools/tests/test_boundaries.py -v`. Expected: FAIL (ImportError).
- [ ] **Step 3: Implement `find_violations` and `main`.** Python files: use `ast` for imports, and `importlib.import_module`/`__import__` calls with a constant first argument; use `tokenize` STRING tokens for the personal-path rule, so comments are never scanned. TS/JS files: a small scanner that skips `//` and `/* */` comments and yields each `'…'`, `"…"` or `` `…` `` literal with its line. Its known limitation is regex literals; note it in the docstring. A string matches if it contains `fixtures/personal` (or `fixtures\personal`).
- [ ] **Step 4:** Run `uv run pytest tools/tests/test_boundaries.py -v`, then `uv run cinewright-check-boundaries .`. Expected: 7 passed; the repo itself reports nothing and exits 0.
- [ ] **Step 5:** Commit: `git add tools && git commit -m "build: import-boundary check for bpy and personal fixtures"`.

## Task 4: CI checks and layout docs (PR M0.1)

**Files:**
- Create: `.github/workflows/checks.yml`
- Modify: `AGENTS.md` §7 (add `cli/`, `tools/` and `container/`), `docs/DESIGN_SPEC.md` "Repository layout" (same lines)

**Interfaces:**
- Produces: workflow `checks` with top-level `permissions: contents: read`, triggered on `pull_request` and on `push` to `main`. Jobs (whose names become required-check names in Task 5):
  - `ts`: setup-node with `node-version-file: .node-version`, pnpm/action-setup reading `packageManager`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
  - `py`: setup-uv with `version-file: pyproject.toml`, `uv sync --locked`, `ruff check`, `ruff format --check`, pyright through pnpm, `pytest`.
  - `boundaries`: `uv run cinewright-check-boundaries .`.

- [ ] **Step 1:** Write `checks.yml`, pinning every action by commit SHA.
- [ ] **Step 2:** Update the two layout blocks.
- [ ] **Step 3:** With the maintainer's go-ahead, push `m0.1-scaffold` and open PR "M0.1 Monorepo scaffold" with M0.1's AC as the checklist. Expected: `ts`, `py` and `boundaries` pass.
- [ ] **Step 4: Prove the failure modes** on throwaway commits, reverted afterwards: (a) add a dependency to `core/package.json` without updating the lockfile; `ts` fails at `--frozen-lockfile`. (b) Add a dependency to `tools/pyproject.toml` without `uv lock`; `py` fails at `--locked`. (c) Add `import bpy` to `tools/src/cinewright_tools/__init__.py`; `boundaries` fails. Link the three failed runs in the PR.
- [ ] **Step 5:** Merge after review.

## Task 5: Required checks and fork safety (PR M0.3, branch `m0.3-ci`)

**Files:**
- Create: `.github/rulesets/main.json` (target `main`; require a PR; required status checks `ts`, `py`, `boundaries`, `workflow-safety`; block force pushes and deletion)
- Create: `tools/src/cinewright_tools/workflows.py`, `tools/tests/test_workflows.py`, `tools/tests/fixtures/workflows/` (YAML cases)
- Modify: `.github/workflows/checks.yml` (add job `workflow-safety`), `tools/pyproject.toml` (add `pyyaml`, pinned exactly with `uv add`; script `cinewright-check-workflows`)

**Interfaces:**
- Produces:

```python
def required_checks(ruleset_path: Path) -> set[str]
def check_workflows(workflow_dir: Path, required: set[str]) -> list[str]   # human-readable problems, sorted
def main(argv: list[str] | None = None) -> int   # args: workflow dir, ruleset path; 1 if problems
```

Rules: (1) no workflow uses `pull_request_target`; (2) every workflow sets top-level `permissions`; (3) a workflow triggered by `pull_request` requests no `write` permission anywhere; (4) every required check is a job `name` in a workflow triggered by `pull_request`; (5) required jobs contain no `secrets.` reference.

- [ ] **Step 1: Write the failing tests**, one fixture directory per rule:

```python
def test_clean_workflows_pass(): assert check_workflows(FIX / "clean", {"ts"}) == []
def test_rejects_pull_request_target():
    assert check_workflows(FIX / "prt", set()) == ["prt.yml: uses pull_request_target"]
def test_requires_top_level_permissions():
    assert check_workflows(FIX / "noperms", set()) == ["noperms.yml: no top-level permissions"]
def test_rejects_write_on_pull_request():
    assert check_workflows(FIX / "prwrite", set()) == ["prwrite.yml: job build requests packages: write on pull_request"]
def test_required_check_must_exist_on_pull_request():
    assert check_workflows(FIX / "clean", {"ts", "lint"}) == ["required check 'lint' is not a pull_request job"]
def test_required_job_must_not_use_secrets():
    assert check_workflows(FIX / "secret", {"ts"}) == ["secret.yml: required job ts references secrets"]
def test_required_checks_read_from_ruleset():
    assert required_checks(REPO / ".github/rulesets/main.json") == {"ts", "py", "boundaries", "workflow-safety"}
```

- [ ] **Step 2:** Run `uv run pytest tools/tests/test_workflows.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement against PyYAML's `safe_load`. Note that YAML parses the key `on` as `True`; read it under both keys.
- [ ] **Step 4:** Run the tests, then `uv run cinewright-check-workflows .github/workflows .github/rulesets/main.json`. Expected: 7 passed; exit 0 on the repo.
- [ ] **Step 5:** Add job `workflow-safety` running that command to `checks.yml`, then commit: `git add -A && git commit -m "ci: workflow safety check and required-check ruleset"`.
- [ ] **Step 6:** With the maintainer's go-ahead, apply the ruleset: `gh api repos/<owner>/cinewright/rulesets -X POST --input .github/rulesets/main.json`. Open PR "M0.3 CI".
- [ ] **Step 7: Prove the gate.** Open a throwaway PR with a failing unit test, another with a Biome lint error, and another with a stale lockfile. Each shows its check failing and the merge button blocked. Link them, then close them unmerged. If a second account or an org exists, also open a fork PR and confirm the same required checks run with no secrets; otherwise record that `workflow-safety` covers this statically (see Deviation).
- [ ] **Step 8:** Merge after review.

## Task 6: Render image and pin check (PR M0.2, branch `m0.2-render-container`)

**Files:**
- Create: `container/pins.json`, `container/Dockerfile`, `container/README.md`
- Create: `container/render-runner/` (`package.json` with exact dependencies `hyperframes@0.9.41`, `@hyperframes/producer@0.9.41` and `gsap@3.15.1`; `src/versions.ts`; `test/versions.test.ts`)
- Create: `tools/src/cinewright_tools/pins.py`, `tools/tests/test_pins.py`
- Modify: `pnpm-workspace.yaml` (add `container/render-runner`), `tools/pyproject.toml` (scripts `cinewright-check-pins`, `cinewright-build-image`)

**Interfaces:**
- Produces: `container/pins.json`:

```json
{ "platform": "linux/amd64",
  "base_image": "node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0",
  "debian_snapshot": "<timestamp chosen in Step 3>",
  "apt": { "ffmpeg": "7:7.1.5-0+deb13u1", "libx264-164": "2:0.164.3108+git31e19f9-2",
           "python3.13": "3.13.5-2+deb13u5", "fonts-noto-core": "<resolved in Step 3>" },
  "chrome_headless_shell": "<build id from the locked puppeteer-core>" }
```

- Produces: `render-job --versions` prints JSON with the keys `node`, `hyperframes`, `gsap`, `ffmpeg`, `libx264`, `python`, `chrome_headless_shell` and `fonts-noto-core`. TS: `export async function reportVersions(): Promise<Record<string, string>>`.
- Produces:

```python
@dataclass(frozen=True)
class Pin:
    value: str
    source: str   # file the expected value came from

def expected_pins(repo_root: Path) -> dict[str, Pin]
def compare_pins(expected: Mapping[str, Pin], reported: Mapping[str, str]) -> list[str]
def main(argv: list[str] | None = None) -> int   # script cinewright-check-pins: --image REF; runs the image with --network none
def docker_build_args(repo_root: Path) -> list[str]   # ["--build-arg", "BASE_IMAGE=…", …] from pins.json, plus INPUTS_HASH (Task 7's inputs_hash)
def build_main(argv: list[str] | None = None) -> int  # script cinewright-build-image: --tag T [--push]; runs docker buildx with those args
```

- [ ] **Step 1: Write the failing tests:**

```python
def test_matching_pins_pass():
    assert compare_pins({"node": Pin("24.22.3", ".node-version")}, {"node": "24.22.3"}) == []
def test_mismatch_names_key_values_and_source():
    assert compare_pins({"node": Pin("24.22.3", ".node-version")}, {"node": "24.22.2"}) == [
        "node: expected 24.22.3 (from .node-version), image reports 24.22.2"]
def test_missing_key_is_reported():
    assert compare_pins({"gsap": Pin("3.15.1", "container/render-runner/package.json")}, {}) == [
        "gsap: expected 3.15.1 (from container/render-runner/package.json), image reports nothing"]
def test_build_args_come_from_pins(tmp_repo):
    args = docker_build_args(tmp_repo)
    assert "BASE_IMAGE=" + json.loads((tmp_repo / "container/pins.json").read_text())["base_image"] in args
    assert any(a.startswith("INPUTS_HASH=") for a in args)
def test_expected_pins_reads_repo_files():
    pins = expected_pins(REPO)
    assert pins["node"] == Pin("24.22.3", ".node-version")
    assert pins["hyperframes"] == Pin("0.9.41", "container/render-runner/package.json")
    assert pins["ffmpeg"].source == "container/pins.json"
```

  In `test/versions.test.ts`, test that `reportVersions()` returns `hyperframes` equal to the installed package's version (it is runnable on the host for that key).
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3: Resolve the open values.** Choose the latest snapshot.debian.org timestamp whose trixie and trixie-security indexes carry the four exact apt versions, and resolve `fonts-noto-core`'s version at it. Read the chrome-headless-shell build id from the installed `puppeteer-core` revisions module. Write them into `pins.json`.
- [ ] **Step 4: Write the Dockerfile.** `FROM --platform=linux/amd64 <base_image>`; point apt at the snapshot (with `Acquire::Check-Valid-Until=false`); install the exact apt versions; install pnpm from `packageManager`; `pnpm install --frozen-lockfile --filter @cinewright/render-runner...`; install chrome-headless-shell at the pinned build id to `/opt/chrome-headless-shell`; copy GSAP's minified file to `/opt/cinewright/vendor/`. Set `ENV HYPERFRAMES_BROWSER_PATH=...`, `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, `HYPERFRAMES_NO_PREVIEW_DISCOVERY=1`, `ENTRYPOINT ["render-job"]`, and `LABEL org.cinewright.inputs-hash=$INPUTS_HASH` (a build arg). Every value arrives as a build arg from `docker_build_args`; none are typed into the Dockerfile.
- [ ] **Step 5:** Implement `pins.py` and `versions.ts`. Run the tests. Expected: PASS.
- [ ] **Step 6:** Build locally with `uv run cinewright-build-image --tag cinewright-render:dev`, then run `uv run cinewright-check-pins --image cinewright-render:dev`. Expected: exit 0. Then change `.node-version` to `24.22.2` and rerun. Expected: exit 1 with the node line naming `.node-version`. Revert.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "build: pinned render image and pin check"`.

## Task 7: Render job and host runner (PR M0.2)

**Files:**
- Create: `container/render-runner/render-settings.json`, `src/settings.ts`, `src/cli.ts`, `src/render.ts`, `test/cli.test.ts`
- Create: `container/fixtures/hello-world/index.html`
- Create: `tools/src/cinewright_tools/container.py`, `tools/tests/test_container.py`, `tools/tests/conftest.py`
- Modify: `tools/pyproject.toml` (script `cinewright-render-in-container`; pytest marker `container`)

**Interfaces:**
- Produces: `render-settings.json` = `{ "workers": 1, "browser_gpu": false, "best_effort": false, "strict": true, "frame_format": "png", "encode": "hyperframes", "encoder": { "codec": "libx264", "pix_fmt": "yuv420p", "preset": "medium", "crf": 18, "keyint": 30, "closed_gop": true, "threads": 1 }, "low_memory_mode": false }`. The encoder values are test settings until delivery profiles own them (M5.3). `encode` is `"hyperframes"` or `"ffmpeg"`, and Task 9 sets the default.
- Produces, in TS:

```ts
export type Format = "mp4" | "png-sequence";
export interface RenderArgs { input: string; output: string; format: Format }
export class UsageError extends Error {}
export function parseArgs(argv: readonly string[]): RenderArgs | { versions: true }   // throws UsageError
export function loadSettings(path: string): RenderSettings                             // throws on unknown keys
export async function render(args: RenderArgs, settings: RenderSettings): Promise<number>
```

  Exit codes: 0 ok, 2 usage or input error, 3 blocked network request (Task 8), 4 render failure. Outputs in `--out`: `output.mp4` (or `frames/000001.png`…), `framemd5.txt` (from `ffmpeg -f framemd5`), `sha256.txt` (of `output.mp4`, or of the frame files in order) and `render-log.jsonl`. The render copies `--in` to a work directory, adds `vendor/gsap.min.js`, and calls `@hyperframes/producer`'s `createRenderJob`/`executeRenderJob` with every setting passed explicitly.
- Produces, in Python:

```python
@dataclass(frozen=True)
class RenderResult:
    exit_code: int
    out_dir: Path
    framemd5: str | None
    sha256: str | None
    stderr: str

def inputs_hash(repo_root: Path) -> str
def run_render(image: str, composition: Path, out_dir: Path, fmt: str = "mp4") -> RenderResult
def main(argv: list[str] | None = None) -> int   # script: cinewright-render-in-container
```

  `run_render` runs `docker run --rm --network none --platform linux/amd64 -v <composition>:/job/in:ro -v <out_dir>:/job/out <image> --in /job/in --out /job/out --format <fmt>`, passing every argument as a list element (never through a shell). `inputs_hash` is the SHA-256 over sorted `(relative path, sha256 of bytes)` pairs for `container/Dockerfile`, `container/pins.json`, `container/render-runner/**` (excluding `node_modules`, `dist`, `test`), `pnpm-lock.yaml` and `.node-version`.
- Hello-world fixture: a composition with `data-composition-id="hello"`, 1280×720, 30 fps, 2 s, one text element and one box. It loads `vendor/gsap.min.js` by relative path and registers a paused timeline as `window.__timelines["hello"]`.

- [ ] **Step 1: Write the failing TS tests:** `parseArgs(["--in","a","--out","b"])` gives `{input:"a",output:"b",format:"mp4"}`; `parseArgs(["--versions"])` gives `{versions:true}`; a missing `--out` throws `UsageError`; `loadSettings` rejects a file with an unknown key.
- [ ] **Step 2: Write the failing Python tests.** Docker-dependent tests are marked `container` and run only when `CINEWRIGHT_CONTAINER_TESTS=1`. `tools/tests/conftest.py` provides `image` (from `CINEWRIGHT_IMAGE`, default `cinewright-render:dev`), `tmp_repo` (a temporary copy of the container inputs) and `fake_docker` (stubs `shutil.which` and `subprocess.run`).

```python
def test_inputs_hash_is_stable_and_sensitive(tmp_repo):
    h = inputs_hash(tmp_repo); assert h == inputs_hash(tmp_repo)
    (tmp_repo / "container/pins.json").write_text("{}\n"); assert inputs_hash(tmp_repo) != h
def test_missing_docker_exits_2(monkeypatch, capsys):
    monkeypatch.setattr(shutil, "which", lambda _: None)
    assert main(["--image", "x", "--in", ".", "--out", "o"]) == 2
    assert "Docker is not available" in capsys.readouterr().err
def test_non_amd64_host_warns(monkeypatch, capsys, fake_docker):
    monkeypatch.setattr(platform, "machine", lambda: "arm64")
    main(["--image", "x", "--in", ".", "--out", "o"])
    assert "not a baseline" in capsys.readouterr().err
@pytest.mark.container
def test_hello_world_is_deterministic(image, tmp_path):
    a = run_render(image, HELLO, tmp_path / "a"); b = run_render(image, HELLO, tmp_path / "b")
    assert a.exit_code == b.exit_code == 0
    assert a.framemd5 == b.framemd5 and a.sha256 == b.sha256
@pytest.mark.container
def test_path_with_spaces_and_non_ascii(image, tmp_path):
    odd = tmp_path / "hello world é"; shutil.copytree(HELLO, odd)
    assert run_render(image, odd, tmp_path / "o").framemd5 == run_render(image, HELLO, tmp_path / "p").framemd5
```

- [ ] **Step 3:** Run `pnpm --filter @cinewright/render-runner test` and `uv run pytest tools/tests/test_container.py`. Expected: FAIL.
- [ ] **Step 4:** Implement `settings.ts`, `cli.ts`, `render.ts` and `container.py`. For the frame-capture and encode options, check each against the HyperFrames producer docs for 0.9.41, and record the mapping from `render-settings.json` keys to producer options in `container/README.md`.
- [ ] **Step 5:** Rebuild the image, then run `CINEWRIGHT_CONTAINER_TESTS=1 uv run pytest tools/tests/test_container.py -v`. Expected: all pass. On Apple Silicon this runs under emulation: it proves behaviour, not baselines.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat: render-job entry point and host runner"`.

## Task 8: Blocked network requests fail the render (PR M0.2)

**Files:**
- Create: `container/fixtures/remote-url/index.html` (hello world plus `<img src="https://example.com/cinewright-network-probe.png">`)
- Modify: `container/render-runner/src/render.ts`, `tools/tests/test_container.py`

- [ ] **Step 1: Write the failing test:**

```python
@pytest.mark.container
def test_remote_url_fails_and_names_it(image, tmp_path):
    r = run_render(image, REMOTE, tmp_path / "o")
    assert r.exit_code == 3
    assert "blocked network request: https://example.com/cinewright-network-probe.png" in r.stderr
```

- [ ] **Step 2:** Run it. Expected: FAIL (wrong exit code or message).
- [ ] **Step 3:** Find out how HyperFrames 0.9.41 reports a failed resource under `--strict` and with best-effort off (its error output, or a `hyperframes check` pass before rendering). Make `render.ts` map that to exit 3 and the message above. If HyperFrames reports no URL, collect failed requests from the producer's log stream.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: fail renders that request the network"`.

## Task 9: Encoding spike (PR M0.2)

Decides whether HyperFrames' own MP4 encode meets D33 and M5.1, or whether the runner renders a PNG sequence and encodes with the pinned FFmpeg.

- [ ] **Step 1:** Run the hello world 3 times with `encode: "hyperframes"` and 3 times with `encode: "ffmpeg"` (PNG sequence plus `ffmpeg` with the `encoder` settings, `-flags +cgop`, `-fflags +bitexact`, `-map_metadata -1`), on the CI amd64 runner (a temporary `workflow_dispatch` job) and locally. Record `framemd5` and `sha256` for each run.
- [ ] **Step 2:** Check that the output's GOPs are closed and its keyframe interval matches `keyint` (`ffprobe -show_frames`). M5.1 concatenates without re-encoding, so this must hold.
- [ ] **Step 3: Decide.** Use `hyperframes` if its runs are byte-identical and its GOPs are closed; otherwise `ffmpeg`. If neither is byte-identical on one runner, stop and raise it (D33). Set `render-settings.json` `encode` accordingly.
- [ ] **Step 4:** Write the results table and the decision into `container/README.md` §Determinism and into the PR description. Remove the temporary job.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "docs: encoding spike result"`.

## Task 10: Render CI and the image digest (PR M0.2)

**Files:**
- Create: `.github/workflows/render-image.yml`, `.github/workflows/render-smoke.yml`, `container/image.lock.json` (`{ "image": "ghcr.io/<owner>/cinewright-render", "digest": null, "inputs_hash": null }` until the first publish)
- Create: `tools/src/cinewright_tools/image_lock.py`, `tools/tests/test_image_lock.py`
- Modify: `tools/pyproject.toml` (script `cinewright-check-image-lock`)

**Interfaces:**
- Produces:

```python
def check_image_lock(lock: Mapping[str, str | None], label_inputs_hash: str | None, tree_inputs_hash: str) -> list[str]
# script: cinewright-check-image-lock (pulls image@digest, reads its org.cinewright.inputs-hash label)
```

- `render-image.yml`: on `push` to `main` when container inputs change, and on `workflow_dispatch`. It runs `cinewright-build-image --push`, pushes to GHCR (job permissions `packages: write`; never on `pull_request`), and writes the digest and inputs hash to the job summary.
- `render-smoke.yml`: on `pull_request` and `push` to `main`, with path filters for `container/**`, `.node-version`, `pnpm-lock.yaml` and the workflow file (M3 adds the HyperFrames backend package's path). If the tree's inputs hash equals the lock's, it pulls the locked digest; otherwise it builds without pushing. Jobs `smoke-a` and `smoke-b` each run on a separate `ubuntu-24.04` runner and do three things: run the pin check, run the hello world twice, and run the remote-URL test. Each uploads its hashes plus the CPU model and flags (`/proc/cpuinfo`). Job `smoke-compare` fails if the hashes differ across runners, printing both CPU descriptions. Job `image-lock` runs `cinewright-check-image-lock` when `image.lock.json` is set.

- [ ] **Step 1: Write the failing tests:**

```python
def test_unpublished_lock_is_allowed(): assert check_image_lock({"digest": None, "inputs_hash": None}, None, "h1") == []
def test_lock_matches_label_and_tree(): assert check_image_lock({"digest": "sha256:a", "inputs_hash": "h1"}, "h1", "h1") == []
def test_label_mismatch(): assert check_image_lock({"digest": "sha256:a", "inputs_hash": "h1"}, "h2", "h1") == [
    "image sha256:a was built from inputs h2, lock says h1"]
def test_stale_lock(): assert check_image_lock({"digest": "sha256:a", "inputs_hash": "h1"}, "h1", "h3") == [
    "container inputs changed (h3) since the locked image (h1): publish and update container/image.lock.json"]
```

- [ ] **Step 2:** Run `uv run pytest tools/tests/test_image_lock.py`. Expected: FAIL. Implement it, then run again. Expected: PASS.
- [ ] **Step 3:** Write the two workflows with SHA-pinned actions. Run `cinewright-check-workflows`. Expected: exit 0.
- [ ] **Step 4:** With the maintainer's go-ahead, push and open PR "M0.2 Render container". Expected: `smoke-a`, `smoke-b` and `smoke-compare` pass on a locally built image. If `smoke-compare` fails only because the runners' CPU flags differ, stop and raise it: the runner class may need a CPU feature level (D33).
- [ ] **Step 5:** After merge, `render-image.yml` publishes. Open a follow-up PR that writes the digest and inputs hash from the job summary into `image.lock.json`. Expected: `image-lock` passes, and the smoke jobs now use the published digest.
- [ ] **Step 6:** Commit and merge after review: `git commit -m "ci: render image publish, smoke test and digest lock"`.

---

## Done when (M0 AC map)

| M0 acceptance criterion | Proven by |
| --- | --- |
| M0.1: clean-checkout install and tests pass locally and in CI, one placeholder test each | Tasks 1, 2 and 4 |
| M0.1: lint and format checks for both languages; a stale lockfile fails CI; the import-boundary check catches `bpy` and personal fixtures | Tasks 1–4 (Task 4 Step 4) |
| M0.2: CI builds and pushes; the recorded digest matches | Task 10 |
| M0.2: every pinned version is printed from inside the image and compared | Task 6 |
| M0.2: two runs, then a second machine of the same runner class, give identical `framemd5` and bytes | Tasks 7, 9 and 10 |
| M0.2: a remote URL fails with a non-zero exit naming the URL | Task 8 |
| M0.2: the encoding spike is recorded | Task 9 |
| M0.3: a failing test, a lint error or a stale lockfile cannot merge | Task 5 Step 7 |
| M0.3: fork PRs run the same checks without secrets | Task 5 (statically; see Deviation) |

## Machine prerequisites

This Mac has git and gh but not Node, pnpm, uv or Docker. Executing this plan needs:
- Node 24.22.3, through a version manager that reads `.node-version` (fnm or mise).
- pnpm through `npm install -g pnpm@12.18.0`.
- uv 0.13.8.
- A Docker runtime with amd64 emulation (Docker Desktop or OrbStack) for Tasks 6–9. Without one, those tasks iterate through CI only.
