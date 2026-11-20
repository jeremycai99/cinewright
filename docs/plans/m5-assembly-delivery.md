# M5 — Assembly and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-20. Written 2026-11-20 against branch `m3.6-audit-fixes` (PR #51) and the approved `docs/plans/m4-audio.md`. M5.3 (delivery profiles) is already merged (PR #41). This plan assumes M4 Tasks 2–11 have merged as planned; where it relies on a name M4 has not yet fixed in code, it says so.

**Goal:** Turn the cached parts of a film into a deliverable, and give the project one command that makes it:
- one MP4 per deliverable, built from shot bodies and transition segments by stream copy, with the mixed audio muxed in;
- SRT and WebVTT sidecars from the same cues the burn-in draws;
- a provenance manifest beside each file;
- `cinewright render`, which runs every non-agent job in order and re-does only what an edit changed;
- the backend reached only through the plugin interface, and render caches that survive two processes writing one key.

**Architecture:**
- **The backend becomes a full kind interface.** `plugins/sdk-ts/src/kinds/backend.ts` defines `render.plan`, `render.composition`, `render.shot`, `render.segment` and `render.keyframes`, with conformance cases. `plugins/backend-hyperframes` implements them over the functions it already has. The engine loads it through the M4 registry; the CLI imports no plugin package.
- **`plugins/export-mp4`** (Apache-2.0, kind `exporter`) plans and runs assembly with the pinned FFmpeg in the render image, as `segment.ts` and the mixer do.
- **`plugins/export-captions`** (Apache-2.0, kind `exporter`) writes sidecars. Cue derivation moves to one function shared with the burn-in.
- **`engine/src/pipeline/`** holds the render pipeline: a pure planner that turns the IR into ordered steps with content keys, and a runner that executes them through plugins and caches. M7's reconciler reuses the planner's step keys as task keys.
- **No scheduler, gates or agents.** Steps run one after another in this milestone. M7.2 adds the pool.

**Tech Stack:** the pinned FFmpeg of the render image (concat demuxer, stream copy, native AAC encoder); no new dependency. FFmpeg facts were checked on 2026-11-20 (§External facts); each task re-checks on its own day.

**Spec:**
- `docs/V0_1_PLAN.md`: §M5, §Multi-agent orchestration (P8, P9, P12, §Invalidation), §Exit gate.
- `docs/plans/roadmap-audit-2026-11-16.md`: §4 M5 table, §6.
- `docs/plans/audit-m3-m4-plan-2026-11-16.md`: G1, G3, G8, G9, G10 and the M3 deferral "CLI calls the backend directly".
- `docs/plans/m4-audio.md`: Decisions "Timing solver", "Sequences on one timeline", "PCM contract", "Mix cache"; Tasks 9 and 11.
- `docs/DESIGN_SPEC.md`: D27, D28, D32, D33, D34, D35, D37; §Production completeness (provenance).
- `AGENTS.md` §3: invariants 5, 7 and 12.

## Decisions this plan makes

| Choice | Value | Why, and the cost if wrong |
| --- | --- | --- |
| **Split M5.4 in two** | **M5.4a:** backend kind interface, CLI through the engine, cache commit rule (G9). **M5.4b:** the pipeline and `cinewright render`. | The interface change touches every caller of the backend and is reviewable on its own; the roadmap's single M5.4 would be the largest PR of the alpha path. Task ids stay stable: M5.4 is not renumbered, it gains letters. |
| Backend methods | `render.plan`, `render.composition`, `render.shot`, `render.segment`, `render.keyframes` (signatures in Task 1). Every method takes the project folder, ids and the solved timing; none takes a function or an open store. | In-process today, but the same JSON would cross a process boundary (D32), which the Blender backend needs in v0.3b. Cost if wrong: a second interface revision at v0.3b. |
| Who may import a backend | `engine` loads plugins by manifest through the registry (`findPlugins`, M4 Task 4). `cli/` depends on `@cinewright/core`, `@cinewright/engine` and `@cinewright/components` only. `cinewright-check-boundaries` fails on any import of a `plugins/*` package from `cli/` or `core/`, and on a static import of one from `engine/` outside tests. | Invariant 5; closes the M3 deferral due by M5.4. |
| Cache commit rule (G9) | `commitCacheDir(tmp, final)` in core: `rename(tmp, final)`; when `final` already exists the new folder is discarded and the existing one returned. No code path removes a committed entry. A committed entry is one whose `inputs.json` exists. Renders, segments, keyframes, mixes, assemblies and captions all use it. | Two processes rendering one key both finish, and a reader never sees a folder vanish. No per-key lock: the worst case is one wasted render. M7.2 dedupes inside one process. |
| Solved timing type | `SolvedTiming` = the return of `solveTiming` without `findings` (`{ table, sequences, scenes, shots }`), exported from `core/src/timing/solve.ts`. | M4 Task 9 gives the shape but no name. If M4.2 lands with a name, use that one. |
| Timeline order | Sequences in project order; scenes in order; shots in order. Between two scenes of one sequence with a segment transition: outgoing body, segment, incoming body. Everything else is a cut. Each body is the shot's `body.mp4` (D34, G1). | The files already exist; assembly only orders them. |
| Assembly method | Two FFmpeg runs in the render image, both single-threaded and bitexact:<ol><li>**Video:** concat demuxer over the part files, `-c copy`, into `video.mp4`.</li><li>**Mux:** `video.mp4` plus the mix `master.wav`, video `-c copy`, audio encoded once with the profile's `audio_codec` and `audio_bitrate_kbps`, `-map_metadata -1`, `+faststart`.</li></ol>If Task 2's spike finds the concat demuxer does not reproduce the parts' frames exactly, the fallback is to remux each part to an Annex B elementary stream, concatenate the bytes, and mux at the profile frame rate. Still no re-encode. | D34 and the M0.2 spike. The demuxer adjusts timestamps from each file's stored duration and "may cause gaps if all streams do not have exactly the same length" (FFmpeg docs); the parts are x264 with B-frames, so the spike must show frame-exact output before the task builds on it. Cost if wrong: the fallback, about a day. |
| What "identical" means for assembly | `framemd5` of the assembled video equals the concatenation of the parts' `framemd5` frame hashes, in order. The decoded audio length is within two encoder frames of the video length. Two runs give byte-identical files on one runner class. | D33. The first assertion is the only proof that stream copy lost or repeated nothing. |
| Loudness of the delivered file | The profile's targets apply to the **decoded audio of the delivered MP4**, not only to the master. Task 2 measures the true peak after AAC encoding. If it exceeds the target, the mixer limits at `target − encode_headroom_db`, a value in `plugins/audio-ffmpeg/settings.json` set from the measurement, and the mix key includes it. | The M4 mixer verifies the PCM master. A lossy encode can raise the true peak, and M6.1b measures the delivered file; without this a critic would fail a mix nobody can fix. Cost if wrong: one settings change and a re-baseline. |
| Assembly key and cache | `.cinewright/cache/assemblies/<key>/`: `video.mp4`, `<deliverable>.mp4`, `framemd5.txt`, `sha256.txt`, `inputs.json`. The key is the JCS hash of the ordered parts (kind, cache key, frame count), the mix key, the profile's audio encoding, the container flags, the render image digest and the exporter version. | The same pattern as renders and mixes. Disposable (D37). |
| One cue function | `sequenceCues(ir, table, sequenceId, rules): TimedCue[]` in `@cinewright/components` (where `breakCaption` and `displayCues` live), returning final cues on the sequence timeline with their line id. The backend's `captionCues` becomes a clip of it to a span. The exporter offsets each sequence by `solved.sequences[id].start`. | "Timing matches the burn-in" by construction (G3). |
| Sidecar format | Per deliverable (caption rules come from its profile) and per language (the narrator's `voice.description.language`): `<deliverable>.<lang>.srt` and `.vtt`, UTF-8 without BOM, LF line ends.<ul><li>**Times:** `ms = round(frame × 1000 × den / num)`; a cue's end is clamped to the next cue's start after rounding.</li><li>**SRT:** a counter from 1, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, the text lines, a blank line.</li><li>**WebVTT:** `WEBVTT`, a blank line, cues with `HH:MM:SS.mmm`; `&`, `<` and `>` escaped; no cue identifiers; text containing `-->` is refused (`captions.unsafe_text`).</li></ul> | WebVTT is a W3C Candidate Recommendation Draft (2026-05-20): UTF-8, end after start, starts non-decreasing, identifiers optional. SRT has no normative specification; this is the form players agree on. Cost if wrong: LF versus CRLF is a one-line change. |
| Captions cache | `.cinewright/cache/captions/<key>/`, keyed by the cues, the format version and the language. | A caption edit never invalidates the MP4 of a deliverable without burn-in. |
| Provenance manifest | `manifest.json`, written by `cinewright render --out` beside the files: project id, revision, `state_hash`, deliverable, profile id and hash, frame count, every referenced asset (id, role, hash, provider, model, plan tier, licence), every shot (id, type, backend plugin id and version, render key), the mix and assembly keys, both image digests, `synthetic_voice: true` for each take with `consent.synthetic`. | P12 requires it and no task delivered it. It is derived data, so it is not part of any cache key. |
| Pipeline steps | `planRender(ir, ctx): RenderPlan` is pure. Step kinds, in order: `narrate` (per line), `timing`, `compose` (per sequence), `render` (per shot × deliverable), `segment`, `keyframes`, `mix`, `captions`, `assemble` (per deliverable). Each step has a content key. `critique` joins in M6.1. | One list drives the command now and the reconciler later, so a task's idempotency key is the step key. |
| What "re-renders only that shot" is proven by | The `hit` flag of every step in the run report, not by `dirtyNodes`. | The M1.5 graph hashes `shot.duration` and scene sound; after M4 it sees neither solved spans, `line.take` nor `sequence.music`. Step keys are the truth; Task 4 points the graph's render, mix, captions and assembly nodes at them. |
| `cinewright render` | `cinewright render [--deliverable <id>]… [--until narrate\|timing\|compose\|shots\|mix\|captions\|assemble] [--retake <line>] [--provider <id>] [--out <dir>] [--image <ref>] [--json]`. Without `--out` it prints cache paths. The M3 and M4 developer commands stay as thin calls into the same engine functions; `render-shot` goes through the plugin interface. | Agents and tests still drive single steps. M8.1 adds `export`, which is `--out` plus the clearance check. |
| Findings stop the run | A step that returns an error-severity `Finding` (`timing.no_take`, `timing.uncovered`, `mix.loudness_unmet`, a compile error) stops the pipeline after reporting every finding of that step. Exit codes: 3 for IR and compile errors, 8 for render failures, 9 for providers (M4). | The walking skeleton has no fix loop. |

## Global Constraints

- **Rules from earlier milestones:** M1–M4 conventions and the neutrality rules bind. No frame rate, bitrate, loudness, caption length or language literal in core, engine or plugins: they come from the delivery profile, the pack or the IR.
- **Determinism (D33):** every FFmpeg run is single-threaded and bitexact, in the render image, with the network off and the M3 run limits. Same inputs give the same `framemd5`, PCM hash and bytes on one runner class.
- **No re-encode of video** anywhere in assembly. A test fails if the assembly command line carries a video encoder.
- **Caches are disposable (D37).** Deleting `.cinewright/cache/` changes no IR and no `state_hash`; the next `render` rebuilds identical files.
- **Schema:** this milestone adds no IR field.
- **Container tests run in CI** (G2): each package with container tests has a step that runs them with the locked image and fails on a skip.
- **No media in git:** test video and audio are rendered or synthesized at test time.
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.
- **Neutrality test item 4:** it doesn't apply until the alpha gate; each PR says so.

## Review Focus

1. **Bodies and segments around a transition.** For two scenes joined by a 12-frame and a 13-frame dissolve, the assembled file has exactly the timeline's frames, and its frame hashes equal the parts' hashes in order: nothing repeated, nothing dropped. Test: Task 2.
2. **One edit, one re-render.** After a change to one shot's layers, the run report shows a miss for that shot's render, its adjacent segments and the assembly, and a hit for every other render, the mix and the captions. Test: Task 4.
3. **Two processes, one key.** Two `render` processes started together on one project both exit 0, leave one committed folder per key, and neither reads a folder the other removed. Test: Tasks 1 and 4.
4. **Sidecar and burn-in agree.** For a deliverable with burn-in, the cues drawn in the shots, joined across cuts, equal the sidecar's cues frame for frame; a cue split by a cut is one sidecar cue. Test: Task 3.
5. **Audio and video end together, and the delivered file meets its targets.** Video frames equal the solved timeline; decoded audio is within two encoder frames of it; the delivered file's integrated loudness and true peak are inside the profile's limits. Test: Task 2.

---

## Tasks

PR order: Task 1 → Task 2 → Task 4. Task 3 needs only M4.2 (Task 9 of the M4 plan) and can run beside Tasks 1 and 2. Task 1 needs only the `engine` package (M4 Task 4), so it can start while M4.1–M4.4 are in review. Each task is one PR; the files listed are the expected ones.

### Task 1: Backend kind interface, CLI through the engine, cache commit rule (PR M5.4a)

**Files:**
- **SDK:** `plugins/sdk-ts/src/kinds/backend.ts`, `plugins/sdk-ts/schema/kinds/backend.schema.json`, `plugins/sdk-ts/test/fixtures/stub-backend/`.
- **Core:** `core/src/project/cache.ts` (`commitCacheDir`), `core/src/project/layout.ts` (`SEGMENT_CACHE_DIR`, `ASSEMBLY_CACHE_DIR`, `CAPTIONS_CACHE_DIR`, `COMPILED_DIR`).
- **Backend:** `plugins/backend-hyperframes/src/{plugin,render,segment,keyframes}.ts`, `manifest.json` (capabilities), tests.
- **Engine:** `engine/src/plugins/backend.ts`.
- **CLI:** `cli/src/commands/compile.ts`, `cli/package.json` (drop `@cinewright/backend-hyperframes`).
- **Tools:** `tools/src/cinewright_tools/boundaries.py`, `tools/tests/test_boundaries.py`.

**Interfaces:**
- Common params: `{ project: string; deliverable: string; timing: SolvedTiming; image: string; pack_path?: string[] }`.
- `render.plan`: common + `{ shot }` → `{ key, frames, body: { start, end }, segments: { incoming?: string; outgoing?: string } }`. Writes nothing.
- `render.composition`: common + `{ shot, out_dir }` → `{ dir, inputs }` (as today, with `SolvedTiming` in place of the table).
- `render.shot`: common + `{ shot }` → `{ key, dir, frames, body_frames, framemd5, sha256, hit }`.
- `render.segment`: common + `{ scene }` → `{ key, dir, frames, framemd5, sha256, hit }`. It renders the two shots it needs if they are not cached.
- `render.keyframes`: common + `{ shot }` → `{ key, keyframes: Keyframe[] }`.
- Errors: `CompileError` and timing errors map to `invalid_request` with `data.issues`; `RenderError` maps to `provider_error` with `data.rule` (`render.timeout`, `render.memory`, `render.failed`, `render.unsupported_fps`), retryable only for `render.failed`.
- Engine: `backendFor(ir, shotId, registry): Promise<LoadedPlugin>` picks the plugin whose manifest lists `render.shot` and the shot's `backend` (or, when unset, the only backend that accepts the shot's `type`); none is `render.no_backend`.
- Core: `commitCacheDir(tmp: string, final: string): "committed" | "existing"`.

- [ ] **Step 1: Write the failing tests.**
  - **Conformance:** the backend kit accepts the stub backend; a manifest listing `render.shot` without `render.plan` is rejected.
  - **Parity:** for the M3 reference project, `render.plan`'s key equals `shotRenderKey`'s, and `render.shot` through the plugin gives the same `framemd5` and `sha256` as the M3 goldens (container).
  - **Error mapping:** a missing required prop returns `invalid_request` naming the layer; a timed-out render returns `provider_error` with `data.rule = "render.timeout"`.
  - **Commit rule:** `commitCacheDir` onto an existing folder returns `"existing"`, leaves it byte-identical and removes the temporary one. Two processes calling `render.shot` for one key together both return, exactly one folder exists, and `inputs.json` is valid (Review Focus 3).
  - **No removal:** a grep-style test fails if `render.ts`, `segment.ts` or `keyframes.ts` call `rmSync` on a final cache path.
  - **Boundary:** an import of `@cinewright/backend-hyperframes` from `cli/src` fails `cinewright-check-boundaries`.
  - **CLI:** `compile` and `render-shot` give the same output and exit codes as before, through the engine.
- [ ] **Step 2: Implement.** `plugin.ts` dispatches the five methods to the existing functions. Replace `rmSync(dir); renameSync(out, dir)` in `render.ts` and `segment.ts`, and the keyframes write, with `commitCacheDir`.
- [ ] **Step 3: Verify.** Run the full suite, the backend container tests and the boundary check. `smoke-compare` is unchanged.
- [ ] **Step 4: Commit.**

### Task 2: Assembly (PR M5.1)

**Files:** `plugins/export-mp4/{manifest.json,package.json,settings.json,src/{index,plugin,plan,concat,mux,probe}.ts,test/…,README.md}`, `plugins/audio-ffmpeg/settings.json` (`encode_headroom_db`), `plugins/audio-ffmpeg/src/plan.ts` (the limiter ceiling reads it), `.github/workflows/render-smoke.yml` (assembly determinism on both runners), `docs/DESIGN_SPEC.md` (D33: the delivered-file clause, if the spike requires headroom).

**Interfaces:**
- `planAssembly({ ir, deliverableId, solved, parts, mix }): AssemblyPlan`, pure. `parts: { kind: "body" | "segment"; id: string; key: string; file: string; frames: number }[]` in timeline order; `mix: { key: string; file: string; samples: number }`. It throws `assemble.frame_mismatch` when the parts' frames do not sum to the solved timeline, and `assemble.length_mismatch` when the mix length is not `frames × rate / fps`.
- `assemble({ plan, image, cacheDir, limits }): Promise<Assembled>`; `Assembled = { key, dir, file, frames, framemd5, sha256, audio: { samples, integrated_lufs, true_peak_dbtp }, hit }`.
- Plugin method `export.mp4`: `{ project, deliverable, timing, parts, mix, image }` → `Assembled`.
- `probe(file, image): Promise<Probe>`: container, codec names, pixel format, width, height, frame rate, frame count, sample rate, channels, stream durations. M6.1b reuses it.

- [ ] **Step 1: Spike, recorded in the README.** With the M3 reference project plus a second scene joined by a 12-frame dissolve:
  - concat by the demuxer, then compare the result's `framemd5` frame hashes with the parts' in order, and its frame count with the timeline;
  - confirm every part has identical codec parameters (`extradata`) and time base;
  - mux with a synthetic master, then decode the audio and record its length, integrated loudness and true peak against the master's;
  - repeat 3 times at `--cpus 1` and `4` and compare bytes.

  If frames differ, switch to the Annex B fallback and repeat. If no method is frame-exact and byte-stable, **stop and raise it** (D33, D34).
- [ ] **Step 2: Write the failing tests.**
  - **Unit:** the part order for one sequence with a cut, a dissolve and a wipe, and for two sequences. A missing part, or frames that do not add up, is the typed error. The key changes with any part key, the mix key, the audio bitrate or the image digest. The video command line has `-c:v copy` and no encoder.
  - **Container (Review Focus 1):** for `d = 12` and `d = 13`, frame count equals the timeline and frame hashes equal the parts' in order.
  - **Container (Review Focus 5):** decoded audio length is within two encoder frames of `frames × rate / fps`; the delivered file is within `tolerance_lu` of the integrated target and at or under the true-peak target.
  - **Container:** two runs are byte-identical; an unchanged plan is a cache hit; a part with different codec parameters fails with `assemble.incompatible_part` naming it.
  - **Probe:** the result matches the profile's width, height, frame rate, codec, pixel format and sample rate.
- [ ] **Step 3: Implement** with the spike's flags. Set `encode_headroom_db` from the measurement (0 if the encode does not raise the peak past the target).
- [ ] **Step 4: Verify.** Run the container tests in CI; add the assembled reference film to `smoke-compare`.
- [ ] **Step 5: Commit.**

### Task 3: Sidecar captions (PR M5.2)

**Files:** `components/src/caption_track/lines.ts` and `components/src/index.ts` (`sequenceCues`, `TimedCue`), `plugins/backend-hyperframes/src/captions.ts` (clip of `sequenceCues`), `plugins/export-captions/{manifest.json,package.json,src/{index,plugin,cues,srt,vtt}.ts,test/…,README.md}`.

**Interfaces:**
- `TimedCue = { line: string; text: string; start: number; end: number }`, frames on the sequence timeline.
- `timelineCues(ir, solved, rules): TimedCue[]`: every sequence's cues, offset to the project timeline, in order.
- `toSrt(cues, fps): string` and `toVtt(cues, fps): string`, pure.
- Plugin method `export.captions`: `{ project, deliverable, timing }` → `{ key, dir, files: { srt, vtt }, language, cues: number, hit }`.

- [ ] **Step 1: Write the failing tests.**
  - **Parity (Review Focus 4):** for each shot of a burn-in deliverable, the backend's cues, shifted back to the timeline and joined where a cut split them, equal `timelineCues`. The M3.4 caption goldens are unchanged.
  - **Two sequences:** the second sequence's cues start at its solved offset.
  - **SRT golden:** counters from 1, comma decimals, blank-line separation, no trailing spaces.
  - **VTT golden:** the header line, dot decimals, `&` and `<` escaped; a line containing `-->` is `captions.unsafe_text`, naming the line.
  - **Rounding:** at 30000/1001 fps no cue ends after the next begins, and every end is after its start.
  - **Always written:** a deliverable with `burn_in_captions: false` still gets both files; a project with no lines gets valid empty files (a WebVTT header alone).
  - **Rules per deliverable:** the portrait profile's shorter line limit gives more cues than the landscape one for the same script.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** Run the full suite; the specimen and caption goldens are unchanged.
- [ ] **Step 4: Commit.**

### Task 4: Render pipeline and `cinewright render` (PR M5.4b)

**Files:** `engine/src/pipeline/{plan,run,report,manifest}.ts`, `engine/src/index.ts`, `core/src/graph/deps.ts` (`RenderInputs` gains `stepKey`), `cli/src/commands/render.ts`, `cli/src/main.ts`, `cli/README.md`, `cli/test/render.test.ts`, `cli/test/fixtures/m1-reference/` (a second scene with a dissolve), `.github/workflows/render-smoke.yml`.

**Interfaces:**
- `Step = { id: string; kind: StepKind; key: string; entity?: string; deliverable?: string; needs: string[] }`; `StepKind = "narrate" | "timing" | "compose" | "render" | "segment" | "keyframes" | "mix" | "captions" | "assemble"`.
- `planRender(ir, ctx: { pack; catalog; renderer; plugins }): Promise<RenderPlan>`; `RenderPlan = { steps: Step[]; findings: Finding[] }`. Step ids: `narrate:<line>`, `timing`, `compose:<sequence>`, `render:<shot>@<deliverable>`, `segment:<scene>@<deliverable>`, `keyframes:<shot>@<deliverable>`, `mix@<deliverable>`, `captions@<deliverable>`, `assemble@<deliverable>`.
- `runRender(store, options: { deliverables?; until?; retake?; provider?; image; out?; onEvent? }): Promise<RenderReport>`.
- `RenderReport = { revision; state_hash; steps: { id; kind; key; hit: boolean; ms: number }[]; deliverables: Record<string, { file; sha256; framemd5; pcm_sha256; frames; captions: { srt; vtt }; manifest? }>; findings: Finding[] }`.
- `writeManifest(store, report, deliverableId, outDir)`.

- [ ] **Step 1: Write the failing tests** (stub TTS, synthesized library, container).
  - **End to end:** from a project with no takes, `render --out <dir>` produces for each deliverable an MP4, both sidecars and `manifest.json`; the MP4's frames equal the solved timeline.
  - **Second run:** every step is a hit and no container starts (asserted through the Docker runner's call count).
  - **One-shot edit (Review Focus 2):** a patch to one shot's layer props gives a miss for that shot's render in each deliverable, its adjacent segments and both assemblies, and a hit for everything else, including the mix and captions.
  - **Line edit:** a text change re-narrates that line only and re-renders only shots whose compile inputs changed; the mix and captions miss.
  - **Token edit:** a project-level palette change misses every render and hits narration, timing and the mix.
  - **`--until mix`:** no assembly step runs; the report says so.
  - **Findings:** a stale take stops after `timing` with `timing.no_take` and exit 3; nothing is rendered.
  - **Concurrency (Review Focus 3):** two `render` processes on one project both exit 0 with identical reports apart from `hit` and `ms`.
  - **Cache deleted:** removing `.cinewright/cache/` and re-running gives byte-identical deliverables and an unchanged `state_hash`.
  - **Manifest:** every asset the deliverable uses appears with provider, plan tier and licence; a planted secret appears nowhere.
  - **Graph:** `dirtyNodes` with `stepKey` reports the same render, mix, captions and assembly nodes as the report's misses for the three edits above.
- [ ] **Step 2: Implement.** Serial execution in plan order. Narration and Composer are the M4 jobs; timing is `solveTiming`; the rest go through plugins.
- [ ] **Step 3: Document.** `cli/README.md`: the command, its JSON report and exit codes. `docs/V0_1_PLAN.md`: M5 done line.
- [ ] **Step 4: Verify.** Full suite, container tests in CI, and `smoke-compare` on the reference film's MP4 hash, `framemd5` and PCM hash.
- [ ] **Step 5: Commit.**

## External facts (checked 2026-11-20)

- **FFmpeg concat demuxer:** "All files must have the same streams (same codecs, same time base, etc.)"; timestamps are adjusted "so that the first file starts at 0 and each next file starts where the previous one finishes", using each file's duration, and this "may cause gaps if all streams do not have exactly the same length"; `safe` defaults to 1; `auto_convert` adds `h264_mp4toannexb` when needed. Source: [FFmpeg formats documentation](https://ffmpeg.org/ffmpeg-formats.html).
- **WebVTT:** Candidate Recommendation Draft of 2026-05-20. UTF-8; `WEBVTT` then a blank line; `mm:ss.ttt` with hours optional; end after start; start times non-decreasing; `&` and `<` not allowed raw in cue text; `-->` not allowed in a payload; identifiers optional and unique. Source: [WebVTT](https://www.w3.org/TR/webvtt1/).
- **SRT:** no normative specification exists. *Unverified against a standard, by definition.*
- **Not verified:** that the concat demuxer is frame-exact for these x264 parts (B-frames, per-file edit lists); how far the pinned FFmpeg's AAC encoder moves the true peak; that the AAC encoder is byte-stable across CPU counts (the M4.0b spike measures the last one). Task 2 Step 1 settles all three.

## Done when (M5 acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| M5.1: concatenation without re-encoding; audio muxed; byte-identical on two runs; ffprobe matches the profile | Task 2 |
| M5.2: SRT and VTT from line timestamps, always; timing matches the burn-in | Task 3 |
| M5.3: two data-file profiles | Done (PR #41) |
| M5.4: runs every non-agent job in dependency order; a one-shot edit re-renders only that shot and its adjacent segments and re-assembles without re-encoding the rest | Tasks 2 and 4 |
| M3 deferral: the CLI reaches the backend through the plugin interface | Task 1 |
| Audit G9: a lost cache race keeps the existing folder | Tasks 1 and 4 |
| P12: provenance manifest written | Task 4 |
| D33 for the whole film: identical `framemd5`, PCM hash and bytes on two runs and two runners | Tasks 2 and 4 (`smoke-compare`) |
