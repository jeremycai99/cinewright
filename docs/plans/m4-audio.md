# M4 — Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved 2026-11-17, with the changes from the audit `docs/plans/audit-m3-m4-plan-2026-11-16.md` folded in (findings G1–G29). Task 1 (M3.6) fixes M3 before any M4 code.

**Goal:** Give the timeline a real, deterministic soundtrack:
- narration takes from TTS plugins, frozen in the CAS with provenance;
- word times from forced alignment against the script;
- a timing solver that owns scene and shot spans and turns takes into the timing table M3 consumes;
- music and SFX from a local library or one generative provider, chosen by a rules-based Composer job;
- a mixer that meets the delivery profile's loudness and true-peak targets, with ducking from the pack, gives the same PCM on every run, and is exactly as long as the video.

**Architecture:**
- **A second pinned image, `cinewright-audio`** (audit decision 7). It holds only TTS and STT:
  - Python 3.12, CPU-only PyTorch, Kokoro and WhisperX;
  - FFmpeg, for decoding;
  - every model baked in by revision and sha256.

  Plugin code is **mounted** read-only, not baked in, so a plugin change needs no image rebuild (G17). The network is off.
- **Local Python plugins run as subprocess plugins inside that image.** The manifest gains `runtime.container`. The SDK host runs `docker run -i --name … --init` with the run limits, and stops the container with `docker kill` (G14). JSON-RPC over stdio is unchanged (D32), and files cross the boundary through a per-plugin work folder.
- **The mixer runs in the render image**, with the pinned FFmpeg the segments already use (G16). So the PCM contract and the mix cache rest on the image that carries the determinism baseline.
- **Kind interfaces for TTS, STT and music/SFX** go in the plugin SDK, with conformance cases.
- **Jobs and the plugin registry** live in a new `engine/` package. It holds jobs only for now; the runtime arrives in M7.1a.
  - **Narration job:** writes takes as IR assets and records the selected take on each line.
  - **Composer job:** writes music and SFX assets the same way.
- **The timing solver** is pure core code. Takes, IR and pack give scene, shot and sequence spans, the timing table and findings.
- **`plugins/audio-ffmpeg`** (Apache-2.0) plans and renders the mix, cached by a mix key.

**Tech Stack:**
- **Audio image:**
  - `torch` and `torchaudio` 2.8.x CPU wheels (WhisperX 3.8.6 pins `torch~=2.8.0`);
  - `kokoro` 0.9.4 with `misaki[en]` 0.9.4, which brings `phonemizer-fork` and `espeakng-loader`;
  - `whisperx` 3.8.6, and spaCy `en_core_web_sm`;
  - Debian `ffmpeg` from the render image's snapshot.

  Everything is locked with hashes in the image's own `uv.lock`.
- **ElevenLabs:** plain `fetch`, with no vendor SDK.
- **Versions** were checked on 2026-11-16 (audit §3.1). Each task re-checks them on its own day.

**Spec:**
- `docs/V0_1_PLAN.md`: §M4, Open issue 8, and §Revised task breakdown and order.
- `docs/plans/roadmap-audit-2026-11-16.md`: §3.3, §3.4, F16, F18, F21, and decisions 7 and 8.
- `docs/plans/audit-m3-m4-plan-2026-11-16.md`: G1–G29 and §3.4.
- `docs/DESIGN_SPEC.md`: §Voice production pipeline, §Sound palette, and D16, D17, D18, D26, D27, D29, D32, D33, D34, D35, D37 and D38.
- `AGENTS.md` §3: invariants 4–7, 10 and 11, and §6.

## Decisions this plan makes

The first three rows were approved on 2026-11-17 in the form the audit recommended.

| Choice | Value | Why |
| --- | --- | --- |
| **Second image for audio (audit decision 7)** | `container/audio/` builds `ghcr.io/jeremycai99/cinewright-audio`, with its own pins, lock, inputs hash and publish workflow.<ul><li>It holds Python, dependencies and models only; plugin folders are mounted at `/plugins/<id>`.</li><li>The image tools (`cinewright-build-image`, `-check-pins`, `-check-image-lock`) take `--image render\|audio`.</li><li>A `linux/arm64` build is allowed if Task 3 measures a real-time factor above 2 under emulation, because take and transcript outputs are frozen and need not match across architectures.</li></ul> | Keeps torch out of the render image, and gives Kokoro its Python. Mounting the code and running the mixer elsewhere keep this image rarely rebuilt and out of the PCM contract. |
| **Kokoro plugin licence (audit decision 8)** | `plugins/tts-kokoro` is **GPL-3.0-or-later**. In its process, misaki imports `phonemizer-fork` (GPLv3+), which loads the espeak-ng library bundled in the `espeakng-loader` wheel (GPL-3.0-or-later). Both are pinned by hash. The image ships both licences, the espeak-ng version the binary reports, and the upstream source location for that version; `audio-job versions` reports the loaded library path. Core reaches the plugin only over JSON-RPC across a process boundary. | Kokoro without the fallback drops unknown words, so there is no clean non-GPL mode. This matches D2 and invariant 10. Not legal advice. |
| **Generative music (new decision)** | **ElevenLabs Music** (`POST /v1/music`), with these conditions:<ul><li>Each asset's licence records the plan tier and the terms' exclusions (film, TV, radio, Studio Games).</li><li>Beds are requested instrumental, and `seed` is not relied on.</li><li>The plugin is built **after the alpha gate** (Task 12), which uses no paid API.</li><li>Stable Audio stays the named fallback.</li></ul> | It exists as described and shares the TTS key. Keeping a second provider in view protects invariant 6. |
| Where local plugins run | Subprocess plugins with `runtime.container: { image: "audio" }`. The host resolves the image from its lock (or a dev tag) and runs `docker run --rm -i --init --name cinewright-plugin-<uuid> --network none` with:<ul><li>the M3 run limits;</li><li>`/work` mounted for files, and `/plugins/<id>` mounted read-only;</li><li>`HOME`, `HF_HOME`, `HF_HUB_OFFLINE=1` and the cache folders set;</li><li>declared secrets only, passed by name.</li></ul>It stops the container with `docker kill <name>` on timeout, shutdown and host exit. Container plugins get their own start timeout (60 s). `docker.ts` and `limits.ts` move from `backend-hyperframes` into the SDK, and both use them. | Network off and pinned models, with the D32 protocol unchanged. No orphaned containers, and one copy of the limits. |
| Files across the plugin boundary | `PluginContext.workDir`, a per-instance folder the host creates and deletes. Containers see it as `/work`. Requests and results name files relative to it. | One contract for in-process and containerized plugins. |
| Script words | `lineWords(text)`: a whitespace split with empty items dropped (core). It is the one definition of word indices. | Anchors (`point: word`) index these words; M3 already splits this way. |
| Lexicon values | A respelling (`KOO-ber-NET-eez`) by default; a value in slashes (`/kuːbərˈnɛtiːz/`) is IPA. Plugins translate: respellings are substituted; IPA uses each provider's mechanism, or else is `unsupported`, naming the term. A substituted term still counts as one script word. | Provider-neutral data (D29); anchors stay valid. |
| Take identity and selection | **Identity:** a take is an asset with role `take`, its `line`, and `provenance.request_hash = takeKey(ir, lineId, providerId)`. The key is computed in core: the JCS hash of the line's text and `direction`, the voice language, the provider id, the speaker's binding for that provider, the lexicon entries whose terms occur in the text, and the project sample rate. The seed and secrets are left out.<br>**Selection:** a new authorable field on the line, `take` (Ref<asset>). Narration writes it as a job. The user may set it, and a gate may lock it. A selected take whose key no longer matches is `timing.no_take`.<br>**Making takes:** narration reuses a take of the *routed* provider with the current key if one exists, and otherwise makes one. `--retake <line>` always makes a new take with a new seed. | Selection no longer depends on asset order or routing history (G13), and follows the spec's step 4 ("selected takes are locked"). Editing the text, direction, binding or a lexicon entry the line uses invalidates the take. |
| One sample rate per project | A semantic check: every deliverable's profile has the same `sample_rate` (`project.mixed_sample_rates`). Take word times are stored in samples at the take's own `audio.sample_rate`. | D27 fixes one frame rate per project; this pins the sample rate too, so mix arithmetic is exact. |
| Alignment and transcription | Timing uses forced alignment against the script (`stt.align`), **matched against each word's spoken form** (M4.0b: given written numerals, alignment of the whole line fails; the request may carry `spoken` forms, and the WhisperX plugin spells numerals, years, currency, percentages and ordinals when it gets none). Transcription (`stt.transcribe`) is only for the STT check (M6.1c). Both are frozen:<ul><li>**alignment:** on the take, as `words` plus `aligned_by`;</li><li>**transcription:** as a `transcript` asset keyed by take hash, plugin version and model hash.</li></ul>If Task 3 finds Kokoro's native timestamps within one frame of alignment, the Kokoro plugin returns them, and alignment remains the fallback (G26). **Task 3 result:** they are not (starts 55–136 ms early, ends include pauses), so Kokoro returns `words: null` and its takes are aligned. | Audit §3.3. Tier A never needs live STT. |
| Words with no time (digits, symbols) | Interpolated. A run of unaligned words fills the gap between its aligned neighbours (or the take's speech bounds), split by character count, and each is marked `interpolated: true`. An anchor on one resolves to its interpolated time. | WhisperX gives "2014" or "£13.60" no time. |
| Provider routing (D29) | Use `settings.providers.<kind>` (an ordered list of plugin ids) if set. Otherwise take the installed plugins the speaker has a binding for, in this order:<ol><li>free plugins;</li><li>paid plugins whose secrets are present;</li><li>then by id.</li></ol>`--provider <id>` overrides both. | No provider is a default in code (invariant 11). Cost-conservative (D17). |
| Timing solver: scenes | Scenes play in order on their sequence's timeline. Each scene is its head pad, then its lines' speech spans in order separated by the line gap, then its tail pad. The natural length `N` is the sum of those.<ul><li>**`voiceover` sync:** the length is `max(N, ⌈target·(1−flex)⌉)`, and spare time goes to the tail.</li><li>**`fixed` and `music` sync:** exactly `target` in v0.1.</li><li>**Overrun:** `N > target·(1+flex)` (or `N > target` for `fixed`) is `timing.overrun`. The timeline grows; speech is never stretched or cut.</li></ul> | The roadmap's M4.2 criteria. |
| Timing solver: shots | **The solver owns shot spans (G12).** A scene's shots tile it:<ul><li>shot 0 starts at the scene's start;</li><li>shot `i > 0` starts at its resolved `anchors.start`;</li><li>each shot ends where the next starts, and the last ends at the scene's end.</li></ul>A start anchor outside its scene, or out of order, is `timing.uncovered`, and the shot gets zero length. A shot's `anchors.end` or `duration` that disagrees with its tiled end is a `timing.uncovered` warning; the tiled span wins. Spans are derived on demand and never written to the IR (D37). `shotSpan` takes the solved spans when given them. The M3 rule (anchors, then `duration`, then the next shot) stays only for a hand-written `--timing` table. | Video and audio are then the same length by construction. |
| Timing solver: other findings | A shot shorter than `max(density.min_hold, density.hold_per_word × readable words)` is `timing.short_hold`. A line with no valid selected take is `timing.no_take`. An anchor on a missing word is `timing.unknown_word`. | F21's tokens get their first reader. |
| Sequences on one timeline | The project timeline is the sequences in project order. The solver returns `sequences: { <id>: { start, frames } }`; the mixer offsets each sequence's clips by its start (G19). | The timing table is per sequence; the mix is per deliverable. |
| New tokens | `sound.voice.line_gap`, `sound.voice.head` and `sound.voice.tail`, in ms, in the pack schema and both packs. Readable text props are marked `"x-readable": true` in component prop schemas. | Pacing is taste, so it lives in packs. |
| Findings | `Finding = { rule, severity: "error" \| "warning", entity, pointer?, message, data }` in `core/src/findings.ts`. | One shape before M6's critics. |
| Music and SFX selection | **Music:** role `music` with a `sequence` reference. The Composer builds the request from `sound.music.*` (resolved through the cascade), the sequence's `mood`, its `music_bed` text, the sequence length and `vocals: false`. The selected bed is a new authorable field on the sequence, `music` (Ref<asset>), written by the Composer.<br>**SFX:** only when `sound.sfx.enabled`. They are matched by name from `scene.sound.sfx`, each with a `scene` reference, and play at the scene's start. | The same freeze-and-select rule as takes. |
| Licences | A plugin's response `license` is authoritative, and the manifest's `output_license` is the default. A plugin whose terms depend on the account's plan reads the tier once at init and writes the exclusions into `terms`. | ElevenLabs' terms vary by tier (G20). |
| Mix loudness method | No dynamic `loudnorm`:<ol><li>measure the premix (`ebur128=peak=true`, parsed on the host);</li><li>apply gain to the profile's integrated target;</li><li>if the true peak would exceed the target, limit at the target on a 4× oversampled signal;</li><li>re-measure.</li></ol>Missing the target by more than `tolerance_lu`, or the true peak at all, is `mix.loudness_unmet`, naming the measured and target values; nothing is cached. | Fixed operations whose repeatability the spike measures; the targets are checked, not assumed. |
| Ducking | Music gain is `sound.bus.music_db`, plus `duck.depth_db` during each line's speech span (`scene.sound.duck_under_vo_db` overrides it), with linear ramps of `duck.attack` and `duck.release` ms. It is a sample-exact gain envelope from the solved timing. | Exact, testable and repeatable. |
| PCM contract (into D33 after the spike) | The **PCM hash** is the sha256 of the master as raw interleaved PCM s24le (`-f s24le`), stereo, at the project sample rate. It is converted from float without dither, rendered in the render image, before any encoding. Encoded files are byte-identical per runner class (M5.1). | Needs no WAV chunk parser (G18), and rests on the existing baseline image. |
| Mix cache | `.cinewright/cache/mixes/<mix key>/`: `master.wav`, `master.s24le.sha256`, `measure.json` and `plan.json`. The mix key is the JCS hash of the mix plan, the **render** image digest and the mixer version. It is disposable (D37). | The same pattern as renders. |
| Dev commands | Developer tools until `cinewright render` (M5.4):<ul><li>`cinewright narrate [--line <id>] [--retake <line>] [--provider <id>]`;</li><li>`cinewright timing [--out <file>]`;</li><li>`cinewright compose [--sequence <id>]`;</li><li>`cinewright mix --deliverable <id>`.</li></ul>`compile` and `render-shot` use the solved spans when `--timing` is absent. New exit code `provider: 9`. | Lets agents and tests drive each step. |
| Live API tests | Opt-in with `CINEWRIGHT_LIVE_TESTS=1` plus the key. Capped at 300 characters of TTS and one 10-second music clip per run; never in CI by default. Cassettes keep each real response's JSON and replace the audio with a synthetic tone of equal length. | AGENTS.md §4.3 and §6. |

## Global Constraints

- **Rules from earlier milestones:** M1–M3 conventions and neutrality rules bind. No voice id, genre, BPM, loudness or pacing literal goes in core, engine, components or plugins.
- **Determinism (D33):** the same mix plan in the same render image gives the same PCM hash, and byte-identical files on one runner class. TTS, music and STT outputs are frozen and never regenerated without an explicit re-take.
- **Network:** off for every container run, including local plugins. Only the ElevenLabs plugins reach the network, from the host.
- **Secrets:** a secret never appears in a request hash, provenance, log, cassette, error, stderr tail or patch. The host replaces declared secret values in any stderr it returns.
- **Licences:** every take, music, SFX and transcript asset records provider, model, plan tier and licence.
- **No media in git:** test audio is synthesized at test time by FFmpeg, or comes from cassettes with synthetic audio.
- **Dependencies:** pinned exactly, with hashes, and installed frozen. Models are pinned by revision and file sha256.
- **Container tests run in CI** (G2): every package with container tests has a CI step that runs them with the image, and a required job may not skip silently.
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.
- **Neutrality test item 4:** it doesn't apply until the alpha gate; each PR says so.

## Review Focus

1. **A line edited, or its provider switched, after its take was made.** An edit gives `timing.no_take` until narration runs, and then the new take is selected. Switching providers and back selects the routed provider's take, and `narrate` reports reuse only when that take is the one selected. Test: Tasks 6 and 9.
2. **Numerals and symbols** ("In 2014 it cost £13.60."). Every script word gets a time, the unaligned ones are marked `interpolated`, and an anchor on "£13.60" resolves. Test: Tasks 4 and 5.
3. **A provider failure mid-narration.** A typed error and exit 9, naming the line and provider. Takes already made are kept and a re-run makes only the missing ones. The key appears nowhere. Test: Tasks 6 and 7.
4. **A mix that can't meet its targets, or a project with no music.** The first gives `mix.loudness_unmet` and nothing is cached; the second still mixes and meets loudness. Test: Task 11.
5. **Narration longer than the scene allows, and shots that do not tile.** `timing.overrun` names the scene, `N` and the limit, and the timeline grows. The video frame total always equals the mix length. Test: Tasks 9 and 11.

---

## Tasks

PR order: Task 1 → 2 → 3 → 4 → then 5 and 6 in either order → 9 → then 7, 8 and 10 in any order (8 needs 5) → 11. Task 12 comes after the alpha gate. Each task is one PR; the files listed are the expected ones.

### Task 1: M3 fixes from the audit (PR M3.6)

**Files:** `plugins/backend-hyperframes/src/{render,compile,captions}.ts`, `components/src/node/composition.ts` (export the HTML builder), `components/src/caption_track/lines.ts`, `plugins/backend-hyperframes/test/{segment,segment.container,compile,key,captions}.test.ts`, `.github/workflows/render-smoke.yml`, `.gitignore`.

**Interfaces:**
- `renderJobCommand(shot)` encodes `--body <body.start − start>,<body.end − start>` from `compileSpan`.
- `CompileInputs` gains `body: { start, end }` (relative to the compiled span) and `html` (sha256 of the composition HTML without the mount spec).
- `captionCues` returns final display times: `end = min(max(cue.end, cue.start + min_display_frames), next cue's start, shot end)`.

- [ ] **Step 1: Write the failing tests.**
  - **G1 frame counts:** two shots `[0,60)` and `[60,150)` with a 12-frame dissolve give bodies of 54 and 84 frames plus a 12-frame segment, totalling 150. This is the same for 13 frames (54 + 83 + 13).
  - **Container G1:** the encoded body MP4s plus the segment come to exactly the timeline's frames.
  - **G1 cache key:** the incoming shot's render key differs between `d = 12` and `d = 13`.
  - **G4 cache key:** changing the composition HTML template changes the render key.
  - **G3 captions:** two cues 10 frames apart: the first ends at the second's start, with no overlap.
- [ ] **Step 2: Implement.** Correct the M3.3 tests that asserted the old ranges (`0,72` and `6,66`).
- [ ] **Step 3: Add the backend container tests to CI (G2).** In `render-smoke.yml`'s `smoke` job, run `pnpm --filter @cinewright/backend-hyperframes test` with `CINEWRIGHT_CONTAINER_TESTS=1` and the locked image, and fail if any test is skipped.
- [ ] **Step 4: Ignore iCloud duplicates (G5).** Change the `.gitignore` patterns to `* [0-9]` and `* [0-9].*`.
- [ ] **Step 5: Verify.** Run the full suite and the backend container tests locally. In CI the new step runs, and `smoke-compare` passes (the reference shot has no transition, so its hash is unchanged).
- [ ] **Step 6: Commit.**

### Task 2: Audio image and image tooling (PR M4.0a)

**Files:**
- Create: `container/audio/{Dockerfile,pins.json,models.json,pyproject.toml,uv.lock,image.lock.json,README.md,NOTICES.md}`, `container/audio/audio_job/{__init__,cli,versions}.py`, `.github/workflows/audio-image.yml`.
- Change: `tools/src/cinewright_tools/{pins,container,image_lock}.py` (`--image`; a timeout on the Python runner, G7), `pyproject.toml`, `.dockerignore`, `tools/tests/…`, `.github/workflows/checks.yml` (`image-lock` for both images).

**Interfaces:**
- `audio-job versions` reports, as JSON:
  - Python, torch, torchaudio, kokoro, misaki, `phonemizer-fork`, `espeakng-loader`, whisperx, ctranslate2 and spaCy versions;
  - the loaded espeak-ng library path and its version;
  - each model's revision and sha256.
- `inputs_hash(repo_root, image)`, `expected_pins(repo_root, image)` and `docker_build_args(repo_root, image)`.

- [ ] **Step 1: Write the failing tests.**
  - Pins tests for the audio image.
  - `inputs_hash(..., "audio")` covers exactly the audio build context.
  - `check-image-lock --image audio` reports `unpublished`.
  - `check-pins --image audio` compares with `audio-job versions`.
  - The Python runner kills a run at its timeout, by container name.
- [ ] **Step 2: Implement.**
  - **Base:** `python:3.12-slim-trixie` by digest, with apt from the render image's Debian snapshot.
  - **Python:** `uv sync --frozen`.
  - **Models**, checked against `models.json` sha256:
    - Kokoro-82M with every published voice;
    - `Systran/faster-whisper-small`;
    - torchaudio `WAV2VEC2_ASR_BASE_960H`;
    - `en_core_web_sm`, from its wheel by hash.
  - **Offline environment:** set `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and the cache folders.
  - **Notices:** `NOTICES.md` covers `phonemizer-fork`, espeak-ng (the binary in `espeakng-loader`, with its version and source location), and each model's licence.
- [ ] **Step 3: Verify.**
  - Build locally and record the image size and build time in the README.
  - `audio-job versions` succeeds with `--network none`, and importing kokoro and whisperx makes no network attempt.
  - Add the CI job that builds the image when its inputs change.
- [ ] **Step 4: Commit.** After merge, publish, then a follow-up PR locks the digest.

### Task 3: Audio spike and the PCM contract (PR M4.0b)

**Files:** `container/audio/spike/{run.sh,mix.json,text.json}`, a temporary `workflow_dispatch` job, `container/audio/README.md` §Determinism, `docs/DESIGN_SPEC.md` (D33), `plugins/audio-ffmpeg/settings.json` (mixer FFmpeg flags).

A spike modelled on M0.2.

- [ ] **Step 1: Mixer, in the render image.**
  - **The mix:**
    - three pink-noise "speech" bursts, one generated at **24 kHz**, resampled to 48 kHz;
    - a synthetic chord bed with the duck envelope;
    - gain to −14 LUFS and the 4× oversampled limiter at −1 dBTP;
    - output as raw s24le and WAV, then AAC at 384 kb/s in MP4.
  - **Where:** 3 runs each at `--cpus 1`, `2` and `4`, on two CI amd64 jobs (record `lscpu`), and locally.
  - **Record:** the PCM hash, the MP4 sha256, and the measured values.
- [ ] **Step 2: If PCM differs across machines,** repeat with `-cpuflags` restricted to a common SIMD set. If no setting gives one PCM hash per runner class, **stop and raise it** (D33).
- [ ] **Step 3: Kokoro, in the audio image.** One line with digits, a fixed seed, one thread and deterministic algorithms, 3× at `--cpus 1` and `4`. Record:
  - the PCM hash;
  - the real-time factor locally (under emulation) and in CI;
  - whether the native token timestamps are within one frame of Step 4's alignment, which decides Task 8 (G26).
- [ ] **Step 4: WhisperX.** Align and transcribe that take 3× at each CPU count. Record the hashes and the real-time factor, and confirm the digits get no times.
- [ ] **Step 5: Record and decide.**
  - Write the results tables into the README.
  - Write the PCM contract into D33.
  - Set the mixer flags.
  - Decide the arm64 build (an emulated real-time factor above 2).
  - Remove the temporary job.
- [ ] **Step 6: Commit.**

### Task 4: Plugin runtime, engine, registry and the STT interface (PR M4.5a)

**Files:**
- **SDK (TS):** `plugins/sdk-ts/src/{host,plugin,manifest,docker,limits}.ts` (`docker.ts` and `limits.ts` moved from `backend-hyperframes`, which now imports them), `plugins/sdk-ts/schema/manifest.schema.json`, `plugins/sdk-ts/src/kinds/{stt,common}.ts`, `plugins/sdk-ts/schema/kinds/stt.schema.json`.
- **SDK (Python):** `plugins/sdk-py/{pyproject.toml (>=3.12),src/…/plugin.py}`.
- **Engine:** `engine/{package.json,src/{index,plugins/registry,plugins/route}.ts,test/…}`.
- **Core:** `core/schema/asset.schema.json`, `core/src/timing/words.ts`, `core/src/findings.ts`.
- **Python tooling:** ruff per-file `target-version = "py312"` for the 3.12 packages, and a CI step running `sdk-py` tests on Python 3.12.

**Interfaces:**
- **Context:** `PluginContext` gains `workDir` and `onLog?`.
- **Container command:** `containerCommand(manifest, workDir, limits, name)`, with the start timeout `CONTAINER_START_TIMEOUT_MS = 60_000`.
- **stderr (F18):** the host keeps 64 KiB of stderr, with declared secret values replaced. A failed call's `PluginError.data.stderr` holds the tail.
- **STT requests:**
  - `stt.align`: `{ audio, text, words, language }` → `{ words: ({ start, end } | null)[], sample_rate, model }`, in samples at `sample_rate`;
  - `stt.transcribe`: `{ audio, language }` → `{ text, words, sample_rate, model }`.
- **Engine:** `findPlugins(kind, searchPath)` and `route(kind, ir, speaker, options)`.
- **Core:** `lineWords`, `interpolateWords`, `Finding`.
- **Asset schema:**
  - role `transcript`;
  - `take`, `sequence` and `scene` references;
  - `audio: { sample_rate, channels, samples }`;
  - `aligned_by`;
  - word `interpolated`, with word times in the asset's own samples.

- [ ] **Step 1: Write the failing tests.**
  - **Container command:** `containerCommand` has `--network none`, `--init`, `--name`, every limit, both mounts and the offline environment, with secret values off the command line.
  - **No orphans:** killing, timing out or shutting down a container plugin leaves no container (`docker ps --filter name=…` is empty).
  - **stderr:** the tail is returned in `data.stderr`, with a planted secret replaced.
  - **Engine:** the registry finds plugins by kind; routing follows settings, then the free-first rule.
  - **Interpolation:** "In 2014 it cost £13.60." gets marked times (Review Focus 2).
  - **Conformance:** the STT kit accepts a stub aligner.
  - **Python 3.12:** the Python SDK passes on 3.12.
- [ ] **Step 2: Implement.** Regenerate the types.
- [ ] **Step 3: Verify.** Run the full suite, `gen:check`, ruff and pyright. The backend container tests still pass with the moved `docker.ts`.
- [ ] **Step 4: Commit.**

### Task 5: WhisperX plugin (PR M4.5b)

**Files:** `plugins/stt-whisperx/{manifest.json,pyproject.toml,src/cinewright_stt_whisperx/{plugin,align,transcribe}.py,tests/…,README.md}` (Apache-2.0; a workspace member whose heavy dependencies are declared only in the image's project), `engine/src/jobs/transcribe.ts`, root `pyproject.toml` (`testpaths`, pyright `include`, with lazy heavy imports typed through a small protocol).

**Interfaces:** plugin `stt_whisperx`, capabilities `stt.align` and `stt.transcribe`, mounted at `/plugins/stt_whisperx`. `transcribeTake(store, takeId)` inserts or reuses the transcript asset.

- [ ] **Step 1: Write the failing tests.**
  - **Host, with a fake aligner:** segments map onto `lineWords` by character offsets, and unaligned words come back `null`.
  - **Container:** a take Kokoro synthesizes inside the test aligns, with every word timed after interpolation.
  - **Container:** two runs match, or the README records that only frozen results are used.
  - **Freezing:** the second `transcribeTake` makes no call.
- [ ] **Step 2: Implement.** English alignment only; any other language is `unsupported`, naming it.
- [ ] **Step 3: Verify.** Run the host and container tests, and add this package's container tests to the CI job from Task 2.
- [ ] **Step 4: Commit.**

### Task 6: TTS interface, takes and the narration job (PR M4.1a)

**Files:** `core/src/audio/select.ts`, `core/schema/script.schema.json` (line `take`), `core/src/ir/semantic.ts` (`project.mixed_sample_rates`), `plugins/sdk-ts/src/kinds/tts.ts`, `plugins/sdk-ts/schema/kinds/tts.schema.json`, `engine/src/jobs/narration.ts`, `core/schema/project.schema.json` (`settings.providers`), `cli/src/commands/narrate.ts`, `cli/src/exit-codes.ts` (`provider: 9`), `plugins/sdk-ts/test/fixtures/stub-tts/`.

**Interfaces:**
- **`tts.synthesize`:** `{ text, words, language, direction?, binding, lexicon, seed, sample_rate, output }` → `{ file, sample_rate, channels: 1, words: { start, end }[] | null (samples at the returned sample_rate), model, request, license }`.
- **Core:** `takeKey(ir, lineId, providerId)` and `selectedTake(ir, lineId): { take?: Asset; stale: boolean }`.
- **Engine:** `narrate(store, { lines?, retake?, provider? }): { made; reused; findings }`.

- [ ] **Step 1: Write the failing tests, using the stub TTS.**
  - **Reuse:** narrating makes one take per line and sets `line.take`; a re-run reuses them all.
  - **Stale takes (Review Focus 1):**
    - Editing the text or `direction` gives `stale` and one new take.
    - A lexicon entry the line uses does the same; one it doesn't use changes nothing.
  - **Provider switch (Review Focus 1):** narrating with A, then B, then A selects A's take again and reports reuse.
  - **Re-takes:** `--retake` makes a new take and selects it.
  - **User selection:** a user-set `line.take` is kept by narration while it is valid.
  - **Fallback alignment:** `words: null` triggers alignment and interpolation.
  - **Failures (Review Focus 3):** a failure on line 3 of 5 exits 9. Lines 1–2 are committed, and the re-run makes only lines 3–5.
  - **Sample rates:** mixed deliverable sample rates fail with `project.mixed_sample_rates`.
  - **Consent (D18):** a speaker with `synthetic: false` and no record is refused (`narration.consent_missing`).
  - **Provenance:** each take records provider, model, tier, licence and key, and a planted secret appears nowhere.
- [ ] **Step 2: Implement.** One patch per take: insert the asset and set `line.take`, as `author: { kind: "job", name: "narration" }`.
- [ ] **Step 3: Verify.**
- [ ] **Step 4: Commit.**

### Task 7: ElevenLabs TTS plugin and the vendor-SDK boundary (PR M4.1b)

**Files:** `plugins/tts-elevenlabs/{manifest.json,package.json,src/{index,request,words,lexicon,tier}.ts,test/{…,cassettes/}}`, `tools/src/cinewright_tools/boundaries.py`, `tools/tests/test_boundaries.py`.

**Interfaces:**
- Plugin `tts_elevenlabs`, secret `ELEVENLABS_API_KEY`.
- `POST /v1/text-to-speech/{voice_id}/with-timestamps`.
- `output_format` comes from `binding.settings.output_format`, otherwise a format Step 1 finds every tier accepts; the mixer resamples either way.
- `wordsFromCharacters(alignment, scriptWords, substitutions)`.

- [ ] **Step 1: Re-verify the API** on the task's day: the request and response fields, the output formats and their tiers, which models read IPA, and how to read the plan tier. Record it in the README.
- [ ] **Step 2: Write the failing tests.**
  - **Word times:** cassette replay gives one time per script word, from `alignment`; a substitution counts as one word.
  - **IPA:** on a model without IPA support it is `unsupported`.
  - **Error mapping:** 401, 429, 5xx and 422 map to typed errors, and the key is never echoed.
  - **Licence:** it carries the tier read at init.
  - **Boundary rule:** importing `elevenlabs` or `@elevenlabs/*` elsewhere fails the check.
  - **Live test:** opt-in and capped.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit.**

### Task 8: Kokoro plugin (PR M4.1c)

**Files:** `plugins/tts-kokoro/{LICENSE (GPL-3.0-or-later),manifest.json,pyproject.toml,src/cinewright_tts_kokoro/{plugin,lexicon}.py,tests/…,README.md}`, `tools/src/cinewright_tools/boundaries.py` (no `kokoro`, `misaki` or `phonemizer` import outside the plugin).

**Interfaces:** plugin `tts_kokoro`, mounted at `/plugins/tts_kokoro`. It returns `words: null` (Task 3 did not clear its native times), so its takes are aligned by `stt_whisperx`.

- [ ] **Step 1: Write the failing tests.**
  - **Host:** the lexicon translation is correct, and a missing `voice` is `invalid_request` (no default voice).
  - **Container:** synthesis at 24 kHz with the network off.
  - **End to end:** the reference narration through Kokoro and through the ElevenLabs cassette both yield anchors that resolve for every line (the V0_1_PLAN M4.1 criterion).
  - **Boundary rule:** the import check fails outside the plugin.
- [ ] **Step 2: Implement.** Use the spike's thread and determinism settings (`torch.set_num_threads(1)`, `torch.use_deterministic_algorithms(True)`, `torch.manual_seed(seed)`); takes still differ across CPUs, which is fine because they are frozen.
- [ ] **Step 3: Verify.** Run the host and container tests in CI.
- [ ] **Step 4: Commit.**

### Task 9: Timing solver (PR M4.2)

**Files:** `core/src/timing/{solve,span}.ts`, `core/schema/pack/tokens.schema.json`, `packs/{neutral,playful}/{tokens.json,README.md}`, `components/src/*/props.schema.json` (`x-readable`), `core/src/catalog/catalog.ts` (`readableWords`), `cli/src/commands/{timing,compile,render-shot}.ts`, `cli/test/fixtures/m1-reference/` (narrated with the stub TTS), tests.

**Interfaces:** `solveTiming(ir, pack, catalog): { table; sequences: Record<id, { start; frames }>; scenes: Record<id, Span>; shots: Record<id, Span>; findings }`, which is pure.

- [ ] **Step 1: Write the failing tests.**
  - **Snapping:** spans snap to narration within `flex`.
  - **Overrun (Review Focus 5):** the finding is right, and later scenes shift.
  - **Tiling:**
    - Shots tile every scene.
    - A start anchor outside its scene is `timing.uncovered`.
    - A disagreeing `duration` is a warning.
  - **Two sequences:** they are placed end to end.
  - **Other findings:** `short_hold` counts only `x-readable` props; `no_take` covers a stale or missing take; `unknown_word` covers a removed word.
  - **Packs:** neutral and playful differ only through tokens.
  - **Reference project:** the sum of shot spans equals the sum of scene lengths equals the timeline length.
  - **CLI:** `compile` without `--timing` uses the solved spans.
- [ ] **Step 2: Implement.** Frames come from samples by `floor` at starts and `ceil` at ends.
- [ ] **Step 3: Verify.** Run the full suite; the specimen goldens are unchanged.
- [ ] **Step 4: Commit.**

### Task 10: Music and SFX interface, local library, Composer job (PR M4.3a)

**Files:** `plugins/sdk-ts/src/kinds/music.ts`, `plugins/sdk-ts/schema/kinds/music.schema.json`, `plugins/library-audio/{…}`, `core/schema/sequence.schema.json` (`music`), `core/src/audio/select.ts` (`musicKey`), `engine/src/jobs/composer.ts`, `cli/src/commands/compose.ts`, and tests with a library synthesized at test time.

**Interfaces:**
- **Requests:**
  - `music.request`: `{ genre, mood, brief, bpm_min, bpm_max, duration_ms, vocals: false, seed?, output }`;
  - `sfx.request`: `{ name, output }`.

  Both return `{ file, sample_rate, channels, model?, request, license }`.
- **Library:** `library.json` on `CINEWRIGHT_AUDIO_LIBRARY_PATH`, with deterministic scoring.
- **Composer:** `compose(store, { sequence?, provider? })`.

- [ ] **Step 1: Write the failing tests.**
  - The request comes from the cascade-resolved `sound.music.*` plus the mood, `music_bed`, the length and `vocals: false`.
  - The Composer sets `sequence.music`, and a re-run reuses it.
  - A library entry with no licence is rejected.
  - SFX are requested only when enabled.
  - No match gives `compose.no_match`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.**
- [ ] **Step 4: Commit.**

### Task 11: Mixer (PR M4.4)

**Files:** `plugins/audio-ffmpeg/{manifest.json,package.json,settings.json,src/{plan,envelope,render,measure}.ts,test/…,README.md}`, `core/src/project/layout.ts` (`MIX_CACHE_DIR`), `cli/src/commands/mix.ts`, `.github/workflows/render-smoke.yml` (mix determinism on both runners).

**Interfaces:**
- `planMix({ ir, deliverableId, pack, solved }): MixPlan`, which is pure. It contains:
  - clips (asset hash, bus, start sample on the project timeline including the sequence offset, trim);
  - bus gains and duck envelope breakpoints;
  - targets;
  - the sample rate and length (`total frames × rate / fps`).
- `renderMix({ plan, renderImage, cacheDir, limits })` runs FFmpeg in the render image (`--entrypoint ffmpeg`, as `segment.ts` does) and parses `ebur128` on the host.

- [ ] **Step 1: Write the failing tests.**
  - **Unit:**
    - A take is placed so its first word lands on the line's start, with a negative offset trimmed.
    - A second sequence's clips are offset by its start.
    - The envelope reaches `bus + depth` in speech.
    - The key changes with any input or the render image digest.
  - **Container:**
    - The reference project meets −14 LUFS ±1 LU and −1 dBTP.
    - Music is lower by `depth_db` ±0.5 dB during speech.
    - Two runs give the same PCM hash, and an unchanged plan is a cache hit.
    - Unmet targets give `mix.loudness_unmet`, with nothing cached; no music still mixes (Review Focus 4).
    - The mix length in samples equals the video frame total × rate / fps for each deliverable (Review Focus 5).
- [ ] **Step 2: Implement** with the spike's flags.
- [ ] **Step 3: Verify.** Run the container tests in CI and add the mix to `smoke-compare`.
- [ ] **Step 4: Commit.**

### Task 12: Generative music plugin (PR M4.3b, after the alpha gate)

**Files:** `plugins/music-elevenlabs/{manifest.json,package.json,src/…,test/cassettes/…,README.md}`, or `plugins/music-stableaudio/` if the decision falls back.

- [ ] **Step 1: Re-verify** `POST /v1/music`: its parameters (`prompt`, `music_length_ms`, `force_instrumental`; `seed` not combinable with `prompt`), its output formats, and the terms by tier. Record them in the README.
- [ ] **Step 2: Write the failing tests.**
  - Cassette replay maps a Composer request to the provider request: an instrumental bed with no `seed`, and the length within range.
  - The asset licence carries the tier and the exclusions.
  - Errors map as in Task 7.
  - The live test is opt-in and capped.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit.**

## Done when (M4 acceptance criteria map)

| Acceptance criterion | Proven by |
| --- | --- |
| Audit G1–G4: bodies and segments add up; the body range and the HTML are in the render key; captions don't overlap; container tests run in CI | Task 1 |
| M4.0: repeatability and image size recorded; a pinned audio image with models and network off; the PCM contract in D33 | Tasks 2 and 3 |
| M4.5: a frozen take yields a transcript and word times, repeatable or frozen; digits get interpolated times | Tasks 4 and 5 |
| M4.1: the same narration through either plugin yields timing anchors; re-running reuses frozen takes; a re-take is explicit; stderr captured (F18); vendor-SDK rule (F16) | Tasks 4, 6, 7 and 8 |
| M4.2: spans snap to narration within `flex`; an overrun is a finding, never a stretch; hold tokens read (F21); a removed word is a finding; shots tile scenes | Task 9 |
| M4.3: the request comes from `sound.*` and the mood; every asset records provider, tier and licence | Task 10 (Task 12, the generative plugin, after the alpha gate) |
| M4.4: loudness and true-peak met; music ducks by the pack's depth; identical PCM hash on two runs; **the mix length equals the video frame total for every deliverable** | Tasks 9 and 11 |
