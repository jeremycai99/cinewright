# Contributing to Cinewright

Read `AGENTS.md` first. It applies to human contributors and coding agents alike: the neutrality rule, the architecture invariants and the testing bar. `docs/HANDOFF.md` explains where the project stands.

## Toolchain

Every version is pinned in a tracked file. Install these exact versions:

| Tool | Version | Pinned in |
| --- | --- | --- |
| Node | 24.22.3 | `.node-version`, `package.json` `engines` |
| pnpm | 12.18.0 | `package.json` `packageManager` |
| Python | 3.13 | `.python-version` |
| uv | 0.13.8 | `pyproject.toml` `[tool.uv] required-version` |

A version manager that reads `.node-version` (fnm, mise) is the easiest way to get Node. Install pnpm with `npm install -g pnpm@12.18.0`.

## Checks

Run these before opening a PR. CI runs the same commands and they are required to merge.

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
uv sync --locked
uv run ruff check . && uv run ruff format --check . && pnpm exec pyright && uv run pytest
uv run cinewright-check-boundaries .
```

`pnpm format` and `uv run ruff format .` fix formatting.

## Pull requests

- One task from `docs/V0_1_PLAN.md` per PR, with that task's acceptance criteria as the PR checklist.
- If a change alters a decision, update the Decision log in `docs/DESIGN_SPEC.md` in the same PR.
- Answer the neutrality test in `AGENTS.md` §2.3 in the PR description.
- Never commit API keys, generated media or cloned-voice assets.

## Fixtures: benchmark and personal

`fixtures/benchmark/` is the neutral suite that gates merges and releases (AGENTS.md §4.1). `fixtures/personal/` is for your own briefs and looks: run it with `--suite personal`; it reports as "personal, not gating", always exits 0, cannot update expected hashes or record a baseline, and never holds media. No code may name it except `eval/src/cinewright_eval/suites.py`. A change that only helps personal fixtures must still not regress the benchmark.
