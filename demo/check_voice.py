#!/usr/bin/env python3
"""Transcribes each narration clip and compares it with the script, to catch repeats and slips."""
import json
import os
import re

import librosa
from faster_whisper import WhisperModel

from edit import wav_seconds

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE = os.path.join(HERE, "out", "voice")
lines = json.load(open(os.path.join(HERE, "lines.json"), encoding="utf-8"))
model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=4)


def words(text):
    return re.findall(r"[a-z']+", text.lower().replace("dao", "dow"))


total = 0.0
for line in lines:
    path = os.path.join(VOICE, f"{line['id']}.wav")
    seconds = wav_seconds(path)
    total += seconds
    audio, _ = librosa.load(path, sr=16000, mono=True)
    segments, _ = model.transcribe(audio, language="en", beam_size=5, word_timestamps=False)
    heard = " ".join(s.text.strip() for s in segments)
    a, b = words(line["text"]), words(heard)
    extra = max(0, len(b) - len(a))
    missing = len(set(a) - set(b))
    pace = len(a) / seconds * 60
    flag = "CHECK" if extra >= 2 or missing >= 2 or pace > 215 else "ok   "
    print(f"{flag} {line['id']} {seconds:5.2f}s {pace:4.0f}wpm  {heard}")
print(f"total {total:.1f}s")
