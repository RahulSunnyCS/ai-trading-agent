"""BL-132: book MTM stop levels that leave 85 / 90 / 93 / 95 % of days untouched.

As registered in backlog/BL-132. Reads BL-131's replayed minute paths (its git-ignored cache, path given by
BL131_PATHS or the default below) and the live store, read-only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl132/day_lows.py
"""

from __future__ import annotations

import json
import math
import os
import pickle
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, portfolio
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import track_names, variant_names

HERE = Path(__file__).parent
PATHS = Path(os.environ.get("BL131_PATHS", HERE.parent / "bl131" / "results" / "paths.pkl"))
CALIBRATE = (date(2025, 1, 10), date(2025, 10, 8))
TEST = (date(2025, 10, 9), date(2026, 10, 16))
WHOLE = (CALIBRATE[0], TEST[1])
PCTS = (85, 90, 93, 95)
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261024, 0.90


def picks_by_day(root: Path, names: list[str]) -> dict[date, list[str]]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    return {d: rec.picks(d)["C"]["core"] for d in rec.days_available() if WHOLE[0] <= d <= WHOLE[1]}


def level(lows: np.ndarray, p: int) -> float:
    """The p-th percentile day low, rounded up to the next ₹500."""
    # "higher": an observed day low, so the level is reached on at most (100 - p) % of days (registered rule)
    return float(math.ceil(np.percentile(lows, p, method="higher") / 500.0) * 500)


def main() -> None:
    root = data_dir()
    paths = pickle.loads(PATHS.read_bytes())
    report: dict = {"calibrate": [str(d) for d in CALIBRATE], "test": [str(d) for d in TEST]}
    for book, names in (
        ("core_298", variant_names()),
        ("t1", [*variant_names(), *track_names("t1")]),
    ):
        members_by_day = {}
        for d, ps in picks_by_day(root, names).items():
            lots = Counter(ps)
            members_by_day[d] = [portfolio.Member(n, k, paths[(d, n)]) for n, k in lots.items()]
        days = sorted(members_by_day)
        low = {
            d: max(0.0, -min(portfolio.apply_book(members_by_day[d], None).combined)) for d in days
        }
        cal = [d for d in days if CALIBRATE[0] <= d <= CALIBRATE[1]]
        test = [d for d in days if TEST[0] <= d <= TEST[1]]
        cal_lows = np.array([low[d] for d in cal])
        out = {
            "days": {"calibrate": len(cal), "test": len(test)},
            "percentiles": {
                span: {
                    str(p): float(np.percentile(np.array([low[d] for d in ds]), p)) for p in PCTS
                }
                for span, ds in (("calibrate", cal), ("test", test), ("whole", days))
            },
        }
        none = np.array([portfolio.apply_book(members_by_day[d], None).gross_with for d in test])
        out["test_no_stop"] = {
            "per_day": float(none.mean()),
            "max_drawdown": max_drawdown(none),
            "worst_day": float(none.min()),
        }
        for p in PCTS:
            lvl = level(cal_lows, p)
            res = [portfolio.apply_book(members_by_day[d], lvl) for d in test]
            withs = np.array([r.gross_with for r in res])
            hit = np.array([r.stop_minute is not None for r in res])
            diff = withs - none
            m, lo, hi = block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
            out[str(p)] = {
                "level": lvl,
                "calibrate_hit_rate": float((cal_lows >= lvl).mean()),
                "test_hit_rate": float(hit.mean()),
                "target_hit_rate": (100 - p) / 100,
                "holds": bool(abs(hit.mean() - (100 - p) / 100) <= 0.02),
                "per_day": float(withs.mean()),
                "diff_per_day": m,
                "ci90": [lo, hi],
                "positive": bool(lo > 0),
                "max_drawdown": max_drawdown(withs),
                "worst_day": float(withs.min()),
                "protective": bool(
                    max_drawdown(withs) > max_drawdown(none) and withs.min() > none.min()
                ),
            }
        report[book] = out
    (HERE / "day_lows_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for book in ("core_298", "t1"):
        r = report[book]
        print(
            f"== {book} days {r['days']}  no stop (test): {r['test_no_stop']['per_day']:+.0f}/day DD {r['test_no_stop']['max_drawdown']:,.0f} worst {r['test_no_stop']['worst_day']:,.0f}"
        )
        for span in ("calibrate", "test", "whole"):
            print(
                f"   day-low percentiles {span:9}: "
                + "  ".join(f"P{p} {r['percentiles'][span][str(p)]:,.0f}" for p in PCTS)
            )
        for p in PCTS:
            x = r[str(p)]
            print(
                f"   P{p}: stop {x['level']:,.0f} | hit cal {x['calibrate_hit_rate']:.1%} test {x['test_hit_rate']:.1%} (target {x['target_hit_rate']:.0%}, holds {x['holds']}) "
                f"| {x['per_day']:+.0f}/day diff {x['diff_per_day']:+.0f} [{x['ci90'][0]:+.0f},{x['ci90'][1]:+.0f}] | DD {x['max_drawdown']:,.0f} worst {x['worst_day']:,.0f}"
            )


if __name__ == "__main__":
    main()
