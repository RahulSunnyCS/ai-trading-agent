"""BL-109: re-score Steady (A) and Adaptive (C) over 2025-10-16..2026-10-15 with the stored
calendar-day DTE labels (older) and with weekday-only labels (newer). Read-only: it reads the
stored results and writes only under this folder. The rule it applies is the item's Phase 0.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl109/rescore.py
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown

OUT = Path(__file__).parent
FROM, TO = date(2025, 10, 16), date(2026, 10, 15)
LISTS = {"A": "Steady", "C": "Adaptive"}
ADOPT_DD_LIMIT = 1.20  # not adopted if Adaptive's drawdown is more than 20% deeper


def summary(values: np.ndarray) -> dict:
    return {
        "days": int(values.size),
        "win_rate": float((values > 0).mean()),
        "mean_per_lot_day": float(values.mean()),
        "cumulative_per_lot": float(values.sum()),
        "max_drawdown_per_lot": max_drawdown(values),
    }


def main() -> None:
    root = data_dir()
    # older: the stored calendar-day labels as written; newer: the weekday basis (store default)
    arms = {
        "older": daylog.reconstruction(root, basis="calendar"),
        "newer": daylog.reconstruction(root, basis="weekdays"),
    }
    assert all(r.error is None for r in arms.values())
    days = [d for d in arms["older"].days_available() if FROM <= d <= TO]
    results = daylog._Results(root)
    rows = []
    series: dict[tuple[str, str], dict[date, float]] = {}
    picks_differ = {key: 0 for key in LISTS}
    for d in days:
        out = {name: daylog.reconstructed_row(d, r, results) for name, r in arms.items()}
        if not all(out.values()):
            continue
        for key in LISTS:
            blocks = {name: out[name]["lists"][key] for name in arms}
            if not all(b["scored"] and b["per_lot_day"] is not None for b in blocks.values()):
                continue
            for name, b in blocks.items():
                series.setdefault((key, name), {})[d] = float(b["per_lot_day"])
            chosen = {
                name: [*r.picks(d)[key]["core"], *r.picks(d)[key]["buy"]]
                for name, r in arms.items()
            }
            picks_differ[key] += 0 if chosen["older"] == chosen["newer"] else 1
            rows.append(
                {
                    "day": d.isoformat(),
                    "list": key,
                    "older": blocks["older"]["per_lot_day"],
                    "newer": blocks["newer"]["per_lot_day"],
                    "picks_older": " ".join(chosen["older"]),
                    "picks_newer": " ".join(chosen["newer"]),
                }
            )
    report: dict = {
        "window": [FROM.isoformat(), TO.isoformat()],
        "data_root": str(root),
        "boot": {"resamples": 2000, "block": 5, "seed": 20261012, "level": 0.9},
        "lists": {},
    }
    for key, name in LISTS.items():
        common = sorted(set(series[(key, "older")]) & set(series[(key, "newer")]))
        old = np.array([series[(key, "older")][d] for d in common])
        new = np.array([series[(key, "newer")][d] for d in common])
        mean, lo, hi = block_bootstrap_mean(new - old)
        half = len(common) // 2
        report["lists"][name] = {
            "older": summary(old),
            "newer": summary(new),
            "newer_minus_older": {"mean": mean, "lo90": lo, "hi90": hi},
            "days_with_different_picks": picks_differ[key],
            "first_half": {
                "older": summary(old[:half]),
                "newer": summary(new[:half]),
                "to": common[half - 1].isoformat(),
            },
            "second_half": {"older": summary(old[half:]), "newer": summary(new[half:])},
        }
    a = report["lists"]["Adaptive"]
    worse = a["newer_minus_older"]["hi90"] < 0
    # drawdowns are non-positive: "more than 20% deeper" means newer < older * 1.2
    deeper = (
        a["newer"]["max_drawdown_per_lot"] < a["older"]["max_drawdown_per_lot"] * ADOPT_DD_LIMIT
    )
    report["decision"] = {
        "interval_entirely_below_zero": worse,
        "drawdown_more_than_20pct_deeper": deeper,
        "adopt": not (worse or deeper),
    }
    (OUT / "rescore_2026-10-15.json").write_text(json.dumps(report, indent=1) + "\n")
    import csv

    with (OUT / "rescore_daily_2026-10-15.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
