#!/usr/bin/env python3
"""Cuts the demo video from recorded shots and narration. Python standard library plus ffmpeg.

    python demo/edit.py            # writes demo/out/tacit-demo.mp4

The narration sets the timing. Each section lists its lines and which part of which shot to show.
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
VOICE = os.path.join(OUT, "voice")
SHOTS = os.path.join(OUT, "shots")
WORK = os.path.join(OUT, "work")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FPS = 30
TEMPO = 0.86  # The voice model speaks at about 195 words a minute. This brings it near 168.
RATE = 24000
GAP = 0.32  # Between lines inside a section.
TAIL = 0.42  # After the last line of a section.

LINES = {line["id"]: line for line in json.load(open(os.path.join(HERE, "lines.json"), encoding="utf-8"))}


def run(*args, cwd=None):
    res = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"ffmpeg failed: {res.stderr[-1800:]}\nargs: {args}")


def wav_seconds(path):
    """Reads the RIFF header directly, because the voice model writes float WAVs the wave module refuses."""
    with open(path, "rb") as fh:
        data = fh.read()
    i, byte_rate = 12, None
    while i + 8 <= len(data):
        chunk, size = data[i : i + 4], struct.unpack("<I", data[i + 4 : i + 8])[0]
        if chunk == b"fmt ":
            byte_rate = struct.unpack("<I", data[i + 16 : i + 20])[0]
        if chunk == b"data":
            return size / byte_rate
        i += 8 + size + (size & 1)
    raise ValueError(f"no audio data in {path}")


def line_seconds(line_id):
    return wav_seconds(os.path.join(WORK, f"voice-{line_id}.wav"))


def slow_voice():
    for line_id in LINES:
        target = os.path.join(WORK, f"voice-{line_id}.wav")
        run("-i", os.path.join(VOICE, f"{line_id}.wav"), "-af", f"atempo={TEMPO},aresample={RATE}", "-ac", "1", "-c:a", "pcm_s16le", target)


class Shot:
    def __init__(self, name):
        self.dir = os.path.join(SHOTS, name)
        data = json.load(open(os.path.join(self.dir, "frames.json"), encoding="utf-8"))
        self.frames = data["frames"]
        self.end_time = data["end"]
        self.events = json.load(open(os.path.join(self.dir, "events.json"), encoding="utf-8"))
        self.t0 = self.frames[0]["t"]

    def at(self, spec):
        """Resolves 'event', 'event+1.5' or 'event-2' to an absolute time."""
        for sign in ("+", "-"):
            if sign in spec:
                name, value = spec.split(sign)
                base = self.events[name]
                return base + float(value) if sign == "+" else base - float(value)
        return self.events[spec]


CLIP_ID = [0]


def render_clip(shot_name, start_spec, end_spec, seconds):
    """Writes [start, end] of a shot, squeezed or held to last exactly `seconds`."""
    shot = Shot(shot_name)
    start = shot.at(start_spec)
    end = shot.at(end_spec) if end_spec else start + seconds  # No end means real time.
    scale = seconds / max(0.01, end - start)
    inside = [f for f in shot.frames if start <= f["t"] <= end]
    before = [f for f in shot.frames if f["t"] < start]
    if before:
        inside.insert(0, {"name": before[-1]["name"], "t": start})
    if not inside:
        inside = [shot.frames[-1]]
    lines = ["ffconcat version 1.0"]
    for i, frame in enumerate(inside):
        following = inside[i + 1]["t"] if i + 1 < len(inside) else end
        lines.append(f"file '{frame['name']}'")
        lines.append(f"duration {max(0.001, (following - frame['t']) * scale):.6f}")
    lines.append(f"file '{inside[-1]['name']}'")
    listing = os.path.join(shot.dir, "list.ffconcat")
    with open(listing, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    CLIP_ID[0] += 1
    target = os.path.join(WORK, f"clip-{CLIP_ID[0]:03d}.mp4")
    run(
        "-f", "concat", "-safe", "0", "-i", "list.ffconcat",
        "-t", f"{seconds:.3f}",
        "-vf", f"fps={FPS},scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,setsar=1",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-an", target,
        cwd=shot.dir,
    )
    return target, seconds, shot_name, start, end


def tone(path, seconds, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples))


def make_effects():
    tick = [0.34 * math.exp(-i / (RATE * 0.006)) * math.sin(2 * math.pi * 1900 * i / RATE) for i in range(int(RATE * 0.05))]
    tone(os.path.join(WORK, "tick.wav"), 0.05, tick)
    thump = [0.75 * math.exp(-i / (RATE * 0.05)) * math.sin(2 * math.pi * (70 + 60 * math.exp(-i / (RATE * 0.02))) * i / RATE) for i in range(int(RATE * 0.28))]
    tone(os.path.join(WORK, "thump.wav"), 0.28, thump)


def ass_time(t):
    h, rem = divmod(max(0, t), 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def caption_text(line):
    body = wrap_caption(line["text"])
    return f"{body}\\N{{\\fs30}}{line['note']}" if line.get("note") else body


def wrap_caption(text, width=46):
    words, out, current = text.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > width and current:
            out.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        out.append(current)
    return r"\N".join(out)


def write_captions(cues, notes):
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Segoe UI Semibold,50,&H00FFFFFF,&H00FFFFFF,&H28121A16,&H28121A16,0,0,0,0,100,100,0,0,3,14,0,2,120,120,46,1
Style: CapLeft,Segoe UI Semibold,50,&H00FFFFFF,&H00FFFFFF,&H28121A16,&H28121A16,0,0,0,0,100,100,0,0,3,14,0,1,76,120,46,1
Style: Note,Segoe UI,31,&H00FFFFFF,&H00FFFFFF,&H3C121A16,&H3C121A16,0,0,0,0,100,100,0,0,3,10,0,9,60,60,34,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rows = [
        f"Dialogue: 0,{ass_time(a)},{ass_time(b)},{'CapLeft' if side == 'left' else 'Cap'},,0,0,0,,{text}"
        for a, b, text, side in cues
    ]
    rows += [f"Dialogue: 0,{ass_time(a)},{ass_time(b)},Note,,0,0,0,,{text}" for a, b, text in notes]
    with open(os.path.join(WORK, "captions.ass"), "w", encoding="utf-8") as fh:
        fh.write(head + "\n".join(rows) + "\n")


def build(sections):
    os.makedirs(WORK, exist_ok=True)
    slow_voice()
    make_effects()

    clips, placed, cues, notes, sounds, anchored, spans = [], [], [], [], [], [], []
    now = 0.0
    for section in sections:
        start = now
        cursor = now + section.get("lead", 0.0)
        for i, line_id in enumerate(section["lines"]):
            length = line_seconds(line_id)
            placed.append((line_id, cursor))
            cues.append((cursor, cursor + length, caption_text(LINES[line_id]), section.get("caption", "center")))
            cursor += length + (GAP if i + 1 < len(section["lines"]) else 0)
        cursor += section.get("tail", TAIL)
        duration = cursor - start
        # A section can hand part of its time to a fixed clip, usually silence or a time lapse.
        fixed = sum(c["seconds"] for c in section["video"] if "seconds" in c)
        flexible = [c for c in section["video"] if "seconds" not in c]
        share = max(0.2, duration + section.get("extra", 0) - fixed) / max(1, len(flexible))
        total = 0.0
        for clip in section["video"]:
            seconds = clip.get("seconds", share)
            rendered = render_clip(clip["shot"], clip["from"], clip.get("to"), seconds)
            clips.append(rendered)
            spans.append((rendered[2], rendered[3], rendered[4], start + total, seconds))
            total += seconds
        for note in section.get("notes", []):
            notes.append((start + note["at"], start + note["until"], note["text"]))
        for sound in section.get("sounds", []):
            if "event" in sound:
                anchored.append(sound)
            else:
                sounds.append((sound["file"], start + sound["at"]))
        now = start + total
        print(f"{section['name']:10s} {start:6.2f} - {now:6.2f}")

    # Sounds tied to a moment on screen follow that moment through any speed change.
    for sound in anchored:
        moment = Shot(sound["shot"]).at(sound["event"])
        for name, a, b, at, seconds in spans:
            if name == sound["shot"] and a <= moment <= b:
                sounds.append((sound["file"], at + (moment - a) / (b - a) * seconds + sound.get("nudge", 0.0)))
                break

    joined = os.path.join(WORK, "joined.mp4")
    listing = os.path.join(WORK, "clips.txt")
    with open(listing, "w", encoding="utf-8") as fh:
        for path, *_ in clips:
            fh.write(f"file '{os.path.basename(path)}'\n")
    run("-f", "concat", "-safe", "0", "-i", "clips.txt", "-c", "copy", "joined.mp4", cwd=WORK)

    # Narration and small sounds, each placed at its moment, then loudness-matched.
    inputs, chains, labels = [], [], []
    for i, (line_id, at) in enumerate(placed):
        inputs += ["-i", f"voice-{line_id}.wav"]
        chains.append(f"[{i}:a]adelay={int(at * 1000)}:all=1[a{i}]")
        labels.append(f"[a{i}]")
    offset = len(placed)
    for j, (name, at) in enumerate(sounds):
        inputs += ["-i", name]
        chains.append(f"[{offset + j}:a]adelay={int(at * 1000)}:all=1[s{j}]")
        labels.append(f"[s{j}]")
    graph = ";".join(chains) + ";" + "".join(labels) + f"amix=inputs={len(labels)}:normalize=0,apad=whole_dur={now:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    run(*inputs, "-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "mix.wav", cwd=WORK)

    write_captions(cues, notes)
    final = os.path.join(OUT, "tacit-demo.mp4")
    run(
        "-i", "joined.mp4", "-i", "mix.wav",
        "-vf", "ass=captions.ass,format=yuv420p",
        "-map", "0:v", "-map", "1:a",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "17", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{now:.3f}",
        "final.mp4",
        cwd=WORK,
    )
    shutil.move(os.path.join(WORK, "final.mp4"), final)
    print(f"{final}  {now:.1f}s")
    timing = {"sections": [], "lines": [{"id": line_id, "at": round(at, 2)} for line_id, at in placed], "total": round(now, 2)}
    with open(os.path.join(OUT, "timing.json"), "w", encoding="utf-8") as fh:
        json.dump(timing, fh, indent=1)


if __name__ == "__main__":
    from sections import SECTIONS  # noqa: E402  Kept apart because it changes with every recut.

    build(SECTIONS)
