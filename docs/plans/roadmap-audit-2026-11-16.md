# Cinewright — implementation audit and roadmap to v1.0

Audit of `main` at `4b8d8be` (M0, M1 and M2 merged). PR #34, the image lock, merged as `0da1bd0` while the audit ran; it changes only `container/image.lock.json` and was not re-audited. Written 2026-11-16. Read-only audit: no code was changed.

## 1. Summary

**Integrity verdict: sound, with one real bug.** M0–M2 are faithful to their plans, the spec and the binding rules. On a clean export of `4b8d8be`, every check passes, three times in a row, and so do all 43 container tests and all four specimen sets. The audit found one data-loss bug in the store, four places where the code enforces less than the docs claim, and a test suite that is not hermetic on the maintainer's machine.

**Top findings**

| # | Grade | Finding | Where |
| --- | --- | --- | --- |
| F1 | Critical | Reverting an `insert`, `remove` or `move` silently discards every later edit to the other items of that list. Reproduced with the CLI: a user's later edit vanished and the state hash went back two revisions, with no conflict. | `core/src/store/apply.ts:267,286,305`, `core/src/store/store.ts:667-670`, `core/src/store/conflict.ts:41` |
| F2 | Important | Density and overflow markers are set but nothing reads them. Seven bullets under a pack limit of five passed the specimen check (exit 0). The README says the check fails. | `components/src/bullet_reveal/index.ts:90`, `components/src/host/fit.ts:62`, `components/README.md:68` |
| F3 | Important | The render key misses most of what M2 made a render depend on: tokens a component reads implicitly, region geometry, font files and component code. M3.2 would serve stale renders from the cache. | `core/src/graph/render-key.ts:83-115` |
| F4 | Important | Nothing reads `project.style.pack`. `show --resolved` still takes a raw tokens file. "Switch packs by changing the style reference" is proven only for specimens. | `cli/src/commands/show.ts:35-36,56` |
| F5 | Important | Token values go into the composition's `<style>` block unescaped, so a pack string can close the block and add a script. M3.1 inherits this builder. | `core/src/pack/tokens.ts:152,159`, `components/src/node/specimen.ts:180` |
| F6 | Important | `pnpm test` fails in the working checkout: iCloud duplicate files break one test every run, and the 5-second default timeout failed two other tests in 2 of 3 runs. | `components/test/no-literals.test.ts:55-57`; no Vitest config sets `testTimeout` |

**Top plan changes**

1. **Fix the store and close the M2 gaps before M3** (new tasks M2.5a–d): F1, F2, F6 and a docs sweep.
2. **Start M3 with a pin refresh and real delivery profiles** (new M3.0; M5.3 moves forward). HyperFrames is 15 releases past the pin, with security fixes in nine of them. `cinewright init` works today only with test-fixture profiles.
3. **Redefine the render key in M3.2** (F3) and wire pack resolution and pack pinning in M3.1 (F4).
4. **Add an audio spike and a second pinned image** (new M4.0). Kokoro needs Python below 3.13 and the repository is on 3.13; WhisperX and its models do not belong in the render image; the mixer's determinism is untested.
5. **Move the tier A harness to the alpha gate** (split M8.3). AGENTS.md §2.3 item 4 applies from that gate, so the runner and the asset remote (Open issue 7) must exist then, not at M8.

Also recommended: build the M7.1 runtime interface with a plain loop implementation first and add LangGraph second, and split v0.3, which is too large for one release.

## 2. Audit results

### 2.1 Check outputs

Run on 2026-11-15 on macOS arm64 (the container runs under amd64 emulation, so its hashes are not baselines).

| Check | Clean export of `4b8d8be` | Working checkout |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 | exit 0 |
| `pnpm lint` | exit 0: 359 files, 2 infos (`useLiteralKeys` in the two container fixtures) | same |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test` | exit 0, 3 runs: core 336, cli 40, components 84, packs 34, plugin-sdk 15, render-runner 22 | **exit 1, 3 runs** (see F6) |
| `pnpm gen:check` | exit 0 | exit 0 |
| `uv run ruff check .` | All checks passed | same |
| `pnpm exec pyright` | 0 errors | 0 errors |
| `uv run pytest -q` | 59 passed, 5 skipped | 65 passed, 7 skipped (it also collects `test_check 2.py`) |
| `cinewright-check-boundaries .` | exit 0 | exit 0 |
| `cinewright-check-workflows …` | exit 0 | exit 0 |
| Container tests (`cinewright-render:m2`) | 43 passed in 96 s | not run |
| Specimens: build, then `cinewright-check-specimens` | build exit 0; check exit 0: all four sets `ok` (neutral and playful × landscape and portrait) | not run |

Notes:
- **Working-checkout failures.** Run 1: `core/test/contrast.test.ts` timed out at 5 s. Run 2: `components/test/specimens-cli.test.ts` timed out, and `no-literals.test.ts` failed on the duplicates. Run 3: `no-literals.test.ts` only. The recursive run stops at the first failing package, so later packages never ran.
- **First clean run.** The plugin-sdk subprocess tests skipped (5 tests) because `.venv` did not exist yet. CI runs them in the `py` job.
- **Image lock.** At `4b8d8be` the lock's `inputs_hash` (`f96d1ff4…`) does not match the tree (`a0627d78…`). That is expected until PR #34 merges.

### 2.2 Acceptance criteria

"Proven" means a test asserts it and the test passed in this audit.

**M0**

| AC | Verdict | Evidence |
| --- | --- | --- |
| M0.1: frozen install and tests pass, in both languages | Proven | `.github/workflows/checks.yml:16-54`; runs above |
| M0.1: lint and format checks for both languages | Proven | `checks.yml:27,46-47` |
| M0.1: a stale lockfile fails CI | Proven by construction | `--frozen-lockfile`, `uv sync --locked` |
| M0.1: the boundary check fails on `bpy` and on personal fixtures | Proven | `tools/tests/test_boundaries.py:17,45` |
| M0.2: pins printed in the image and compared | Proven | `tools/tests/test_pins.py:9-33`; `render-smoke.yml:83` |
| M0.2: hello-world twice, identical `framemd5` and bytes | Proven | `tools/tests/test_container.py:65` |
| M0.2: same result on a second machine | Proven in CI only | `render-smoke.yml:147-166` |
| M0.2: a remote URL fails and is named | Proven | `tools/tests/test_container.py:84` |
| M0.2: the recorded digest matches the pushed one | Stale at this commit | `container/image.lock.json`; PR #34 |
| M0.3: a failing PR turns a required check red | Claimed; not checkable from the tree | Throwaway PRs, per the plan |
| M0.3: such a PR cannot merge | **Not enforced** | The ruleset is not applied (private repository) |
| M0.3: fork PRs run required checks without secrets | Proven statically | `tools/tests/test_workflows.py:13-39` |

**M1**

| AC | Verdict | Evidence |
| --- | --- | --- |
| M1.1a–c: fixtures with exact error lists; meta-schema | Proven | `core/test/schema/fixtures.test.ts:39-45`, `meta.test.ts:19`, `core/test/semantic.test.ts:26-94` |
| M1.2a: four protections, 1,000 cases each | Proven | `core/test/authorship/properties.test.ts:113-181` |
| M1.2a: every out-of-table transition rejected | Partly by property (lock and unlock only), the rest by example | `properties.test.ts:184-203`, `table.test.ts:31-280` |
| M1.2b: pending patches, approve, reject, stale approve | Proven | `core/test/store/pending.test.ts:20-163` |
| M1.3: resolved values and origins; unresolved reference | Proven | `core/test/cascade.test.ts:19-54` |
| M1.4a: apply then revert restores the hash, per op | Proven, but only with nothing in between (F1) | `core/test/store/ops.test.ts:27-112` |
| M1.4a: old or new after a kill | Proven at 6 journal steps, by `process.exit`, not by signal | `core/test/store/atomic.test.ts:30-57` |
| M1.4a: hand edit named; replay reproduces the hash | Proven | `load.test.ts:8-23`, `replay.test.ts:7` |
| M1.4b: disjoint apply, overlap conflicts, scope names the op | Proven | `concurrency.test.ts:35-81`, `scopes.test.ts:18-78` |
| M1.5: dirty sets; stable keys | Proven as written; "uses a token" means an explicit reference (F3) | `core/test/graph.test.ts:70-158` |
| M1.6: drift fails CI; round trips in both languages | Proven | `checks.yml:56-72`, `generated.test.ts:40`, `core/py/tests/test_models.py:38` |
| M1.7: init, byte-identical save, RFC 8785, CAS errors, `runs/` | Proven | `project.test.ts:43-179`, `canonical.test.ts:36-93`, `cas.test.ts:29-72` |
| M1.8a: stub passes the kit; licence terms required | Proven | `plugins/sdk-ts/test/kit.test.ts:16-62` |
| M1.8b: Python stub, hang killed, no orphan | Proven | `plugins/sdk-ts/test/host.test.ts:51-102` |
| M1.9: reference build byte-identical; goldens; log | Proven | `cli/test/reference.test.ts:6`, `show.test.ts:16`, `diff.test.ts:13`, `patch.test.ts:23` |

**M2**

| AC | Verdict | Evidence |
| --- | --- | --- |
| M2.1: pack format, loader, citable rule ids | Proven | `core/test/pack.test.ts:76-214`, `layouts.test.ts:51-189` |
| M2.2: neutral pack | Proven | `packs/test/packs.test.ts:26-113` |
| M2.3: contrasting pack differs in five domains | Proven | `packs/test/packs.test.ts:121-149` |
| M2.4: eight components, catalog and props schemas | Proven | `components/test/catalog.test.ts:10-38` |
| AC: lint fails on literal design values | Proven | `components/test/no-literals.test.ts:55-79` |
| AC: every component renders correctly, both packs, both aspects | Proven for HyperFrames' check; **not for the plan's "no element carries `data-cw-overflow`"** (F2) | Specimens job; `tools/src/cinewright_tools/specimens.py:90-115` |
| Plan Task 6: the 300 ms example ends in its exit state; the long word fails only with the marker | By eye only (contact sheet); no test asserts it | `tools/tests/test_check.py:115-124` |
| AC: same IR under either pack | Component level only, as the plan says (F4) | `components/test/specimen.test.ts:52` |
| Open issue 6 settled | Proven | `components/test/bundle.test.ts:8` (no GSAP in the bundle) |

### 2.3 Binding rules

| Rule | Verdict |
| --- | --- |
| Invariant 1, D37, D40 (IR is the truth; store is the only writer) | Holds. Load compares the hash and the stored form (`store.ts:261-316`). |
| Invariant 2, D25 (authorship) | Holds for agents and jobs. F1 breaks it for a user's own revert. F8 is a gap in the approval rule. |
| Invariant 3 (style is data; origins recorded) | Holds. Origins come from `resolveEntity`. |
| Invariant 4, D29 (cast by id) | Holds in the schema and semantic checks. |
| Invariants 5, 6, 11 (plugins, neutrality, no model in code) | Hold: no vendor SDK or model name anywhere. The boundary check does not test for them yet (F16). |
| Invariant 7, D33 (determinism) | Holds: no clock or `Math.random` in components or the render path; seeded PRNG; bundle byte-identical; `--network none` (`container.py:103`). |
| Invariant 10 (Blender boundary) | Holds trivially; checked by `cinewright-check-boundaries`. |
| Invariant 12, D31 (typed IR, no renderer code) | Holds. Components build the DOM with `createElement`; no `innerHTML`. F5 is the one path where data becomes markup. |
| Neutrality (§2) | Holds. Three small literals remain (F13). |
| D26–D28, D30, D32, D41 | Hold as implemented. |
| D34–D36, D38 | Not implemented yet (M3–M8). |
| D39 | Holds at pack and component level; full IR at M3.1. |

### 2.4 Findings

**F1 — Critical. A revert of a list change discards later edits.**
- *Cause.* A list op snapshots the whole list, item bodies included (`apply.ts:267,286,305`). A revert restores that snapshot (`apply.ts:361-377`). The conflict check compares entity ids, so a later edit to an item, which has its own id, is not seen (`conflict.ts:41`, `store.ts:667`).
- *Reproduction.* Revision 9 inserts a shot. Revision 10 sets `framing` on a sibling shot, as the user. `cinewright patch revert 9` applies as revision 11 with the state hash of revision 8. The user's edit is gone.
- *What a user hits.* Reverting "add sequence 2" after a day of work in sequence 1 rolls sequence 1 back too, with no warning. The log keeps the data, so reverting the revert recovers it.
- *Fix.* Snapshot a list as its order of ids plus the bodies of removed items only; restore by re-ordering and re-inserting. Add a test with an edit between the op and its revert, for each list op.

**F2 — Important. Density and overflow markers are not enforced.**
- *Cause.* Components set `data-cw-density` and `data-cw-overflow`. No code in `container/`, `tools/` or `core/` reads either.
- *Verified.* A `bullet_reveal` with 7 items under `density.max_bullets: 5` passed `cinewright-check-specimens`.
- *What a user hits.* A pack's density limits are silently ignored, though the README and the prop description say otherwise.
- *Fix.* In `render-job check`, read both markers from the page at each sample time and report them as failures. This is the first DOM critic of M6.1; do it now as M2.5b.

**F3 — Important. The render key is incomplete.**
- *Cause.* `renderKey` hashes the shot's IR with explicit `{ token }` references resolved, asset hashes, component versions, backend version, container digest and profile hash. It omits tokens a component reads through its `tokens` list, region boxes, font file hashes and solved timing. Component versions are hand-kept semver, all `1.0.0`.
- *What a user hits (from M3.2).* Change `palette.ink` at project level, or switch packs, and cached shots do not re-render.
- *Fix.* M3.2b: key on the compiled composition's inputs (the mount spec, the emitted CSS, the font hashes, the runtime bundle hash, the compiler version). Do not key on `Pack.hash`: it covers `README.md`, so a documentation edit would invalidate every render (`core/src/pack/load.ts:95-112`).

**F4 — Important. The project's pack reference is unused.**
- *Cause.* No command calls `loadPack` with `project.style.pack`. The semantic check does not test that the pack exists.
- *Fix.* M3.1a: resolve the pack through the search path, fail with `pack.not_found` at patch time when a search path is known, and make `show --resolved` use it.

**F5 — Important. Unescaped token values in the `<style>` block.**
- *Cause.* `tokenEmit` writes string tokens with `JSON.stringify` and `ext.*` tokens with `String(value)`. Neither escapes `<`. The builder puts them in `<style>`.
- *What a user hits.* A third-party pack, which is meant to be plain data, can run script in the render. The network is off, so the effect is limited to the render itself. Layer overrides go into a `style` attribute with quotes escaped, so they can add CSS declarations but not markup.
- *Fix.* M3.1b: emit tokens through one escaping function (reject `<`, `>` and `;` outside quoted strings, or set the properties from the mount spec in script). Add a test with a hostile pack.

**F6 — Important. The test suite is not hermetic.**
- *Cause.* The checkout is in an iCloud-synced folder, which creates ` 2` copies. `no-literals.test.ts:55-57` compares a directory listing exactly. Pytest collects `test_check 2.py`. Pack hashes cover any stray non-dot file. No Vitest config raises the 5 s timeout, and first calls that compile schemas exceed it under load.
- *What a contributor hits.* A red local suite that hides real failures. Deferred minor 6 is one instance of the timeout.
- *Fix.* Move the checkout out of iCloud (maintainer). Add a shared Vitest config with `testTimeout: 30_000`. Make listing-based tests ignore untracked names.

**Minor findings**

| # | Finding | Where | Fix |
| --- | --- | --- | --- |
| F7 | `cinewright-check-specimens` exits 0 on a root with no specimens (verified), so CI can pass having checked nothing. | `tools/src/cinewright_tools/specimens.py:90-115` | Fail when no `samples.json` is found. |
| F8 | `patch revert` always runs as the user, with no proposal step. D41 and the CLI README forbid auto-approving only `patch approve`. | `cli/src/commands/patch.ts:225` | Name `patch revert` in D41, AGENTS.md and the README; or give revert a propose mode. |
| F9 | A project with stale component or token names loads, but every patch is rejected until one fixes them (deferred minor 1, confirmed). | `core/src/store/store.ts:430-434,476-479` | Report only errors the patch introduces, or add `cinewright doctor`. Needed before the first catalog change that removes a name. |
| F10 | The CLI imports the components index, which imports esbuild (deferred minor 2, confirmed). Measured cost is about 8 ms; the real cost is a native dependency in the CLI. | `components/src/index.ts:4`, `cli/src/commands/components.ts:1` | Export `catalogDir` from a subpath. |
| F11 | The examples asset pattern allows `..` (deferred minor 3, confirmed). First-party data only. | `core/schema/pack/examples.schema.json:100` | Forbid `..` segments. |
| F12 | `lineCount` counts child elements' top offsets, so a broken word counts as one line (deferred minor 4, confirmed). | `components/src/host/fit.ts:18-23` | Count line boxes with `getClientRects()`. |
| F13 | Contact sheets pad unused cells black (deferred minor 5, confirmed). Cosmetic. | `tools/src/cinewright_tools/specimens.py:30` | Set the tile filter's `color`. |
| F14 | Three design literals in components: a 0.5 scale floor, a 2× pop distance, and "title lines + 2" for quotes. | `components/src/motion/presets.ts:33,42`, `components/src/quote_card/index.ts:63` | Move to tokens or justify as craft rules. |
| F15 | Docs drift: README says M2 is "in review"; `V0_1_PLAN.md` has no "done" line for M1 or M2 and still says "GSAP timelines" in M2.4 and M3.1; the spec's open questions list issues 5–8 as open; `container/README.md:22` says Open issue 6 is undecided; the HANDOFF prompt names only M0 and M1. | `README.md:5`, `docs/V0_1_PLAN.md:138,143`, `docs/DESIGN_SPEC.md:580`, `docs/HANDOFF.md:58` | One docs PR (M2.5d). |
| F16 | The boundary check covers `bpy` and personal fixtures only. Invariants 5 and 11 have no check. | `tools/src/cinewright_tools/boundaries.py` | Add vendor-SDK and model-name rules with the first provider plugin (M4.1). |
| F17 | Docker runs have no timeout, memory limit, `--cap-drop` or `--read-only`. A hung browser hangs the caller. | `tools/src/cinewright_tools/container.py:84,102-107,124` | Add them in M3.2a, when user assets first enter the container. |
| F18 | The subprocess host discards plugin stderr. | `plugins/sdk-ts/src/host.ts:69` | Capture it for the event log (M4.1a). |
| F19 | Write scopes are entity kinds × paths. They cannot limit a role to one entity, and an insert is checked only at its list path, not for the fields inside. | `core/src/store/scopes.ts:15-19`, `core/src/store/store.ts:688-714` | Extend in M7.4 (per-task entity ids; check inserted subtrees). |
| F20 | The `specimens` CI job does not trigger on `core/src/cascade/**`, which it depends on. | `.github/workflows/render-smoke.yml:8-42` | Add the path. |
| F21 | `density.hold_per_word` and `density.min_hold` are defined in both packs and read by nothing. | `packs/*/tokens.json` | Expected; first readers are M4.2 and M6.1. Listed so it is not forgotten. |

No dead or duplicated code worth a finding was seen. `isTokenRef`, `isObject` and `isWrapper` are each defined in three or four files; a shared helper would be tidier.

## 3. Forward-plan assessment

**Overall.** The plan is still a sound target. The architecture has held through two milestones without a decision being reversed. The alpha gate (a walking skeleton with no agents) is the right next proof. The changes below are about order, missing tasks and stale facts.

### 3.1 What M1 and M2 change for M3 onward

| Decision | Consequence | Plan change |
| --- | --- | --- |
| WAAPI, `data-no-timeline`, `__hf.buildReady` | M3.1 emits a mount spec and the host bundle. No GSAP timeline. The plan text is stale. | Reword M3.1. Decide whether the image keeps GSAP (see §6). |
| Mount spec with absolute `{ enter, end }` frames | The compiler needs solved timing. The IR holds anchors. | M3.1 takes a timing table (line id → frames) as input. M4.2 produces it; before M4, a fixture does. |
| Tokens read implicitly by components | The M1.5 render key is too narrow (F3). | M3.2b redefines it. |
| Catalog checked at patch time; required props at compile time | Compile errors must be typed findings that name the layer. | AC in M3.1b. |
| Pack as a folder on a search path; hash exposed, not pinned | A pack update silently changes an existing project. | M3.1a pins id, version and hash in the project, like convention 16. |
| Specimens use M1 fixture profiles | `cinewright init` has no shipped profile to point at. | Move M5.3 to the start of M3. |
| `render-job check` wraps HyperFrames' check | M6.1's DOM critics should wrap it, not rewrite it. Its findings change between HyperFrames versions (0.9.44 added a 9:16 safe-area warning), so the HyperFrames version is part of every critic baseline. | Note in M6.1; D36 pinning covers it. |
| Video as a HyperFrames clip built at run time | Proven only by eye. | M3.2a asserts that a video plate's frame hashes change over time. |
| Kinds × paths write scopes | Too coarse for "one Shot Builder per shot" (F19). | M7.4. |

### 3.2 Dependency order

The suggested order holds: one shot through HyperFrames, then real narration timing, then the rest to the alpha gate, then agents. Four adjustments:

1. M2.5 (fixes) and M3.0 (pin refresh, profiles) come first.
2. M4.0 (audio spike) comes before any M4 code. It decides the audio image and how the PCM contract is measured.
3. M3.3 (transitions) needs a decision the plan has not made: whether an overlap shortens the film or consumes frames from each shot. Settle it in the M3 plan. The M1.5 graph models transitions only between scenes.
4. The tier A harness and the asset remote land at the alpha gate.

### 3.3 Open issues 7 and 8

**Issue 7, tier A assets.** Agree with a read-only remote fetched by hash. Concretely:
- **What goes in it.** Narration takes made with Kokoro (Apache-licensed weights, no paid API) and CC0 music, kept short and at a modest bit rate, so a fixture should stay within a few megabytes.
- **Where.** Static files addressed by hash, for example release assets on the repository. The CAS gets a `remote` read path that verifies the hash on fetch; CI caches it.
- **Blocker.** The repository and the GHCR image are private, so a fork can fetch neither. Tier A on fork PRs needs the repository public, or a public mirror for the image and assets. This is a maintainer decision due at the alpha gate.

**Issue 8, STT in tier A.** Agree: freeze transcripts as assets keyed by take hash, plugin version and model hash; tier A compares script against the frozen transcript; live STT runs only for a new take. Two additions:
- **Timing and checking are different jobs.** For word timestamps the text is known, so use forced alignment against the script. Use transcription only for the STT-vs-script check.
- **WhisperX does not align digits or symbols** ("2014", "£13.60" get no timing). The plugin must interpolate, and an anchor on such a word needs a defined result.

### 3.4 Risks

| Risk | Assessment | Mitigation |
| --- | --- | --- |
| Audio determinism | TTS is not repeatable (ElevenLabs: "Determinism is not guaranteed" even with a seed). Freezing covers it. The mixer is the open question: FFmpeg filters, resampling and the AAC encoder have not been tested for repeatability, and D33 does not say whether the PCM hash is taken before or after encoding. | M4.0 spike, modelled on M0.2. Define the PCM hash on the mix before encoding, plus byte identity of the muxed file per runner class. |
| WhisperX on CPU | Unverified. Models download at run time, which the network-off rule forbids. | Bake models into the audio image or fetch them from the CAS. Freeze transcripts. |
| LangGraph | 1.7.4 is current and unchanged since the plan. An interrupt still restarts its node. With D37, LangGraph holds only run state, and the reconciler already gives crash recovery. Its benefit is the weakest-justified dependency in the plan. The SQLite checkpointer adds a native module. | Build the runtime interface with a plain loop first (M7.1a). Add LangGraph as the second implementation (M7.1c). If it adds nothing, amend D5 by RFC. |
| Cost | Tier B is 8 briefs × 3 runs nightly through a frontier model, a vision critic and paid TTS. No figure exists. | Set a monthly evaluation budget before M8.3. Consider 1 run nightly and 3 before releases. Every run is capped by M7.7. |
| Tier A assets | See issue 7. | Decide hosting at the alpha gate. |
| HyperFrames churn | 38 releases in 8 days. Each bump is a new image digest and a new baseline. | Bump at milestone starts and for security fixes only. Rebase baselines in the same PR. |
| Scope of M7 | Seven tasks hold most of the product's novelty and all of its LLM cost. | Stub agents first, as planned. Split M7.1 and M7.5 (§4). |

### 3.5 External facts, re-checked 2026-11-15

| Item | Plan says | Now | Matters because |
| --- | --- | --- | --- |
| HyperFrames | 0.9.41 | **0.9.56** (2026-11-16 UTC), Node ≥ 22, Apache-2.0 | 0.9.48–0.9.56 carry security fixes: file servers no longer serve env, Git or credential files; Host checks; media playlists cannot name files outside their folder. 0.9.44 and 0.9.47 change `check` output. No release notes mention WAAPI, `buildReady`, `data-no-timeline` or PNG output; re-verify them on the bump. |
| Chrome headless shell | 152 pinned | 0.9.41's notes mention Chrome 157+ for fast capture | Check the pin against the new HyperFrames version. |
| `@langchain/langgraph` | 1.7.4 | 1.7.4; checkpoint-sqlite 1.1.0 | No change. |
| ElevenLabs TTS with timestamps | "character/word timestamps" | **Character-level only**; default model `eleven_multilingual_v2`; seed is best effort | The plugin derives word times from characters. The spec's `eleven_v4` was not confirmed. |
| Kokoro | "not verified" | 0.9.4, released 2025-04; **Python ≥ 3.10, < 3.13**; needs espeak-ng; README shows no timestamps | The repository is on Python 3.13, so the plugin needs its own interpreter. Take timestamps from alignment (M4.5). espeak-ng is GPL-3.0: confirm the process boundary is enough, as for Blender. |
| WhisperX | "not verified" | 3.8.6 (2026-05), BSD-2-Clause, Python < 3.14 | See issue 8. Diarization needs a Hugging Face token; v0.1 does not need diarization. |
| esbuild, Ajv, json-schema-to-typescript, datamodel-code-generator | pinned | unchanged | — |

Sources: npm registry (`hyperframes`, `@hyperframes/producer`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-sqlite`) · PyPI (`kokoro`, `whisperx`, `elevenlabs`) · [HyperFrames releases](https://github.com/heygen-com/hyperframes/releases) · [ElevenLabs convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps) · [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) · [Kokoro](https://github.com/hexgrad/kokoro) · [WhisperX](https://github.com/m-bain/whisperX)

## 4. The plan from here to v0.1

One task is one PR. Existing ids keep their meaning; new ids are marked *new*. "Needs" lists tasks that must merge first.

### M2.5 — Audit fixes (*new*)

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M2.5a | Store: list snapshots and revert conflicts (F1) | For each list op, a revert after a later edit to a sibling keeps that edit; a revert after a later change to the same list conflicts; replay still reproduces every `state_hash`, including old logs | — |
| M2.5b | Check reads `data-cw-overflow` and `data-cw-density` (F2); empty root fails (F7) | The 7-bullet example fails naming the element; an empty root exits non-zero; the long-word and 300 ms claims get assertions | — |
| M2.5c | Hermetic tests (F6, F20) | Shared Vitest timeout; the suite passes with stray untracked files present; 10 consecutive green runs | — |
| M2.5d | Docs sweep (F15) and `patch revert` in D41 (F8) | Every item in F15 fixed; D41 row updated | — |

### M3 — HyperFrames backend

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M3.0 (*new*) | Refresh the HyperFrames and Chrome pins; rebuild and lock the image | Smoke and all specimens pass on the new image; readiness, `data-no-timeline` and PNG output re-verified against the tagged source and recorded; External facts updated | M2.5b |
| M5.3 (moved) | Delivery profiles v0 in `registry/` | Two profiles validate; `init --deliverable web=landscape_web` works by name; specimens and the reference project use them | — |
| M3.1a | Compile inputs: pack resolution and pin (F4), timing table, compile-time prop checks | A project resolves its pack by id; a missing pack fails by name; the project records pack id, version and hash, and a changed pack is reported; a missing required prop is a typed error naming the layer | M5.3 |
| M3.1b | Shot compiler | The reference motion-graphics shot compiles for both deliverables; output matches goldens; the same IR compiles under both packs by changing only `style.pack`; a hostile pack string cannot add markup (F5); compiling twice gives identical bytes | M3.1a |
| M3.2a | Backend interface and renderer adapter | PNG sequence, then the pinned FFmpeg encode per the M0.2 spike; logs, timings, `framemd5` and hash recorded; outputs in the CAS; run limits (F17); a video plate's frames change over time | M3.0, M3.1b |
| M3.2b | Render key v1 and cache (F3) | Changing any token a shot's components read, a font file, the bundle, the profile or the digest changes the key; changing a pack's README does not; an unchanged shot is a cache hit; the determinism test (two runs, identical hashes) runs in CI | M3.2a |
| M3.3 | Transition segments | Cross-dissolve and wipe render as segments; a cut needs none; frame counts add up to the timeline exactly; segment timing rule recorded in the spec | M3.2b |
| M3.4 | Caption layer | Burn-in follows the profile; a cue across a cut is split and identical on both sides; a caption edit re-renders only the shots it touches | M3.2b |
| M3.5 | Keyframe capture | Stills and DOM snapshots at the densest moments, by a stated rule; stored in the CAS; repeatable | M3.2a |

### M4 — Audio

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M4.0 (*new*) | Audio spike and audio image | Recorded results for: mixer repeatability across runs, CPU quotas and machines; Kokoro and WhisperX repeatability on CPU; image size. A pinned `audio` image with its own digest, models included, network off. The PCM contract written into D33 | M3.0 |
| M4.5a | STT and alignment interface; transcript asset | Interface and conformance cases; a frozen transcript is an asset keyed by take hash, plugin version and model hash | M4.0 |
| M4.5b | WhisperX plugin | A frozen take yields a transcript and word times; words with digits get interpolated times; same result on every run in the image, or the frozen transcript is used | M4.5a |
| M4.1a | TTS interface, take assets, narration job | Takes frozen with provenance and licence; a second run reuses them; a re-take is explicit; plugin stderr captured (F18) | M4.5a |
| M4.1b | ElevenLabs plugin | Recorded-response tests; word times derived from character times; lexicon translated; live test opt-in and capped; vendor-SDK boundary rule added (F16) | M4.1a |
| M4.1c | Kokoro plugin | Runs as a subprocess on its own Python; timestamps from M4.5b; same narration through either plugin yields timing anchors | M4.1a, M4.5b |
| M4.2 | Timing solver | Shot durations snap to narration within `flex`; an overrun is a finding, never a stretch; reads `density.min_hold` and `hold_per_word`; an anchor on a removed word is a finding | M4.1a |
| M4.3a | Music and SFX interface, local library, Composer job | The job builds its request from `sound.*` tokens and the mood; every asset records provider, tier and licence | M4.1a |
| M4.3b | One generative music plugin | Recorded-response tests; licence terms in the manifest | M4.3a |
| M4.4 | Mixer | Meets the profile's loudness and true-peak targets; music ducks by the pack's depth; identical PCM hash on two runs | M4.0, M4.3a |

### M5 — Assembly and delivery

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M5.1 | Assembly | Concatenation without re-encoding; audio muxed; byte-identical on two runs; ffprobe matches the profile | M3.3, M4.4 |
| M5.2 | Sidecar captions | SRT and VTT from line timestamps, always; timing matches the burn-in | M4.2 |
| M5.4 | `cinewright render` | Runs every non-agent job in dependency order; a one-shot edit re-renders only that shot and its adjacent segments and re-assembles without re-encoding the rest | M5.1, M5.2, M3.4 |

### M6.1 — Deterministic critics

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M6.1a | Critic interface, finding schema, DOM critics | Findings carry type, severity, entity path, frame range, evidence and signature; overflow, collision, safe area, contrast, minimum text size and hold time, each with a seeded failing fixture | M3.5, M2.5b |
| M6.1b | Media critics | Loudness, true peak, silence, clipping, black or frozen frames, ffprobe spec, licence presence, each with a seeded failing fixture | M5.1 |
| M6.1c | STT-vs-script critic | Uses the frozen transcript in tier A; threshold is data | M4.5b |

### v0.1-alpha gate

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| A.1 (*new*) | CAS remote (Open issue 7) | Read-only fetch by hash, verified; CI cache; works without secrets | M4.1c |
| A.2 (*new*) | Alpha fixtures | One explainer, both aspects, both packs, built only through `cinewright patch`; takes from Kokoro; CC0 music | M5.4, A.1 |
| M8.3a (split) | Tier A harness in CI | Every PR renders the alpha fixtures at reduced resolution and reports per-check pass rates; no paid API; required check | A.2, M6.1a–c |
| Gate | — | Both fixtures render to a narrated, mixed, captioned MP4 that passes every deterministic check; a one-shot edit re-renders only that shot; two runs give identical hashes | all above |

### M7 — Engine and agents

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M7.1a | Runtime interface, run ledger and event log schemas, loop runtime | With stub agents and the loop runtime, a run reaches the end of the explainer template; ledger and log validate | Gate |
| M7.1b | Reconciler, workflow templates, P0 intake | Tasks derive from IR state alone; a human edit, an agent patch and a restart give the same task set; intake rejects a missing budget or an unsupported capability | M7.1a |
| M7.1c | LangGraph runtime and gate pauses | The same tests pass on the LangGraph runtime; a run pauses at each gate, resumes, and survives a kill in every phase; deleting checkpoints loses nothing | M7.1b |
| M7.2 | Scheduler | Idempotency keys; limits from manifests; backoff; fallback; render pool | M7.1b |
| M7.3 | LLM interface and Claude plugin | Structured output; tiers are configuration; cassettes keyed by context-pack hash; model-name boundary rule (F16) | M7.1a |
| M7.4 | Agent runner and role table | Context packs from read scopes; output validated for schema, scope, authorship and citations; per-task entity scopes and inserted-subtree checks (F19); repair loop; one conflict retry | M7.3 |
| M7.5a | Producer and Writer | A brief runs to the script gate; cassette replay reproduces the `state_hash` | M7.4 |
| M7.5b | Director | Every line covered by one scene; every shot type routable | M7.5a |
| M7.5c | Shot Builder and Editor | Props validate; compile succeeds within two repair rounds | M7.5b |
| M7.6 | Gates, presets, human task queue | Four presets; gate packets; any role set to `human` runs the same workflow | M7.1c |
| M7.7 | Cost ledger and cap | Estimate, reservations, fix reserve; a run pauses before crossing the cap; spend survives deleting `runs/` | M7.2 |
| M6.2 | Vision critic | Pinned model, prompt and rubric; variance recorded on tier A; per-pack threshold in the baseline | M7.4, M3.5 |
| M6.3a | Fix routing and deterministic fixers | Each seeded defect is detected and routed to the right owner; layout, contrast and loudness resolve automatically | M6.2, M7.5c |
| M6.3b | Bounds, oscillation, escalation | A seeded oscillation stops and escalates; the regression guard re-runs every deterministic critic | M6.3a |

### M8 — CLI and benchmark

| Task | Work | Acceptance criteria | Needs |
| --- | --- | --- | --- |
| M8.1 | Remaining commands | `plan`, `review`, `export`, `status`, `tasks`, `log`; JSON output; documented exit codes | M7.6 |
| M8.2 | Benchmark v0 briefs | At least 8 neutral briefs per the plan; no personal briefs; tier A grows from good tier B runs | M7.5c |
| M8.3b | Tier B harness | Nightly and on trigger; capped; per-brief pass rate, rubric mean and variance, cost and latency, stored per commit | M8.2, M6.3b |
| M8.4 | Personal fixtures | Never imported by core; never gating | — |
| M8.5 (*new*) | Clean-machine setup | The documented setup runs a brief from `init` to export on a fresh machine, including a local-only run; tested in CI on a bare runner | M8.1 |

### v0.1 exit gate

Unchanged from the plan. Two clarifications: "byte-identical shot files" is checked per runner class, and the rubric baseline records the HyperFrames version with the critic versions.

### Order

`M2.5a–d` → `M3.0`, `M5.3` → `M3.1a` → `M3.1b` → `M3.2a` → `M3.2b` → `M4.0` → `M4.5a` → `M4.5b`, `M4.1a` → `M4.1c`, `M4.2` → `M3.3`, `M3.4`, `M3.5`, `M4.1b`, `M4.3a`, `M4.3b`, `M4.4` → `M5.1`, `M5.2` → `M5.4` → `M6.1a–c` → `A.1`, `A.2`, `M8.3a` → **alpha gate** → `M7.1a` → `M7.1b` → `M7.2`, `M7.3` → `M7.4` → `M7.1c`, `M7.6`, `M7.7` → `M7.5a` → `M7.5b` → `M7.5c` → `M6.2` → `M6.3a` → `M6.3b` → `M8.1`, `M8.2`, `M8.4` → `M8.3b`, `M8.5` → **exit gate**.

Tasks separated by commas can run in parallel. Each milestone still gets its own detailed plan and approval before its first PR.

## 5. After v0.1: the roadmap to v1.0

The spec gives gates only for v0.1 and v0.2. The exit criteria below are proposals. Items the spec describes but the roadmap never schedules are placed and marked *unscheduled in spec*.

| Release | Main tasks | Proposed exit criteria |
| --- | --- | --- |
| **v0.2 Cast and sound** | Full cast bible and Casting role · multi-voice dialogue (dialogue mode and per-line mode) · takes and selection · Dialogue Director · Composer agent · more music and SFX plugins · stems · consent artifacts and the render gate that enforces them · schema versioning and migrations (*unscheduled in spec*) | A 4-character dialogue brief passes every audio check (the spec's gate) · a v0.1 project opens after migration · a cloned voice without consent blocks the render · tier A gains a multi-voice fixture |
| **v0.3a Pre-production** | Image-based storyboard frames · animatic and its gate · Style Designer and pack derivation · packs 3–6 from D14 · Studio alpha (read, review, approve) · estimates including storyboard and animatic · `cinewright adopt` or a merge driver (*unscheduled in spec*; Studio brings team use) | Guided pauses at four gates · all six packs pass the shared pack checks and the specimens · a derived pack passes the same checks · two IR branches can be reconciled |
| **v0.3b Blender** | GPL-3.0 package and job interface · bpy version adapter and conformance suite · Cycles in a GPU image · 3D component library · HyperFrames compositing of 3D layers · GPU CI | A 3D product shot renders twice with identical frame hashes on one runner class · the boundary check passes · black-frame critic covers Blender output |
| **v0.4 Footage and characters** | Image and video generation plugins · character sheets · lip sync · render-guided generation · capability routing · monthly model benchmark · continuity and clearance critics · colour management (*unscheduled in spec*) | A narrator-plus-two-characters brief with lip sync passes · routing picks a plugin from the benchmark with no model name in core · every generated asset carries provider, model, tier and licence |
| **v0.5 Interchange and scale** | OTIO and FCPXML export · TypeScript and Python SDKs · MCP server · distributed render · localization, including RTL and a pinned CJK font · sandboxed third-party plugins and the registry groundwork · C2PA and disclosure, audio description (*unscheduled in spec*) | An exported timeline opens in Resolve and Premiere · a localized project in a non-Latin and an RTL script passes the checks · an untrusted plugin runs sandboxed |
| **v1.0** | Freeze IR v1 and plugin contracts · registry with conformance badges · the full AGENTS.md §4.1 benchmark · human rating panel (D20) · RFC process live | Every §4.1 coverage row has a fixture · a blinded pairwise study by outside raters is published · no schema change without an RFC and a migration |

**Why split v0.3.** As written it holds a new generative modality, a web UI, pack derivation, four packs and a GPL 3D backend with GPU CI. Pre-production and Blender share nothing, and each can slip without blocking the other.

**Why move work forward.** Migrations are needed before any outside user keeps a project across versions. The benchmark needs three languages by v1.0, but localization arrives at v0.5; components already carry a known CJK gap.

## 6. Validation strategy

| Layer | What | When | Gate |
| --- | --- | --- | --- |
| Unit and contract | Schema, cascade, authorship, patches, packs, components, plugin kit | Every PR | Required checks |
| Property | Authorship (1,000 cases), geometry, motion scaling | Every PR | Required |
| Determinism | Two runs with identical `framemd5`, PCM hash and bytes; second runner compared | Every PR that touches render inputs; main | Required from M3.2b |
| Specimens | Every component example × pack × aspect through the check, plus the markers (M2.5b) | PRs touching packs, components, cascade | Required for those paths |
| Tier A | Frozen IR and assets; all deterministic critics; reduced resolution; no paid API | Every PR, forks included, from the alpha gate | Required; per-category, not average |
| Cassettes | Recorded LLM and provider responses; replay must reproduce the `state_hash` | Every PR from M7.3 | Required |
| Tier B | Live agents and providers; several runs per brief; variance | Nightly and before releases, from M8.3b | Per category, with sign-off for trade-offs |
| Vision critic | Pinned model, prompt, rubric and HyperFrames version per baseline | Tier B; tier A for variance | A changed pin sets a new baseline |
| Human rating | Blinded pairwise, raters other than the maintainer | Before v0.2 and each later release; published at v1.0 | Informs, then gates v1.0 |
| Security | Hostile pack and asset fixtures; container limits; fork-safe workflows | From M3.1b | Required |

Rules that hold throughout: a new feature ships with a benchmark brief; a pin bump rebases baselines in the same PR; a skipped test must say why in CI output, and required jobs may not skip silently.

## 7. Decisions for the maintainer

| # | Decision | Recommendation | Due |
| --- | --- | --- | --- |
| 1 | Fix F1 before M3? | Yes. It is silent data loss. | Now |
| 2 | Move the checkout out of iCloud | Yes. | Now |
| 3 | Bump HyperFrames at M3.0, and the bump policy | Bump to the current release; afterwards at milestone starts and for security only. | M3.0 |
| 4 | Keep GSAP in the render image? | Remove it and convert the smoke fixture to WAAPI. Raw compositions are not in v0.1; re-add it with them. | M3.1b |
| 5 | Pin the pack (id, version, hash) in the project? | Yes, like delivery profiles. | M3.1a |
| 6 | Transition timing rule | Overlap consumes frames from both shots; total length unchanged. | M3 plan |
| 7 | A second pinned image for audio? | Yes. Keep the render image small. | M4.0 |
| 8 | Kokoro and espeak-ng (GPL-3.0) | Treat as a process boundary, as for Blender; confirm with the licence text. | M4.1c |
| 9 | Go public, or a public mirror for the image and tier A assets | Go public by the alpha gate; it also turns on the ruleset. | Alpha gate |
| 10 | Who writes the 8 benchmark briefs | Someone other than the maintainer, per D24. | M8.2 |
| 11 | Monthly evaluation budget and tier B cadence | Set a cap; 1 run nightly, 3 before releases. | M8.3b |
| 12 | LangGraph after M7.1a | Keep D5 only if the LangGraph runtime gives something the loop runtime does not. | M7.1c |
| 13 | Split v0.3; schedule migrations in v0.2 | Yes to both. | v0.1 exit |
| 14 | Paid raters and budget (D20) | Needed before the first human study. | v0.2 |
| 15 | Name, GitHub organisation and npm scope | Before anything is published. | v0.1 exit |
