# Benchmark briefs (tier B)

Tier B runs these briefs through live agents and providers (D36, M8.3b). The v0.1 exit gate runs a reduced set (decision 11, 2026-11-21): 4 briefs, 2 runs each in their home pack plus 1 pack-swap run each, with local media providers. The full matrix (8 briefs, 3 runs, paid media) is the v0.2 target.

Briefs are written by someone other than the maintainer and reviewed for neutrality (decision 10, AGENTS.md §2.3). Each `<id>/README.md` records the author, the reviewer and the review. `_dev/` holds development briefs used to record cassettes; they are not benchmark entries.

## Coverage (v0.1)

| Brief | Genre | Length | Deliverables | Home pack |
| --- | --- | --- | --- | --- |
| `tides_explainer` | explainer | 60 s | landscape | neutral |
| `compost_explainer` | explainer | 30 s | portrait + landscape | playful |
| `library_hours_ad` | ad | 15 s | portrait | playful |
| `bike_repair_ad` | ad | 30 s | landscape | neutral |

Rules, checked by `uv run cinewright-eval briefs check`: at least 4 briefs; 2 explainers and 2 ads; each length (15, 30, 60 s) at least once; both aspect ratios across the set; at least 1 brief asking for both; 2 briefs on each pack; no pack id, token name, hex colour or font name in a brief's text.

`uv run cinewright-eval briefs init <id> --to <dir> [--pack <id>]` makes a project for a brief: `cinewright init` with its deliverables, then one user patch setting the brief, the narrator, the pack and the Auto preset.
