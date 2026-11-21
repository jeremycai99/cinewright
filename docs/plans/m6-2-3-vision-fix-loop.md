# M6.2–M6.3 — Vision Critic and Fix Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-20. Written 2026-11-20. It needs `docs/plans/m7-engine-agents.md` Tasks 1–8 (runtime, scheduler, LLM interface, agent runner, gates, budget) and, for Tasks 2 and 3, Task 11 (Shot Builder and Editor).

**Goal:** Close the quality loop:
- a vision critic that scores keyframes and transition strips against the brief, the resolved pack and craft rules, with its variance measured and its versions pinned;
- a findings ledger that outlives a run;
- routing of every finding to an owner, deterministic fixers first;
- bounds, oscillation detection, a regression guard and escalation to a gate, so the loop always ends.

**Architecture:**
- **The vision critic is an agent role with no write scope.** `agents/roles/vision_critic/` holds its prompt and output schema; the agent runner (M7.4) builds its context pack and validates its output. Its output is scores and findings, never a patch. The rubric is a versioned data file in `eval/rubrics/`.
- **Findings become durable.** `log/findings.jsonl` is append-only and tracked, like the decision log. It records each finding raised, each fix attempt, each resolution and each escalation. Attempt counts and signature history are read from it, so deleting `.cinewright/runs/` cannot reset a bound, and `finding:<id>` citations always resolve.
- **The fix loop is the reconciler plus a table.** Open findings are an input to `reconcile`. For each one the critic orchestrator (engine code, D37) looks up `engine/fix-routing.json`, emits a deterministic fixer task or a fix task for the owning role, and the normal pipeline re-runs what the resulting patch dirtied. There is no second control loop.
- **Fixers are jobs.** A fixer is a pure function from a finding to a patch or a job re-run. It writes as `job` and obeys authorship like any other author.

**Tech Stack:** no new dependency. Strips are tiled with the pinned FFmpeg in the render image.

**Spec:**
- `docs/V0_1_PLAN.md`: §M6.2, §M6.3, §Critique and fix loop (routing table, bounds), §Gates and autonomy presets, Open issue 12, §Exit gate.
- `docs/plans/roadmap-audit-2026-11-16.md`: §4 (M6.2, M6.3a, M6.3b), §6.
- `docs/plans/m6-1-deterministic-critics.md` (`CriticFinding`, `RULES`, signatures) and `docs/plans/m7-engine-agents.md` (runner, cassettes, gates, budget).
- `docs/DESIGN_SPEC.md`: §Quality system, D33, D36, D37; `AGENTS.md` §2.2, §4.2, §8.

## Decisions this plan makes

| Choice | Value | Why, and the cost if wrong |
| --- | --- | --- |
| Rubric | `eval/rubrics/craft/v1.json`: criteria, each with an id, a question, and anchored descriptions for scores 1 to 5.<ul><li>**Shot level:** `hierarchy`, `composition`, `legibility`, `pack_conformance`.</li><li>**Scene level:** `rhythm`, `continuity`.</li></ul>Every criterion is phrased against the brief, the resolved pack rules given in the context, or a craft rule id. None names a look. | `AGENTS.md` §2.2: a playful pack and a restrained pack must both score well when executed well. A lint test applies the prompt lint to the rubric. |
| What the critic sees | Per shot and deliverable: the keyframe stills (M3.5) with their text boxes as text, the shot's intent and lines, the resolved tokens it uses, the pack rules by id, and the craft rules. Per scene: one contact strip per transition segment (first, middle and last frames of the overlap) and the neighbouring shots' stills. Stills are downscaled by the plugin to its documented limit; the downscale is part of the request hash. | The roadmap's "keyframes and transition frame strips". No video input in v0.1. |
| Output | `{ scores: [{ criterion; score: 1–5; target: entity id; evidence: string }]; findings: [{ criterion; target; frames?; observation; suggestion }] }`. Each finding becomes a `CriticFinding` with rule `vision.<criterion>`, the target as `entity`, and a signature over rule, target and deliverable. | Every finding names a shot or scene (M6.2). The signature omits the prose so a re-worded complaint is the same finding. |
| Severity | Vision findings are **warnings**. They enter the fix loop but never block export on their own. A score at or under `vision.floor` (data, default 2) raises the finding's priority in the loop, not its severity. | The exit gate requires 100% of deterministic checks, not a model's opinion. A non-deterministic critic that could block would make the gate unrepeatable. Cost if wrong: a poor-looking film can export; the gate packet shows the scores and the user decides. |
| Pinning (D36) | A baseline file records: the `pin` passed to `llm.generate`, the model id the plugin reported, the role version (prompt hash), the rubric version, the critic plugins' versions and the HyperFrames version. Any change makes a new baseline. **Proposed D36 addition:** name the renderer (HyperFrames) version among the pinned items. | The roadmap audit's exit-gate clarification, not yet in the decision log. |
| Variance | The model's sampling cannot be fixed (M7 plan), so variance is measured, not removed: N = 5 scoring runs per tier A fixture, per criterion mean and standard deviation, stored in the baseline. | M6.2's criterion. Cost: 5 × the critic's calls per fixture, once per baseline. |
| Pack threshold | For each pack and criterion, `threshold = baseline mean − 2 × baseline sd`, floored at `vision.floor + 1`, written into the baseline file when it is recorded and never computed at check time. A later run passes when its mean over its runs meets the threshold. | Open issue 12: the pass condition must be a recorded number. |
| Tier A stays free | Tier A replays the critic's cassettes for the frozen fixtures; a changed still is a cassette miss, reported as "vision not evaluated", not a failure. Live scoring happens in tier B and when a baseline is recorded. | Tier A may call no paid API. |
| Findings ledger | `log/findings.jsonl`. Entry kinds: `raised` (the finding, revision, run), `attempt` (finding id, owner, task key, result revision), `resolved` (finding id, revision), `escalated` (finding id, reason, gate), `waived` (finding id, by a user, note). A finding is open when its last entry is `raised` or `attempt`. | The same reasoning as the spend log (M7 plan): bounds and citations must not live in disposable run state. Cost if wrong: log noise in git. |
| Routing table | `engine/fix-routing.json`: for each rule or rule prefix, an ordered list of owners, each `{ owner: OwnerClass; via: "fixer:<id>" \| "role" \| "job:<step>" \| "suggest" }`. It encodes the table in `V0_1_PLAN.md` §Critique and fix loop, plus four rows that table lacks: `captions.missing_line` → Director; `layout.density` → Shot Builder; `timing.uncovered` → Director; `clearance.*` → human, blocking export. | Routing is data, so a community critic can add rows. |
| Deterministic fixers in v0.1 | <ul><li>`fixer:mix_headroom`: for `audio.true_peak` and `audio.loudness`, re-run the mix with the limiter ceiling lowered by `fix.headroom_step_db`, at most twice.</li><li>`fixer:retake`: for `stt.mismatch`, a narration re-take with a new derived seed, at most twice.</li><li>`fixer:rerender`: for `video.blank` and `video.frozen`, one re-render with the cache entry set aside.</li><li>`fixer:contrast_role`: for `contrast.text` where the layer's colour is a token reference, switch to the pack's paired role for that background if `contrastPairs` lists one that passes.</li></ul> | "Deterministic fixers before agents." Each is a few lines over existing jobs. Layout findings go to the Shot Builder: reflowing text is a creative call. |
| Bounds are policy | `policies.fix: { attempts_per_owner; rounds_per_shot; qa_rounds; reserve_fraction }`, optional on the project, defaulting from `engine/settings.json` to 2, 3, 3 and the estimate's reserve. | `V0_1_PLAN.md` §Bounds: project policy, engineering defaults. |
| Oscillation | A finding id that is `raised` again after a `resolved` entry for the same entity stops fixing for that entity and escalates with reason `oscillation`. | The signature is stable by construction (M6.1 plan). |
| Regression guard | After any fix to a shot, every deterministic critic re-runs for that shot (`scope.shots`), not only the one that failed. A new error finding caused by the fix counts as a round for the shot. | §Bounds. |
| Escalation | An escalated finding goes into the next gate's packet with its attempts and evidence. In Auto that is the final gate. Export proceeds when no **error** finding is open; a `waived` entry by a user closes an error finding other than `clearance.*`. | The loop must end, and a person must be able to overrule a critic. |
| Locked fields | A fix that would change a field a gate locked is submitted in `propose` mode and becomes a suggestion in the next packet; the finding moves to the next owner. | §Workflow: fixes do not re-open a gate. |

## Global Constraints

- **The rubric and the critic prompt pass the prompt lint:** no colour, font, easing, duration, pack id or aesthetic adjective used as a standard.
- **Critics do not patch; fixers and agents do,** through the store, under authorship and scope. A fixer never writes a `user` or `locked` field.
- **Every bound is read from policy or settings;** no loop constant in code.
- **Termination:** for any input, the loop ends in at most `qa_rounds` QA passes. A property test generates finding sequences and proves it.
- **No LLM call in required CI:** stub critics and stub agents, or cassettes.
- **Costs:** every critic call and fix call is a paid task with a reservation; fix spending stops at the reserve and escalates.
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.

## Review Focus

1. **Two contrasting packs, one rubric.** On the tier A fixtures, the neutral and playful films each meet their own recorded thresholds, and a film built with one pack's tokens but graded against the other pack's rules scores lower on `pack_conformance`. Test: Task 1.
2. **Each seeded defect reaches the right owner.** Overflowing title → Shot Builder for that shot; low contrast → the contrast fixer, then the Shot Builder; clipped audio → mixer fixer, then human; missing caption → Director; short hold → Editor, then Writer as a suggestion when lines are locked. Test: Task 2.
3. **A fix that breaks something else.** A stub Shot Builder that cures the overflow by shrinking text under the minimum size is caught by the regression guard in the same round, and the shot's round count rises. Test: Task 3.
4. **An oscillating fix.** A stub that alternates between two layouts, each failing a different rule, is stopped at the first reappearance and escalated with both finding ids; the run ends without reaching the QA round limit. Test: Task 3.
5. **Bounds survive a restart.** Killing the process mid-loop and deleting `runs/` does not give a finding fresh attempts: the counts come from `log/findings.jsonl`. Test: Tasks 2 and 3.

---

## Tasks

PR order: Task 1 needs M7 Tasks 5 and 6 and can run beside M7 Tasks 9–11. Task 2 needs Task 1 and M7 Task 11. Task 3 needs Task 2. Each task is one PR.

### Task 1: Vision rubric critic (PR M6.2)

**Files:** `eval/rubrics/craft/v1.json`, `eval/rubrics/schema/rubric.schema.json`, `agents/roles/vision_critic/{role.json,prompt.md,output.schema.json}`, `engine/src/critics/{vision,strips}.ts`, `engine/src/critics/run.ts` (register), `eval/src/cinewright_eval/{baseline,variance}.py`, `fixtures/benchmark/baselines/README.md`, `engine/test/critics/cassettes/…`, `docs/DESIGN_SPEC.md` (D36, if approved).

**Interfaces:**
- `visionCritique(store, { deliverable, scope?: { shots?; scenes? }, pin?, rubric }): Promise<{ scores: Score[]; findings: CriticFinding[]; meta: { model; role_version; rubric_version } }>`.
- `transitionStrip(segmentDir, image): Promise<{ file; sha256 }>`: three frames tiled left to right, cached in the segment's cache entry.
- `cinewright-eval baseline record --suite tier-a --runs 5 --pin <id>` → `fixtures/benchmark/baselines/<date>-<short hash>.json`: `{ pins: { critic_pin; model; role_version; rubric_version; critics; hyperframes; images }, fixtures: { <id>: { <deliverable>: { <criterion>: { mean; sd; n } } } }, thresholds: { <pack>: { <criterion>: number } } }`.
- `cinewright-eval baseline check <report> --against <baseline>` → per pack and criterion: mean, threshold, pass.

- [ ] **Step 1: Write the rubric.** Review each criterion against the neutrality test (`AGENTS.md` §2.3), and record the review in the PR.
- [ ] **Step 2: Write the failing tests** with a stub LLM.
  - The context pack holds stills by hash, text boxes, intent, resolved tokens, pack rules and craft rules, and nothing from another shot.
  - Output with a score outside 1–5, an unknown criterion, or a target that is not a shot or scene of the task is refused and repaired.
  - Every finding has rule `vision.<criterion>`, severity `warning`, an entity, and a signature that ignores the wording.
  - The strip is three frames of the right segment, byte-identical on two runs.
  - Baseline arithmetic: the threshold formula, the floor, and `check` pass and fail cases.
  - The rubric and prompt pass the lint; a planted "dark, cinematic look" fails it.
- [ ] **Step 3: Record cassettes and a first baseline** on the two tier A fixtures, 5 runs, within the test budget. Note the cost.
- [ ] **Step 4: Cross-pack check (Review Focus 1)**, recorded in the PR with the scores.
- [ ] **Step 5: Verify.** Tier A replays the cassettes and reports the scores without failing on them.
- [ ] **Step 6: Commit.**

### Task 2: Findings ledger, routing and deterministic fixers (PR M6.3a)

**Files:** `core/src/project/layout.ts` (`FINDINGS_LOG = "log/findings.jsonl"`), `core/schema/finding-entry.schema.json`, `engine/src/fix/{ledger,route,orchestrate}.ts`, `engine/fix-routing.json`, `engine/schema/fix-routing.schema.json`, `engine/src/fix/fixers/{mix_headroom,retake,rerender,contrast_role}.ts`, `engine/src/reconcile/reconcile.ts` (open findings as input), `engine/src/agents/context.ts` (findings section), `fixtures/benchmark/defects/{overflow_title,low_contrast,clipped_audio,missing_caption,short_hold}/`, tests.

**Interfaces:**
- `FindingsLedger = { open(): CriticFinding[]; history(id): Entry[]; raise(findings, revision, run); attempt(id, owner, taskKey, revision); resolve(id, revision); escalate(id, reason, gate); waive(id, note) }`.
- `syncFindings(ledger, current: CriticFinding[], revision)`: raises new ids, resolves open ids that are absent from a critic run that covered their entity.
- `route(finding, history, ir, routing): { owner; via } | { escalate: string }`: the first owner whose attempts are under the bound and whose target field is writable.
- `Fixer = (finding, ctx) => Promise<{ patch?: Patch; rerun?: StepKind[] } | null>`; `null` means "cannot fix".
- Fix task: `Task` with `kind: "agent" | "job"`, `phase: "P11"`, `entities` of the finding's entity, and `finding: id`. Its key includes the finding id and the attempt number.

- [ ] **Step 1: Build the five defect fixtures** through the store, with media synthesized at test time. Each README states the defect, the rule expected and the owner expected.
- [ ] **Step 2: Write the failing tests** with stub agents.
  - **Ledger:** the entry kinds validate; open and history are right after a raise, two attempts and a resolve; the file is append-only.
  - **Sync:** a finding absent from a scoped critic run that did not cover its entity stays open.
  - **Routing (Review Focus 2):** all five fixtures, plus one test per row of the routing table using a synthetic finding.
  - **Fixers:** `mix_headroom` brings a file 0.4 dB over the true-peak limit under it in one step; `retake` selects a new take and the finding resolves when the stub's second take matches; `rerender` re-renders once and escalates if the frame is still blank; `contrast_role` swaps to a passing role and returns `null` when the pack has none.
  - **Automatic resolution:** the layout fixture (stub Shot Builder returns a shorter title), the contrast fixture and the loudness fixture each end with no open error finding and a film that passes every check.
  - **Fix context:** the owner's context pack carries the finding with its evidence, and its decision cites `finding:<id>`.
  - **Locked target:** after G2, a fix to a locked layout template is a pending suggestion and the finding moves to the next owner.
  - **Restart (Review Focus 5).**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Record one cassette run** of the real Shot Builder fixing the overflow fixture; replay it in CI.
- [ ] **Step 5: Verify and commit.**

### Task 3: Bounds, oscillation, regression guard, escalation (PR M6.3b)

**Files:** `engine/src/fix/{bounds,oscillation,guard,escalate}.ts`, `core/schema/project.schema.json` (`policies.fix`), `engine/settings.json`, `engine/src/gates/packet.ts` (escalated findings), `engine/src/cost/reserve.ts` (fix reserve), `cli/src/commands/review.ts` (`review waive <finding> --note`), `fixtures/benchmark/defects/oscillation/`, tests.

**Interfaces:**
- `withinBounds(finding, history, policy, shotRounds, qaRounds): { ok: true } | { ok: false; reason: "attempts" | "shot_rounds" | "qa_rounds" | "reserve" | "oscillation" }`.
- `oscillating(id, history): boolean`.
- `guardScope(patch, ir): { shots: string[] }`: the shots a fix patch touched, for the scoped critic re-run.
- `exportable(ledger): { ok: boolean; blocking: CriticFinding[] }`.

- [ ] **Step 1: Write the failing tests.**
  - **Bounds:** a stub that never fixes gets 2 attempts per owner, then the next owner, then escalation; a shot stops at 3 rounds; a run stops at 3 QA rounds; each limit read from `policies.fix` when set.
  - **Reserve:** fix calls stop when the reserve is spent, and the remaining findings escalate with reason `reserve`.
  - **Oscillation (Review Focus 4).**
  - **Regression guard (Review Focus 3).**
  - **Termination property:** for 1,000 generated sequences of stub fix outcomes, the loop ends within the bounds and every finding is resolved, escalated or waived.
  - **Escalation:** the next gate's packet lists each escalated finding with attempts and evidence; in Auto it is the final gate; `exportable` is false while an error finding is open and true after `review waive`, except for `clearance.*`.
  - **Manual preset:** findings become suggestions, never patches.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** on the development brief by cassette replay: the run ends at G3 with every error finding resolved or escalated, and the event log shows each round.
- [ ] **Step 4: Commit.**

## Done when (M6.2–M6.3 acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| M6.2: rubric and prompt versioned; critic model pinned per baseline; each finding names a shot or scene | Task 1 |
| M6.2: run-to-run score variance on tier A fixtures is measured and recorded | Task 1 Step 3 |
| M6.2: each v0.1 pack's mean rubric score on its tier A fixtures meets a threshold recorded in the baseline | Task 1 Steps 3 and 4 |
| M6.3a: each seeded defect (overflowing title, low contrast, clipped audio, missing caption, hold time too short) is detected and routed to the right owner | Task 2 |
| M6.3: the loop resolves at least the layout, contrast and loudness fixtures automatically | Task 2 |
| M6.3b: a seeded oscillating fix is stopped and escalated; the regression guard re-runs every deterministic critic | Task 3 |
| §Bounds: per-finding, per-shot and per-run limits; fix budget reserve; escalation to a gate | Task 3 |
| Exit gate: rubric scores reported per brief with variance against a pinned critic | Task 1 (mechanism); `docs/plans/m8-cli-benchmark.md` Task 4 (tier B numbers) |
