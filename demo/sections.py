"""The cut list. Each section's narration sets its length; clips are squeezed or held to fit.

`from` and `to` are moments in a recorded shot: an event name, optionally plus or minus seconds.
No `to` means real time. A clip with `seconds` takes exactly that long, and the remaining clips
share the rest of the section.
"""

TICKS = [{"file": "tick.wav", "at": a} for a in (2.4, 3.4, 4.4, 5.4, 6.4)]

SECTIONS = [
    {
        "name": "old",
        "lines": ["01", "02", "03", "04", "05", "06"],
        "lead": 0.25,
        "tail": 0.9,
        "video": [{"shot": "old", "from": "start+0.35"}],
        "sounds": [{"file": "thump.wav", "shot": "old", "event": "stamped"}],
    },
    {
        "name": "census",
        "lines": ["07", "08", "09"],
        "tail": 0.5,
        "video": [{"shot": "census", "from": "start+0.2", "to": "facts-1"}],
    },
    {
        "name": "hero",
        "lines": ["10", "11"],
        "tail": 1.1,
        "video": [{"shot": "hero", "from": "start"}],
        "sounds": [{"file": "thump.wav", "shot": "hero", "event": "stamped", "nudge": 0.38}],
    },
    {
        "name": "budget",
        "lines": ["12"],
        "tail": 0.35,
        "caption": "left",
        "video": [{"shot": "post", "from": "start+0.5", "to": "budget+2.5"}],
    },
    {
        "name": "post",
        "lines": ["13", "14"],
        "tail": 0.3,
        "caption": "left",
        "video": [{"shot": "post", "from": "budget+2.5", "to": "clock+1.0"}],
    },
    {
        "name": "silence",
        "lines": ["15"],
        "tail": 5.2,
        "caption": "left",
        "video": [
            {"shot": "post", "from": "clock+1.0"},
            {"shot": "post", "from": "clock+5.0", "to": "confirming-9", "seconds": 3.4},
        ],
        "sounds": TICKS,
        "notes": [{"at": 3.6, "until": 7.2, "text": "Demo window: 2 minutes. A real budget gives people 48 hours."}],
    },
    {
        "name": "pays",
        "lines": ["16"],
        "tail": 1.5,
        "caption": "left",
        "video": [
            {"shot": "post", "from": "confirming-9", "to": "confirming-1.5"},
            {"shot": "post", "from": "confirming-1.5", "to": "stamped", "seconds": 1.6},
            {"shot": "post", "from": "stamped", "to": "stamped+2.2", "seconds": 2.2},
        ],
        "sounds": [{"file": "thump.wav", "shot": "post", "event": "stamped", "nudge": 0.12}],
    },
    {
        "name": "earned",
        "lines": ["17"],
        "tail": 0.5,
        "caption": "left",
        "video": [{"shot": "post", "from": "records", "to": "end"}],
    },
    {
        "name": "break",
        "lines": ["18"],
        "tail": 0.25,
        "caption": "left",
        "video": [{"shot": "object", "from": "start+0.2", "to": "posted"}],
    },
    {
        "name": "object",
        "lines": ["19"],
        "tail": 1.0,
        "caption": "left",
        "video": [{"shot": "object", "from": "lena", "to": "stamped+0.8"}],
        "sounds": [{"file": "thump.wav", "shot": "object", "event": "stamped", "nudge": 0.12}],
    },
    {
        "name": "council",
        "lines": ["20"],
        "tail": 0.45,
        "caption": "left",
        "video": [{"shot": "object", "from": "stamped+0.8", "to": "end"}],
    },
    {
        "name": "refused",
        "lines": ["21"],
        "tail": 1.2,
        "caption": "left",
        "video": [
            {"shot": "refused", "from": "start+0.2", "to": "typed"},
            {"shot": "refused", "from": "typed", "to": "toast", "seconds": 1.0},
            {"shot": "refused", "from": "toast", "to": "toast+1.7", "seconds": 1.7},
        ],
    },
    {
        "name": "near",
        "lines": ["22"],
        "tail": 0.45,
        "video": [{"shot": "install", "from": "start+0.2", "to": "end"}],
    },
    {
        "name": "report",
        "lines": ["23"],
        "tail": 0.5,
        "video": [{"shot": "report", "from": "start+0.2", "to": "report+3.4"}],
    },
    {
        "name": "close",
        "lines": ["24"],
        "lead": 0.3,
        "tail": 1.6,
        "caption": "left",
        "video": [{"shot": "post", "from": "stamped+0.5", "to": "stamped+3.9"}],
    },
]
