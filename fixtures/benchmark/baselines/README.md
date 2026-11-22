# Vision baselines

Recorded scores of the vision critic (M6.2, D36), one file per recording: `<date>-<short hash>.json`.

- **Pins:** the critic pin passed to `llm.generate`, the model id the plugin reported, the vision critic's role version (its prompt hash), the rubric version (`eval/rubrics/craft/v1.json`), the critic plugins' versions, the HyperFrames version and the image digests. Any change makes a new baseline.
- **Fixtures:** per fixture, deliverable and criterion, the mean, sample standard deviation and number of runs (N = 5 per tier A fixture).
- **Thresholds:** per pack and criterion, `mean − 2 × sd` over the pack's runs, floored at the rubric's `floor + 1`. Written when the baseline is recorded, never computed at check time (Open issue 12).

Record and check with the eval tools:

```bash
uv run cinewright-eval baseline record runs/*.json --pins pins.json --out fixtures/benchmark/baselines/<date>-<hash>.json
uv run cinewright-eval baseline check runs/*.json --against fixtures/benchmark/baselines/<file>.json
```

A run file is `{ fixture, pack, deliverable, scores: { <criterion>: [score, …] } }`, its scores read from a critique report's `measured` (`vision.<criterion>.<target>`, from `cinewright render --vision`).

Vision findings are warnings: they enter the fix loop (M6.3) but never block export, and a non-deterministic critic never decides the exit gate.
