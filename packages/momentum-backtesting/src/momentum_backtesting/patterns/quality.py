"""How well-formed a detected base is: a 0-1 grade from its own geometry (bl041 addendum 1,
`quality`). Each component is clipped to [0, 1] and the grade is their mean. Nothing here reads a
bar after the detection week; it only reads the geometry the detector recorded.
"""

from __future__ import annotations

import json

import pandas as pd


def _clip(x: float) -> float:
    return min(1.0, max(0.0, float(x)))


def _tight_range(g: dict) -> list[float]:
    from . import detector_params

    limit = detector_params("tight_range")["max_range"][str(g["weeks"])]
    dry = g.get("volume_10d_vs_50d")
    return [
        _clip(1 - g["range_vs_own_median"] / 0.5),
        _clip(1 - g["range"] / limit),
        0.5 if dry is None else _clip((1 - dry) / 0.5),
    ]


def _flag(g: dict) -> list[float]:
    return [
        _clip(1 - g["retrace_of_pole"] / 0.3333),
        _clip((1 - g["flag_vs_pole_volume"]) / 0.6),
        _clip((g["pole_rise"] - 0.2) / 0.4),
    ]


def _cup_handle(g: dict) -> list[float]:
    depth = g["depth"]
    if 0.15 <= depth <= 0.30:
        sweet = 1.0
    elif depth < 0.15:
        sweet = (depth - 0.12) / 0.03
    else:
        sweet = (0.35 - depth) / 0.05
    return [
        _clip(sweet),
        _clip(1 - g["handle_depth"] / 0.15),
        _clip(1 - abs(g["right_vs_left"]) / 0.10),
        _clip((g["prior_advance"] - 0.3) / 0.7),
    ]


GRADERS = {"tight_range": _tight_range, "flag": _flag, "cup_handle": _cup_handle}


def grade(pattern: str, geometry: dict | str) -> float:
    """0-1 quality of one detection; NaN for a pattern without a grader (high tight flag)."""
    grader = GRADERS.get(pattern)
    if grader is None:
        return float("nan")
    g = json.loads(geometry) if isinstance(geometry, str) else geometry
    parts = grader(g)
    return sum(parts) / len(parts)


def with_quality(detections: pd.DataFrame) -> pd.DataFrame:
    """`detections` plus `quality` and `blend_score` (state score x quality)."""
    out = detections.copy()
    out["quality"] = [grade(p, g) for p, g in zip(out["pattern"], out["geometry"], strict=True)]
    out["blend_score"] = out["score"] * out["quality"]
    return out
