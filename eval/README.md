# cinewright-eval

Benchmark tooling. Python, in the uv workspace; it drives the `cinewright` CLI and never imports the engine.

## `cinewright-eval cas-export <project> --to <dir>` (A.1)

Writes every asset the project references as a flat file named by its hex digest, verified and idempotent, and prints one JSON line per asset (`hash`, `bytes`, `role`). The maintainer uploads the folder to the read-only remote in `CINEWRIGHT_CAS_REMOTE`; no tool writes the remote.

## `cinewright-eval tier-a` (M8.3a)

```
cinewright-eval tier-a [--fixture <id>]... [--runner-class linux-amd64] [--out <dir>]
                       [--update-expected] [--cache <dir>] [--root <repo>] [--cli "<command>"]
```

Renders every fixture in `fixtures/benchmark/tier-a/index.json` and grades it. Exit 0 when every fixture passes, 1 otherwise.

- **Environment.** Every variable whose name ends in `_API_KEY`, `_KEY_ID`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_ACCESS_KEY` is removed before the CLI starts, and `CINEWRIGHT_FREE_ONLY=1` is set: the engine refuses to start any plugin whose cost model is not free, so a paid provider fails the run.
- **Isolation.** Each fixture's `project/` is copied to a scratch folder and rendered there with `cinewright render --json`; the checked-in fixture is never written. The render cache lives in `--cache/<fixture id>` (default `.tier-a-cache/`) and is linked into the copy, so CI can restore it.
- **Fails on:** any error finding; any deliverable hash (`sha256`, `framemd5`, `pcm_sha256`) that differs from `expected/<runner class>.json`, printing the expected and actual values; a fixture that is missing, marked `skip`, unknown to the index, or does not render (a provider failure, a paid plugin). `--update-expected` rewrites the expected hashes instead of failing on them; a PR that changes a baseline says why (D36).
- **Reports.** `tier-a.json`: `{ commit, runner_class, image: { render, audio }, critics: [{ id, version, settings_hash }], hyperframes, fixtures: [{ id, deliverables: [{ id, hashes, expected, match }], checks: { <rule>: { run, failed } }, findings, steps: { hit, miss }, seconds, error? }] }`. `tier-a.md`: every failure by name first (rule · fixture · deliverable), then one row per fixture × deliverable, then one row per rule with its pass rate. Never one average.

`--cli` (or `CINEWRIGHT_CLI`) is the command that runs `cinewright`; the default is `node <root>/cli/dist/bin.js`.

In CI, `.github/workflows/tier-a.yml` runs it on every PR (with the cache restored) and on `main` (cold, saving the cache), and writes the summary to the job summary. Until the fixtures land (A.2) the job reports that and passes. It becomes a required check after decision 9 (`docs/plans/alpha-gate.md`).
