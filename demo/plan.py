#!/usr/bin/env python3
"""Works out when things must happen on screen, from how long the narration runs.

Run after the voice is generated and before recording. Writes demo/out/plan.json.
"""
import json
import os

from edit import GAP, OUT, TEMPO, VOICE, wav_seconds


def seconds(line_id):
    return wav_seconds(os.path.join(VOICE, f"{line_id}.wav")) / TEMPO


def starts(line_ids, lead=0.0):
    t, out = lead, {}
    for line_id in line_ids:
        out[line_id] = t
        t += seconds(line_id) + GAP
    return out


old = starts(["01", "02", "03", "04", "05", "06"], lead=0.25)
hero = starts(["10", "11"])
plan = {
    "old": {
        "yesAt": round(old["03"] + seconds("03") * 0.8, 2),
        "drainAt": round(old["04"] + 0.2, 2),
        "drainFor": round(old["06"] - old["04"] + seconds("06") * 0.1, 2),
        "stampAt": round(old["06"] + seconds("06") * 0.42, 2),
    },
    # The stamp should land on "yes", near the end of the line.
    "hero": {"stampAt": round(hero["11"] + seconds("11") * 0.74, 2)},
}
with open(os.path.join(OUT, "plan.json"), "w", encoding="utf-8") as fh:
    json.dump(plan, fh, indent=1)
print(plan)
print("narration only:", round(sum(seconds(f"{i:02d}") for i in range(1, 25)), 1), "s")
