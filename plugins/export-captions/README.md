# export_captions

Caption sidecars (M5.2, D35). Apache-2.0. Every deliverable gets `<deliverable>.<lang>.srt` and `<deliverable>.<lang>.vtt`, whether or not it burns captions in.

- **One cue function.** `sequenceCues(ir, table, sequenceId, rules)` in `@cinewright/components` makes the cues for both the burn-in (the backend clips them to each shot) and the sidecars, so their timing agrees by construction (G3). `timelineCues(ir, solved, rules)` offsets each sequence's cues by its solved start.
- **Rules** come from the deliverable's profile (`captions`: line length, line count, minimum display), so a portrait deliverable may split a line that a landscape one keeps whole.
- **Times:** `ms = round(frame × 1000 × den / num)`; each end is clamped to the next cue's start and kept at least 1 ms after its own start.
- **SRT:** a counter from 1, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, the text, a blank line. UTF-8, no BOM, LF. A project with no lines gives an empty file.
- **WebVTT:** `WEBVTT`, a blank line, cues with `HH:MM:SS.mmm`, `&`, `<` and `>` escaped, no identifiers. A project with no lines gives the header alone.
- Text containing `-->` is refused as `captions.unsafe_text`, naming the line.
- **Language:** the narrator's voice language, else the first speaker's, else `und`.
- **Cache:** `.cinewright/cache/captions/<key>/`, keyed by the deliverable, the cues, the language, the frame rate and the format version, and committed with core's `commitCacheDir`. A caption edit never invalidates the MP4 of a deliverable without burn-in.
- **Plugin method `export.captions`:** `{ project, deliverable, timing }` → `{ key, dir, files: { srt, vtt }, language, cues, hit }`.
