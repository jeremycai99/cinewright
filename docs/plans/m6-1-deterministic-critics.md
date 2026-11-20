# M6.1 — Deterministic Critics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-20. Written 2026-11-20. It follows `docs/plans/m5-assembly-delivery.md` and belongs to the v0.1-alpha gate. M6.2 and M6.3 are planned in `docs/plans/m6-2-3-vision-fix-loop.md`.

**Goal:** Make "passes every deterministic check" a command result:
- one finding shape, with a stable signature, for every critic and for the fix loop that comes later;
- a critic kind interface with conformance cases;
- layout critics that read the rendered page: overflow, density, collision, safe area, minimum text size, contrast;
- media critics that read the delivered file: loudness, true peak, silence, clipping, blank frames, format, plus clearance checks on the IR;
- script critics: transcript against script, and caption timing;
- a `critique` step in `cinewright render` that writes a report and sets the exit code.

**Architecture:**
- **Findings.** M4 put `Finding` in `core/src/findings.ts`. This plan adds `CriticFinding`, which extends it with an id, a signature, the critic's id and version, a deliverable, a frame range and evidence. Solver and compile findings keep the short form; `sign()` lifts them when a report needs one shape.
- **Critics are plugins of kind `critic`** (the manifest schema already has the kind), each with one method, `critic.run`. Three first-party plugins, all Apache-2.0 and in process:
  - `plugins/critic-layout` wraps `render-job check` and `render-job boxes`;
  - `plugins/critic-media` runs the pinned FFmpeg in the render image and reads PCM on the host;
  - `plugins/critic-script` is pure TypeScript over frozen transcripts and cues.
- **Thresholds are data.** A value that a delivery profile or a pack already holds is read from there (loudness, true peak, caption rules, contrast floors, minimum text size, hold times). Engineering tolerances with no home in either live in each plugin's `settings.json`, and the plugin version is part of every baseline (D36).
- **The engine runs critics** (`engine/src/critics/run.ts`) after assembly, merges their findings with the solver's, sorts and dedupes by signature, and writes a report. Critic orchestration is engine code (D37). No fixer and no routing here.

**Tech Stack:** HyperFrames `check` at the pinned version (through `render-job check`), the pinned FFmpeg (`ebur128`, `ffprobe`), Ajv. No new dependency. WCAG and loudness facts were checked on 2026-11-20 (§External facts).

**Spec:**
- `docs/V0_1_PLAN.md`: §M6.1, §Critique and fix loop (the finding fields and the routing table), Open issue 8, §Exit gate.
- `docs/plans/roadmap-audit-2026-11-16.md`: §4 M6.1 table, §3.1 (wrap `render-job check`; the HyperFrames version is part of the baseline), F2, F12, F21.
- `docs/plans/audit-m3-m4-plan-2026-11-16.md`: G3, G8, G11.
- `docs/plans/m4-audio.md`: Decisions "Findings", "Alignment and transcription", "Words with no time", "Mix loudness method".
- `docs/DESIGN_SPEC.md`: §Quality system (deterministic gates), D33, D35, D36; `AGENTS.md` §4.2 and §5.

## Decisions this plan makes

| Choice | Value | Why, and the cost if wrong |
| --- | --- | --- |
| **Severity names** | Keep M4's `"error" \| "warning"`. "Blocking" in `V0_1_PLAN.md` means `error`. The plan text is updated in Task 1. | The type exists in code after M4.5a; two vocabularies would need a mapping in every consumer. |
| **Finding shape** | `CriticFinding = Finding & { id; signature; critic: { id; version }; deliverable?; frames?: Span; evidence }`.<ul><li>`entity` is an entity id, and `pointer` a JSON Pointer inside it: together they are the plan's "entity path".</li><li>`frames` is on the project timeline.</li><li>`evidence` is `{ measured?; limit?; selector?; box?; still?; text? }`: numbers and references, never prose.</li></ul> | The six fields `V0_1_PLAN.md` requires (type, severity, entity path, frame range, evidence, signature). |
| **Signature** | `signature = sha256(JCS({ rule, entity, pointer, deliverable, key }))`, where `key` is the part of the evidence that stays the same while the defect persists: a selector or prop path, never a measured number. `id = "f_" + first 12 hex digits`. | The fix loop detects oscillation by a signature reappearing (M6.3b). A signature that carried "overflows by 14 px" would change on every attempt. Cost if wrong: oscillation goes unseen; M6.3b tests it. |
| Rule names | `<area>.<defect>`, lower snake case, listed in one table in `core/src/findings.ts` with severity and the routing owner class. A critic that emits a rule not in the table fails conformance. | One vocabulary for routing (M6.3a), reports and tier A pass rates. |
| What the layout critic samples | The shot's keyframe times (`sampleFrames`, M3.5) per deliverable. A defect between samples is not seen; the README says so. | The stills and text boxes already exist for those frames; denser sampling is a later setting, not a design change. |
| Layout rules and their sources | <ul><li>`layout.overflow`, `layout.density`: the component markers that `render-job check` reports (M2.5b).</li><li>`layout.collision`: two text boxes of different layers intersect by more than `collision.min_overlap_px`.</li><li>`layout.safe_area`: a text box leaves `safeRect(pack, profile)`'s title-safe rectangle.</li><li>`layout.min_text_size`: computed font size below the resolved `density.min_text_size`.</li><li>`contrast.text`: the contrast findings of HyperFrames `check` at the sample; `contrast.pack_pair`: a pair from `contrastPairs` under the pack's own floor (a pack defect).</li><li>`layout.check`: any other error from `check`, with its code in the evidence.</li></ul> | Wrap, do not rewrite (audit §3.1). Safe areas stay with the delivery profile, so HyperFrames' own safe-zone check remains off. |
| Text boxes carry their font size | `render-job boxes` adds `font_size` (computed px) to each box. This changes the render image, so Task 1 rebuilds and re-locks it, at a milestone start as the bump policy allows. | The size check needs the computed value; box height cannot give it for wrapped text. Cost: one image rebuild and a new digest for baselines not yet recorded. |
| Hold time | Not a critic. `timing.short_hold` comes from the solver (M4.2); the engine includes solver findings in the report. | One reader of `density.min_hold` and `hold_per_word`. |
| Loudness and peak | `audio.loudness` and `audio.true_peak`, measured on the **decoded audio of the delivered MP4** with `ebur128=peak=true`, against the profile (`integrated_lufs` ± `tolerance_lu`, `true_peak_dbtp`). | The profile describes the delivered file (M5 plan). Measurement follows ITU-R BS.1770 as FFmpeg implements it; the targets are data, so R 128 or streaming targets are a profile choice, not code. |
| Silence | `audio.silence`: a run of samples under `silence.floor_dbfs` longer than `silence.max_ms`, anywhere in the programme. Both values are in the plugin's settings. | A film without music has true silence between lines; the limit says how much is a defect. It is an engineering default that a project can override in M6.3b's policy, not a pack value. |
| Clipping | `audio.clipping`: `clipping.min_run` or more consecutive samples at full scale in the decoded audio. Counted on the host from raw PCM. | Deterministic and independent of an FFmpeg filter's wording. |
| Blank frames, not `blackdetect` or `freezedetect` | <ul><li>`video.blank`: at a keyframe sample where the mount spec says at least one layer is visible, the still is one uniform colour.</li><li>`video.frozen`: every frame of a shot's body has the same hash although a layer of the shot has an entrance.</li></ul>Both are read from the cached stills and `framemd5.txt`; no FFmpeg run. | A held title is a legitimate still image, and a dark pack is legitimately dark before its first entrance. Threshold filters would flag both, which fails the neutrality test. The mount spec says what should be on screen. Cost if wrong: a partial render failure that still draws something is missed; the layout critic and `check` cover that. |
| Format | `spec.ffprobe`: container, codecs, pixel format, size, frame rate, frame count against the solved timeline, sample rate, channels, audio within two encoder frames of the video, and `max_duration` when the profile sets it. Uses `probe` from `export-mp4`. | The registry's two profiles set no `max_duration` today; the check must treat it as optional. |
| Clearance | `clearance.license_missing` (a used asset with no licence), `clearance.noncommercial` (when `policies.require_commercial_license`), `clearance.consent_missing` (D18). Pure function `clearanceFindings(ir, deliverableId)` in core, called by the engine. | "Licence and consent presence" is an IR check; it needs no plugin. `export` (M8.1) blocks on these. |
| Transcript against script | `stt.mismatch`, per line: word error rate between the normalized script words and the frozen transcript, over `stt.max_wer`. Script words the take marks `interpolated` (digits, symbols) are wildcards that match any one to `stt.wildcard_max` transcript words. No live STT: a take without a frozen transcript is `stt.no_transcript` (a warning in `render`, an error in tier A). | Open issue 8. The alignment already says which words a recognizer cannot be compared on, so no number-to-words table per language is needed. |
| Caption timing | `captions.overlap`, `captions.out_of_range`, `captions.short_display`, `captions.line_too_long`, `captions.missing_line` (a spoken line with no cue), `captions.sync` (a cue starts more than `captions.sync_frames` from its first word). Read from `timelineCues` and the written sidecars. | `AGENTS.md` §4.2 lists caption timing among the deterministic checks; `V0_1_PLAN.md` §M6.1 omits it. |
| Flashing | **Not in v0.1.** Recorded in `V0_1_PLAN.md` §Scope as out, scheduled with the accessibility critic. | WCAG 2.3.1 needs flash area and luminance analysis; the v0.1 component set has no strobing preset. Raised as a scope decision, not silently dropped. |
| Report and exit code | `.cinewright/cache/reports/<assembly key>.json`: `{ deliverable, revision, critics: [{ id, version }], findings, measured }`. `cinewright render` exits **10** (`findings`) when any finding is an error. `--no-critics` skips the step. | One new exit code; agents branch on it. |
| Where findings live | In the report only. The durable findings ledger (`log/findings.jsonl`) arrives with the fix loop (M6.3a). | Nothing needs history before a loop exists. |

## Global Constraints

- **Rules from earlier milestones:** M1–M5 conventions bind. A critic grades against the brief, the resolved pack and general craft rules, never a house look (`AGENTS.md` §2.2).
- **No taste literals:** a limit comes from the delivery profile, the resolved pack, or the plugin's `settings.json`. A numeric literal that is a threshold fails a lint test in each critic package.
- **Determinism:** the same deliverable and the same critic versions give the same findings in the same order (sorted by rule, entity, pointer, frames). No critic calls a network, a clock or a model.
- **Critics never write the IR** and never fix anything. They return findings; the engine records them.
- **Every rule ships with a seeded failing fixture** and a passing one, built through the store, with media synthesized at test time.
- **Container tests run in CI** and may not skip (G2).
- **Baselines:** the critic plugin versions, their settings hash and the HyperFrames version are recorded in every report (D36).
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.
- **Neutrality test item 4:** it doesn't apply until the alpha gate; each PR says so.

## Review Focus

1. **A signature that survives a failed fix.** The overflowing-title fixture, re-rendered with a slightly shorter title that still overflows, gives the same finding id; fixing it removes the finding; a different layer overflowing gives a different id. Test: Task 1.
2. **Legitimate stills and dark packs.** A three-second held end card and a pack with a black background before its first entrance raise no `video.*` finding; a shot rendered with its layers removed from the page does. Test: Task 2.
3. **Numerals and symbols in the transcript check.** "In 2014 it cost £13.60." against a transcript that spells the numbers out passes; a transcript missing "cost" fails, naming the line and the word. Test: Task 3.
4. **Both aspect classes.** The same shot that passes in landscape and leaves the title-safe area in portrait is reported once, for the portrait deliverable only, with the profile's rectangle in the evidence. Test: Task 1.
5. **The delivered file, not the master.** A deliverable whose master meets the targets but whose encoded audio exceeds the true-peak limit fails `audio.true_peak` with both measurements; with the M5 headroom applied it passes. Test: Task 2.

---

## Tasks

PR order: Task 1 needs M3.5 and the M5.4a interface. Task 2 needs M5.1. Task 3 needs M4.5b and M5.2. The three can be reviewed in parallel once their inputs exist; the `critique` step lands with Task 1 and each later task registers its critic. Each task is one PR, plus the image lock follow-up after Task 1.

### Task 1: Critic interface, finding schema, layout critics (PR M6.1a)

**Files:**
- **Core:** `core/src/findings.ts` (`CriticFinding`, `RULES`, `sign`, `findingId`), `core/schema/finding.schema.json`, `core/src/clearance.ts`.
- **SDK:** `plugins/sdk-ts/src/kinds/critic.ts`, `plugins/sdk-ts/schema/kinds/critic.schema.json`, `plugins/sdk-ts/test/fixtures/stub-critic/`.
- **Backend:** `plugins/sdk-ts/src/kinds/backend.ts` and `plugins/backend-hyperframes/src/plugin.ts` (`render.check`).
- **Container:** `container/render-runner/src/boxes.ts` (`font_size`), its tests, `container/image.lock.json` (follow-up PR).
- **Plugin:** `plugins/critic-layout/{manifest.json,package.json,settings.json,src/{index,plugin,markers,geometry,contrast}.ts,test/…,README.md}`.
- **Engine and CLI:** `engine/src/critics/run.ts`, `engine/src/pipeline/{plan,run}.ts` (`critique` step), `cli/src/commands/render.ts`, `cli/src/exit-codes.ts` (`findings: 10`), `cli/README.md`.
- **Docs:** `docs/V0_1_PLAN.md` (severity wording; flashing in §Scope).

**Interfaces:**
- `sign(f: Finding, extra: { critic; deliverable?; frames?; evidence; key: string }): CriticFinding`; `findingId(signature): string`.
- `RULES: Record<string, { severity: "error" | "warning"; owner: OwnerClass }>`; `OwnerClass = "shot_builder" | "editor" | "writer" | "director" | "narration" | "mixer" | "render" | "assembly" | "human"`.
- `critic.run`: `{ project, deliverable, timing: SolvedTiming, image, artifacts: { assembly?: string; renders: Record<string, string>; captions?: { srt; vtt } }, scope?: { shots?: string[] } }` → `{ findings: CriticFinding[]; measured: Record<string, number> }`.
- `render.check`: common backend params + `{ shot }` → `{ failures: Failure[]; boxes: { frame: number; boxes: TextBox[] }[] }`, cached in the render's cache entry.
- `critique(store, { deliverable, report: RenderReport, image, scope? }): Promise<{ findings: CriticFinding[]; file: string }>`.

- [ ] **Step 1: Record the HyperFrames `check` codes** that the pinned version emits in the `layout` and `contrast` sections, in the plugin README, with the rule each maps to. Anything unmapped becomes `layout.check`.
- [ ] **Step 2: Write the failing tests.**
  - **Schema and signature (Review Focus 1):** a finding validates; the id is stable under a changed measurement and differs for another layer; findings sort deterministically.
  - **Conformance:** the critic kit accepts the stub critic; a rule outside `RULES` is rejected; a finding without evidence is rejected.
  - **Seeded fixtures, one failing and one passing each:** `layout.overflow` (a title too long for its region), `layout.density` (7 bullets under a limit of 5), `layout.collision`, `layout.safe_area`, `layout.min_text_size`, `contrast.text`, `contrast.pack_pair`. Each finding names the layer as `entity`, the prop or field as `pointer`, and the sample frame.
  - **Aspect classes (Review Focus 4).**
  - **Scope:** `scope.shots` limits the run to those shots; an unchanged shot's check is a cache hit.
  - **Clearance:** an asset with no licence, a non-commercial asset under `require_commercial_license`, and a cloned voice with no consent record each give their finding.
  - **CLI:** `render` on the overflow fixture exits 10 and prints the finding; `--json` carries the report path; `--no-critics` exits 0.
  - **No threshold literals:** the lint test fails on a number compared against a measurement in `src/`.
- [ ] **Step 3: Implement.** Rebuild the render image locally for the `boxes` change.
- [ ] **Step 4: Verify.** Full suite and container tests. The M3 specimens still pass on the rebuilt image. After merge, publish the image; a follow-up PR locks the digest.
- [ ] **Step 5: Commit.**

### Task 2: Media critics (PR M6.1b)

**Files:** `plugins/critic-media/{manifest.json,package.json,settings.json,src/{index,plugin,loudness,silence,clipping,frames,spec}.ts,test/…,README.md}`, `engine/src/critics/run.ts` (register), `.github/workflows/render-smoke.yml`.

**Interfaces:**
- `measureDelivered(file, image, limits): Promise<{ integrated_lufs; true_peak_dbtp; samples; sample_rate; channels }>`.
- `decodePcm(file, image, outFile)`: raw s16le for the host-side silence and clipping scans.
- `blankFindings(keyframes, mountSpec)` and `frozenFindings(framemd5, mountSpec)`, pure.
- `specFindings(probe: Probe, profile, solved)`, pure.

- [ ] **Step 1: Write the failing tests.** Media is synthesized in the test.
  - **Loudness:** a deliverable 3 LU under target fails `audio.loudness` with measured and limit; one inside the tolerance passes.
  - **True peak (Review Focus 5).**
  - **Silence:** a 3-second digital gap fails with its frame range; a 300 ms line gap passes.
  - **Clipping:** a take with a run of full-scale samples fails with the first frame of the run; a signal that touches full scale once passes.
  - **Blank and frozen (Review Focus 2).**
  - **Format:** a wrong frame rate, a wrong size, a frame count one short, a missing audio stream and a film over `max_duration` each fail `spec.ffprobe` naming the field; a profile with no `max_duration` is not checked for it.
  - **Repeatable:** two runs give identical reports; the measurement is a cache hit for an unchanged assembly.
- [ ] **Step 2: Implement.** FFmpeg runs use the render image with `--entrypoint ffmpeg`, the M3 limits and the network off.
- [ ] **Step 3: Verify.** Container tests in CI.
- [ ] **Step 4: Commit.**

### Task 3: Script critics (PR M6.1c)

**Files:** `plugins/critic-script/{manifest.json,package.json,settings.json,src/{index,plugin,normalize,wer,captions}.ts,test/…,README.md}`, `engine/src/critics/run.ts` (register), `engine/src/jobs/transcribe.ts` (called for new takes when a live STT plugin is installed).

**Interfaces:**
- `normalizeWords(text, language): string[]`: case folding, punctuation stripped, Unicode NFKC. Language-neutral; no word lists.
- `wordErrors(script: { word: string; wildcard: boolean }[], transcript: string[], wildcardMax: number): { wer: number; ops: { op: "sub" | "del" | "ins"; script?: string; heard?: string; index: number }[] }`.
- `captionFindings(cues: TimedCue[], lines, solved, rules, settings)`, pure.

- [ ] **Step 1: Write the failing tests.**
  - **Numerals and symbols (Review Focus 3).**
  - **Lexicon:** a respelled term counts as its script word.
  - **Threshold is data:** raising `stt.max_wer` in settings turns the failing fixture into a pass; no number in `src/`.
  - **Frozen only:** with a transcript asset present no plugin is called; without one the finding is `stt.no_transcript`, and with `--strict` (tier A) it is an error.
  - **Caption rules, one fixture each:** overlap, a cue past the end of the film, a cue shorter than `min_display_frames` with room to extend, a line over `max_chars_per_line`, a spoken line that no scene lists, a cue that starts 20 frames before its first word.
  - **Sidecar check:** the written SRT and VTT parse back to the same cues.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Full suite. Run the reference film end to end: `render` exits 0 with an empty error list for both deliverables and both packs.
- [ ] **Step 4: Commit.**

## External facts (checked 2026-11-20)

- **WCAG 2.2** is a W3C Recommendation (2024-12-12). SC 1.4.3 asks 4.5:1 for text and 3:1 for large text (18 pt, or 14 pt bold); SC 1.4.11 asks 3:1 for non-text; the contrast ratio is `(L1 + 0.05) / (L2 + 0.05)`. SC 2.3.1 forbids more than three flashes in any one-second period above the thresholds. Source: [WCAG 2.2](https://www.w3.org/TR/WCAG22/). The pack floors in `tokens.json` are the values checked; these are the reference they should not fall below. *Not verified here:* the relative-luminance constant in the current text (the code uses 0.04045) and the numeric flash thresholds.
- **EBU R 128** normalizes programme loudness to −23.0 LUFS with a maximum true peak of −1 dBTP, measured per ITU-R BS.1770 with gating that starts at −70 LUFS. Sources (search summaries, not read in full): [EBU R 128 v4.0](https://tech.ebu.ch/docs/r/r128v4_0.pdf), [EBU Tech 3341](https://tech.ebu.ch/docs/tech/tech3341.pdf). *Not verified here:* the ±0.5 LU tolerance in the current revision, the relative gate and block length, and which BS.1770 revision the pinned FFmpeg's `ebur128` implements. The registry profiles use −14 LUFS for web and social delivery; a broadcast profile at −23 LUFS is a data file away.
- **HyperFrames `check`** sections at the pin: `lint`, `runtime`, `layout`, `contrast`, `motion`, `audio` (`container/render-runner/src/check.ts`). *Not verified:* the full list of codes per section; Task 1 Step 1 records it.

## Done when (M6.1 acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| Findings carry type, severity, entity path, frame range, evidence and signature | Task 1 |
| M6.1a: overflow, collision, safe area, contrast, minimum text size and hold time, each with a seeded failing fixture | Task 1 (hold time: the solver's `timing.short_hold`, M4 Task 9, included in the report) |
| M6.1b: loudness, true peak, silence, clipping, black or frozen frames, ffprobe spec, licence presence, each with a seeded failing fixture | Tasks 1 (clearance) and 2 |
| M6.1c: uses the frozen transcript in tier A; the threshold is data | Task 3 |
| `AGENTS.md` §4.2: caption timing is a deterministic check | Task 3 |
| M5.4 note: "M6.1 adds the deterministic critics to `cinewright render`" | Task 1 |
| The reference film passes every check in both aspect ratios and both packs | Task 3 Step 3 |
