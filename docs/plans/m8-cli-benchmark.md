# M8 — CLI and Benchmark v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-20. Written 2026-11-20. It needs `docs/plans/m7-engine-agents.md` and `docs/plans/m6-2-3-vision-fix-loop.md`. M8.3a (the tier A harness) is in `docs/plans/alpha-gate.md`. Four maintainer decisions are due here: 10 (who writes the briefs), 11 (evaluation budget and cadence), 13 (split v0.3, migrations in v0.2) and 15 (name, organisation, scope, if not already settled at the alpha gate).

**Goal:** Finish v0.1 and prove it:
- the remaining commands, so a person or an agent can run, review, inspect and export a project without touching a file;
- the v0.1 benchmark: at least 8 neutral briefs and a rule for growing tier A;
- a tier B harness that runs briefs through live agents and providers, capped, and reports per brief;
- a place for personal fixtures that can never gate;
- a documented setup that CI proves on a bare machine;
- the exit gate check, run and recorded.

**Architecture:**
- **The CLI stays a thin shell.** Each command parses flags, calls one engine or core function, prints text or JSON, and returns a documented exit code. No command holds logic an SDK caller would need to repeat.
- **Briefs are data.** `fixtures/benchmark/tier-b/<id>/brief.json` validates against a schema; a brief becomes a project by `init` plus one `user` patch, the same way a person would start.
- **The harness is the Python `eval` package** from the alpha gate, extended. It drives the CLI as a subprocess and never imports engine code.
- **CI:** `tier-b.yml` runs on a schedule and on a maintainer trigger, with secrets, never on pull requests. `setup.yml` runs the documented setup on a bare runner.

**Tech Stack:** no new dependency.

**Spec:**
- `docs/V0_1_PLAN.md`: §M8, §Exit gate, §Observability and testing, §Environment and secrets, §Gates and autonomy presets.
- `docs/plans/roadmap-audit-2026-11-16.md`: §3.4 (cost), §4 M8 table and exit gate, §5, §6, §7 decisions 10, 11, 13 and 15.
- `docs/plans/audit-m3-m4-plan-2026-11-16.md`: G10, G24.
- `docs/DESIGN_SPEC.md`: §Interfaces (CLI row), §Eval harness, D17, D20, D24, D33, D36, D38, D39, D41; `AGENTS.md` §2, §4.

## Decisions this plan makes

| Choice | Value | Why, and the cost if wrong |
| --- | --- | --- |
| **Decision 10: who writes the briefs (maintainer)** | **Recommendation:** someone other than the maintainer writes them: a contributor, or an agent session given only `AGENTS.md` §4.1 and the coverage matrix below. The maintainer reviews for neutrality and coverage, not for taste, and the author and review are recorded in each brief's README. Start at the alpha gate: this is content with a long lead time and no code dependency. | D24 and §4.2: personal preference must not define the bar. Cost if the maintainer writes them anyway: the benchmark measures one person's idea of a good brief; D20's later rating panel would expose it. |
| **Decision 11: budget and cadence (maintainer)** | **Recommendation:** a monthly evaluation cap in USD held as a repository variable and enforced by the harness, with two modes.<ul><li>**Nightly:** 1 run per brief, local media providers (Kokoro, library music), live LLM.</li><li>**Release:** 3 runs per brief with the paid media providers, plus the pack-swap runs; on a maintainer trigger and before a tag.</li></ul>Set the figure after Task 4 Step 1 measures the real cost of one brief; until then no nightly schedule is enabled. | No cost figure exists (roadmap audit §3.4). The exit gate needs 3 runs per brief once, not nightly. Cost if wrong: either an unbounded bill or a baseline too thin to judge variance. |
| **Decision 13: v0.3 split and migrations (maintainer)** | **Recommendation: yes to both**, recorded in the spec's roadmap at the exit gate: v0.3a pre-production, v0.3b Blender; schema versioning and migrations first in v0.2. | `docs/plans/completion-roadmap.md` §After v0.1. v0.1 adds only optional fields because no migration exists; v0.2 cannot keep that up. |
| **Decision 15: name, organisation, scope (maintainer)** | Due at the alpha gate if the repository goes public there (see `alpha-gate.md`); otherwise here, before the exit gate is declared. | Nothing is published in v0.1, but every baseline records an image reference. |
| Brief format | `brief.json`: `{ id; genre: "explainer" \| "ad"; target_seconds: 15 \| 30 \| 60; deliverables: string[] (profile names); pack: string; brief: string; narrator: { language; description }; notes?: string; author; reviewed_by }`. `fixtures/benchmark/tier-b/index.json` lists them. | The harness needs the matrix as data to report per category. |
| Coverage for v0.1 | At least 8 briefs: explainer and ad, each at 15, 30 and 60 seconds (6 cells), with both aspect ratios across the set, at least 2 briefs requesting both, 4 briefs on each pack, and different subjects and tones. English only in v0.1. | `V0_1_PLAN.md` §M8.2. Languages, cast sizes and other genres belong to later releases (`AGENTS.md` §4.1). |
| "The same briefs pass under both packs" | Each brief has a home pack, set as a `user` value so the Producer cannot change it, and gets the 3 release runs there. The **pack-swap matrix** adds 1 run per brief under the other pack. Passing means every one of the 8 × 3 + 8 × 1 = 32 runs ends with a deliverable that passes every deterministic check, with the IR's only forced difference being `style.pack`. | The exit gate says "the same briefs pass under both v0.1 packs"; §M8.2 says briefs are "split across both packs". Running all 8 three times under both packs doubles the cost to prove the same thing. Cost if wrong: 16 more runs. |
| What "local-only run" means | Media providers are local (Kokoro, library music, no stock). The agents still need an LLM plugin with a key, unless the preset is `manual` or every role is `human`. The fully keyless path is tested with a Manual project and with cassettes. | The exit gate asks for a local-only run on a clean machine; v0.1 ships one LLM plugin and no local model. Saying so avoids a promise the code cannot keep. A second, OpenAI-compatible LLM plugin is the v0.2 item that makes a keyless agent run possible and tests invariant 6. |
| Command surface | `plan`, `render`, `review`, `export`, `status`, `tasks`, `log` (signatures in Task 1). The M3 and M4 developer commands are listed under "developer commands" in the README. | The spec's CLI row. `plan`, `render`, `review` and `tasks` already exist from M7; this task completes and documents them. |
| Exit codes | 0 ok · 1 internal · 2 usage · 3 invalid · 4 conflict · 5 blocked · 6 load · 7 lock · 8 render · 9 provider · 10 findings · 11 paused (gate or human task) · 12 budget. | Agents branch on them. 9 to 12 come from M4, M6.1 and M7. |
| Export | `cinewright export [--deliverable <id>]… --to <dir>` copies the MP4, sidecars and manifest of the current revision. It refuses (exit 10) while an error finding is open and always on `clearance.*`. It re-renders nothing: if the deliverable for the current revision is not in the cache it says to run `render`. | "The render gate blocks uncleared assets." |
| Asset pruning | `cinewright assets prune [--dry-run]` removes take and music assets that no line or sequence selects and whose key is stale, as a `user` patch. | G24, due with the first long agent runs, which re-take freely. |
| Where tier B results live | Each run's report is a workflow artifact. A release run's summary is committed as `fixtures/benchmark/baselines/<tag>.json` by a normal PR. No bot pushes to the repository. | "Stored per commit" without giving a workflow write access. |
| Growing tier A | `cinewright-eval snapshot <run dir> --as <fixture id>` freezes a tier B run that passed every check: the project, its patch log, and its assets exported for the CAS remote. Review is a normal PR; the maintainer uploads the assets. At least 2 snapshots (one per pack, one of them an ad) join tier A before the exit gate. | §M8.2: tier A grows from good tier B runs. |
| Clean machine | A fresh `ubuntu-24.04` hosted runner with Docker and nothing else preinstalled by us. The job runs the commands in `docs/SETUP.md` exactly as written, extracted from its code blocks, so the document cannot drift. `linux/amd64` is the supported runner class; arm64 hosts run the amd64 image under emulation and are documented as such. | M8.5. A setup guide that CI does not run is wrong within a month. |
| Renderer facts from the image | `resolveRenderer` reads the HyperFrames version and render settings from `render-job --versions` in the image, not from the repository's `container/render-runner/`. | G10: an installed CLI has no such folder. |

## Global Constraints

- **Neutrality:** nothing under `fixtures/benchmark/` is derived from `fixtures/personal/`; no brief names a look that only one pack could meet, and none is written to flatter a pack.
- **Tier B never runs on a pull request or a fork**, and never without a cap. The harness stops starting runs when the monthly or per-night cap would be crossed, and reports what it skipped as skipped, not passed.
- **Per category, never the average** (D36): a regression in one brief, one pack or one aspect ratio is reported on its own line and fails the release check.
- **Secrets** come only from the workflow's environment and appear in no report, artifact or log.
- **Every command has `--json`,** stable field names, and an exit code from the table. A change to either is a documented breaking change.
- **D41:** `review approve`, `patch approve`, `patch revert` and `review waive` act as the user. No harness passes them automatically except the tier B `--approve-final` flag.
- **Git:** commits end with the harness trailer. Pushing, opening PRs, tagging and merging need the maintainer's go-ahead.

## Review Focus

1. **An agent can drive the whole thing blind.** A scripted session using only `--json` output and exit codes takes a brief from `init` through `plan`, a script-gate edit, `review approve`, `render`, the final gate and `export`, never reading a project file. Test: Task 1.
2. **Export refuses what it should.** With an open error finding, or an asset with no licence under `require_commercial_license`, `export` exits 10 naming the finding and writes nothing; after the finding is resolved it writes the same bytes `render --out` did. Test: Task 1.
3. **The cap holds across a night.** With a cap that covers two and a half briefs, the harness completes two, skips the rest as skipped, exits non-zero for the release mode and zero for the nightly mode, and the total recorded spend is under the cap. Test: Task 4.
4. **A clean machine with no keys.** On the bare runner, the documented setup renders the tier A fixture and runs a Manual project from `init` to `export` with no provider key set; a cassette-driven Auto brief also completes. Test: Task 5.
5. **Personal fixtures cannot gate or leak.** A file under `fixtures/personal/` is ignored by tier A and tier B unless `--suite personal` is given; that suite cannot update a baseline; an import of it from any package fails the boundary check. Test: Task 3.

---

## Tasks

PR order: Tasks 1, 2 and 3 in any order (Task 2's brief writing starts at the alpha gate). Task 4 needs Task 2 and the fix loop (M6.3b). Task 5 needs Task 1. Task 6 is the exit gate check. Each task is one PR.

### Task 1: The remaining commands (PR M8.1)

**Files:** `cli/src/commands/{plan,render,review,export,status,tasks,log,assets}.ts`, `cli/src/main.ts`, `cli/src/exit-codes.ts`, `cli/README.md`, `cli/test/{session,export,status,log}.test.ts`, `engine/src/export.ts`, `engine/src/status.ts`, `engine/src/assets/prune.ts`.

**Interfaces:**
- `cinewright plan [--project <dir>] [--json]`: start or resume to the storyboard gate.
- `cinewright render [--deliverable <id>]… [--jobs-only] [--until <step>] [--retake <line>] [--approve-final] [--out <dir>] [--no-critics] [--json]`.
- `cinewright review [--json]` · `review approve <gate>` · `review reject <gate> --note <text>` · `review variants <gate> --entity <id> [--n <n>]` · `review choose <variant>` · `review budget --cap <usd>` · `review waive <finding> --note <text>`.
- `cinewright export [--deliverable <id>]… --to <dir> [--json]`.
- `cinewright status [--json]`: `{ revision, state_hash, pending, run?: { id, phase, outcome, pause? }, tasks: { ready, running, human }, findings: { error, warning, escalated }, cost: { spent_usd, reserved_usd, cap_usd, estimate_to_complete_usd } }`. The first three fields are unchanged from M1.
- `cinewright tasks [--json]` · `tasks show <id>` · `tasks submit <id> --file <output.json>`.
- `cinewright log [--decisions | --patches | --events | --spend | --findings] [--entity <id>] [--run <id>] [--limit <n>] [--json]`.
- `cinewright assets prune [--dry-run] [--json]`.
- Engine: `exportDeliverables(store, { deliverables?, to }): Promise<ExportResult>`; `projectStatus(store): Status`.

- [ ] **Step 1: Write the failing tests** with stub agents and stub providers.
  - **Blind session (Review Focus 1).**
  - **Export (Review Focus 2).**
  - **Status:** matches the run's phase and pause at each gate; with no run, the run fields are absent and the M1 fields unchanged.
  - **Log:** `--decisions --entity <shot>` lists that shot's decisions with citations; `--spend` sums to `status`'s spent; `--findings` shows open and escalated findings.
  - **Exit codes:** one test per code in the table, each asserting the code and that stderr names the cause.
  - **JSON:** every command's `--json` output validates against a schema in `cli/schema/`.
  - **Prune:** an unselected stale take is removed, a selected one and a user-inserted one are kept; `--dry-run` changes nothing.
  - **Help:** `--help` lists every command, and the README's command block equals it (a test compares them).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Record one trial of a coding agent taking the development brief from a prose request to an exported film using only the CLI, as M1.9 did; attach it to the PR.
- [ ] **Step 4: Commit.**

### Task 2: Benchmark v0 briefs and the snapshot tool (PR M8.2)

**Files:** `fixtures/benchmark/tier-b/{index.json,<id>/{brief.json,README.md}}` (at least 8), `fixtures/benchmark/schema/brief.schema.json`, `fixtures/benchmark/README.md` (coverage matrix), `eval/src/cinewright_eval/{briefs,snapshot}.py`, `eval/tests/…`.

**Interfaces:**
- `cinewright-eval briefs check`: validates every brief and the coverage rules, and prints the matrix.
- `cinewright-eval briefs init <id> --to <dir> [--pack <id>]`: `cinewright init` with the brief's deliverables, then one `user` patch setting the brief, the narrator, `style.pack` and the Auto preset.
- `cinewright-eval snapshot <run dir> --as <fixture id>`.

- [ ] **Step 1: Obtain the briefs** (decision 10). Each README records the author, the reviewer and the neutrality review.
- [ ] **Step 2: Write the failing tests.**
  - Coverage: fewer than 8 briefs, a missing genre × length cell, fewer than 2 dual-aspect briefs, or an uneven pack split fails `briefs check`, naming the gap.
  - A brief whose text contains a pack id, a token name, a hex colour or a font name fails, naming it.
  - `briefs init` produces a project that validates, whose brief and pack are `user`, and which passes intake.
  - `snapshot` refuses a run with an open error finding; for a clean run it writes a fixture that `replay` accepts and lists its asset hashes.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `briefs check` runs in the `checks` workflow.
- [ ] **Step 5: Commit.**

### Task 3: Personal fixtures (PR M8.4)

**Files:** `fixtures/personal/README.md`, `fixtures/personal/.gitignore` (media and caches), `eval/src/cinewright_eval/suites.py`, `tools/src/cinewright_tools/boundaries.py` and its tests, `CONTRIBUTING.md`.

**Interfaces:** `--suite benchmark|personal` on `tier-a` and `tier-b`, default `benchmark`. A personal fixture has the same layout as a benchmark one.

- [ ] **Step 1: Write the failing tests (Review Focus 5):** the default suite never reads `fixtures/personal/`; `--suite personal` reports under a "personal, not gating" heading and exits 0 whatever the result; `--update-expected` and `baseline record` refuse the personal suite; the boundary check fails on an import or path reference to `fixtures/personal` from `core/`, `engine/`, `agents/`, `components/`, `plugins/`, `cli/`, `packs/` or `eval/src`; no workflow names the personal suite.
- [ ] **Step 2: Implement.** The README says what belongs there, that media is never committed, and that a change which only helps personal fixtures must still not regress the benchmark.
- [ ] **Step 3: Verify and commit.**

### Task 4: Tier B harness (PR M8.3b)

**Files:** `eval/src/cinewright_eval/{tier_b,budget,compare}.py`, `eval/tests/…`, `eval/README.md`, `.github/workflows/tier-b.yml`, `tools/src/cinewright_tools/workflows.py` (tier B must not trigger on pull requests).

**Interfaces:**
- `cinewright-eval tier-b --mode nightly|release [--brief <id>]… [--runs <n>] [--cap-usd <n>] [--month-cap-usd <n>] [--out <dir>]`.
- Per run: `briefs init`, `cinewright render --approve-final --json`, `cinewright export`, then collect `status`, the report, the event log, the spend log and the vision scores.
- Report `tier-b.json`: `{ commit, mode, pins: { critic_pin, model, role_versions, rubric_version, critics, hyperframes, images }, briefs: [{ id, genre, seconds, pack, runs: [{ pack, completed, manual_edits: 0, deterministic: { run, failed, by_rule }, vision: { <criterion>: score }, cost_usd, seconds, escalated, hashes }], deterministic_pass_rate, vision: { <criterion>: { mean, sd } }, cost_usd: { mean, max }, seconds: { mean, max } }], by_category: { genre, seconds, pack, aspect }, skipped: [id…], spent_usd }`.
- `cinewright-eval compare <report> --against <baseline>`: per category, the deterministic pass rate and each criterion's mean against the baseline threshold; exit 1 on any category regression.

- [ ] **Step 1: Measure one brief.** A single capped live run of one 30-second brief, recorded in the PR: tokens and cost per role, provider costs, wall time. This sets decision 11's figure and the per-run cap.
- [ ] **Step 2: Write the failing tests** with a stub CLI.
  - A run that paused at a human task or needed a patch counts `manual_edits > 0` and fails the brief.
  - Pass rates and vision statistics are computed per brief and per category; one failing category fails `compare` even when the average rises.
  - **Cap (Review Focus 3).**
  - Runs of one brief execute in parallel up to a limit, in separate project folders, and never share a cassette folder or cache.
  - The pack-swap run uses the other pack and is reported under it.
  - The workflow check fails if `tier-b.yml` gains a `pull_request` trigger.
  - A provider outage (every run `failed` with `provider_error`) is reported as "not evaluated", exit 2, distinct from a quality failure.
- [ ] **Step 3: Implement.** The workflow uploads the report and summary; the schedule stays commented out until decision 11 is answered.
- [ ] **Step 4: First release run** on a maintainer trigger. Fix what it finds through the owning milestone's code, not by loosening a check; list each fix in the PR.
- [ ] **Step 5: Commit.**

### Task 5: Clean-machine setup (PR M8.5)

**Files:** `docs/SETUP.md`, `README.md`, `tools/src/cinewright_tools/setup_doc.py` (extracts and runs the guide's code blocks) and its tests, `.github/workflows/setup.yml`, `plugins/backend-hyperframes/src/render.ts` (`resolveRenderer` from the image), `container/render-runner/src/versions.ts` (settings in `--versions`), `cli/src/commands/doctor.ts`.

**Interfaces:**
- `cinewright doctor [--json]`: Docker reachable; both images present at the locked digests (or how to pull them); Node and Python versions; plugins found, each with its secrets present or missing by name; the CAS remote reachable. Exit 0 when a keyless Manual render can work, 3 otherwise, naming what is missing.
- `render-job --versions` adds `settings` (the render settings) so `resolveRenderer(image)` needs no repository file.

- [ ] **Step 1: Write the failing tests.**
  - `resolveRenderer` gives the same `RendererInfo`, and so the same render keys, as before for the locked image (the tier A hashes do not move), and works from a folder with no `container/`.
  - `doctor` names a missing image, a missing key and an unreachable remote, each separately.
  - The setup-doc runner fails when a code block in `docs/SETUP.md` fails, and when the guide has no block for a required step.
- [ ] **Step 2: Write `docs/SETUP.md`:** prerequisites; clone, install and build; pull the images by digest; `doctor`; render the tier A fixture; a Manual project from `init` to `export`; then the keyed path (`ANTHROPIC_API_KEY`, optionally `ELEVENLABS_API_KEY`) with `plan` and `render`; the local-only definition; arm64 notes.
- [ ] **Step 3: The workflow (Review Focus 4):** a bare runner executes the guide's blocks; no secret is set; a cassette folder drives the Auto brief.
- [ ] **Step 4: Verify.** The image change is published and locked in a follow-up PR; tier A baselines are unchanged or re-recorded in that PR with the reason.
- [ ] **Step 5: Commit.**

### Task 6: The v0.1 exit gate check (one docs PR recording the result)

Run from a tag candidate on `main`. Record the output in this file's §Result and in `docs/V0_1_PLAN.md`.

- [ ] **The alpha gate has passed** (`alpha-gate.md` §Result).
- [ ] **Every tier B brief renders end to end in Auto with no manual edit, in each of 3 runs:** the release run's report shows `completed` and `manual_edits: 0` for all 24 home-pack runs.
- [ ] **100% of tier A and tier B renders pass the deterministic checks:** `tier-a.json` and `tier-b.json` show `failed: 0` for every rule, including the 8 pack-swap runs.
- [ ] **Determinism:** for every tier A fixture, two runs on two runners give identical `framemd5` and PCM hashes for every shot and deliverable, and byte-identical shot files on that runner class. For 2 tier B runs, re-rendering the final IR from an empty cache reproduces the delivered hashes.
- [ ] **Rubric baseline:** per brief and criterion, mean and standard deviation over the 3 runs, with the critic pin, model, role and rubric versions and the HyperFrames version, committed as `fixtures/benchmark/baselines/v0.1.json`.
- [ ] **Guided:** a run pauses at all three gates and resumes after approval, and the kill-and-resume suite passes in every phase (M7 Tasks 1, 2 and 7), once more against the real providers by cassette.
- [ ] **Both packs:** the pack-swap matrix passes; a diff of the two tier A fixture projects shows only the style reference; a grep finds no pack id in `core/`, `engine/`, `agents/` or `components/`.
- [ ] **Clean machine:** `setup.yml` is green on the tag candidate, including the keyless Manual run; one keyed local-only run (Kokoro, library music, no stock) of a brief from `init` to `export` is recorded by the maintainer.
- [ ] **Neutrality:** the five questions of `AGENTS.md` §2.3 answered for the release as a whole; the prompt and rubric lints pass; no core import of personal fixtures.
- [ ] **Decisions 13 and 15 recorded** in `docs/DESIGN_SPEC.md`; External facts refreshed; `docs/HANDOFF.md` updated for v0.2.

If any item fails, v0.1 is not done; fix forward in the owning milestone and re-run the item.

## Done when (M8 and exit gate acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| M8.1: `plan`, `review`, `export`, `status`, `tasks`, `log`; JSON output; documented exit codes | Task 1 |
| M8.2: at least 8 neutral briefs per the plan; no personal briefs; tier A grows from good tier B runs | Task 2; Task 4 Step 4 (snapshots) |
| M8.3a: tier A on every PR | `alpha-gate.md` Task 3 |
| M8.3b: nightly and on trigger; capped; per-brief pass rate, rubric mean and variance, cost and latency, stored per commit | Task 4 |
| M8.4: never imported by core; never gating | Task 3 |
| M8.5: the documented setup runs a brief from `init` to export on a fresh machine, including a local-only run; tested in CI on a bare runner | Task 5 (keyless Manual and cassette runs in CI; the keyed local-only run recorded at the gate) |
| Audit G10 and G24 | Tasks 5 and 1 |
| Exit gate, all eight items | Task 6 |

## Result

*To be filled in by Task 6.*
