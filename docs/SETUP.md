# Setting up Cinewright

This guide takes a fresh machine to a rendered, exported video. CI runs it exactly as written on a bare `ubuntu-24.04` runner (`.github/workflows/setup.yml`): every block marked `<!-- setup: … -->` runs in order in one bash shell from the repository root, so a step that stops working here fails CI. `uv run --locked cinewright-setup-doc --list` lists the steps.

Run the blocks in order in one terminal: later blocks use the variables and the `cinewright` function that earlier blocks define.

## Prerequisites

You need:

- **Docker**, running. Renders, narration and checks run in two pinned `linux/amd64` images.
- **Node 24**, at the exact version in `.node-version`. pnpm comes with Node through Corepack.
- **uv**, which installs the Python version in `.python-version` on first use. It runs the eval harness and the repository tools.
- **git**, to clone the repository.

Supported: Linux on `x86_64` (`linux/amd64`, the runner class CI uses) and macOS. On an arm64 host (Apple silicon, Linux on ARM) Docker runs the amd64 images under emulation: everything works, renders are several times slower, and only `linux/amd64` hashes are compared against the baselines (D33).

<!-- setup: prerequisites -->
```bash
docker info --format 'Docker {{.ServerVersion}} ({{.Architecture}})'
node --version
uv --version
git --version
```

## Clone, install and build

Clone the repository and work from its root (CI starts from a checkout, so this block is shown and not run):

```bash
git clone https://github.com/jeremycai99/cinewright.git
cd cinewright
```

Then install the TypeScript and Python workspaces, build every package, and define `cinewright` for this shell. `WORK` is a scratch folder for the projects below; set it yourself first to keep them somewhere else.

<!-- setup: install -->
```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec tsc -b
uv sync --locked
CINEWRIGHT_REPO="$PWD"
cinewright() { node "$CINEWRIGHT_REPO/cli/dist/bin.js" "$@"; }
cinewright --version
WORK="${WORK:-$(mktemp -d)}"
echo "projects go in $WORK"
```

## Pull the images

Both images are pulled by the digests locked in the repository, so every machine renders with the same bytes: `container/image.lock.json` (the render image: HyperFrames, Chrome, FFmpeg) and `container/audio/image.lock.json` (the audio image: Kokoro speech and WhisperX transcription, with their model weights). Together they are several gigabytes.

While the repository is private, the images are too: log in to `ghcr.io` first with a GitHub token that has `read:packages`, for example `gh auth token | docker login ghcr.io -u <your GitHub user> --password-stdin`.

<!-- setup: images -->
```bash
locked() { node -e 'const l = require(process.argv[1]); console.log(`${l.image}@${l.digest}`)' "$CINEWRIGHT_REPO/$1"; }
docker pull --platform linux/amd64 "$(locked container/image.lock.json)"
docker pull --platform linux/amd64 "$(locked container/audio/image.lock.json)"
export CINEWRIGHT_IMAGE="$(locked container/image.lock.json)"
```

`CINEWRIGHT_IMAGE` tells `render` and `export` which render image to use; the audio image is found from its lock file.

## Check the machine

`cinewright doctor` checks Docker, both images, Node and Python, each plugin's secrets (by name, never the values) and the CAS remote. It exits 0 when a keyless Manual render can work, and 3 otherwise, with a `fix:` line under each failing check. Missing keys and an unset remote are warnings: only agents and the tier A fixtures need them.

<!-- setup: doctor -->
```bash
cinewright doctor
```

## Render the tier A fixtures

The tier A fixtures are frozen projects whose rendered hashes are recorded (`fixtures/benchmark/tier-a/`). Rendering them proves this machine renders exactly what CI renders. Their assets are fetched by hash from the CAS remote in `CINEWRIGHT_CAS_REMOTE`; set it before this step. CI skips this step until the fixtures land (`docs/plans/alpha-gate.md`, A.2).

<!-- setup: fixture -->
```bash
uv run --locked cinewright-eval tier-a --out "$WORK/tier-a"
```

The report is `$WORK/tier-a/tier-a.md`.

## A Manual project, from `init` to `export`, with no key

A Manual project is one you write yourself: no agent runs, so no LLM key is needed, and every media provider here is local (Kokoro speech in the audio image, no stock, no music). `docs/setup/manual-project.json` is one `user` patch with a narrator, two lines and two scenes of one title shot each; any patch you write works the same way (`cinewright schema` lists the shapes).

<!-- setup: manual -->
```bash
cinewright init "$WORK/hello" --id hello --deliverable web=landscape_web
cinewright patch apply --file docs/setup/manual-project.json --project "$WORK/hello"
cinewright render --project "$WORK/hello"
cinewright export --to "$WORK/hello-export" --project "$WORK/hello"
test -s "$WORK/hello-export/web.mp4"
ls "$WORK/hello-export"
```

`render` narrates the lines, times the scenes, renders each shot, mixes, assembles and runs the deterministic checks; a second `render` with no edit is all cache hits. `export` copies the MP4, its caption sidecars and its provenance manifest, and refuses (exit 10) while an error finding is open.

## With a key: agents write the video

The agents need an LLM plugin with its key. v0.1 ships one, `llm_anthropic`, which reads `ANTHROPIC_API_KEY`. Set it in your shell or secret manager, never in a file in the repository. `ELEVENLABS_API_KEY` is optional and adds a paid voice provider; without it narration stays on Kokoro.

This step costs money: about $2 to $3 for a 30-second brief (measured 2026-11-23, without `--vision`'s critic it is about $0.85 less), more for this 60-second one; the cap below pauses the run at $5. CI never runs it: it has no key.

<!-- setup: keyed -->
```bash
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY to run the agents}"
uv run --locked cinewright-eval briefs init tides_explainer --to "$WORK/tides"
cinewright review budget --cap 5 --project "$WORK/tides"
cinewright render --approve-final --project "$WORK/tides"
cinewright export --to "$WORK/tides-export" --project "$WORK/tides"
cinewright status --project "$WORK/tides"
```

`briefs init` makes a project from a benchmark brief in the Auto preset. `render --approve-final` runs the whole workflow (producer, writer, director, shot builder, editor, then every job) and approves the final gate itself, as tier B does; to approve each gate yourself, run `cinewright plan` instead, read the gate with `cinewright review`, and continue with `cinewright review approve <gate>` and `cinewright render`. `status` shows what it spent.

### What "local-only" means

A local-only run uses only local media providers: Kokoro for speech, the music library (`CINEWRIGHT_AUDIO_LIBRARY_PATH`) or no music, and no stock. The agents still need an LLM key: v0.1 has no local model. A run with no key at all is a Manual project, as above, or a run replayed from recorded cassettes (`CINEWRIGHT_CASSETTE_MODE=replay`).

## When something fails

- `cinewright doctor` again: each failing check names what is missing and how to fix it.
- `Unable to find image … unauthorized` from `render`: the images are not pulled, or the `ghcr.io` login expired.
- Exit codes are listed in `cli/README.md`; `--json` on any command gives the same facts in a stable shape.
