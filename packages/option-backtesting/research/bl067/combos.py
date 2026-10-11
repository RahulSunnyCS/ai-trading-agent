"""BL-067: the 16 criteria-weight combinations (recent, weekday, days to expiry, VIX band; percent).

Row 0 is the baseline DRB-6W3L2 weighting; the rest isolate each criterion (corners), drop one at a
time (leave-one-outs), pair them, and tilt the blend. Registered in backlog/BL-067-drb-weight-map.md
before any run."""

COMBOS = [
    ("baseline", (33, 25, 25, 17)),
    ("recent-only", (100, 0, 0, 0)),
    ("weekday-only", (0, 100, 0, 0)),
    ("dte-only", (0, 0, 100, 0)),
    ("vix-only", (0, 0, 0, 100)),
    ("equal", (25, 25, 25, 25)),
    ("no-recent", (0, 33, 33, 34)),
    ("no-vix", (40, 30, 30, 0)),
    ("no-weekday", (40, 0, 30, 30)),
    ("no-dte", (40, 30, 0, 30)),
    ("recent+dte", (50, 0, 50, 0)),
    ("recent+weekday", (50, 50, 0, 0)),
    ("recent+vix", (50, 0, 0, 50)),
    ("calendar-only", (0, 50, 50, 0)),
    ("recent-heavy", (60, 13, 14, 13)),
    ("recent-light", (15, 28, 28, 29)),
]
