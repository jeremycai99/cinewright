# library_audio

A local library of music beds and sound effects (M4.3a). Apache-2.0. No network and no generation: it picks files you supply, so tier A benchmarks and offline projects can have music.

- **Where:** every folder on `CINEWRIGHT_AUDIO_LIBRARY_PATH` (separated like `PATH`) holds a `library.json` and the WAV files it lists.
- **Items:** `{ id, kind: "music" | "sfx", file, sha256, tags, mood?, bpm?, duration_ms, vocals?, loop?, license: { terms, commercial_use, attribution? } }`. An item with no licence, id, file hash or duration is rejected, naming it (`AGENTS.md` §6). A file whose bytes don't match its `sha256` is refused when it is chosen.
- **Music** (`music.request`): candidates are instrumental, at least as long as the sequence (or `loop: true`), and inside the BPM range when they state a BPM. Score: genre words shared with `tags` count twice, mood words shared with `mood` once, and the brief's words shared with either once. Ties go to the BPM nearest the middle of the range, then to the id. No positive score is `unsupported` with `data.reason: "no_match"`.
- **SFX** (`sfx.request`): the item whose id or a tag equals the name, case-insensitive.
- The result's licence is the item's own; the manifest's `output_license` is only a placeholder.

The library path is declared as a manifest secret only so the host passes it to the plugin; it is not secret.
