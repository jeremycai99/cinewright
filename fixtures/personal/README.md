# Personal fixtures

The maintainer's own briefs and preferred looks, for dogfooding (AGENTS.md §4.1). They **never gate** a merge or a release: the benchmark (`fixtures/benchmark/`) does.

- Same layout as the benchmark: `tier-a/<id>/project/` with `tier-a/index.json`, and `tier-b/<id>/brief.json` with `tier-b/index.json`.
- Run them with `--suite personal` on `cinewright-eval tier-a` or `tier-b`. The report is headed "personal, not gating" and the command exits 0 whatever the result.
- They cannot update expected hashes (`--update-expected`) or record a vision baseline.
- **Media is never committed here.** Projects reference assets by hash; keep the bytes in your own CAS or remote.
- No code may name this folder: the boundary check fails on any path reference to it outside `eval/src/cinewright_eval/suites.py`.
- A change that only improves these fixtures must still not regress the benchmark.
