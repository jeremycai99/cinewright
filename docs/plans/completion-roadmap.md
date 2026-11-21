# Cinewright — completion roadmap: today to v0.1, then to v1.0

**Status:** approved 2026-11-20. Written 2026-11-20 on branch `m4.0a-audio-image` (equal to `m3.6-audit-fixes`, PR #51). It is the third audit in the series after `roadmap-audit-2026-11-16.md` and `audit-m3-m4-plan-2026-11-16.md`, and the index of the detailed plans written with it. Read-only for code: only files under `docs/plans/` were written, plus pointer lines in `docs/V0_1_PLAN.md`.

Detailed plans, approved 2026-11-20:

| Plan | Covers | PRs |
| --- | --- | --- |
| `m4-audio.md` (approved 2026-11-17) | M3.6, M4.0a–M4.4; M4.3b after the alpha gate | 11 + 1 |
| `m5-assembly-delivery.md` | M5.4a, M5.1, M5.2, M5.4b | 4 |
| `m6-1-deterministic-critics.md` | M6.1a–c | 3 |
| `alpha-gate.md` | A.1, A.2, M8.3a, the gate check | 3 + 1 |
| `m7-engine-agents.md` | M7.1a–b, (M7.1c), M7.2–M7.4, M7.5a–c, M7.6, M7.7 | 10 (+1) |
| `m6-2-3-vision-fix-loop.md` | M6.2, M6.3a, M6.3b | 3 |
| `m8-cli-benchmark.md` | M8.1, M8.2, M8.4, M8.3b, M8.5, the exit gate check | 5 + 1 |

## 1. Summary

**The remaining plan is sound in order and in architecture.** No decision in D1–D41 has to be reversed to finish v0.1. The gaps found are of three kinds: interfaces that M4 fixes and later milestones need in a slightly different shape; things the exit gate asks for that no task delivered; and two places where a fact about today's APIs changes a design assumption. Each is closed in one of the plans above.

**Top findings**

| # | Grade | Finding | Closed in |
| --- | --- | --- | --- |
| H1 | Important | **No command starts or resumes an agent run.** The CLI list is `init, patch, show, plan, render, review, export, status, tasks, log`, and `render` is defined as the non-agent pipeline (M5.4). M7's criteria ("a brief runs to the first gate") need an entry point before M8.1 exists. | M7 plan: `plan` runs to the storyboard gate, `render` to the final gate, both wired in M7.1a |
| H2 | Important | **Agents cannot emit generic patch ops under schema-constrained output.** A patch `value` is arbitrary JSON and props differ per component; constrained output needs closed objects, the newest models reject a forced tool call, and they reject sampling parameters, so there is no "temperature 0" for replay or for the vision critic. | M7 plan: typed role output converted to a patch by the engine; cassettes are the only reproducibility; M6.2 measures variance instead of assuming none |
| H3 | Important | **Two finding shapes, and no durable home for findings.** M4 defines `Finding` with `error \| warning` and no signature, frames or evidence; `V0_1_PLAN.md` asks for `blocking \| warning` plus those fields. Fix-loop bounds and `finding:<id>` citations would live in `.cinewright/runs/`, which is disposable. | M6.1 plan (`CriticFinding`, signatures); M6.2–3 plan (`log/findings.jsonl`) |
| H4 | Important | **Loudness is verified on the master, not on the delivered file.** The M4 mixer checks PCM before encoding. A lossy encode can raise the true peak, and the M6.1 critic reads the MP4, so a mix could fail a check that no owner can fix. Unmeasured. | M5 plan Task 2 (measure, then `encode_headroom_db`); M6.1 plan Task 2 |
| H5 | Important | **Stills need a render, but the workflow puts stills before rendering.** M3.5 keyframes are copies of the cached render's frames. P7 (stills, before G2) precedes P8 (render). G8 (stills "stored in the CAS") is also still open. | M7 plan: P7 runs the real render (CPU only, cached), P8 becomes a cache hit; stills stay in the render cache and the wording is dropped |
| H6 | Important | **"The same briefs pass under both packs" contradicts "briefs split across both packs"**, and tier B has no cost figure: 8 briefs × 3 runs, doubled if every brief runs under both packs. | M8 plan: a home pack per brief plus a 1-run pack-swap matrix (32 runs); decision 11 set after one measured run |
| H7 | Important | **"Local-only run" is undefined for the LLM.** v0.1 ships one LLM plugin and no local model, and CI on a fork holds no key. | M8 plan: local-only means local media providers; the keyless path is a Manual project plus cassettes, tested on a bare runner |
| H8 | Important | **Cassette replay cannot reproduce `state_hash` unless job-made ids and seeds are derived.** M4 Task 6 (not started) does not say how a take asset's id or a re-take's seed is chosen; a random one enters the IR. | M7 plan, binding M4.1a: ids from the request hash, seeds from the take count. **Raise in M4.1a now; it is free today.** |
| H9 | Important | **The project schema lacks what M7 reads and writes** (roles as human or agent, the workflow template, the Producer's plan, fix policy), and `init` leaves the budget open although D17 asks for a conservative default. No migration tool exists before v0.2. | M7 and M6.3 plans: optional fields only (`settings.roles`, `settings.workflow`, `project.plan`, `patch.task`, `policies.fix`); `init` writes the default cap |
| H10 | Minor | **The M1.5 dependency graph is out of date after M4.** `duration:<shot>` hashes `shot.duration`, which the solver no longer writes; `mix@` ignores `line.take` and `sequence.music`. | M5 plan: pipeline step keys are the truth and feed the graph; the reconciler uses them |
| H11 | Minor | **M6.1 omits caption timing** (required by `AGENTS.md` §4.2) **and flashing** (§5). FFmpeg black and freeze detection would flag legitimate holds and dark packs. | M6.1 plan: caption rules added; blank and frozen judged against the mount spec; flashing recorded as out of v0.1 |
| H12 | Minor | **Tier A "at reduced resolution" conflicts with profile-pinned fixtures:** safe areas and text size depend on pixels. | Alpha plan: full resolution with a keyed render cache; half-size profiles only if the cold run is too slow |
| H13 | Minor | **Decision 15 (name, organisation, scope) is dated after decision 9 (going public) makes it visible.** The image reference is in every lock and baseline. | Alpha plan: decide 15 with 9 |
| H14 | Minor | **D41 names two approval commands; gates add more** (`review approve`, `review waive`), and tier B auto-approves the final gate. | M7 plan: proposed D41 addition |
| H15 | Minor | **The manifest's `cost_model` is one price per unit,** which cannot describe an LLM. The Producer and the budget read cost models. | M7 plan: `<kind>.estimate` and `cost_usd` on responses |
| H16 | Minor | **The role table says the solver "writes final frame durations and the assembly plan";** M4 decided spans are derived and never written. P12's provenance manifest has no task. The registry profiles set no `max_duration`, which the Writer's check and the format critic read. | M7 plan (Editor output); M5 plan (manifest); M6.1 and M7 plans treat `max_duration` as optional |
| H17 | Minor | **External pins moved:** `@langchain/langgraph` 1.7.5 and the SQLite checkpointer 1.1.1 (the plan records 1.7.4 and 1.1.0). | M7 plan §External facts; decision 12 |
| H18 | Minor | **Housekeeping still open:** the checkout is still in iCloud (duplicate ` 2` to ` 5` files are present under `core/src`, `core/schema`, `cli/test` and `plugins/backend-hyperframes/src`); "required check" is unenforceable while the repository is private on GitHub Free. | Alpha plan Task 0 |

**What was checked and how.** Docs: `AGENTS.md`, `DESIGN_SPEC.md`, `V0_1_PLAN.md`, both audits, the M3 and M4 plans. Code, read not run: `core/src` (graph, timing, store scopes and gates, CAS, layout), `core/schema`, `plugins/sdk-ts`, `plugins/backend-hyperframes`, `cli/src`, `container/render-runner`, the workflows and `tools`. External facts fetched on 2026-11-20: npm registry for LangGraph; LangGraph interrupt and persistence docs; FFmpeg formats documentation; WebVTT and WCAG 2.2 at W3C; a search for EBU R 128. The Claude API facts come from Anthropic's developer reference as cached on 2026-11-03. **Not done:** no test suite or container was run for this audit, and nothing after M3.6 exists in code, so every interface from M4 on is a plan, not a fact.

## 2. Status

| Milestone | State | Evidence |
| --- | --- | --- |
| M0 repo, toolchain, render image | Done 2026-11-14 | PRs #1–#9 |
| M1 IR v0, store, CLI `init`/`patch`/`show` | Done 2026-11-15 | PRs #10–#25 |
| M2 style system, two packs, eight components | Done 2026-11-16 | PRs #26–#34 |
| M2.5a–d audit fixes | Done | merged before M3 |
| M3.0–M3.5 HyperFrames backend; M5.3 profiles | Done 2026-11-16 | PRs #40–#49 |
| M4 plan and second audit | Open, green | PR #50 |
| M3.6 body ranges, HTML in render key, caption holds, container tests in CI | Open, green | PR #51 |
| M4.0a audio image | Next | branch `m4.0a-audio-image`, no commits yet |
| Everything below | Not started | — |

## 3. Remaining PR sequence

"Needs" lists what must merge first. Rows with the same wave number can be in review at the same time.

**To the alpha gate**

| Wave | PR | Task | Needs |
| --- | --- | --- | --- |
| 0 | #50, #51 | M4 plan; M3.6 | — |
| 1 | M4.0a | Audio image and tooling (plus a lock follow-up) | #51 |
| 2 | M4.0b | Audio spike, PCM contract into D33 | M4.0a |
| 3 | M4.5a | Plugin runtime, `engine/`, registry, STT interface | M4.0b |
| 4 | M4.5b · M4.1a · **A.1** · **M5.4a** | WhisperX · TTS interface and narration · CAS remote · backend interface | M4.5a |
| 5 | M4.2 · M4.1b · M4.1c | Timing solver · ElevenLabs · Kokoro | M4.1a (M4.1c also M4.5b) |
| 6 | M4.3a · **M5.2** · **M6.1a** | Music interface and Composer · sidecars · critic interface and layout critics (plus an image lock follow-up) | M4.2 (M6.1a: M5.4a) |
| 7 | M4.4 | Mixer | M4.3a, M4.0b |
| 8 | **M5.1** · **M6.1c** | Assembly · script critics | M4.4, M5.4a (M6.1c: M4.5b, M5.2) |
| 9 | **M5.4b** · **M6.1b** | `cinewright render` · media critics | M5.1 (M5.4b also M5.2; M6.1b also M6.1a) |
| 10 | **A.2** | Alpha fixtures | M5.4b, M6.1a–c, M4.1c, A.1 |
| 11 | **M8.3a** | Tier A harness | A.2 |
| 12 | Gate | Gate check recorded | all above; decisions 9 and 15 |

**From the alpha gate to the v0.1 exit**

| Wave | PR | Task | Needs |
| --- | --- | --- | --- |
| 13 | M7.1a · M4.3b · *brief writing starts* | Runtime, ledger, loop · generative music · (content) | Gate |
| 14 | M7.1b · M7.3 | Reconciler, templates, intake · LLM interface and plugin | M7.1a |
| 15 | M7.2 · M7.4 · (M7.1c) | Scheduler · agent runner · (LangGraph, only if kept) | M7.1b (M7.4 also M7.3) |
| 16 | M7.6 · M7.7 · M6.2 | Gates and presets · budget · vision critic | M7.4 (M7.7: M7.2) |
| 17 | M7.5a | Producer and Writer | M7.4, M7.7 |
| 18 | M7.5b · M8.4 | Director · personal fixtures | M7.5a |
| 19 | M7.5c · M8.1 | Shot Builder and Editor · remaining commands | M7.5b (M8.1: M7.6) |
| 20 | M6.3a · M8.2 · M8.5 | Routing and fixers · briefs · clean-machine setup | M7.5c, M6.2 (M8.5: M8.1) |
| 21 | M6.3b | Bounds, oscillation, escalation | M6.3a |
| 22 | M8.3b | Tier B harness and the first release run | M8.2, M6.3b |
| 23 | Exit | Exit gate check recorded | all above; decisions 10, 11, 13 |

**Counts.** After #50 and #51: 20 task PRs plus 2 image-lock follow-ups (audio image; render image for M6.1a) to the alpha gate, and the gate record. From the gate to the exit: 19 task PRs (20 with LangGraph), one image-lock follow-up (M8.5), and the exit record. About 44 PRs in all.

## 4. Critical path

**To the alpha gate — 11 PRs in sequence:** M4.0a → M4.0b → M4.5a → M4.1a → M4.2 → M4.3a → M4.4 → M5.1 → M5.4b → A.2 → M8.3a → gate.

Off the path but needed for the gate: M4.5b, M4.1c, A.1, M5.4a, M5.2, M6.1a, M6.1b, M6.1c (9 with M4.1b, which the gate itself does not use). The roadmap audit dated A.1 after M4.1c; it needs only core, so it and M5.4a can start as soon as M4.5a creates the `engine` package. What can stall the path: the audio spike (M4.0b, a stop-and-raise on PCM repeatability), the concat spike in M5.1 (frame-exact stream copy across B-frame parts), and decision 9.

**From the gate to the exit — 9 PRs in sequence:** M7.1a → M7.1b → M7.4 → M7.5a → M7.5b → M7.5c → M6.3a → M6.3b → M8.3b → exit. M7.3 and M7.2 → M7.7 run beside M7.1b and M7.4 and must land before M7.5a (the first task that spends money).

Off the path: M7.6, M6.2, M8.1, M8.2, M8.4, M8.5, M4.3b. The longest non-code lead is M8.2: eight briefs written and reviewed by someone other than the maintainer. Start it at the alpha gate.

## 5. Maintainer decisions

Numbers continue the roadmap audit's §7. Decisions 1 and 3–8 are settled; 2 is still open.

| # | Decision | Recommendation | Due |
| --- | --- | --- | --- |
| 2 | Move the checkout out of iCloud | Yes. Duplicates are back in the tree. | Now |
| 16 *new* | Derive take and music asset ids and re-take seeds (H8) | **Approved 2026-11-20**; added to M4 Task 6 (M4.1a). | M4.1a |
| 17 *new* | Loudness targets apply to the delivered file, with encoder headroom if the spike needs it (H4) | Yes. | M5.1 |
| 18 *new* | Flashing check out of v0.1; caption timing in (H11) | Yes to both. | M6.1a |
| 9 | Go public, or a public mirror for images and tier A assets | Go public at the alpha gate, after a history scan. | Alpha gate (Task 0) |
| 15 | Name, GitHub organisation, npm scope | Decide with 9, not at the exit: the image reference is in every lock and baseline. | Alpha gate if 9 is "public"; otherwise v0.1 exit |
| 12 | LangGraph after M7.1a | Amend D5 and D37 and skip M7.1c in v0.1. Keep the runtime interface. | Before M7.1c (wave 15) |
| 19 *new* | Typed role output instead of raw ops; `plan` and `render` as the run entry points (H1, H2) | Yes to both. | M7 plan approval |
| 20 *new* | Spend and findings ledgers tracked in `log/` (H3) | Yes. | M7.7, M6.3a |
| 10 | Who writes the benchmark briefs | Not the maintainer; a contributor or an agent session, reviewed for neutrality. One brief is already needed for A.2. | A.2, then M8.2 |
| 11 | Monthly evaluation budget and tier B cadence | Set after one measured brief; nightly 1 run with local media, release 3 runs plus pack-swap. | M8.3b Step 1 |
| 13 | Split v0.3; migrations first in v0.2 | Yes to both. | v0.1 exit |
| 14 | Paid raters and their budget (D20) | Needed before the first human study. | v0.2 |

**Proposed decision-log changes** (each needs approval and lands in the PR named):

| Decision | Proposed change | PR |
| --- | --- | --- |
| D5, D37 | "A runtime interface with a plain loop implementation in v0.1; LangGraph or Temporal adapters possible later." D37's "LangGraph (D5) holds run state only" becomes "the workflow runtime holds run state only". | M7.1b, if decision 12 is approved |
| D41 | Add `cinewright review approve` and `review waive` to the commands a harness never auto-approves; name tier B's `--approve-final` as the one exception. | M7.6 |
| D33 | Add: the delivery profile's loudness and true-peak targets are met by the decoded audio of the delivered file. (The PCM contract itself is written by M4.0b.) | M5.1 |
| D36 | Add the renderer (HyperFrames) version to the items pinned per baseline. | M6.2 |
| D17 | Clarify: `init` writes the conservative default cap; intake rejects a project with no budget. | M7.1b |
| D38 | Clarify: storyboard stills are frames of the real renders, produced before G2 and reused after it. | M7.6 |

No other decision is changed by these plans.

## 6. Risks

| Risk | Assessment | Mitigation |
| --- | --- | --- |
| Agents do not reliably produce a film that passes every deterministic check | The largest unknown. The exit gate needs 24 of 24 Auto runs clean, and nothing with a live model has been run yet. | Stub agents first; one development brief by cassette through M7.5; the fix loop before tier B; M8.3b Step 4 budgets time for what the first release run finds. |
| Cassette churn | Any prompt, schema or context change is a miss for that role, and re-recording costs money and review time. | The request hash names the role; record per role, not per run; keep the development brief small. |
| Audio or assembly repeatability | Two spikes can stop the path (M4.0b, M5.1). | Both are scheduled first in their milestones, with a stated fallback (restricted SIMD flags; Annex B concatenation). |
| Tier B cost | Unmeasured. | Decision 11 after one measured brief; hard caps in the harness and in every run (M7.7). |
| HyperFrames and provider churn | The backend is pre-1.0 and bumped only at milestone starts; one LLM and one paid audio vendor. | The bump policy; re-verify steps in every provider task; v0.2 adds a second LLM plugin. |
| One LLM plugin | Invariant 6 is satisfied by the interface but untested by a second implementation. | The stub and cassette plugins exercise the interface in v0.1; an OpenAI-compatible plugin in v0.2. |
| Schema growth without migrations | v0.1 adds only optional fields; that cannot continue. | Migrations are the first v0.2 item (decision 13). |
| Going public | History, name and personal fixtures become visible. | Alpha plan Task 0: scan, decide the name, then switch. |
| Solo review of about 44 PRs | The waves allow three or four PRs in parallel, but one maintainer approves all of them. | The critical path is 20 PRs; everything else can queue without blocking it. |

## 7. After v0.1: release plans

Release level only. Exit criteria are proposals, refined from the roadmap audit's §5; each release gets its own audit and task plans when it starts. Items marked *pulled forward* are scheduled earlier than the spec's roadmap places them, with the reason.

### v0.2 — Cast and sound

- **Scope:** schema versioning and migrations · full cast bible and the Casting role (auditions, voice design, clones with consent records) · multi-voice dialogue in dialogue mode and per-line mode · takes, shortlisting and selection, `assets prune` extended · Dialogue Director · Composer as an agent · a second music provider and an SFX provider · stems · the render gate enforcing consent and licence policy · a second LLM plugin (OpenAI-compatible).
- **Prerequisites:** v0.1 exit; decision 14 (raters) if a human study is wanted for the release; a decision on which second music vendor.
- **Proposed exit criteria:** a 4-character dialogue brief passes every audio check (the spec's gate) · a v0.1 project opens after migration and renders to the same hashes · a cloned voice without a consent record blocks the render · the same brief completes through either LLM plugin with no code or prompt change · tier A gains a multi-voice fixture and tier B a dialogue brief.
- **Pulled forward:** migrations (*unscheduled in the spec*; needed before any outside user keeps a project); the second LLM plugin (tests invariant 6 and makes a keyless agent run possible); the accessibility critic's flashing check (deferred from M6.1).

### v0.3a — Pre-production

- **Scope:** image-based storyboard frames through an image-generation interface · animatic and its gate (Guided gains a fourth gate, D38) · Style Designer and pack derivation from words and references · packs 3 to 6 of D14 · Studio alpha (read, review, approve, comment-to-patch) · estimates covering storyboard and animatic · `cinewright adopt` or a merge driver for IR branches.
- **Prerequisites:** v0.2; the engine API stable enough for Studio to call; a choice of image provider by benchmark, not by name.
- **Proposed exit criteria:** Guided pauses at four gates · all six packs pass the shared pack checks, the specimens and their own rubric thresholds · a derived pack passes the same checks · two IR branches can be reconciled with the result recorded as a `user` patch · a review done in Studio produces the same patches as the CLI.
- **Pulled forward:** `adopt` (*unscheduled*; Studio brings team use, and D41 forbids merging until it exists).

### v0.3b — Blender

- **Scope:** `plugins/backend-blender` (GPL-3.0) over the backend kind interface from M5.4a, as a subprocess · the bpy version adapter and its conformance suite · Cycles in a pinned GPU image · the 3D component library and asset registry · HyperFrames compositing of 3D layers with alpha · GPU CI.
- **Prerequisites:** the open question on a GPU CI provider; the backend interface proven across a process boundary; v0.2's migrations. Independent of v0.3a.
- **Proposed exit criteria:** a 3D product shot renders twice with identical frame hashes on one runner class · the boundary check proves no `bpy` import outside the plugin · the blank-frame critic covers Blender output · a mixed film (HTML shots and one 3D shot) passes tier A.

### v0.4 — Footage and characters

- **Scope:** video-generation and image-generation plugins · character sheets · lip sync as a post-pass · render-guided generation · capability routing across generative providers · the monthly model benchmark · continuity and clearance critics · colour management.
- **Prerequisites:** v0.3a (image generation, character sheets) and v0.3b (blocking passes for render-guided shots); decision 14 answered, since generative quality needs human rating.
- **Proposed exit criteria:** a narrator-plus-two-characters brief with lip sync passes · routing picks a plugin from benchmark data with no model name in core · every generated asset carries provider, model, tier and licence, and the render gate blocks one without a usable licence · a continuity defect seeded across two shots is caught.
- **Pulled forward:** colour management (*unscheduled*; needed as soon as footage from two sources shares a timeline).

### v0.5 — Interchange and scale

- **Scope:** OTIO and FCPXML export · TypeScript and Python SDKs · the MCP server · distributed render · localization, including a right-to-left script and a pinned CJK font · sandboxed third-party plugins and registry groundwork · C2PA credentials, disclosure policies and an audio description track.
- **Prerequisites:** v0.4; the plugin contract stable enough to sandbox; D32's out-of-process worker design.
- **Proposed exit criteria:** an exported timeline opens in Resolve and in Premiere with media linked · a project localized into a non-Latin and a right-to-left script passes every check · an untrusted plugin runs sandboxed and cannot write project state · the same project renders to the same hashes on one machine and on a worker pool.
- **Pulled forward:** right-to-left and CJK text support in components should start in v0.3a's pack work, because the benchmark needs three languages by v1.0 and components already carry a known CJK gap.

### v1.0

- **Scope:** IR v1 and the plugin contracts frozen · the registry with conformance badges · the full `AGENTS.md` §4.1 benchmark · the human rating panel (D20) · the RFC process live.
- **Prerequisites:** v0.5; paid raters contracted; every §4.1 coverage row with at least one fixture.
- **Proposed exit criteria:** every §4.1 coverage row has a tier A or tier B fixture · a blinded pairwise study by raters other than the maintainer is published · no schema change without an RFC and a migration, checked in CI · every first-party plugin passes its conformance kit from the registry's point of view.
