# stt_whisperx

Forced alignment (`stt.align`) and transcription (`stt.transcribe`) with [WhisperX](https://github.com/m-bain/whisperX) 3.8.6, for Cinewright (M4.5b). Apache-2.0.

- **Runs in the audio image** (`runtime.container.image: "audio"`), which holds whisperx, torch, `WAV2VEC2_ASR_BASE_960H` and `faster-whisper-small` (`container/audio`). The plugin folder is mounted at `/plugins/stt_whisperx`. The network is off.
- **English only.** Another language is `unsupported`, naming it.
- **Alignment needs the spoken form.** Forced alignment matches letters to speech, so given "2014" or "£13.60" as written (or with those words left out) it mistimes the whole line; given "twenty fourteen" and "thirteen pounds and sixty pence" it times every word within a few frames (`container/audio/README.md` §Determinism). The request's `spoken` forms win; otherwise `normalize.spoken_form` spells numerals, years, currency, percentages, ordinals and a few symbols. Each script word's time spans its spoken tokens; a word with no timed token comes back `null`, and the narration job interpolates it.
- **Times** are integer samples at 16 kHz (WhisperX loads audio at that rate).
- **Deterministic** on one image: one thread, deterministic algorithms; the spike measured identical results across runs and CPU counts. Results are frozen as assets anyway (`aligned_by` on takes, `transcript` assets), so tier A never runs STT live.

Host tests (`tests/`) cover the normalizer and the token mapping without whisperx. The container tests are in `engine/test/stt-whisperx.container.test.ts`.
