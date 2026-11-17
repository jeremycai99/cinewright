# Render container

One pinned Linux image renders every composition (M0.2, D33). The engine and CLI run on the host and only start the image. Its single process is `render-job`, and it always runs with the network disabled (`--network none`). HyperFrames runs in its local mode inside the image. Never use HyperFrames' own `--docker` flag: it builds a separate, unpinned image.

## Pins

Every version lives in a tracked file. The Dockerfile has none typed in; `cinewright-build-image` passes them as build args.

| What | Pinned in | Value |
| --- | --- | --- |
| Base image (Node) | `pins.json` `base_image`, `.node-version` | `node:24.22.3-trixie-slim@sha256:af02d57b…` |
| Platform | `pins.json` `platform` | `linux/amd64` |
| Debian packages | `pins.json` `debian_snapshot` and `apt` | snapshot `20261113T143145Z`: `ffmpeg`, `libx264-164`, `python3.13`, `fonts-noto-core` at exact versions |
| chrome-headless-shell | `pins.json` `chrome_headless_shell` | `152.0.7977.30` |
| HyperFrames | `render-runner/package.json`, `pnpm-lock.yaml` | `hyperframes` and `@hyperframes/producer` 0.9.58 |
| pnpm | `package.json` `packageManager` | 12.18.0 |

**Debian packages** come from [snapshot.debian.org](https://snapshot.debian.org) at one timestamp, for both `trixie` and `trixie-security`. apt checks every package against the snapshot's signed indexes, using the base image's archive keyring. The packages Chrome needs come from the same snapshot, so the timestamp fixes their versions too. To move to newer packages, choose a new timestamp whose indexes carry the new exact versions, and update `debian_snapshot` and `apt` together.

**chrome-headless-shell** is the build HyperFrames 0.9.58 manages itself: `CHROME_VERSION` in `@hyperframes/engine`, the build `hyperframes browser ensure` installs. HyperFrames tunes and tests its deterministic BeginFrame capture against that build; Puppeteer's default build (157.x for puppeteer-core 25.17) is not used. The `@puppeteer/browsers` version in the lockfile installs it to `/opt/chrome-headless-shell`, and `HYPERFRAMES_BROWSER_PATH` points HyperFrames at it. Chrome for Testing publishes no checksums, so the download relies on HTTPS, and `cinewright-check-pins` confirms the installed build. When HyperFrames is upgraded, read its new `CHROME_VERSION` and update the pin.

**No animation library** is in the image. Core components and the smoke fixtures animate with WAAPI, which HyperFrames seeks natively (Open issue 6). GSAP was removed in M3.0; it returns only with user-authored compositions, which declare its licence.

**Install scripts** of dependencies are denied in `pnpm-workspace.yaml` (`allowBuilds`). Puppeteer's would download a browser.

## Commands

```bash
uv run cinewright-build-image --tag cinewright-render:dev     # add --push to publish
uv run cinewright-check-pins --image cinewright-render:dev
```

`cinewright-check-pins` runs `render-job --versions` inside the image, with the network off, and compares each reported version with the tracked file it should come from. A mismatch names the key, both values and the file, for example `node: expected 24.22.3 (from .node-version), image reports 24.22.2`.

The image carries the label `org.cinewright.inputs-hash`: a SHA-256 over every file in its build context (`cinewright_tools.container.inputs_hash`). CI uses it to tie a published digest to the inputs it was built from. `container/image.lock.json` records the published digest and its inputs hash. `cinewright-check-image-lock` fails when the locked image's label disagrees with the lock. A tree whose inputs moved on since the locked image is only a warning, because a PR cannot publish: `render-image` publishes after merge, and a follow-up PR updates the lock. Until then the smoke jobs build the image from the tree. Any change to `pnpm-lock.yaml` counts as a new input.

## Rendering

```bash
uv run cinewright-render-in-container --image cinewright-render:dev --in container/fixtures/hello-world --out out/hello
```

The host runs `docker run --rm --network none --platform linux/amd64` as the host user, with the composition mounted read-only at `/job/in` and the output folder at `/job/out`. Every argument is a list element, never passed through a shell, and the bind mounts are CSV-quoted, so paths with spaces, commas or non-ASCII characters work.

**Run limits (audit F17).** User assets enter the container, so every run (render, check, asset generation) adds `--memory 4096m --memory-swap 4096m --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,size=2048m`: no capabilities, no writes outside `/tmp` and `/job/out`, bounded memory and processes. `renderShot` (`plugins/backend-hyperframes`) also kills a run after 120 s plus 1 s per frame. The Python tools (`container.py` `RUN_LIMITS`) and the plugin (`src/limits.ts`) use the same values.

Inside the image, `render-job`:

1. Copies `/job/in` to a fixed work folder, adding nothing to it.
2. Calls `@hyperframes/producer`'s `createRenderJob` and `executeRenderJob`, passing every setting explicitly.
3. Writes `output.mp4` (or `frames/000001.png`…), `framemd5.txt` (`ffmpeg -f framemd5` of the decoded frames), `sha256.txt` and `render-log.jsonl`.

Exit codes: 0 ok, 2 usage or input error, 3 blocked network request, 4 render failure.

`--format mp4+frames` writes `output.mp4` and keeps its PNG frames in `frames/` (shot renders keep them for transition segments, M3.3). `--fps 24|25|30|60` sets the frame rate to the composition's own; without it the settings' `fps` applies.

With `--format png-sequence` (or `mp4+frames`), `render-job` moves HyperFrames' frames from its work folder to `/job/out/frames/`. The two are on different devices (the output is a bind mount), so a rename that fails with `EXDEV` falls back to copy and delete.

## Checking

```bash
uv run cinewright-check-in-container --image cinewright-render:dev --in <composition dir> --out <dir> --at 0.5,1.5
```

`render-job check --in /job/in --out /job/out --at <seconds,…>` runs HyperFrames 0.9.58's own `check` on a copy of the composition, with the network off:

```
hyperframes check <dir> --json --strict --no-craft --no-cache --no-browser-gpu --safe-zone off --at <seconds,…>
```

It audits each time for:
- runtime console errors and failed requests;
- layout overflow, clipping and overlaps;
- WCAG AA contrast.

Craft warnings (dead stretches, unread lines) are skipped, because they depend on the film, not the composition. Platform safe zones are off (`--safe-zone off`): HyperFrames' default applies the TikTok, Reels and Shorts zones (`@hyperframes/core` `safeAreas.js`) to every 9:16 frame, but safe areas belong to the delivery profile (D27), whose title-safe insets place every layout region; a social delivery profile (M5.3) encodes those platform zones in its insets. It writes three files to `/job/out`:
- `check.json`: the full report;
- `failures.json`: every error or warning in the lint, runtime, layout, contrast, motion and audio sections, or a not-ok report;
- `check-log.txt`.

HyperFrames demotes a contrast failure seen at one sample to a warning and still reports `ok`, so warnings count as failures here. Two lint rules are ignored: `timeline_track_too_dense` (more than 3 timed elements in a file) and `composition_file_too_large` (more than 300 lines), added after 0.9.41. They ask authors to split hand-written files; compositions here are compiled and never hand-edited. The component host reports its markers as console warnings (`cinewright.overflow …`, `cinewright.density …`); `failures.json` gives those findings their marker as the code.

Exit codes: 0 nothing fails, 2 usage or input error, 4 no report, 5 failures.

`uv run cinewright-check-specimens --image <image> <root>` checks every component specimen under `<root>`, written by `pnpm --filter @cinewright/components specimens -- --out <root>`; see `components/README.md`.

### Settings

`render-runner/render-settings.json` holds every render setting. `loadSettings` rejects unknown, missing or inconsistent keys. The encoder values are test settings until delivery profiles own them (M5.3). How each key reaches HyperFrames 0.9.58:

| Key | HyperFrames option | Notes |
| --- | --- | --- |
| `fps` | `RenderConfig.fps`, engine `fps` | The engine accepts 24, 25, 30 or 60. |
| `workers` | `RenderConfig.workers`, engine `concurrency` | |
| `browser_gpu: false` | `useGpu: false`, engine `browserGpuMode: "software"` (SwiftShader) | HyperFrames forces screenshot capture whenever the GPU mode is software. BeginFrame stalls under CPU raster, so frames are captured by seeking the timeline. |
| `strict` / `best_effort` | `strictness: "strict"` or `"best-effort"` | The two must be opposites. |
| `frame_format` | engine `format` (`"png"` or `"jpeg"`) | The capture format of each frame. |
| `encode: "hyperframes"` | HyperFrames encodes the MP4 | `preset` and `crf` must match a HyperFrames quality level: `standard` is `medium`/18, `draft` is `ultrafast`/28, `high` is `fast`/15. `keyint` becomes `keyframeIntervalSeconds` (`keyint / fps`). GOPs are always closed and output is `yuv420p` (`chromaSubsampling: "420"`). HyperFrames sets x264 `-threads` from the container's CPU quota, not from `threads`. |
| `encode: "ffmpeg"` | HyperFrames writes a PNG sequence; `render-job` encodes it | Every `encoder` key is passed to `ffmpeg` (`-preset`, `-crf`, `-pix_fmt`, `-g`/`-keyint_min`, `-sc_threshold 0`, `open-gop`, `-threads`), with bitexact flags and no metadata. |
| `low_memory_mode` | engine `lowMemoryMode` | |
| (fixed) | `hdrMode: "force-sdr"`, `chromePath` from `HYPERFRAMES_BROWSER_PATH` | |

## HyperFrames facts (re-read for 0.9.58, M3.0)

Every behaviour Cinewright relies on, checked in the published 0.9.58 packages (paths under each package's `dist/`; line numbers are for 0.9.58 and move between releases). Re-read these on every bump (audit decision 3: bump only at a milestone start or for a security fix).

| Fact | Where |
| --- | --- |
| The browser build is `CHROME_VERSION = "152.0.7977.30"`, unchanged from 0.9.41 | `@hyperframes/engine` `services/chromeHostCeiling.js:25` |
| WAAPI animations are discovered and seeked by the runtime's `waapi` adapter | `@hyperframes/core` `hyperframe.runtime.iife.js` (adapter `name:"waapi"`) |
| The runtime waits for every `window.__hf.buildReady[key]` before the first capture; a rejection fails the render | `@hyperframes/core` `runtime/diagnostics.js:54-66` |
| A host with `data-no-timeline` is skipped when the engine looks for a timeline | `@hyperframes/engine` `services/frameCapture.js:1355`, `:1380`, `:1495` |
| Frame rates are `DISTRIBUTED_FPS = [24, 25, 30, 60]` | `@hyperframes/core` `distributedFps.js:2`, used by `@hyperframes/engine` `config.js:105` |
| Quality levels: `draft` `ultrafast`/28, `standard` `medium`/18, `high` `fast`/15 | `@hyperframes/engine` `services/chunkEncoder.js:23-27` |
| `png-sequence` output writes frames, not an MP4 | `@hyperframes/producer` `index.js:14425`, `:14981` |
| `check` flags `--json`, `--strict`, `--no-craft`, `--no-cache`, `--no-browser-gpu`, `--safe-zone` (default: all social zones on 9:16), `--at` | `hyperframes` `chunk-ROESFEBP.js:2734-2842`, `:3113` |
| `check` JSON: `ok`, `strict`, and sections `lint`, `runtime`, `layout`, `motion`, `contrast`, `craft`, `audio`, each with `findings`; `ok` is false in strict mode when any non-craft warning remains. both already existed in 0.9.41. Since M3.0 `motion` (active only with a motion spec) and `audio` count as failures too | `hyperframes` `chunk-ROESFEBP.js:2193-2240` |
| `snapshot` command | `hyperframes` `snapshot-EVSKTVDG.js:1878` |

## Determinism

D33 requires identical decoded frames and bytes for the same resolved IR, assets, plugin versions and image digest, on any machine of the same runner class. A runner class is CPU architecture, image digest and render settings. CPU core count is not part of it, so the output must not depend on how many cores a machine has.

### Encoding spike (Task 9, 2026-11-13)

`hello-world` was rendered 3 times with each `encode` value, then with Docker CPU quotas of 1 and 2. Hashes are truncated to 16 hex characters.

| Run | CI: ubuntu-24.04, x86_64, 2 CPUs | Local: Apple M2 Max, amd64 under Rosetta, 6 CPUs |
| --- | --- | --- |
| `hyperframes` ×3 | framemd5 `0b7b97da3c316091`, bytes `2f17dbcc6d976d49` (all 3 equal) | framemd5 `3aac7b592034e124`, bytes `e79fdc291c39127c` (all 3 equal) |
| `hyperframes`, `--cpus 1` | framemd5 `0b7b97da3c316091`, bytes `cb0cdcc570a9ec4c` | framemd5 `0b7b97da3c316091`, bytes `cb0cdcc570a9ec4c` |
| `hyperframes`, `--cpus 2` | framemd5 `0b7b97da3c316091`, bytes `2f17dbcc6d976d49` | framemd5 `0b7b97da3c316091`, bytes `2f17dbcc6d976d49` |
| `ffmpeg` ×3 | framemd5 `8f6428628e3a8814`, bytes `ba472550545df782` (all 3 equal) | framemd5 `8f6428628e3a8814`, bytes `ba472550545df782` (all 3 equal) |
| `ffmpeg`, `--cpus 1` | framemd5 `8f6428628e3a8814`, bytes `ba472550545df782` | framemd5 `8f6428628e3a8814`, bytes `ba472550545df782` |

What the spike shows:

- **HyperFrames' own encode is repeatable on one machine, but its output depends on the CPU count.** HyperFrames sets x264 `-threads` from the container's CPU quota. The bytes differ at 1, 2 and 6 CPUs, and the decoded frames differ between 2 and 6. Two amd64 machines with different core counts would disagree, which breaks D33.
- **The FFmpeg encode does not depend on the CPU count.** HyperFrames writes a PNG sequence and `render-job` encodes it with `-threads 1`, `-filter_threads 1` and bitexact flags. Its bytes are identical at every CPU quota, and identical between the CI runner and an Apple Silicon host running the image under Rosetta. So the captured frames themselves are reproducible across machines.
- **GOPs are closed and the keyframe interval matches `keyint`.** Both encodes place keyframes at frames 0 and 30 (`keyint` 30 at 30 fps). The FFmpeg encode uses B-frames (`has_b_frames` 2) with `open-gop=0`. `trace_headers` shows exactly 2 IDR slices (NAL type 5), at frames 0 and 30, and 58 non-IDR slices, so segments can be concatenated without re-encoding (M5.1).

**Decision:** `render-settings.json` sets `encode: "ffmpeg"`. `encode: "hyperframes"` stays available for experiments, but baselines never use it.

### Re-run on HyperFrames 0.9.58 (M3.0, 2026-11-16)

`hello-world`, now animated with WAAPI, was rendered 3 times with `encode: "ffmpeg"` and once with `--cpus 1`, locally (Apple M2 Max, amd64 under Rosetta). The sha256 of `framemd5.txt` was `7d22ebb050631c97` and the output's sha256 `2cde779a9020252d` (both truncated) in all four runs. The fixture changed from GSAP to WAAPI, so these values differ from the table above. The two-render determinism tests (`tools/tests/test_container.py`) passed, and CI repeats them on its runner.

## Runner classes

A runner class is CPU architecture + image digest + render settings. Baselines are rendered on `linux/amd64` in CI. On Apple Silicon the amd64 image runs under emulation; those renders prove behaviour, never baselines.
