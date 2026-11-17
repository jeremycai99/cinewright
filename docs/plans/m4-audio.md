# M4 — Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the timeline a real, deterministic soundtrack:
- narration takes from TTS plugins, frozen in the CAS with provenance;
- word times from forced alignment against the script;
- a timing solver that turns takes into the timing table M3 already consumes;
- music and SFX from a local library or one generative provider, chosen by a rules-based Composer job;
- a mixer that meets the delivery profile's loudness and true-peak targets, with ducking from the pack, and gives the same PCM on every run.

**Architecture:**
- **A second pinned image, `cinewright-audio`** (audit decision 7). It holds:
  - Python 3.12 with CPU-only PyTorch, Kokoro and WhisperX;
  - the same FFmpeg build as the render image;
  - every model baked in by revision and sha256.

  Like the render image, it runs with the network off.
- **Local Python plugins run as subprocess plugins inside that image.** The plugin manifest gains `runtime.container`, and the SDK host starts `docker run -i` with the run limits. JSON-RPC over stdio is unchanged (D32), and files cross the boundary through a per-plugin work folder.
- **Kind interfaces for TTS, STT and music/SFX** go in the plugin SDK, with conformance cases.
- **The narration and Composer jobs** live in a new `engine/` package. It holds jobs only for now; the runtime arrives in M7.1a. The jobs call plugins through the plugin interface and write takes and music as IR assets through the store, as job authors.
- **The timing solver** is pure core code: takes plus IR plus pack give the timing table and findings.
- **The mixer** is a new Apache-2.0 backend plugin, `plugins/audio-ffmpeg`. It plans a mix from the IR and runs it in the audio image, cached by a mix key.

**Tech Stack:**
- **Audio image:** Python 3.12, `torch` and `torchaudio` 2.8.x CPU wheels (WhisperX 3.8.6 pins `torch~=2.8.0`), `kokoro` 0.9.4 with `misaki[en]` 0.9.4, `whisperx` 3.8.6, and Debian `ffmpeg` `7:7.1.5-0+deb13u1` from the render image's snapshot. Everything is locked with hashes in the image's own `uv.lock`.
- **ElevenLabs:** plain `fetch` against the REST API, with no vendor SDK.
- **Versions** were checked against PyPI and the vendor docs on 2026-11-16. Each task re-checks them on its own execution day (AGENTS.md: verify external APIs).

**Spec:**
- `docs/V0_1_PLAN.md`: §M4, Open issue 8, and §Revised task breakdown and order (M4.0, M4.5a–b, M4.1a–c, M4.2, M4.3a–b, M4.4).
- `docs/plans/roadmap-audit-2026-11-16.md`: §3.3 (issue 8), §3.4 (audio risks), F16, F18 and F21, and decisions 7 and 8.
- `docs/DESIGN_SPEC.md`: §Voice production pipeline, §Sound palette, and D16, D17, D26, D27, D29, D32, D33, D35, D37 and D38.
- `AGENTS.md` §3: invariants 4, 5, 6, 7 and 11, and §6 (licences, consent, no media in git).

## Decisions this plan makes

The first two rows are the audit's maintainer decisions due in M4, and row 3 is a new one. **Approving this plan approves all three.**

| Choice | Value | Why |
| --- | --- | --- |
| **Second image for audio (audit decision 7)** | `container/audio/` builds `ghcr.io/jeremycai99/cinewright-audio`, with its own pins, lock, inputs hash and publish workflow. The image tools (`cinewright-build-image`, `-check-pins`, `-check-image-lock`) take `--image render\|audio`. | Torch and the models would triple the render image. Kokoro needs Python below 3.13, and the repository is on 3.13. |
| **Kokoro and espeak-ng (audit decision 8)** | `misaki[en]` falls back to espeak-ng (GPL-3.0) for out-of-vocabulary words and loads it into the plugin's process. So `plugins/tts-kokoro` is licensed **GPL-3.0-or-later**, like `backend-blender`. Core reaches it only over JSON-RPC across a process boundary. The audio image ships espeak-ng's licence and a source pointer at its pinned snapshot version. | The same boundary as Blender (invariant 10), and the fallback keeps quality on unknown words. **Cost if wrong:** relicensing one small package. |
| **Generative music provider (M4.3b, new decision)** | **ElevenLabs Music**: the same API key as TTS, a REST API, and commercial use on paid plans. It is re-verified at the task's start (endpoint, licence terms, whether output is repeatable). If those terms fail, use Stable Audio's API instead, and record the switch in the PR. | One vendor account covers v0.1's paid audio. The plugin interface keeps it replaceable (invariant 6). |
| Where local plugins run | Subprocess plugins with `runtime.container: { image: "audio" }`. The host resolves the image from `container/audio/image.lock.json` (or a local tag in dev) and runs:<ul><li>`docker run --rm -i --network none`;</li><li>the M3 run limits;</li><li>the work folder mounted at `/work`;</li><li>`-e` for declared secrets only.</li></ul> | Network off and pinned models, with the D32 protocol unchanged. |
| Files across the plugin boundary | `PluginContext.workDir`, a per-instance folder the host creates and deletes. Containers see it as `/work`. Requests and results name files relative to it. | One contract for in-process and containerized plugins. |
| Script words | `lineWords(text)`: a whitespace split with empty items dropped (core). It is the one definition of word indices, and it is already what M3's captions and anchors use. Aligners and TTS plugins map their tokens onto it. | Anchors (`point: word`) index these words. |
| Lexicon values | A respelling (`KOO-ber-NET-eez`, the spec's example) by default; a value wrapped in slashes (`/kuːbərˈnɛtiːz/`) is IPA. Plugins translate:<ul><li>**ElevenLabs:** substitutes respellings. It sends IPA bare in slashes on models that read it (`eleven_v4`), or as a `<phoneme>` tag where the model supports it. Otherwise IPA is `unsupported`, naming the term.</li><li>**Kokoro:** uses misaki's `[term](/ipa/)` for IPA and substitutes respellings.</li></ul>A substituted term still counts as **one** script word. | Provider-neutral data (D29). The word count never changes, so anchors stay valid. |
| Take identity and selection | A take is an asset with role `take`, its `line`, and `provenance.request_hash` set to `takeKey(ir, lineId, providerId)`. That key is computed in core (no plugin needed): the JCS hash of the line's text, the provider id, the speaker's binding for that provider, the lexicon entries whose terms occur in the text, and the profile sample rate. The seed and the secrets are left out. The **selected take** for a line is the last take in the asset list whose key still equals `takeKey` for its own provider. `--retake <line>` adds a new take with a new seed, which then wins. | Editing a line, its binding or a lexicon entry it uses changes the key, so a stale take is never used. The pure solver can select takes without loading plugins. Re-running reuses frozen takes (D33), and a re-take is always explicit. Music uses the same rule (`musicKey`). |
| Alignment and transcription | Timing uses **forced alignment against the script** (`stt.align`). Transcription (`stt.transcribe`) is only for the STT-versus-script check (M6.1c). Both results are frozen:<ul><li>**alignment:** on the take, as `words` plus `aligned_by` provenance;</li><li>**transcription:** as a `transcript` asset keyed by take hash, plugin version and model hash.</li></ul> | Audit §3.3. Tier A never needs live STT. |
| Words with no time (digits, symbols) | Interpolated. A run of unaligned words fills the gap between its aligned neighbours (or the take's speech bounds), split by character count. Each such word is marked `interpolated: true`. An anchor on one resolves to its interpolated time. | WhisperX gives "2014" or "£13.60" no time (audit §3.3). Anchors need a defined result. |
| Provider routing (D29) | Use `settings.providers.<kind>` (an ordered list of plugin ids) if set. Otherwise take the installed plugins the speaker has a binding for, in this order:<ol><li>free plugins (`cost_model.unit: "free"`);</li><li>paid plugins whose secrets are present;</li><li>then by plugin id.</li></ol>`--provider <id>` overrides both. | No provider is a default in code (invariant 11). The order is cost-conservative (D17) and deterministic. |
| Timing solver | **Per scene:**<ul><li>head pad, then the lines' speech spans in order, separated by the line gap, then the tail pad;</li><li>the natural length `N` is the sum of those;</li><li>for `voiceover` sync, the scene length is `max(N, ⌈target·(1−flex)⌉)`, and spare time goes to the tail.</li></ul>**Findings, never changes to audio:**<ul><li>`N > target·(1+flex)` is `timing.overrun` (scene, `N`, limit). The timeline grows; speech is never stretched or cut.</li><li>A shot shorter than `max(density.min_hold, density.hold_per_word × readable words)` is `timing.short_hold`.</li><li>A line with no selected take is `timing.no_take`.</li><li>An anchor on a missing word is `timing.unknown_word`.</li></ul>`fixed` and `music` sync both use `target` exactly in v0.1, with overrun findings. Music-led sync is v0.2. | The roadmap's M4.2 criteria. Pacing values are tokens, not literals. |
| New tokens | `sound.voice.line_gap`, `sound.voice.head` and `sound.voice.tail`, in ms, in the pack schema and both packs, with the README citing the norm each follows. Text props that count toward hold time are marked `"x-readable": true` in component prop schemas. | Pacing is taste, so it lives in packs (AGENTS.md §2). F21's tokens get their first reader. |
| Findings | `Finding = { rule, severity: "error" \| "warning", entity, pointer?, message, data }` in `core/src/findings.ts`. The solver and jobs return findings; M6 reuses the type. | One shape before M6's critics. |
| Music and SFX selection | **Music:** an asset with role `music` and a new `sequence` reference. The Composer builds its request from `sound.music.*` (resolved through the cascade), the sequence's `mood` and `music_bed` text, and the sequence length. The selected bed follows the take rule: the last asset with that sequence and request hash.<br>**SFX:** only when `sound.sfx.enabled`. The library is matched by name from `scene.sound.sfx`; each SFX is an asset with a `scene` reference and plays at the scene's start. | The same freeze-and-select rule as takes. SFX placement stays minimal in v0.1; v0.2 adds cue points. |
| Mix loudness method | No dynamic `loudnorm`. The steps:<ol><li>measure the premix (`ebur128=peak=true`);</li><li>apply gain to the profile's integrated target;</li><li>if the true peak would exceed the target, limit at the target on a 4× oversampled signal (`aresample` → `alimiter` → `aresample`);</li><li>re-measure.</li></ol>Missing the target by more than `tolerance_lu`, or the true peak at all, is `mix.loudness_unmet`, naming the measured and target values. Nothing is cached. | Every step is a fixed linear or limiter operation that M4.0 can test for repeatability, and the targets are checked, not assumed. |
| Ducking | Music gain is `sound.bus.music_db`, plus `duck.depth_db` during each line's speech span (`scene.sound.duck_under_vo_db` overrides it), with linear ramps of `duck.attack` and `duck.release` ms. It is applied as a sample-exact gain envelope computed from the timing table, not a sidechain compressor. | The depth is exact and testable ("ducks by the pack's depth"), and repeatable. |
| PCM contract (into D33 after the spike) | The **PCM hash** is the sha256 of the master WAV's `data` chunk: interleaved PCM s24le at the profile's sample rate, stereo, before any encoding. Encoded files (AAC in MP4) are byte-identical per runner class, as for video (M5.1). | Audit §3.4: D33 does not yet say where the PCM hash is taken. |
| Mix cache | `.cinewright/cache/mixes/<mix key>/`: `master.wav`, `pcm.sha256`, `measure.json` and `plan.json`. The mix key is the JCS hash of the mix plan (clip hashes, offsets, gains, envelopes, targets), the audio image digest and the mixer version. It is disposable (D37). | The same pattern as renders (M3.2b). |
| Jobs' home | A new `@cinewright/engine` package (Apache-2.0) with `src/jobs/` and `src/plugins/registry.ts`. The registry finds plugins by id from `plugins/*/manifest.json` and `CINEWRIGHT_PLUGIN_PATH`. | M5.4 runs jobs in dependency order and M7.1a adds the runtime there. The CLI-through-plugins ruling from M3 starts here. |
| Dev commands | Documented as developer tools until `cinewright render` (M5.4):<ul><li>`cinewright narrate [--line <id>] [--retake <line>] [--provider <id>]`;</li><li>`cinewright timing [--out <file>]`;</li><li>`cinewright compose [--sequence <id>]`;</li><li>`cinewright mix --deliverable <id>`.</li></ul>`compile` and `render-shot` use the solved timing when `--timing` is absent. New exit code `provider: 9` for a typed plugin failure. | Lets agents and tests drive each step. |
| Live API tests | Opt-in with `CINEWRIGHT_LIVE_TESTS=1` plus the key, capped at 300 characters of TTS and one 10-second music clip per run. They never run in CI by default. Cassettes keep each real response's JSON and replace the audio with a synthetic tone of equal length, so no voice audio enters git. | AGENTS.md §4.3 and §6. |

## Global Constraints

- **Rules from earlier milestones:** M1–M3 conventions and neutrality rules bind. No voice id, genre, BPM, loudness or pacing literal goes in core, engine, components or plugins. They live in packs, profiles, bindings and fixtures.
- **Determinism (D33):** the same mix plan in the same audio image gives the same PCM hash, and byte-identical files on one runner class. TTS, music and STT outputs are frozen as assets and never regenerated without an explicit re-take.
- **Network:** off for every container run, including local plugins. Only ElevenLabs and the music plugin reach the network, from the host.
- **Secrets:** a secret never appears in a request hash, provenance, log, cassette, error message or patch.
- **Licences:** every take, music, SFX and transcript asset records its provider, model, plan tier and licence (AGENTS.md §6). The render gate's use of these fields is M6; here they must be present and schema-valid.
- **No media in git:** test audio is synthesized at test time by FFmpeg (tones, noise) or comes from cassettes with synthetic audio.
- **Dependencies:** pinned exactly, with hashes, and installed frozen. Models are pinned by repository revision and file sha256.
- **Git:** commits end with the harness trailer. Pushing, opening PRs and merging need the maintainer's go-ahead.
- **Neutrality test item 4:** it doesn't apply until the alpha gate; each PR says so.

## Review Focus

1. **A line edited after its take was made.** The request hash no longer matches, so the solver reports `timing.no_take` until narration runs, and then it uses only the new take. The stale take is never mixed. Test: Tasks 5 and 8.
2. **Numerals and symbols** ("In 2014 it cost £13.60."). Every script word gets a time; the unaligned ones are marked `interpolated`; an anchor on "£13.60" resolves to its interpolated start. Test: Tasks 3 and 4.
3. **A provider failure mid-narration** (rate limit, timeout, missing key). This gives a typed error and exit 9, naming the line and provider. Takes already made are kept, each committed as it is made, and a re-run makes only the missing ones. The key appears nowhere in output or logs. Test: Tasks 5 and 6.
4. **A mix that can't meet its targets** (a very dense or clipped premix), or a project with no music selected. The first gives `mix.loudness_unmet` with the measured values and nothing cached. The second still mixes, and meets loudness on dialogue alone. Test: Task 11.
5. **Narration longer than the scene allows.** This gives `timing.overrun`, naming the scene, `N` and the limit. Speech is not stretched, the timeline grows, and later scenes shift with frame totals intact. Test: Task 8.

---

## Tasks

PR order: Task 1 → 2 → 3 → then 4 and 5 in either order → 7 → 8 → then 6, 9 and 10 in any order → 11. Each task is one PR; the files listed are the expected ones.

### Task 1: Audio image and image tooling (PR M4.0a)

**Files:**
- Create: `container/audio/{Dockerfile,pins.json,models.json,pyproject.toml,uv.lock,image.lock.json,README.md}`, `container/audio/audio_job/{__init__,cli,versions}.py`, `.github/workflows/audio-image.yml`.
- Change: `tools/src/cinewright_tools/{pins,container,image_lock}.py` (`--image render|audio`), `pyproject.toml` (workspace member `container/audio/audio_job`), `.dockerignore`, `tools/tests/{test_pins,test_container,test_image_lock}.py`, `.github/workflows/checks.yml` (`image-lock` for both images).

**Interfaces:**
- Produces:
  - `audio-job versions`, a JSON report: Python, torch, torchaudio, kokoro, misaki, whisperx, ctranslate2, FFmpeg and espeak-ng versions, and each model's revision and sha256.
  - `inputs_hash(repo_root, image)`, `expected_pins(repo_root, image)` and `docker_build_args(repo_root, image)`.

- [ ] **Step 1: Write the failing tests.**
  - The pins test reads `container/audio/pins.json`, and its FFmpeg version equals the render image's.
  - `inputs_hash(..., "audio")` covers exactly the audio build context and is stable.
  - `cinewright-check-image-lock --image audio` reports `unpublished` on an empty lock.
  - `cinewright-check-pins --image audio` compares `audio-job versions` with the pins.
- [ ] **Step 2: Implement.**
  - **Base:** `python:3.12-slim-trixie` by digest, using apt from the render image's Debian snapshot (`ffmpeg`, `espeak-ng`, `libsndfile1`).
  - **Python packages:** `uv sync --frozen` from the image's own lock (Python 3.12, torch CPU index).
  - **Models:** downloaded at build time by revision and checked against `models.json` sha256:
    - Kokoro-82M weights, plus the voices a binding may name (all published voices; they are small);
    - the faster-whisper `small` model, for transcription;
    - the torchaudio `WAV2VEC2_ASR_BASE_960H` bundle, for English alignment.
  - Each model records its licence in `models.json`.
  - `ENTRYPOINT ["audio-job"]`.
- [ ] **Step 3: Verify.** Build the image locally. Then `cinewright-check-pins --image audio` passes, and `docker run --network none … audio-job versions` succeeds with the network off.
- [ ] **Step 4: Commit.** After merge, `audio-image` publishes and a follow-up PR locks the digest, as in M0 and M3.

### Task 2: Audio spike and the PCM contract (PR M4.0b)

**Files:** `container/audio/audio_job/{mix,measure}.py` (prototype), `container/audio/spike/{run.sh,mix-plan.json,text.json}`, a temporary `workflow_dispatch` job, `container/audio/README.md` §Determinism, `docs/DESIGN_SPEC.md` (D33), `container/audio/audio-settings.json`.

This task is a spike modelled on M0.2. It decides how the PCM contract is measured.

- [ ] **Step 1: Mixer.**
  - **The mix:** three pink-noise "speech" bursts, a synthetic chord bed with the duck envelope, gain to −14 LUFS, the 4× oversampled limiter at −1 dBTP, s24le WAV, then AAC at 384 kb/s in MP4.
  - **Where:** 3 runs each at `--cpus 1`, `2` and `4`, on two CI amd64 jobs (record each machine's `lscpu` model and flags), and locally.
  - **Record:** PCM hash, MP4 sha256, and measured loudness and true peak.
- [ ] **Step 2: If PCM differs across machines,** repeat with FFmpeg `-cpuflags` restricted to a common SIMD set, and record. If no setting gives one PCM hash per runner class, **stop and raise it** (D33).
- [ ] **Step 3: Kokoro.** One line with digits, one voice, a fixed seed, `torch.set_num_threads(1)` and deterministic algorithms. Run 3× at `--cpus 1` and `4`. Record the PCM hash, the real-time factor, and whether misaki's token timestamps are present (a tie-break input for Task 7).
- [ ] **Step 4: WhisperX.** Align and transcribe that take 3× at each CPU count. Record the JSON hashes and the real-time factor, and confirm the digit words get no times.
- [ ] **Step 5: Record and decide.**
  - Write the image size and build time, and the results tables, into `container/audio/README.md`.
  - Write the PCM contract into D33.
  - Set `audio-settings.json`: `cpuflags` (if needed) and `threads: 1`.
  - Remove the temporary job.

  Expected outcome: TTS and STT freeze regardless of these results; only the mixer's result can block.
- [ ] **Step 6: Commit.**

### Task 3: Plugin runtime additions and the STT interface (PR M4.5a)

**Files:** `plugins/sdk-ts/src/{host,plugin,manifest}.ts`, `plugins/sdk-ts/schema/manifest.schema.json` (`runtime.container`), `plugins/sdk-ts/src/kinds/{stt,common}.ts`, `plugins/sdk-ts/schema/kinds/stt.schema.json`, `plugins/sdk-py/{pyproject.toml (requires-python >=3.12),src/cinewright_plugin_sdk/plugin.py (workDir)}`, `core/schema/asset.schema.json`, `core/src/timing/words.ts` (`lineWords`, `interpolateWords`), `core/src/findings.ts`, tests, `gen:check` outputs.

**Interfaces:**
- **Context:** `PluginContext` gains `workDir: string` and `onLog?: (line: string) => void`.
- **Container runtime:** a `runtime.container` subprocess is spawned through `containerCommand(manifest, workDir, limits)`.
- **stderr (F18, pulled forward from M4.1a because this task changes the host first):** the host keeps the last 64 KiB of plugin stderr. A failed call's `PluginError.details.stderr` holds the tail.
- **STT requests:**
  - `stt.align`: `{ audio, text, words: string[], language }` → `{ words: ({ start, end } | null)[], sample_rate, model }`, in samples at `sample_rate`;
  - `stt.transcribe`: `{ audio, language }` → `{ text, words: { text, start, end }[], sample_rate, model }`.
- **Core helpers:**
  - `lineWords(text): string[]`;
  - `interpolateWords(words, bounds): WordTiming[]`, which marks the words it fills;
  - `Finding`.
- **Asset schema:**
  - role `transcript`;
  - optional `take` (Ref<asset>), `sequence` (Ref<sequence>) and `scene` (Ref<scene>);
  - `audio: { sample_rate, channels, samples }`;
  - `aligned_by` (provenance);
  - word `interpolated`.

- [ ] **Step 1: Write the failing tests.**
  - The manifest accepts `runtime.container`.
  - `containerCommand` has `--network none`, every M3 limit, the `/work` mount, and only declared secrets as `-e` names, with values never on the command line (passed through the child's environment).
  - A stub plugin that writes to stderr and fails returns the tail in `details.stderr`.
  - The Python SDK sees `workDir`.
  - `interpolateWords` fills "In 2014 it cost £13.60." with marked times inside the neighbours' bounds (Review Focus 2), including at a line's start and end.
  - The STT conformance kit accepts a stub aligner.
- [ ] **Step 2: Implement.** Regenerate the TS and Python types (`pnpm gen`).
- [ ] **Step 3: Verify.** Run the full suite, `gen:check`, ruff and pyright.
- [ ] **Step 4: Commit.**

### Task 4: WhisperX plugin (PR M4.5b)

**Files:** `plugins/stt-whisperx/{manifest.json,pyproject.toml,src/cinewright_stt_whisperx/{plugin,align,transcribe}.py,tests/…,README.md}` (Apache-2.0; heavy imports are lazy), `container/audio/pyproject.toml` (install the plugin), `engine/src/jobs/transcribe.ts` (freeze a transcript for a take).

**Interfaces:**
- Consumes: Task 3's STT kind and `interpolateWords`.
- Produces: the plugin id `stt_whisperx`, capabilities `stt.align` and `stt.transcribe`, and `transcribeTake(store, takeId)`, which inserts or reuses the `transcript` asset.

- [ ] **Step 1: Write the failing tests.**
  - **Host unit tests, with a fake aligner:** whisperx segments map onto `lineWords`. A word whisperx splits or merges maps by character offsets. Unaligned words come back `null`, for the engine to interpolate.
  - **Container test:** a take that Kokoro synthesizes inside the test aligns with every script word timed.
  - **Container test:** two runs return the same JSON, or the README records that only the frozen result is used.
  - **Freezing:** a second `transcribeTake` makes no plugin call. The transcript key is take hash, plugin version and model hash.
- [ ] **Step 2: Implement.** English alignment uses the baked wav2vec2 bundle. Another language returns `unsupported`, naming the language.
- [ ] **Step 3: Verify.** Run the host tests and the container tests.
- [ ] **Step 4: Commit.**

### Task 5: TTS interface, takes and the narration job (PR M4.1a)

**Files:** `core/src/audio/select.ts`, `plugins/sdk-ts/src/kinds/tts.ts`, `plugins/sdk-ts/schema/kinds/tts.schema.json`, `engine/{package.json,src/{index,plugins/registry,plugins/route,jobs/narration}.ts,test/…}`, `core/schema/project.schema.json` (`settings.providers`), `cli/src/commands/narrate.ts`, `cli/src/exit-codes.ts` (`provider: 9`), `plugins/sdk-ts/test/fixtures/stub-tts/`.

**Interfaces:**
- **`tts.synthesize`:** `{ text, words: string[], language?, binding: VoiceBinding, lexicon: Record<string,string>, seed, sample_rate, output }` → `{ file, sample_rate, channels: 1, words: { start, end }[] | null, model, request: object, license }`.
- **Engine:**
  - `findPlugins(kind, searchPath)`;
  - `route(kind, ir, speaker, options): LoadedPlugin`;
  - `narrate(store, { lines?, retake?, provider? }): { made: string[]; reused: string[]; findings: Finding[] }`.
- **Core (`core/src/audio/select.ts`):** `takeKey(ir, lineId, providerId): HashString` and `selectedTake(ir, lineId): Asset | undefined`.

- [ ] **Step 1: Write the failing tests, using the stub TTS.**
  - **Reuse:** narrating the reference project makes one take per line; running again makes none (all reused).
  - **Stale takes:** editing a line's text makes exactly one new take, and `selectedTake` never returns the old one (Review Focus 1). Editing a lexicon entry the line uses does the same; editing one it doesn't use changes nothing.
  - **Consent (D18):** a speaker with `consent.synthetic: false` and no `consent.record` is refused (`narration.consent_missing`), with no plugin call.
  - **Re-takes:** `--retake` adds a take that wins.
  - **Fallback alignment:** a plugin returning `words: null` triggers `stt.align` and interpolation.
  - **Routing:** routing follows `settings.providers`, then the free-first rule.
  - **Failures (Review Focus 3):** a plugin failing on line 3 of 5 exits 9, naming the line and provider. Lines 1–2 are committed, and the re-run makes only lines 3–5.
  - **Provenance:** each take records provider, model, plan tier, licence and `request_hash`. A planted secret appears in none of the IR, the log or stderr.
- [ ] **Step 2: Implement.**
  - The job applies one patch per take, `author: { kind: "job", name: "narration" }`.
  - Word times are stored in samples at the profile's sample rate (D27), with `aligned_by` set.
- [ ] **Step 3: Verify.** Run the full suite.
- [ ] **Step 4: Commit.**

### Task 6: ElevenLabs plugin and the vendor-SDK boundary (PR M4.1b)

**Files:** `plugins/tts-elevenlabs/{manifest.json,package.json,src/{index,request,words,lexicon}.ts,test/{…,cassettes/}}`, `tools/src/cinewright_tools/boundaries.py` (vendor-SDK rule), `tools/tests/test_boundaries.py`.

**Interfaces:**
- Consumes: the Task 5 TTS kind.
- Produces:
  - plugin `tts_elevenlabs`, secret `ELEVENLABS_API_KEY`;
  - `POST /v1/text-to-speech/{voice_id}/with-timestamps`, with `output_format` from `binding.settings.output_format`, defaulting to `pcm_<profile rate>`;
  - `wordsFromCharacters(alignment, scriptWords, substitutions)`.

- [ ] **Step 1: Re-verify the API** on the task's day: the endpoint, the request fields (`model_id`, `voice_settings`, `seed`), the response (`audio_base64` plus `alignment` with `characters`, `character_start_times_seconds` and `character_end_times_seconds`), the `output_format` values, and which models read IPA. Record the findings in the plugin README.
- [ ] **Step 2: Write the failing tests.**
  - **Word times:** cassette replay gives one time per script word, from `alignment` (not `normalized_alignment`). A lexicon substitution counts as one word.
  - **IPA:** on a model without IPA support it is `unsupported`, naming the term.
  - **Error mapping:** 401 is `invalid_request` (the key is not echoed); 429 is `rate_limited`, retryable; 5xx is `provider_error`, retryable; a 422 tier error names the output format.
  - **Boundary rule:** importing `elevenlabs` or `@elevenlabs/*` outside `plugins/tts-elevenlabs/` fails the check.
  - **Live test:** opt-in and capped.
- [ ] **Step 3: Implement** (plain `fetch` with an abort signal; base64 PCM is written as WAV to `workDir`).
- [ ] **Step 4: Verify.** Run the suite and the boundaries check.
- [ ] **Step 5: Commit.**

### Task 7: Kokoro plugin (PR M4.1c)

**Files:** `plugins/tts-kokoro/{LICENSE (GPL-3.0-or-later),manifest.json,pyproject.toml,src/cinewright_tts_kokoro/{plugin,lexicon}.py,tests/…,README.md}`, `container/audio/{pyproject.toml,README.md (licence notices)}`, `tools/src/cinewright_tools/boundaries.py` (no `kokoro`, `misaki` or `espeak` import outside the plugin).

**Interfaces:** plugin `tts_kokoro`, capability `tts.synthesize`, `runtime.container: { image: "audio" }`. It returns `words: null`, so timing comes from Task 4. If the spike (Task 2 Step 3) showed misaki's token timestamps are present and match alignment within one frame, a later PR may return them; that is not in M4.

- [ ] **Step 1: Write the failing tests.**
  - **Host unit tests:** the lexicon translation gives misaki `[term](/ipa/)` for IPA and substitution for respellings. The binding's `voice` is required (`invalid_request`), with no default voice.
  - **Container test:** a line synthesizes at 24 kHz mono with the network off.
  - **End to end:** the reference project's narration runs through Kokoro and through the stub-ElevenLabs cassette, and both yield timing anchors that resolve for every line (the V0_1_PLAN M4.1 criterion).
  - **Boundary rule:** importing kokoro or misaki outside the plugin fails the check.
- [ ] **Step 2: Implement.** Use the seed and thread settings from the spike.
- [ ] **Step 3: Verify.** Run the host and container tests.
- [ ] **Step 4: Commit.**

### Task 8: Timing solver (PR M4.2)

**Files:** `core/src/timing/solve.ts`, `core/schema/pack/tokens.schema.json` and `packs/{neutral,playful}/tokens.json` (`sound.voice.*`), `packs/*/README.md`, `components/src/*/props.schema.json` (`x-readable`), `core/src/catalog/catalog.ts` (`readableWords(layer)`), `cli/src/commands/{timing,compile,render-shot}.ts`, tests.

**Interfaces:**
- Consumes: `selectedTake` (Task 5) and `Finding` (Task 3).
- Produces: `solveTiming(ir, pack, catalog): { table: TimingTable; scenes: Record<string, { start: number; end: number }>; findings: Finding[] }`, deterministic and pure.

- [ ] **Step 1: Write the failing tests.**
  - **Snapping:** shot spans snap to narration; a scene inside `flex` keeps `max(N, ⌈target·(1−flex)⌉)`.
  - **Overrun (Review Focus 5):** an overrun is a finding naming the scene, `N` and the limit. The timeline grows, later scenes shift, and the frame total equals the sum of scene lengths.
  - **Short holds:** a shot under its hold time gives `timing.short_hold`, counting only `x-readable` props.
  - **Missing takes:** a line with no selected take gives `timing.no_take`, and the solver still returns a table for the other lines (Review Focus 1).
  - **Removed words:** an anchor on a removed word gives `timing.unknown_word`, naming the layer.
  - **Packs:** neutral and playful give different gaps purely through tokens.
  - **CLI:** `compile` without `--timing` uses the solved table and matches the fixture table when the takes match it.
- [ ] **Step 2: Implement.** Frames come from samples by `floor` at starts and `ceil` at ends (D27).
- [ ] **Step 3: Verify.** Run the full suite and the specimens (the token additions leave the specimen goldens unchanged).
- [ ] **Step 4: Commit.**

### Task 9: Music and SFX interface, local library, Composer job (PR M4.3a)

**Files:** `plugins/sdk-ts/src/kinds/music.ts`, `plugins/sdk-ts/schema/kinds/music.schema.json`, `plugins/library-audio/{manifest.json,package.json,src/{index,library,score}.ts,test/…,README.md}`, `engine/src/jobs/composer.ts`, `cli/src/commands/compose.ts`, tests with a synthesized library fixture built at test time.

**Interfaces:**
- **Requests:**
  - `music.request`: `{ genre, mood: string[], brief, bpm_min, bpm_max, duration_ms, seed, output }` → `{ file, sample_rate, channels, model?, request, license }`;
  - `sfx.request`: `{ name, output }` → the same shape.
- **Library:** a folder with `library.json` (each entry: file, sha256, title, tags, bpm, duration, licence) on `CINEWRIGHT_AUDIO_LIBRARY_PATH`. Scoring counts tag overlap with genre and mood, then BPM inside the range, then the closest duration, then the id. It is deterministic.
- **Composer:** `compose(store, { sequence?, provider? }): { made; reused; findings }`.
- **Core (`core/src/audio/select.ts`):** `musicKey(ir, sequenceId, providerId)` and `selectedMusic(ir, sequenceId)`, by the take rule.

- [ ] **Step 1: Write the failing tests.**
  - The Composer's request is built from `sound.music.*` resolved through the cascade (a sequence-level override changes it), plus the sequence's mood, `music_bed` and length.
  - Every music and SFX asset records provider, tier and licence. An entry with no licence is rejected (`invalid_request`).
  - SFX are requested only when `sound.sfx.enabled`.
  - Re-running reuses the bed.
  - A sequence with no library match gives a `compose.no_match` finding and no asset.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.**
- [ ] **Step 4: Commit.**

### Task 10: Generative music plugin (PR M4.3b)

**Files:** `plugins/music-elevenlabs/{manifest.json,package.json,src/…,test/cassettes/…,README.md}`. If decision row 3 switches providers, `plugins/music-stableaudio/` replaces it.

- [ ] **Step 1: Re-verify against current docs** (endpoint, parameters, output formats, licence terms by plan tier) and record them in the README. The licence terms also go in the manifest's `output_license`.
- [ ] **Step 2: Write the failing tests.** Cassette replay turns a Composer request into the provider request and a frozen music asset whose licence comes from the manifest. Errors map as in Task 6. The live test is opt-in and capped.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit.**

### Task 11: Mixer (PR M4.4)

**Files:** `plugins/audio-ffmpeg/{manifest.json,package.json,src/{plan,mix,envelope,render}.ts,test/…,README.md}`, `container/audio/audio_job/{mix,measure}.py` (from the spike, made production), `core/src/project/layout.ts` (`MIX_CACHE_DIR`), `cli/src/commands/mix.ts`.

**Interfaces:**
- `planMix({ ir, deliverableId, pack, timing }): MixPlan`, pure. It contains:
  - clips (asset hash, bus, start sample, trim);
  - bus gains;
  - the duck envelope breakpoints;
  - targets from the profile;
  - the sample rate and length (`frames × rate / fps`).
- `renderMix({ plan, image, cacheDir, limits }): { key; dir; pcm: string; measured: { integrated, true_peak } }`. It runs `audio-job mix` in the audio image with the network off and the run limits.

- [ ] **Step 1: Write the failing tests.**
  - **Unit:**
    - The plan places each take so that its first word lands on the line's start, trimming a negative offset.
    - The envelope reaches `bus + depth` inside speech spans with the pack's ramps.
    - The mix key changes with any clip, gain, target or image digest.
  - **Container:**
    - The reference project, with synthesized narration and music, meets −14 LUFS ±1 LU and −1 dBTP.
    - Music measured during speech is lower by `depth_db` ±0.5 dB than outside it.
    - Two runs give the same PCM hash, and an unchanged plan is a cache hit with no container run.
    - A premix that can't meet the targets gives `mix.loudness_unmet` with the measured values and no cache entry; a project with no music still mixes and meets targets (Review Focus 4).
- [ ] **Step 2: Implement.** Apply Task 2's `audio-settings.json` (cpuflags, threads), and resample to the profile rate with FFmpeg's default resampler.
- [ ] **Step 3: Verify.** Run the container tests, then add the mix's two runs to `render-smoke`'s determinism comparison on both runners.
- [ ] **Step 4: Commit.**

## Done when (M4 acceptance criteria map)

| Acceptance criterion (V0_1_PLAN.md and the revised breakdown) | Proven by |
| --- | --- |
| M4.0: mixer, Kokoro and WhisperX repeatability and image size recorded; a pinned audio image with models and network off; the PCM contract in D33 | Tasks 1 and 2 |
| M4.5: a frozen take yields a transcript and word timestamps; the same result on every run, or tier A uses the frozen transcript; digits get interpolated times | Tasks 3 and 4 |
| M4.1: the same narration renders through either plugin and yields timing anchors in the IR (take word times); re-running reuses frozen takes; a re-take is explicit; plugin stderr captured (F18); vendor-SDK boundary rule (F16) | Tasks 3, 5, 6 and 7 |
| M4.2: shot durations snap to narration within `flex`; an overrun is a finding, never a stretch; reads `density.min_hold` and `hold_per_word` (F21); an anchor on a removed word is a finding | Task 8 |
| M4.3: the request comes from `sound.*` tokens and the mood; every asset records provider, tier and licence; one generative plugin with recorded-response tests | Tasks 9 and 10 |
| M4.4: meets the profile's loudness and true-peak targets; music ducks by the pack's depth; identical PCM hash on two runs | Task 11 |
