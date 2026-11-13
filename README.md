# Cinewright

An open-source, agent-driven production framework for professional video: multi-scene productions with a cast of narrators and characters, a style system, and a built-in quality loop.

**Status:** v0.1 in progress, starting with M0 (repository, CI and the render container). See `docs/HANDOFF.md`.

## Where things are

| Path | What it holds |
| --- | --- |
| `AGENTS.md` | Rules for contributors and coding agents (`CLAUDE.md` imports it) |
| `CONTRIBUTING.md` | Toolchain, checks and pull-request rules |
| `docs/` | `DESIGN_SPEC.md` (architecture and the binding decision log), `V0_1_PLAN.md` (milestone plan), `HANDOFF.md` (where the project stands) and `plans/` (detailed task plans per milestone) |
| `core/` | `@cinewright/core` (IR schema, store, patch engine) and `core/py/` (`cinewright-ir`, the Python models) |
| `cli/` | `@cinewright/cli`, the `cinewright` command |
| `plugins/` | Plugin SDKs: `sdk-ts/` and `sdk-py/`. First-party plugins arrive with their milestones |
| `container/` | The pinned render image: Dockerfile, pins, its `render-runner/` entry point and render fixtures |
| `tools/` | `cinewright-tools`: repository checks and the render-container runner (Python) |
| `.github/` | CI workflows and the branch ruleset |

Root files are tool configuration and pins: `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` (TypeScript workspace), `pyproject.toml` and `uv.lock` (Python workspace), `tsconfig*.json`, `biome.json`, `.node-version` and `.python-version`. Everything that `.gitignore` lists, such as `node_modules/`, `.venv`, `dist/` and `.cache/`, is local to your machine.

License: Apache-2.0 (the Blender backend plugin is GPL-3.0 and ships separately).
