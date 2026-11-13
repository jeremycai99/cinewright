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
| HyperFrames, GSAP | `render-runner/package.json`, `pnpm-lock.yaml` | `hyperframes` and `@hyperframes/producer` 0.9.41, `gsap` 3.15.1 |
| pnpm | `package.json` `packageManager` | 12.18.0 |

**Debian packages** come from [snapshot.debian.org](https://snapshot.debian.org) at one timestamp, for both `trixie` and `trixie-security`. apt checks every package against the snapshot's signed indexes, using the base image's archive keyring. The packages Chrome needs come from the same snapshot, so the timestamp fixes their versions too. To move to newer packages, choose a new timestamp whose indexes carry the new exact versions, and update `debian_snapshot` and `apt` together.

**chrome-headless-shell** is the build HyperFrames 0.9.41 manages itself: `CHROME_VERSION` in `@hyperframes/engine`, the build `hyperframes browser ensure` installs. HyperFrames tunes and tests its deterministic BeginFrame capture against that build; Puppeteer's default build (157.x for puppeteer-core 25.17) is not used. The `@puppeteer/browsers` version in the lockfile installs it to `/opt/chrome-headless-shell`, and `HYPERFRAMES_BROWSER_PATH` points HyperFrames at it. Chrome for Testing publishes no checksums, so the download relies on HTTPS, and `cinewright-check-pins` confirms the installed build. When HyperFrames is upgraded, read its new `CHROME_VERSION` and update the pin.

**GSAP** is copied from the lockfile into `/opt/cinewright/vendor/gsap.min.js`; nothing loads from a CDN. Open issue 6 (the GSAP licence) still decides whether GSAP stays a core dependency (M2.4).

**Install scripts** of dependencies are denied in `pnpm-workspace.yaml` (`allowBuilds`). Puppeteer's would download a browser.

## Commands

```bash
uv run cinewright-build-image --tag cinewright-render:dev     # add --push to publish
uv run cinewright-check-pins --image cinewright-render:dev
```

`cinewright-check-pins` runs `render-job --versions` inside the image, with the network off, and compares each reported version with the tracked file it should come from. A mismatch names the key, both values and the file, for example `node: expected 24.22.3 (from .node-version), image reports 24.22.2`.

The image carries the label `org.cinewright.inputs-hash`: a SHA-256 over every file in its build context (`cinewright_tools.container.inputs_hash`). CI uses it to tie a published digest to the inputs it was built from.

## Rendering

```bash
uv run cinewright-render-in-container --image cinewright-render:dev --in container/fixtures/hello-world --out out/hello
```

The host runs `docker run --rm --network none --platform linux/amd64` as the host user, with the composition mounted read-only at `/job/in` and the output folder at `/job/out`. Every argument is a list element, never passed through a shell, and the bind mounts are CSV-quoted, so paths with spaces, commas or non-ASCII characters work. Inside the image, `render-job`:

1. Copies `/job/in` to a fixed work folder and adds `vendor/gsap.min.js`.
2. Calls `@hyperframes/producer`'s `createRenderJob` and `executeRenderJob`, passing every setting explicitly.
3. Writes `output.mp4` (or `frames/000001.png`…), `framemd5.txt` (`ffmpeg -f framemd5` of the decoded frames), `sha256.txt` and `render-log.jsonl`.

Exit codes: 0 ok, 2 usage or input error, 3 blocked network request, 4 render failure.

### Settings

`render-runner/render-settings.json` holds every render setting. `loadSettings` rejects unknown, missing or inconsistent keys. The encoder values are test settings until delivery profiles own them (M5.3). How each key reaches HyperFrames 0.9.41:

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

## Runner classes

A runner class is CPU architecture + image digest + render settings. Baselines are rendered on `linux/amd64` in CI. On Apple Silicon the amd64 image runs under emulation; those renders prove behaviour, never baselines.
