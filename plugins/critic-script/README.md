# critic-script

The script critic (M6.1c): a `critic` plugin, in process, Apache-2.0. One method, `critic.run`. It reads only the IR, the CAS and the written sidecars: no recognizer, no network, no clock.

## Transcript against script (open issue 8)

For every line with a selected take, the take's **frozen** transcript (an asset with role `transcript` and a `take` reference, made by the engine's `transcribeTake`) is compared with the line's words:

- Both sides go through `normalizeWords`: Unicode NFKC, case folded for the speaker's language, every punctuation and symbol character removed. No word lists, no number spelling.
- The speaker's lexicon is applied to the heard words: a respelling the recognizer hears ("win") counts as its term ("Nguyen").
- Script words the take marks `interpolated` (the aligner could not time them: digits, symbols) are wildcards that match one to `stt.wildcard_max` heard words. "In 2014 it cost £13.60." matches "in twenty fourteen it cost thirteen pounds sixty".
- A word error rate over `stt.max_wer` is `stt.mismatch` on the line, naming each missing, extra or misheard word. A take with no transcript is `stt.no_transcript` (a warning).

`cinewright render` freezes a transcript for each selected take that lacks one when an installed STT plugin offers `stt.transcribe`; a frozen one is reused and calls nothing. Tier A never needs live STT.

## Caption timing (AGENTS.md §4.2)

The written SRT sidecar is parsed and graded against the cues the timing implies (`sequenceCues`, the same function that writes the sidecars and the burn-in) and the profile's caption rules. Each sidecar cue is matched, in order, to the expected cue with the same text.

| Rule | Defect |
| --- | --- |
| `captions.overlap` | a cue ends after the next starts |
| `captions.out_of_range` | a cue starts before 0 or ends after the film |
| `captions.short_display` | shorter than `min_display_frames` while the next cue (or the end) leaves room |
| `captions.line_too_long` | a line over `max_chars_per_line`, or more than `max_lines` |
| `captions.missing_line` | a line with a selected take has no cue |
| `captions.sync` | a cue starts more than `captions.sync_frames` from its first word, or the VTT disagrees with the SRT |

## Settings

`settings.json`: `stt.max_wer`, `stt.wildcard_max`, `captions.sync_frames`. Caption rules come from the delivery profile. The plugin version and the settings hash are in every report (D36).
