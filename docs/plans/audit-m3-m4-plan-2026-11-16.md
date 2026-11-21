# Cinewright — audit of M2.5, M3 and the M4 plan

Audit of branch `plan/m4-audio` at `5232514` (`main` at `0bbd043` plus the M4 plan). It covers the changes since `4b8d8be` (M2.5a–d, M3.0–M3.5, M5.3, the image lock) and `docs/plans/m4-audio.md`. Written 2026-11-16. Read-only audit: no source, test, schema or config file was changed.

## 1. Summary

**Integrity verdict: sound, with one real bug in M3.3 and one gap in what CI proves.** M2.5 closes F1, F2, F5 and F20, and closes F6 for the tests but not for lint. M3 is faithful to its plan and to D31, D33, D35 and the neutrality rules. On a clean export every check passes, and so do all 52 backend tests (7 of them in the container) and all 69 Python tests with the container enabled. The exception is D34: the body MP4s that `renderShot` encodes overlap their transition segments, so the files M5.1 will concatenate do not add up to the timeline. The M3.3 tests assert the wrong counts, so they pass.

**The M4 plan is a sound design and close to the simplest that works**, and its external facts check out (versions, endpoints, model licences). It has gaps that would surface late: the audio and video timelines can diverge, multi-sequence offsets are undefined, take selection ignores routing, a killed container plugin leaves its container running, and three facts about espeak-ng and model downloads are wrong. All three decisions can be approved, each with changes.

**Top findings**

| # | Grade | Finding | Where |
| --- | --- | --- | --- |
| G1 | Important | `body.mp4` holds the shot's whole own span, including the half of each transition that the segment also renders. Bodies plus segments are `d` frames too long per transition (reproduced: 162 frames for a 150-frame timeline). Fixing it opens a render-key gap. | `plugins/backend-hyperframes/src/render.ts:76-83`, `core/src/timing/span.ts:182-185` |
| G2 | Important | The seven TypeScript container tests of M3 (timeout kill, memory limit, video plate, segments, keyframes) run in no CI job. Their acceptance criteria are proven only on the maintainer's machine. | `.github/workflows/render-smoke.yml:98,158`, `checks.yml` |
| G3 | Important | A burned-in cue shorter than `min_display_frames` is extended past the next cue's start, so two caption boxes draw on top of each other. By code reading; not rendered. | `components/src/caption_track/lines.ts:32-34`, `index.ts:43-49` |
| G12 | Important | M4 plan: the solver's scene lengths and the shots' anchor-derived spans are computed separately, and nothing makes shots tile a scene. In the reference project the mix would be about 460 frames for 147 frames of video. | plan §Timing solver, Tasks 8 and 11 |
| G13 | Important | M4 plan: the selected take is "the last valid take", whatever its provider. After switching providers and back, `narrate` reports a reuse while the mix plays the other provider's take. | plan §Take identity and selection |
| G14 | Important | M4 plan: a containerized plugin is killed by killing the `docker run` client, which leaves the container running. The 5-second health timeout is also too short for a container start. | `plugins/sdk-ts/src/host.ts:9,18,83,121`; plan Task 3 |
| G15 | Important | M4 plan: misaki does not load Debian's espeak-ng. It loads the library inside the `espeakng-loader` wheel through `phonemizer-fork` (GPLv3+), and downloads a spaCy model at run time if absent. The licence notice and the model list in Task 1 are aimed at the wrong things. | plan §Decisions row 2, Task 1 |

**Top plan changes**

1. Fix G1 before M4.4 and M5.1, and put the body range in the render key (new task M3.6).
2. Run the mixer in the render image with the pinned FFmpeg, as `segment.ts` already does. The audio image then holds only TTS and STT.
3. Make the solver own scene spans and check that shots tile them; define sequence offsets on the project timeline.
4. Record the selected take explicitly, or make selection follow routing; add `direction` to the take key.
5. Name plugin containers and stop them with `docker kill`; mount plugin code into the audio image instead of baking it in.

## 2. Audit results

### 2.1 Check outputs

Run on 2026-11-16 on macOS arm64 (colima, Virtualization.Framework with Rosetta; the amd64 image runs under emulation, so its hashes are not baselines). The clean export is `git archive HEAD` of `5232514`.

| Check | Clean export | Working checkout |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 | exit 0 |
| `pnpm lint` | exit 0: 418 files, 3 warnings (unused `error` in the three `test/ignored.ts` copies) | **exit 1**: 3 format errors, all in untracked `plugins/backend-hyperframes/package 3.json`, `4.json`, `5.json` (G5) |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test` | exit 0: core 415, cli 53, components 86, packs 34, render-runner 31, plugin-sdk 10 (+5 skipped, no `.venv` yet), backend-hyperframes 45 (+7 skipped) | exit 0: same counts, plugin-sdk 15 |
| `pnpm gen:check` | exit 0 | exit 0 |
| `uv run ruff check .` | All checks passed | same |
| `pnpm exec pyright` | 0 errors | 0 errors |
| `uv run pytest -q` | 62 passed, 7 skipped | 68 passed, 9 skipped (it also collects duplicate test files) |
| Backend container tests (`CINEWRIGHT_CONTAINER_TESTS=1`, `cinewright-render:m3top`) | 52 passed, 0 skipped, 120 s | not run |
| Python container tests (same image) | 69 passed, 108 s | not run |
| Specimens: build, then `cinewright-check-specimens` | build exit 0; check exit 0: all four sets `ok` (neutral and playful × `landscape_web` and `vertical_social`). `cinewright-check-pins`: 7 pins match. `cinewright-check-boundaries`: exit 0 | not run |

Notes:
- **Image.** The container tests used the local image `cinewright-render:m3top`. Its `inputs-hash` label (`69968c0e…`) is not the tree's (`4694514d…`, which matches `container/image.lock.json`). The locked GHCR image was not pulled, so the lock itself was not re-verified.
- **Working-checkout failures are local noise.** They come only from iCloud duplicates named ` 3`, ` 4` and ` 5` (104 untracked files).

### 2.2 The previous audit's findings

| Finding | Verdict | Evidence |
| --- | --- | --- |
| F1 revert discards later edits | **Closed.** A list is restored by membership and order; a revert that would delete an entity a later revision edited conflicts; old logs replay with the old rule. | `core/src/store/apply.ts:370-380,403-405`, `store.ts:728-734`; `core/test/store/revert.test.ts:65-112` |
| F2 markers not enforced | **Closed.** The host reports markers as console warnings and `render-job check` fails on them. F7 (empty root) is closed too. | `container/render-runner/src/check.ts`; `tools/src/cinewright_tools/specimens.py` |
| F3 render key | **Closed**, with the gaps in G1 and G4. | `plugins/backend-hyperframes/src/compile.ts:463-474`; `test/key.test.ts:49-115` |
| F4 pack reference unused | **Closed.** | `core/src/pack/pin.ts`; `core/test/store/pin.test.ts` |
| F5 unescaped token values | **Closed for markup.** `<`, `>`, `{`, `}`, `;`, `\` and `"` are rejected at load and at emit. G6 is what remains. | `core/src/pack/tokens.ts:123-147,189-198`; `core/test/unsafe.test.ts` |
| F6 hermetic tests | **Partly closed.** Tests pass in the checkout and timeouts are 30 s. Lint and pytest collection are still affected (G5). | `core/vitest.config.ts`; `.gitignore` (last two lines) |
| F17 run limits | **Closed for the backend.** The Python runner has the limits but no timeout (G7). | `plugins/backend-hyperframes/src/docker.ts:50-77`; `tools/src/cinewright_tools/container.py:84,143` |
| F20 specimens trigger | **Closed.** | `.github/workflows/render-smoke.yml:28,51` |

### 2.3 M3 acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| The reference shot compiles and renders in both aspects | Proven | `compile.test.ts`; `render.container.test.ts:42` (passed here) |
| Determinism: two renders, two runners | Proven in CI for the reference shot | `.github/scripts/reference-shot.sh`; `render-smoke.yml` `smoke-compare` |
| A revised shot re-renders only itself and adjacent segments | Proven on v1 keys | `segment.test.ts:173-184`, `key.test.ts:153` |
| M3.3: frame counts add up to the timeline exactly | **Proven for the planned spans only.** The encoded bodies do not add up (G1). | `core/test/timing/segments.test.ts:60-72` versus `segment.container.test.ts:98-99` |
| M3.3: segments render twice identically; first and last frames match | Proven locally; not in CI (G2) | `segment.container.test.ts:87-124` |
| M3.4: cue across a cut split and identical; a caption edit dirties only its shots | Proven | `captions.test.ts:54,129` |
| M3.5: stills equal the render's frames; repeatable | Proven locally; not in CI (G2). Stored in the render cache, not the CAS (G8). | `keyframes.container.test.ts:14` |
| M3.2a: a hung or over-memory render is killed and named | Proven locally; not in CI (G2) | `render.container.test.ts:68,94` |
| Hostile pack values cannot add markup | Proven | `core/test/unsafe.test.ts` |

### 2.4 Binding rules

| Rule | Verdict |
| --- | --- |
| Neutrality (§2), no literals | Holds. No colour, font, easing, voice or model literal in `core/src`, `plugins/*/src` or `cli/src` (grep). Run limits are operational, not taste. |
| Invariants 5 and 12, D31 | Holds. The compiler is the only producer of HTML. The CLI calls the backend directly (known deferral). |
| Invariant 7, D33 | Holds: network off, limits, bit-exact single-threaded encodes, weights rounded before they reach FFmpeg. |
| D34 | The timing rule is implemented in `segmentsOf` and `compileSpan`. The body files break "bodies and segments concatenate" (G1). |
| D35 | Holds. Cues come from the sequence's lines, are styled from the sequence, and enter the render key through the mount spec. |
| Plugins boundary | Holds. `backend-hyperframes` imports only core, components and the SDK. |

### 2.5 Findings in the code

**G1 — Important. Body MP4s overlap their segments.**
- *Cause.* `compileSpan` returns `before = h` and `after = d − h`: the overlap frames outside the shot's own span. `renderJobCommand` encodes `--body before,frames−after`, which is the whole own span. The segment covers `[cut − h, cut + d − h)`, so the outgoing body repeats `h` frames of it and the incoming body repeats `d − h`. `compileSpan().body` holds the right range and nothing uses it.
- *Reproduction* (built `dist`, two shots `[0,60)` and `[60,150)`):

  ```
  d=12 s1.a: compileSpan.body=54 frames; render-job --body 0,60 = 60 frames
  d=12 s2.a: compileSpan.body=84 frames; render-job --body 6,96 = 90 frames
  d=12: timeline=150; planned bodies+segment=150; encoded bodies+segment=162
  ```
- *Why the tests pass.* `segment.test.ts:42-50` and `segment.container.test.ts:93-99` assert the wrong ranges (`0,72`, `6,66`; 72 and 60 frames) under the title "encodes only the body". The exact-total test (`segments.test.ts:60-72`) checks `compileSpan().body`, not what is encoded.
- *What a user hits (from M5.1).* Every dissolve or wipe plays `h` frames, then the transition from its start, then repeats `d − h` frames. The film is `d` frames longer than the mix per transition.
- *Fix (new M3.6, before M4.4 and M5.1).* Encode `[body.start − start, body.end − start)` from `compileSpan`. Add the body range to `CompileInputs`: for the incoming shot, `d = 12` and `d = 13` give the same `before` and `frames`, so the key would not change while the body must (84 versus 83 frames above). Add a test that sums the frame counts of the encoded files.

**G2 — Important. M3's container tests are not in CI.**
- *Evidence.* `CINEWRIGHT_CONTAINER_TESTS` is set only for two `pytest` steps (`render-smoke.yml:98,158`). No job runs `pnpm --filter @cinewright/backend-hyperframes test` with it. `pnpm test` in `checks.yml` skips 7 tests silently on every run.
- *Consequence.* Review Focus 5 (timeout and memory kill), the video plate, segment determinism and keyframe equality rest on local runs. The previous audit's rule was that a required job may not skip silently.
- *Fix (with M3.6).* Add a step to `smoke` that runs the backend tests with the image. They took 120 s here under emulation. M4 adds more container tests, so settle the pattern now.

**G3 — Important. Short caption cues overlap the next cue.**
- *Cause.* `cueTimes` returns `end = max(cue.end, cue.start + minFrames)`. `captionCues` clips cues to the shot and never looks at the next cue. Each cue is an absolutely positioned box in the same place.
- *When.* A line's remainder after a cut, or a short line ("Yes."), followed within 30 frames by another cue. With a 300 ms line gap that is the normal case.
- *Unverified* by a render. It also means burn-in and sidecar timing (M5.2: "timing matches the burn-in") need one shared rule.
- *Fix (M5.2 at the latest).* Apply the minimum in `captionCues`, clamped to the next cue's start and the shot's end, so the mount spec carries final times. Add a unit test with two cues 10 frames apart.

**Minor findings**

| # | Finding | Where | Fix |
| --- | --- | --- | --- |
| G4 | The composition's HTML template is not in the render key. It lives in `components`, and only the hand-kept `COMPILER_VERSION` (`0.1.0`) covers it. A change to the CSS reset or the root attributes would serve stale renders. | `components/src/node/composition.ts:80-102`, `plugins/backend-hyperframes/src/version.ts:2` | Build the HTML string in `planShot` and hash it into `CompileInputs` (M3.6). |
| G5 | `.gitignore` covers `* 2` and `* 2.*` only. iCloud now makes ` 3` to ` 5`. `pnpm lint` fails in the checkout, and pytest collects duplicates. Decision 2 of the last audit (move the checkout) was not acted on. | `.gitignore`; §2.1 | Move the checkout out of iCloud. Until then ignore `* [0-9]` and `* [0-9].*`. |
| G6 | `cssValue` accepts `/*`, an unbalanced `(` and a newline (verified: `"red /* x"`, `"calc(1px"`, `"a\nb"` pass). A pack value can swallow the rest of the style block. It cannot add markup. | `core/src/pack/tokens.ts:123,143-147` | Reject `/*`, control characters and unbalanced brackets. With the next pack-loader change. |
| G7 | The Python container runner has no wall-clock timeout. A hung browser hangs `cinewright-check-specimens` until the CI job limit. | `tools/src/cinewright_tools/container.py:84,143` | Pass `timeout=` and kill by name. M4 Task 1 touches this file. |
| G8 | Keyframes are written into the render cache entry. The roadmap's M3.5 criterion says "stored in the CAS", and the storyboard gate (D38) will show them. | `plugins/backend-hyperframes/src/keyframes.ts:84-86` | Decide at M7.6: the gate packet copies stills into the CAS, or the criterion is reworded. |
| G9 | A cache hit checks only that `inputs.json` exists. Two processes rendering one key both render, and the second removes the folder the first may be reading. | `render.ts:128,176-177`; `segment.ts:145,222-223` | On a lost race keep the existing folder (rename, and on failure discard the new one). M5.4, when renders run in parallel. |
| G10 | `resolveRenderer` reads the HyperFrames version and render settings from the repository's `container/render-runner/` by a relative path, not from the image. An installed CLI has no such folder. | `render.ts:48,62-69` | Read them from the image (`render-job versions`). M8.5. |
| G11 | A string prop equal to a registered asset id is treated as that asset. A title that happens to equal an asset id is copied as a file, or fails with `compile.missing_asset`. M4 adds many asset ids. | `compile.ts:165-170,365-376` | Read asset references from the props schema (an `x-asset` mark), as M4 Task 8 does for `x-readable`. |

Known deferrals from the M3 review (CLI through the plugin interface, OOM for segments and keyframes, `docker kill` fallback, keyframe re-capture, stale `--out`) were seen and are not repeated.

## 3. The M4 plan

### 3.1 External facts, checked 2026-11-16

| Item | Plan says | Found | Matters because |
| --- | --- | --- | --- |
| `kokoro` | 0.9.4, Python < 3.13 | 0.9.4 (2025-04), `>=3.10,<3.13`, Apache-2.0. Requires `misaki[en]>=0.9.4`, `torch`, `transformers`, `huggingface-hub` | Confirmed. No release in 19 months. |
| `misaki[en]` | falls back to espeak-ng, loaded in process | 0.9.4. The `en` extra needs `espeakng-loader`, `phonemizer-fork`, `num2words`, `spacy`, `spacy-curated-transformers`. `misaki/espeak.py` calls `EspeakWrapper.set_library(espeakng_loader.get_library_path())` | The library comes from the wheel, not from apt (G15). |
| `phonemizer-fork` | not mentioned | 3.3.2, **GPLv3+**, imported in process by misaki | A second GPL component, and a Python import rather than a C library. |
| `espeakng-loader` | not mentioned | 0.2.4, wheels of 9–10 MB, **no licence metadata** | The notice and source pointer must cover this binary. |
| spaCy model | not mentioned | `misaki/en.py`: `if not spacy.util.is_package(name): spacy.cli.download(name)` (read on `main`; not checked at the 0.9.4 tag) | Fails with the network off unless `en_core_web_sm` is baked in. |
| Kokoro without espeak | "the fallback keeps quality" | `kokoro/pipeline.py` catches the failure, warns "OOD words will be skipped" and passes `unk=''` | There is no usable non-GPL mode: unknown words would be dropped from the audio. |
| Kokoro timestamps | "whether misaki's token timestamps are present" (spike) | `pipeline.py` has `join_timestamps` from `pred_dur`, for English only (read on `main`) | Native word times probably exist, including for digits. |
| `whisperx` | 3.8.6, `torch~=2.8.0` | 3.8.6 (2026-05), BSD-2-Clause, `<3.14`. Also requires `torchaudio~=2.8.0`, `torchvision~=0.23.0`, `pyannote-audio>=4.0.0`, `torchcodec`, `triton` (linux x86_64), `huggingface-hub<1.0.0` | Confirmed. The dependency set is large; the image size is unmeasured. |
| `torch` | 2.8.x CPU | Latest is 2.15.0; 2.8 is pinned by WhisperX | The image stays six minor versions behind until WhisperX moves. |
| Kokoro-82M weights | licence recorded | Apache-2.0; the card says the training data is permissive | Confirmed. |
| `Systran/faster-whisper-small` | licence recorded | MIT, converted from `openai/whisper-small` | Confirmed. |
| `WAV2VEC2_ASR_BASE_960H` | licence recorded | "released under MIT License and redistributed with the same license" | Confirmed. |
| espeak-ng | GPL-3.0 | "GPL version 3 or later" | Confirmed. |
| ElevenLabs TTS | `POST /v1/text-to-speech/{voice_id}/with-timestamps`, `alignment` fields, `seed` | Confirmed, including `normalized_alignment` and "determinism is not guaranteed". `pcm_48000` is listed; `pcm_44100` needs Pro, and no tier is stated for 48 kHz | The default `pcm_<profile rate>` may be refused on lower tiers. |
| ElevenLabs IPA | bare slashes on `eleven_v4`, `<phoneme>` elsewhere | The docs disagree with each other on the model list (search summary; unverified) | Task 6 Step 1 already re-verifies. |
| ElevenLabs Music | REST, same key, commercial use on paid plans | `POST /v1/music`. `seed` "cannot be used with `prompt`"; `force_instrumental` and `music_length_ms` (3,000–600,000) are valid only with `prompt`. Terms (updated 2026-10-09): Free to Business permit commercial use "except film, TV, radio, and Studio Games"; Starter to Pro are "individual use only"; Free requires attribution | "Commercial use: true" is too coarse (G20). |

### 3.2 Findings in the plan

**G12 — Important. Audio and video timelines can diverge.**
- *Cause.* The solver gives each scene a length (`max(N, ⌈target·(1−flex)⌉)`, head and tail pads). Shot spans still come from anchors on lines (`core/src/timing/span.ts:31-64`), which have no scene-relative form (`common.schema.json` `anchor`). The mix length is the sum of scene lengths; the video is the sum of shot spans.
- *Evidence.* In the reference project the first line starts at frame 15 and the first shot is anchored to it, so frames 0–14 have no shot. Scene `s03_the_problem` has `target: 540`, `flex: 0.15`, so it solves to at least 459 frames, and its shots cover 147.
- *Fix (Task 8).* The solver returns shot spans too. A scene's first shot starts at the scene's start and its last ends at the scene's end; a gap or overlap between shots is `timing.uncovered`. `shotSpan` reads the solved spans. Say whether the solver writes `shot.duration` (the M3 plan and `V0_1_PLAN.md:347` assume it does).

**G13 — Important. Take selection ignores routing, and the key is incomplete.**
- *Selection.* With takes from provider A, then B, then routing back to A: `narrate` finds A's take valid and reuses it, but `selectedTake` returns the last valid take, which is B's.
- *Key.* `takeKey` omits `line.direction`, the voice language and `performance.pace_wpm`, and `tts.synthesize` does not carry them. An edit to the delivery direction leaves the take "fresh".
- *Sample rate.* "The profile sample rate" is undefined when deliverables differ. D27 fixes one frame rate per project, not one sample rate.
- *Fix (Tasks 3 and 5).* Simplest: `narrate` records the selection as a field on the line (`take`, written as the job, user-settable, lockable at the gate, as the spec's step 4 expects), and a selected take whose key no longer matches is `timing.no_take`. Add `direction` and language to the key and the request. Add a semantic check that all deliverables share one sample rate, and store word times in the take's own samples next to `audio.sample_rate`.

**G14 — Important. Container plugins outlive their host.**
- *Cause.* `SubprocessPlugin` stops a child with `child.kill("SIGKILL")` (`host.ts:18,83,121`). For `docker run -i` that kills the client; the container keeps running. Task 3's `containerCommand` has no container name.
- *Also.* `HEALTH_TIMEOUT_MS = 5000` (`host.ts:9`) covers `docker run`, emulation and Python start. Read-only roots need `HOME`, `HF_HOME`, `HF_HUB_OFFLINE=1` and cache folders set.
- *Fix (Task 3).* Run with `--name` and `--init`, and stop with `docker kill` on timeout, shutdown and host exit, with a test that no container remains. Give container runtimes their own start timeout. Move `docker.ts` and `limits.ts` from `backend-hyperframes` into the SDK and use them from both, instead of a third copy of the limits.

**G15 — Important. The espeak-ng and model facts are wrong.** See §3.1. Task 1 installs apt `espeak-ng` that misaki will not load, ships a notice for it, and omits `phonemizer-fork`, the `espeakng-loader` binary and the spaCy model. Fix in Task 1: either point `EspeakWrapper` at Debian's `libespeak-ng1` from the pinned snapshot (clean source provenance) or pin and notice the wheel's binary; list `phonemizer-fork` in the notices; bake `en_core_web_sm` by wheel hash; report the loaded library path in `audio-job versions`.

**G16 — Important. The mixer does not belong in the audio image.**
- *Cause.* `renderMix` runs in the torch image only because it has "the same FFmpeg build". The mix key then includes that image's digest, so a model or plugin change invalidates every mix and PCM baseline. A project that uses ElevenLabs and library music must pull a multi-gigabyte image to run FFmpeg.
- *Fix (Tasks 2 and 11).* Run the mix in the render image with `entrypoint: ffmpeg`, as `segment.ts:155-203` does. Measurement parses `ebur128` output on the host. `audio_job/mix.py` and `measure.py` go away, and D33's PCM contract rests on the image that already carries the determinism baseline.

**G17 — Important. Baking plugin code into the audio image.** Task 4 installs the plugin into the image, so every plugin change is an image rebuild, a publish and a lock PR, and CI builds a torch image on each such PR. Fix (Tasks 1, 4, 7): the image holds Python, dependencies and models only; the host mounts the plugin folder read-only. The plugin version in the manifest already identifies the code in provenance.

**G18 — Important. The spike misses the resampler and the PCM definition is loose.**
- Kokoro is 24 kHz and the profiles are 48 kHz, so every local take is resampled in the mix. Task 2 Step 1 mixes only synthetic sources at one rate.
- "The sha256 of the WAV's `data` chunk" depends on a chunk parser. FFmpeg can write the same samples as raw `-f s24le`.
- *Fix (Task 2).* Add a 24 kHz source to the spike mix. Define the PCM hash as the sha256 of the raw interleaved s24le stream, and state the float-to-integer conversion (no dither).

**Minor findings in the plan**

| # | Finding | Fix |
| --- | --- | --- |
| G19 | **Multi-sequence.** The timing table is per sequence (`timing.schema.json`), music is per sequence, and the mix is per deliverable. No rule places sequences on one timeline. | Task 8 returns `sequences: { id: { start, frames } }`; Task 11 offsets clips by it; a two-sequence test. |
| G20 | **Licences.** Task 5 returns `license` in the response; Task 10 takes it from the manifest. ElevenLabs terms depend on the plan tier and exclude film, TV and radio. Nothing says how a plugin learns the tier. The licence schema has `terms`, `commercial_use` and `attribution` only. | The response's `license` wins; the manifest is the default. The plugin reads the tier once at init (re-verify the endpoint). Put the exclusions in `terms`. |
| G21 | **Interfaces.** `PluginError.details.stderr`: the field is `data` (`errors.ts:19`). Task 4 writes `engine/src/jobs/transcribe.ts` and uses the registry, but Task 5 creates `engine`. Word-time units in `tts.synthesize` are unstated. `music.request` has no instrumental flag, and its `seed` cannot be sent with a prompt. | Use `data.stderr`. Create `engine` and the registry in Task 3, or order Task 5 before Task 4. State samples at the returned `sample_rate`. Add `vocals: false` as the default for a bed under narration. |
| G22 | **Python 3.12 and 3.13.** `sdk-py` drops to `>=3.12` while ruff targets `py313` and pyright 3.13. The plan does not say whether the two plugins are workspace members, where their host tests run, or how pyright treats lazy `torch`, `kokoro` and `whisperx` imports. | Task 3: a ruff per-file target and an `sdk-py` test run on 3.12. Tasks 4 and 7: members with heavy dependencies only in the image's project; `testpaths` and pyright `include` updated. |
| G23 | **Secrets in stderr.** F18 returns the stderr tail in errors and logs. A traceback can carry a key. | The host replaces declared secret values in the tail before returning it; test with the planted secret. |
| G24 | **Takes are never removed.** Each edit or re-take appends an asset to the IR and a file to the CAS. | Note it; schedule `cinewright assets prune` (unselected, stale takes) with v0.2's takes work. |
| G25 | **Apple Silicon.** The audio image is amd64, so torch runs under emulation on the maintainer's machine. Take and transcript outputs are frozen, so they need not match across architectures. | Task 2 records the local real-time factor. If it is above about 2, also build `linux/arm64` for the audio image; G16 keeps the mixer on amd64. |
| G26 | **Kokoro timestamps.** The plan defers native timestamps to "a later PR" whatever the spike finds. They would time digits directly. | If Task 2 Step 3 finds them within one frame of alignment, Task 7 returns them in M4 and alignment stays the fallback. |
| G27 | **Order.** Task 8 waits for Task 7 but needs only Tasks 3 and 5. Task 10 is on the path to the alpha gate, which uses no paid API. | Task 8 after Task 5. Task 10 after the alpha gate (D38 needs it for v0.1, not for the gate). |
| G28 | **Default output format.** `pcm_<profile rate>` may need a higher tier. | Default to a rate every tier accepts, found in Task 6 Step 1; the mixer resamples anyway. |
| G29 | **CI cost.** No task says which job runs the new container tests, or what building the torch image costs. | Task 1 records build time and size and adds the job; with G17 the image changes rarely. |

### 3.3 The three decisions

| Decision | Verdict | Reasoning |
| --- | --- | --- |
| **1. A second image for audio** | **Approve, with changes.** | Torch, WhisperX and the models do not belong in the render image, and Kokoro needs Python below 3.13. Change three things: the mixer runs in the render image (G16); plugin code is mounted, not baked (G17); an arm64 build is allowed for TTS and STT, whose outputs are frozen (G25). The image size and build time are unmeasured; Task 1 must record them. |
| **2. `plugins/tts-kokoro` under GPL-3.0-or-later** | **Approve, with the facts corrected.** | The GPL code in the plugin's process is `phonemizer-fork` (GPLv3+, a Python import) and the espeak-ng library inside `espeakng-loader`, not Debian's package (G15). Kokoro without the fallback drops unknown words, so there is no clean way around it. GPL-3.0-or-later for the plugin is the cautious choice, costs little and matches D2. Apache-2.0 source is compatible with GPLv3, and `kokoro` and `misaki` themselves stay Apache-2.0 while importing the same code, so Apache-2.0 for the plugin with GPL terms on the image is also defensible. This is not legal advice; either way the audio image distributes GPL binaries and must carry their licences and source pointers. |
| **3. ElevenLabs Music** | **Approve, with conditions.** | It exists as described and shares the TTS key. Conditions: record the tier and the film, TV and radio exclusion in each asset's licence (G20); request instrumental beds; do not rely on `seed`; move Task 10 after the alpha gate (G27). One vendor for both paid audio kinds weakens the test of invariant 6, so keep the Stable Audio fallback named in the plan. |

### 3.4 Proposed changes to `docs/plans/m4-audio.md`

| Where | Change |
| --- | --- |
| New, before Task 1 | **M3.6** (one PR): fix the body range (G1), add it and the HTML hash to the render key (G4), add the encoded-frame-count test, run the backend container tests in CI (G2). |
| Decisions, row 1 | The audio image holds Python, torch, Kokoro, WhisperX, FFmpeg for decoding, and models. The mixer runs in the render image. Plugin code is mounted. |
| Decisions, row 2 | Name `phonemizer-fork` and `espeakng-loader`; say which espeak-ng library is loaded and where its source is. |
| Decisions, "Take identity" | Selection is a field on the line, or follows routing. The key adds `direction` and language. One sample rate per project is checked. |
| Decisions, "PCM contract" | sha256 of raw s24le from FFmpeg; no dither; the mix runs in the render image. |
| Decisions, "Timing solver" | Add: scene and shot spans, the tiling rule, `timing.uncovered`, sequence offsets, and whether durations are written to the IR. |
| Task 1 | Drop `audio_job/{mix,measure}.py`. Bake `en_core_web_sm`. Set offline and cache variables. `audio-job versions` reports the espeak library path and `phonemizer` version. Record image size and build time. Add a timeout to the Python runner (G7). |
| Task 2 | Run the mix spike in the render image. Add a 24 kHz source. Record the local real-time factor under emulation. The Kokoro timestamp result decides Task 7. |
| Task 3 | `--name`, `--init`, `docker kill`, a start timeout, no orphan container test. Share `docker.ts` and `limits.ts`. `data.stderr`, with secret values replaced. Create `engine` and the registry here. Ruff and test coverage for Python 3.12. |
| Task 4 | Depends on the registry from Task 3. Plugin mounted, a workspace member, host tests in `testpaths`. |
| Task 5 | Request and key carry `direction` and language. Units of `words` stated. Selection per G13, with a test that switches provider and back. `license` in the response is authoritative. |
| Task 6 | Default output format valid on every tier. Read the plan tier for the licence. |
| Task 7 | Return native timestamps if the spike supports it. Licence notices per G15. |
| Task 8 | After Task 5, not Task 7. Spans, tiling and sequences per G12 and G19. A test on the reference project that the video frame total equals the mix length. |
| Task 9 | `music.request` gains `vocals` (default false); `seed` is optional. |
| Task 10 | After the alpha gate. Licence text carries the exclusions. |
| Task 11 | `renderMix` uses the render image and FFmpeg directly. Clips are offset by sequence. The mix key uses the render image digest. |
| Done-when map | Add: "the mix length equals the video frame total for every deliverable" (Tasks 8 and 11). |

## 4. Decisions for the maintainer

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Fix G1 to G4 as M3.6 before M4 code? | Yes. G1 changes what M4.4 and M5.1 build on. |
| 2 | Audio image (plan decision 1) | Approve with the mixer in the render image and plugin code mounted. |
| 3 | Kokoro licence (plan decision 2) | Approve GPL-3.0-or-later; correct the notices to cover `phonemizer-fork` and the loaded espeak-ng binary. |
| 4 | ElevenLabs Music (plan decision 3) | Approve; record the exclusions; build it after the alpha gate. |
| 5 | How a take is selected | An explicit field on the line. It is the smallest change that makes selection independent of asset order and routing. |
| 6 | Who owns shot spans once the solver exists | The solver, with a tiling check. |
| 7 | Move the checkout out of iCloud | Still open from the last audit, and now breaks `pnpm lint` locally. |

## Sources

PyPI JSON for [kokoro](https://pypi.org/pypi/kokoro/json), [misaki](https://pypi.org/pypi/misaki/json), [whisperx](https://pypi.org/pypi/whisperx/json), [torch](https://pypi.org/pypi/torch/json), [phonemizer-fork](https://pypi.org/pypi/phonemizer-fork/json), [espeakng-loader](https://pypi.org/pypi/espeakng-loader/json) · [misaki `espeak.py`](https://raw.githubusercontent.com/hexgrad/misaki/main/misaki/espeak.py) and [`en.py`](https://raw.githubusercontent.com/hexgrad/misaki/main/misaki/en.py) · [kokoro `pipeline.py`](https://raw.githubusercontent.com/hexgrad/kokoro/main/kokoro/pipeline.py) · [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) · [faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) · [WAV2VEC2_ASR_BASE_960H](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.html) · [eSpeak NG README](https://raw.githubusercontent.com/espeak-ng/espeak-ng/master/README.md) · [ElevenLabs convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps) · [ElevenLabs compose music](https://elevenlabs.io/docs/api-reference/music/compose) · [Eleven Music model-specific terms](https://elevenlabs.io/eleven-music-model-specific-terms)
