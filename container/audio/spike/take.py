"""M4.0b spike: one Kokoro take and its WhisperX alignment and transcript, in the audio image.

Usage: python take.py <out dir>. Prints a JSON result line.
"""

import hashlib
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch

TEXT = os.environ.get(
    "SPIKE_TEXT", "In 2014 it cost £13.60, and the bridge opened two years later."
)
VOICE = "af_heart"
SEED = 1234
MODELS = Path(os.environ.get("CINEWRIGHT_MODELS", "/opt/models"))
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

torch.manual_seed(SEED)
torch.set_num_threads(1)
torch.use_deterministic_algorithms(True)

from kokoro import KModel, KPipeline  # noqa: E402

repo = "hexgrad/Kokoro-82M"
kdir = MODELS / "kokoro-82m"
t0 = time.perf_counter()
model = KModel(
    repo_id=repo, config=str(kdir / "config.json"), model=str(kdir / "kokoro-v1_0.pth")
).eval()
pipe = KPipeline(lang_code="a", repo_id=repo, model=model)
load_s = time.perf_counter() - t0
t0 = time.perf_counter()
chunks, tokens, offset = [], [], 0.0
for result in pipe(TEXT, voice=str(kdir / "voices" / f"{VOICE}.pt")):
    audio = result.audio.numpy()
    for tok in result.tokens or []:
        if tok.start_ts is not None:
            tokens.append(
                {"text": tok.text, "start": offset + tok.start_ts, "end": offset + tok.end_ts}
            )
    chunks.append(audio)
    offset += len(audio) / 24000
synth_s = time.perf_counter() - t0
audio = np.concatenate(chunks)
pcm16 = (np.clip(audio, -1, 1) * 32767).astype("<i2")
with wave.open(str(out / "take.wav"), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(24000)
    w.writeframes(pcm16.tobytes())
duration = len(audio) / 24000
f32 = audio.astype("<f4").tobytes()

import whisperx  # noqa: E402

t0 = time.perf_counter()
wav = whisperx.load_audio(str(out / "take.wav"))
align_model, meta = whisperx.load_align_model(language_code="en", device="cpu")
segments = [{"start": 0.0, "end": duration, "text": TEXT}]
aligned = whisperx.align(segments, align_model, meta, wav, "cpu", return_char_alignments=False)
align_s = time.perf_counter() - t0
words = [
    {"word": w["word"], "start": w.get("start"), "end": w.get("end")}
    for w in aligned["word_segments"]
]
# The same alignment with the words the aligner cannot spell (digits, symbols) left out of
# the text; they are interpolated afterwards (the plan's rule).
vocab = set(meta["dictionary"])
script = TEXT.split()
keep = [i for i, w in enumerate(script) if all(c in vocab for c in w.lower() if c.isalnum())]
filtered = " ".join(script[i] for i in keep)
seg2 = [{"start": 0.0, "end": duration, "text": filtered}]
aligned2 = whisperx.align(seg2, align_model, meta, wav, "cpu", return_char_alignments=False)
words_dropped = [None] * len(script)
for i, w in zip(keep, aligned2["word_segments"], strict=False):
    words_dropped[i] = {"word": w["word"], "start": w.get("start"), "end": w.get("end")}
# The same take aligned against a spoken form of the text (SPIKE_SPOKEN), when given.
spoken = os.environ.get(
    "SPIKE_SPOKEN",
    "In twenty fourteen it cost thirteen pounds sixty, and the bridge opened two years later.",
)
words_spoken = None
if spoken:
    seg3 = [{"start": 0.0, "end": duration, "text": spoken}]
    aligned3 = whisperx.align(seg3, align_model, meta, wav, "cpu", return_char_alignments=False)
    words_spoken = [
        {"word": w["word"], "start": w.get("start"), "end": w.get("end")}
        for w in aligned3["word_segments"]
    ]
t0 = time.perf_counter()
asr = whisperx.load_model(
    str(MODELS / "faster-whisper-small"), "cpu", compute_type="int8", language="en", threads=1
)
transcript = asr.transcribe(wav, batch_size=1, language="en")
transcribe_s = time.perf_counter() - t0
text = " ".join(s["text"].strip() for s in transcript["segments"])

# Native timestamps vs alignment, per word, for the words both time.
native = {i: t for i, t in enumerate(tokens)}
deltas = []
for i, w in enumerate(words):
    t = native.get(i)
    if t and w["start"] is not None and t["text"].strip(".,") == w["word"].strip(".,"):
        deltas.append(max(abs(t["start"] - w["start"]), abs(t["end"] - w["end"])))

result = {
    "duration_s": round(duration, 4),
    "take_f32_sha256": hashlib.sha256(f32).hexdigest(),
    "take_wav_sha256": hashlib.sha256((out / "take.wav").read_bytes()).hexdigest(),
    "align_sha256": hashlib.sha256(json.dumps(words, sort_keys=True).encode()).hexdigest(),
    "transcript_sha256": hashlib.sha256(text.encode()).hexdigest(),
    "transcript": text,
    "words": words,
    "words_dropped": words_dropped,
    "words_spoken": words_spoken,
    "native": tokens,
    "max_native_vs_align_s": max(deltas) if deltas else None,
    "compared_words": len(deltas),
    "untimed_words": [w["word"] for w in words if w["start"] is None],
    "seconds": {
        "load": round(load_s, 2),
        "synth": round(synth_s, 2),
        "align": round(align_s, 2),
        "transcribe": round(transcribe_s, 2),
    },
    "rtf": {
        "synth": round(synth_s / duration, 3),
        "align": round(align_s / duration, 3),
        "transcribe": round(transcribe_s / duration, 3),
    },
}
(out / "result.json").write_text(json.dumps(result, indent=2))
print(
    json.dumps(
        {
            k: v
            for k, v in result.items()
            if k not in ("words", "native", "words_dropped", "words_spoken")
        }
    )
)
