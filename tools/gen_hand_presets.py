"""Regenerate editor/main.js HAND_PRESETS from VRoid Studio's own hand-pose data.

Source data: tools/vroid_hand_muscles.json  (Mecanim humanoid muscle values
extracted from VRoidStudio data.unity3d -- see that file's "_about" note).

Each non-"natural" preset = the natural rest baseline + VRoid's exact per-finger
muscle delta from L_Hand_Natural, scaled to degrees. Only the two global scales
(SCALE, SPREAD) are calibrated visually; the per-finger/per-pose shape is taken
verbatim from VRoid. Re-run after tweaking SCALE/SPREAD and paste the printed
block over HAND_PRESETS in editor/main.js.

    python tools/gen_hand_presets.py

No third-party deps (the one-time UnityPy extraction step has been removed).
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "vroid_hand_muscles.json"), encoding="utf-8"))

# VRoid clip -> editor preset key
KEY2POSE = {"natural": "Natural", "fist": "Grip", "open": "Open",
            "thumbsup": "Good", "peace": "Open_V", "claw": "Gao", "point": "Open_Index"}
ORDER = ["natural", "fist", "open", "thumbsup", "peace", "claw", "point"]
FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"]
DOFJ = ["1Stretched", "2Stretched", "3Stretched"]  # -> curl[0], curl[1], curl[2]

# editor "natural" rest baseline (relaxed slight curl). natural -> delta 0 -> stays this.
BASE = {
    "Thumb":  {"curl": [8, 6, 4],    "splay": 0},
    "Index":  {"curl": [10, 12, 8],  "splay": 2},
    "Middle": {"curl": [10, 14, 10], "splay": 0},
    "Ring":   {"curl": [12, 16, 10], "splay": -2},
    "Little": {"curl": [14, 18, 12], "splay": -5},
}

# Calibrated muscle-delta -> degrees (visually matched against the sample VRM).
SCALE = 45.0    # stretch (curl)
SPREAD = 15.0   # spread (splay)

nat = DATA["Natural"]


def preset(pose):
    p = DATA[pose]
    rows = []
    for fn in FINGERS:
        base = BASE[fn]
        curl = [round(base["curl"][j] + (nat[fn][dof] - p[fn][dof]) * SCALE)
                for j, dof in enumerate(DOFJ)]
        splay = round(base["splay"] + (p[fn]["Spread"] - nat[fn]["Spread"]) * SPREAD)
        rows.append((curl, splay))
    return rows


lines = ["const HAND_PRESETS = {"]
for key in ORDER:
    pose = KEY2POSE[key]
    lines.append(f"    {key}: {{ fingers: [ // VRoid {pose}")
    rows = preset(pose)
    for fi, (curl, sp) in enumerate(rows):
        comma = "," if fi < 4 else ""
        lines.append(f"        {{ curl: [{curl[0]}, {curl[1]}, {curl[2]}], splay: {sp} }}{comma}  // {FINGERS[fi]}")
    lines.append("    ] },")
lines.append("};")
print("\n".join(lines))
