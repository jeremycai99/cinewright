# v0.1-alpha Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-20. Written 2026-11-20. It follows `docs/plans/m5-assembly-delivery.md` and `docs/plans/m6-1-deterministic-critics.md`. Two maintainer decisions are due here: decision 9 (going public) and, pulled forward by this plan, decision 15 (name, organisation and scope).

**Goal:** Prove the walking skeleton with no agents, and turn that proof into the check every later PR must pass:
- frozen assets that any checkout, fork or CI job can fetch by hash, with no secret;
- the first tier A fixtures: one neutral explainer, both aspect ratios, both packs, built only through the CLI;
- a tier A harness that renders them on every PR and reports per-check pass rates;
- a written gate check, run once and recorded.

**Architecture:**
- **CAS remote.** The local CAS gains a read-only fallback: a list of URL templates, tried in order, each fetch verified against the hash before it is stored. The M1.7 interface was kept open for this (Open issue 7).
- **Fixtures** live in `fixtures/benchmark/tier-a/<fixture>/`: the project as the store wrote it (IR files and logs, in git), the patches that built it, and expected hashes per runner class. Media stays out of git: takes and music are in the remote, addressed by the hashes the IR records.
- **Harness.** `eval/` is a new Python package (D3). `cinewright-eval tier-a` drives the built CLI as a subprocess, compares results with the expected files and writes a JSON report and a Markdown summary. It imports no TypeScript and calls no provider.
- **CI.** One workflow, `tier-a.yml`, on every pull request and on `main`, with no secrets.

**Tech Stack:** Python 3.13 standard library plus the repo's existing tools package; `fetch` in Node for the remote. No new dependency.

**Spec:**
- `docs/V0_1_PLAN.md`: §v0.1-alpha gate, §M8.2 and §M8.3, Open issues 7 and 8, §Exit gate, M0.0 and M0.3 (private repository, ruleset not applied).
- `docs/plans/roadmap-audit-2026-11-16.md`: §3.3, §4 alpha gate table, §6, §7 decisions 2, 9, 10 and 15.
- `docs/DESIGN_SPEC.md`: D1, D24, D33, D36; `AGENTS.md` §2.3 item 4 and §4.

## Decisions this plan makes

| Choice | Value | Why, and the cost if wrong |
| --- | --- | --- |
| **Decision 9: go public or mirror (maintainer)** | **Recommendation: make the repository and both GHCR images public at this gate.** The alternative is a public mirror that holds only the images and the frozen assets while the source stays private. Until one is chosen, tier A runs on same-repository PRs only and is a written rule, not an enforced check. | `AGENTS.md` §4.2 and D36 require tier A on fork PRs. A fork can pull neither a private image nor private release assets, and GitHub Free applies no ruleset to a private repository (M0.3). Going public fixes all three at once. A mirror fixes the first two, leaves the ruleset unenforced, and adds a sync job that can drift. Cost of going public early: the name and history become visible before v0.1; see the next row and Task 0. |
| **Decision 15 pulled forward (maintainer)** | Decide the name, the GitHub organisation and the npm scope **with** decision 9, not at the v0.1 exit. | Going public publishes `jeremycai99/cinewright` and `ghcr.io/jeremycai99/cinewright-render`. The image reference is written into `container/image.lock.json`, the workflows and every tier A baseline; moving it later re-locks both images and re-records every baseline. The roadmap audit dated decision 15 at the exit gate before decision 9 made it visible. D1 says the name is a working name. |
| Remote layout | A URL template with `{hex}`, for example `https://…/releases/download/cas-v1/{hex}`: one flat file per asset, named by its sha256. Templates come from `CINEWRIGHT_CAS_REMOTE` (comma-separated). `https:` and `file:` only. | Release assets are a flat namespace, and a static file host or a bucket fits the same template. Nothing about the host is in code. |
| Remote trust | Bytes are hashed before they are written to the local CAS; a mismatch is `cas.remote_corrupt`, naming the hash and the remote, and nothing is stored. A response over the asset's recorded `bytes` is aborted. Redirects are followed only to `https:`. | The hash is the only trust needed (D33); the size cap stops a hostile remote filling the disk. |
| Who may write the remote | Nobody through the CLI. `cinewright-eval cas-export <project> --to <dir>` writes the flat files for the assets a project references; the maintainer uploads them. | A read-only remote needs no credential in any tool. |
| What is frozen | Kokoro takes (Apache-2.0 weights), their alignment words and transcripts, and one CC0 music bed per sequence. Target: under 5 MB per fixture. Each asset's licence and source are in the IR; the bed's source URL and CC0 statement are in the fixture README. | Open issue 7. No paid API and no licence that restricts redistribution. |
| Fixture set | Two projects from one brief and one script: `explainer_01_neutral` and `explainer_01_playful`. They differ only in `style.pack` and the pack pin. Each has two deliverables, `landscape_web` and `vertical_social`, both with burn-in captions on one and off the other so both paths run. Length: 30 to 45 seconds, at least 4 scenes, one cross-dissolve, one wipe, hard cuts, at least 5 of the 8 components. | The gate text: one explainer, both aspect ratios, both packs. "Switching packs needs no other change" is then a diff anyone can read. |
| Who writes the brief | Decision 10 applies already: the brief and script are neutral and not the maintainer's taste. **Recommendation:** an agent session drafts it from the genre list in `AGENTS.md` §4.1 on a topic with no personal link, and the maintainer reviews it for neutrality only. | D24. One brief cannot wait for the M8.2 authoring decision. |
| How "built only through the CLI" is checked | The fixture folder holds `build/` (the ordered patch files and a script that runs `init`, `patch apply`, `narrate`, `compose`). CI does not re-run narration. It replays the checked-in patch log from an empty project and requires the checked-in `state_hash`, and it requires every log entry's author to be `user`, `session` or a known job. | Kokoro output is frozen, not reproducible across architectures (M4 plan), so a rebuild cannot be byte-compared. Replay proves no file was hand-edited (M1 convention 12). |
| Resolution in tier A | **Full profile resolution**, with the render cache restored in CI by a key of the image digest and the fixtures' content. A cold run on `main` re-renders everything. Task 2 measures the cold time; if it is over 20 minutes on a hosted runner, add half-size benchmark profiles and record baselines for those instead. | The spec and the roadmap audit say "reduced resolution for speed". But a fixture's profile is pinned in the project (convention 16), safe areas and minimum text size depend on pixel size, and a second set of profiles would test something no user ships. Cost if wrong: a slow required check; the fallback is ready. |
| Expected results | `expected/<runner class>.json` per fixture: for each deliverable the `framemd5`, PCM hash and MP4 sha256, and the step keys. `expected/report.json`: zero error findings and the measured values. Only `linux/amd64` on a GitHub-hosted runner is recorded as a baseline. | D33 is per runner class. |
| What tier A fails on | Any error finding; any hash that differs from the baseline; a fixture that needs a network other than the CAS remote; a paid-provider plugin being called; a skipped fixture. Pass rates are reported per check and per fixture, never as one average. | `AGENTS.md` §4.2. |
| Baseline changes | A PR that changes a baseline must change `expected/` in the same PR and say why in its description; the harness prints the old and new values. | D36: a changed pin sets a new baseline rather than counting as a regression. |

## Global Constraints

- **No paid API and no secret** anywhere in tier A. The harness sets an environment with no provider keys and fails if a plugin with a non-empty `secrets` list is initialized.
- **Neutral content only.** Nothing in `fixtures/benchmark/` comes from `fixtures/personal/`, and no pack other than the two shipped ones is used.
- **No media in git.** Fixture folders hold JSON, patches and text only. A size check fails the PR if any file under `fixtures/benchmark/` exceeds 256 KB.
- **IR written only by the store** (D40). Fixture projects are never edited by hand; the replay check enforces it.
- **Determinism (D33):** expected hashes are exact; there is no tolerance.
- **Fork safety:** the workflow passes `cinewright-check-workflows` (no secrets, no `pull_request_target`).
- **Git:** commits end with the harness trailer. Pushing, opening PRs, publishing images or assets, and changing repository visibility need the maintainer's go-ahead.
- **Neutrality test item 4** applies to every PR after this gate.

## Review Focus

1. **A corrupted or oversized remote object.** A remote that returns other bytes for a hash fails with `cas.remote_corrupt` and stores nothing; the next remote in the list is then tried; a body longer than the asset's recorded size is cut off. Test: Task 1.
2. **A fixture nobody hand-edited.** Changing one character in a fixture's `cinewright.json` fails the replay check, naming the entity and field. Test: Task 2.
3. **Pack switch with no other change.** The two fixture projects' IR differs only at `style.pack` and `packs`; both render and pass every check in both aspect ratios. Test: Task 2.
4. **A regression that the average would hide.** One failing check in one deliverable of one fixture turns the job red and is named in the summary, whatever the other fixtures do. Test: Task 3.
5. **A one-shot edit.** On a copy of a fixture, a patch to one shot re-renders that shot and its adjacent segments only, and the other shots' files are byte-identical to before. Test: Task 3.

---

## Tasks

Order: Task 0 (maintainer, no PR) can start now. Task 1 needs nothing after M4.5a and can run during M4. Task 2 needs M5.4b, M6.1a–c, M4.1c (Kokoro) and Task 1. Task 3 needs Task 2. Task 4 is the gate check.

### Task 0: Decisions and housekeeping (maintainer, no PR)

- [ ] **Decide 9 and 15** (rows above). If the answer to 9 is "public": choose the organisation and names first, then transfer or rename, then re-lock both images under the final reference.
- [ ] **Before any visibility change:** scan the full history for secrets and personal media (`gitleaks` or equivalent, and a listing of every blob over 256 KB); confirm `fixtures/personal/` is empty or absent; confirm the licence headers and `NOTICES.md` of the audio image.
- [ ] **Move the checkout out of iCloud** (roadmap audit decision 2, still open): the working tree again holds duplicate files (` 2` to ` 5`) under `core/src`, `core/schema`, `cli/test` and `plugins/backend-hyperframes/src`.
- [ ] **Apply the ruleset** in `.github/rulesets/main.json` once the repository is public, and add `tier-a` to its required checks after Task 3 merges.

### Task 1: CAS remote (PR A.1)

**Files:** `core/src/cas/{cas,remote}.ts`, `core/src/index.ts`, `core/test/cas-remote.test.ts`, `cli/src/project.ts` (remotes from the environment), `cli/README.md`, `eval/{pyproject.toml,src/cinewright_eval/{__init__,cas_export}.py,tests/test_cas_export.py}`, root `pyproject.toml` (workspace member, `testpaths`).

**Interfaces:**
- `CasRemote = { name: string; fetch(hash: HashString, maxBytes: number): Promise<Uint8Array | null> }`.
- `httpRemote(template: string): CasRemote`; `remotesFromEnv(env): CasRemote[]`.
- `new Cas(projectDir, { remotes?: CasRemote[] })`. `get` and `has` are unchanged for local hits; on a local miss `get` tries each remote, verifies, stores, and returns. `CasMissingError` lists the remotes tried.
- `resolveAsset` passes the asset's `bytes` as the cap.
- `cinewright-eval cas-export <project> --to <dir>`: one file per referenced asset, named by hex; prints a manifest of hash, bytes and role.

- [ ] **Step 1: Write the failing tests.**
  - **Fetch and verify:** a local miss is served from a `file:` remote, stored, and local on the second call (the remote's call count stays 1).
  - **Corrupt and oversized (Review Focus 1).**
  - **Order:** the first remote returning `null` (404) falls through to the second; a network error on one remote is reported only if all fail.
  - **No remote configured:** behaviour and error text are as today.
  - **Schemes:** `http:` and any other scheme is rejected at configuration with the template named.
  - **No secret:** the request carries no header from the environment.
  - **Export:** the exported set is exactly the assets the IR references; re-export is idempotent.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Full suite; `uv run pytest` collects the new package.
- [ ] **Step 4: Commit.**

### Task 2: Alpha fixtures (PR A.2)

**Files:** `fixtures/benchmark/README.md`, `fixtures/benchmark/tier-a/explainer_01_{neutral,playful}/{README.md,brief.md,build/{build.sh,NN-*.json},project/{cinewright.json,sequences/…,log/…},expected/{linux-amd64.json,report.json}}`, `fixtures/benchmark/tier-a/index.json`, `eval/src/cinewright_eval/replay.py`, `tools/src/cinewright_tools/boundaries.py` (size check), `.gitignore` (fixture caches).

**Interfaces:**
- `index.json`: `{ fixtures: [{ id, path, genre, seconds, deliverables, pack, cas: [hash…] }] }`.
- `cinewright-eval replay <fixture>`: rebuilds the project from `log/patches.jsonl` in a temporary folder and compares `state_hash` and stored bytes with `project/`.

- [ ] **Step 1: Write the brief and script** (decision 10 row). Record the brief, its author and the review in the fixture README.
- [ ] **Step 2: Write the failing checks.** `replay` on both fixtures; the two projects' IR differs only at `/style/pack` and `/packs` (Review Focus 3); a tampered copy fails (Review Focus 2); every referenced asset hash is listed in `index.json`; no file over 256 KB.
- [ ] **Step 3: Build the neutral fixture** with `build.sh`: `init`, the patches, `narrate --provider tts_kokoro`, `compose` from a library holding the CC0 bed. Copy the result into `project/`. Build the playful one from the same patches with `--pack playful`, **reusing the same takes** (the take key does not depend on the pack).
- [ ] **Step 4: Render both** with `cinewright render --out`. Fix any error finding by changing the fixture's patches, never a threshold. Watch each deliverable through once; note anything a critic should have caught and did not as an issue for M6.2 or M6.3, not as a hand fix.
- [ ] **Step 5: Export and publish assets.** `cas-export`, then the maintainer uploads to the remote chosen in Task 0. From a clean clone with only `CINEWRIGHT_CAS_REMOTE` set, `render` succeeds.
- [ ] **Step 6: Measure.** Record the cold and warm render times on a hosted runner in the README and decide the resolution row. Record `expected/linux-amd64.json` from two CI runs on two runners that agree.
- [ ] **Step 7: Commit.**

### Task 3: Tier A harness as a check (PR M8.3a)

**Files:** `eval/src/cinewright_eval/{tier_a,report,env}.py`, `eval/tests/…`, `eval/README.md`, `.github/workflows/tier-a.yml`, `.github/rulesets/main.json` (`tier-a`), `CONTRIBUTING.md` and `AGENTS.md` §2.3 (item 4 now applies), `docs/V0_1_PLAN.md`.

**Interfaces:**
- `cinewright-eval tier-a [--fixture <id>]… [--runner-class linux-amd64] [--out <dir>] [--update-expected]` → exit 0 when every fixture passes, 1 otherwise.
- Report `tier-a.json`: `{ commit, runner_class, image: { render, audio }, critics: [{ id, version, settings_hash }], hyperframes, fixtures: [{ id, deliverables: [{ id, hashes, expected, match }], checks: { <rule>: { run, failed } }, findings, steps: { hit, miss }, seconds }] }`.
- Summary `tier-a.md`: one row per fixture × deliverable, one row per rule with its pass rate, and every failure by name.

- [ ] **Step 1: Write the failing tests** (with a stub CLI that returns canned reports).
  - A passing run exits 0 and lists every rule with `failed: 0`.
  - **One failure (Review Focus 4):** exit 1, the rule, fixture and deliverable named first in the summary.
  - A hash mismatch prints expected and actual and exits 1; `--update-expected` rewrites the file and exits 0.
  - A fixture missing from disk, or skipped, exits 1.
  - A provider key in the environment is removed before the CLI starts; a plugin with secrets being initialized fails the run.
  - **One-shot edit (Review Focus 5):** against the real CLI in the container job.
- [ ] **Step 2: Implement.** The workflow: restore the render cache, run `replay` on every fixture, run `tier-a`, upload the report, write the summary to the job summary. A second job on `main` runs with an empty cache.
- [ ] **Step 3: Verify.** A throwaway PR that lengthens one fixture title until it overflows turns `tier-a` red with the finding named; a throwaway PR that changes one easing token turns it red on hashes only. Record both runs in the PR.
- [ ] **Step 4: Commit.**

### Task 4: The gate check (one docs PR recording the result)

Run on a clean clone at the merge commit of Task 3, on a hosted `linux/amd64` runner and once on the maintainer's machine. Record the output in `docs/plans/alpha-gate.md` §Result and mark the gate in `docs/V0_1_PLAN.md`.

- [ ] Both fixtures were built only through `cinewright` commands: `replay` passes; every log author is a user, a session or a named job.
- [ ] `cinewright render` produces, for each of the 4 deliverables, a narrated, mixed, captioned MP4, both sidecars and a manifest.
- [ ] Every deterministic check passes on all 4: zero error findings from the layout, media and script critics, the solver and clearance.
- [ ] Two runs on two runners give identical `framemd5`, PCM hash and MP4 bytes for every deliverable, and identical bytes for every shot file (D33).
- [ ] A one-shot edit re-renders only that shot and its adjacent segments, and re-assembles without re-encoding the others.
- [ ] The two packs differ only at the style reference.
- [ ] `tier-a` runs on a pull request with no secrets. If decision 9 is "public": it runs on a PR from a fork, and the ruleset blocks a red PR. If not: state that fork PRs are not covered and tier A is a written rule.
- [ ] The M4 exit items the gate depends on are closed: PCM contract in D33; the audio image locked.
- [ ] Open issues 7 and 8 are marked resolved in `docs/V0_1_PLAN.md`.

If any item fails, the gate has not passed; fix forward with a task in the owning milestone. Agent work (M7) starts after this check is recorded.

## Done when (alpha gate acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| A.1: read-only fetch by hash, verified; CI cache; works without secrets | Task 1; Task 3 workflow |
| A.2: one explainer, both aspects, both packs, built only through `cinewright patch`; takes from Kokoro; CC0 music | Task 2 |
| M8.3a: every PR renders the alpha fixtures and reports per-check pass rates; no paid API; required check | Task 3 (resolution per the decision row; "required" enforced only after decision 9) |
| Gate: both fixtures render to a narrated, mixed, captioned MP4 that passes every deterministic check; a one-shot edit re-renders only that shot; two runs give identical hashes | Task 4 |
| These fixtures become the first tier A benchmark entries | Tasks 2 and 3 |
| `AGENTS.md` §2.3 item 4 applies from this gate | Task 3 (docs) |
| Open issue 7 (tier A assets) and decision 9 | Tasks 0 and 1 |

## Result

*To be filled in by Task 4.*
