# tts_kokoro

Local text to speech with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (kokoro 0.9.4, misaki 0.9.4), for Cinewright (M4.1c). **GPL-3.0-or-later** (`LICENSE`): in this plugin's process misaki loads `phonemizer-fork` and the espeak-ng library, both GPL-3.0-or-later (audit decision 8). Core and the other plugins reach it only over JSON-RPC across a process boundary. Not legal advice.

- **Runs in the audio image** (`runtime.container.image: "audio"`), which holds kokoro, misaki, torch and the model with all 54 voices (`container/audio`). The network is off. Free: the router tries it before paid providers (D29).
- **English only** (`en`, `en-US`: American; `en-GB`: British). Another language is `unsupported`, naming it.
- **Voices:** the speaker's `tts_kokoro` binding names one (`{ "voice": "af_heart" }`); there is no default voice. `settings.speed` is optional (default 1.0). Kokoro has no delivery direction control, so `direction` is not used.
- **Lexicon:** a respelling replaces the term in the text; IPA in slashes becomes misaki's inline pronunciation `[term](/ipa/)`. Matching is case-insensitive and never inside a longer word.
- **Output:** a 24 kHz mono 16-bit WAV; the mixer resamples it. One thread, deterministic algorithms and the request's seed. The same take comes out on one machine; takes differ across CPUs, which is fine because they are frozen (M4.0b).
- **Word times:** none (`words: null`). Kokoro's own token times are 55–136 ms early and include pauses (M4.0b), so the narration job aligns its takes with `stt_whisperx`.
