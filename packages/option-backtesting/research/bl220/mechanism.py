"""BL-220 Phase 1: is Friday worse than the other weekdays on hold-out A (NIFTY 2022-04-05 -> 2024-10-08)?

Reads BL-071's per-day results of the 124 NIFTY variants (research/bl071/results/*.csv, gross with
costs 0, no slippage) and BL-214's day labels and quality snapshot (TRADING_DATA_ROOT/_bl214/). Per
session, the mean over the variants with a result that day; Friday sessions against every other weekday
session. Registered test (BL-220 Phase 0): pass if (other - Friday) >= Rs 100 and the one-sided p <= 0.05,
p = share of 2,000 circular 5-day block-bootstrap resamples of the session series (labels kept with their
sessions, seed 20261112) whose gap is <= 0. Everything else printed is descriptive.

    uv run python research/bl220/mechanism.py --results <dir of BL-071 results>
"""

from __future__ import annotations

import argparse
import collections
import csv
import math
import re
import statistics as st
from datetime import date
from pathlib import Path

import numpy as np
from trading_data.quality import excluded_days

from option_backtesting.fyers.daily import data_dir

FIRST, LAST = date(2022, 4, 5), date(2024, 10, 8)
GAP_MIN, P_MAX, RESAMPLES, BLOCK, SEED = 100.0, 0.05, 2000, 5, 20261112
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]


def family(stem: str) -> str:
    token = re.match(r"(?:N_)?([a-z]+\d*)_\d{4}$", stem).group(1)
    return {"wide": "Widesl", "dir": "Dir ATM", "buy": "Buy"}.get(
        token, "Widesl" if token.startswith("p") else token
    )


def gap_of(values: np.ndarray, is_fri: np.ndarray) -> float:
    return float(values[~is_fri].mean() - values[is_fri].mean())


def bootstrap_p(values: np.ndarray, is_fri: np.ndarray) -> tuple[float, tuple[float, float]]:
    rng = np.random.default_rng(SEED)
    n = len(values)
    starts_per = math.ceil(n / BLOCK)
    gaps = np.empty(RESAMPLES)
    for i in range(RESAMPLES):
        starts = rng.integers(0, n, starts_per)
        idx = (starts[:, None] + np.arange(BLOCK)[None, :]).ravel()[:n] % n
        gaps[i] = gap_of(values[idx], is_fri[idx])
    return float((gaps <= 0).mean()), (
        float(np.percentile(gaps, 5)),
        float(np.percentile(gaps, 95)),
    )


def mean_se(xs: list[float]) -> str:
    if not xs:
        return "—"
    se = st.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else math.nan
    return f"{st.mean(xs):,.0f} ± {se:,.0f} ({len(xs)})"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, required=True)
    args = ap.parse_args()
    root = data_dir() / "_bl214"
    with open(root / "rotation" / "days.csv") as fh:
        labels = {r["day"]: r for r in csv.DictReader(fh)}
    excluded = excluded_days(root, "option", "NIFTY") or {}

    per_day: dict[str, dict[str, float]] = collections.defaultdict(dict)
    files = sorted(args.results.glob("*.csv"))
    if len(files) != 124:  # the registered universe (BL-220 Phase 0): stop rather than test a subset
        raise SystemExit(f"expected BL-071's 124 NIFTY variants, found {len(files)}")
    for f in files:
        with open(f) as fh:
            for r in csv.DictReader(fh):
                per_day[r["day"]][f.stem] = float(r["net"])
    days = sorted(
        d
        for d in per_day
        if FIRST <= date.fromisoformat(d) <= LAST
        and date.fromisoformat(d).weekday() < 5
        and d in labels
        and date.fromisoformat(d) not in excluded
    )
    missing_labels = sorted(
        d for d in per_day if FIRST <= date.fromisoformat(d) <= LAST and d not in labels
    )
    print(
        f"variants {len(files)}; sessions {len(days)} ({days[0]} -> {days[-1]}); "
        f"excluded by quality {sum(1 for d in per_day if date.fromisoformat(d) in excluded)}; "
        f"no label {len(missing_labels)}"
    )

    near = [d for d in days if labels[d]["weekday"] == "Fri" and labels[d]["dte_n"] in ("0", "1")]
    test_days = [d for d in days if d not in near]
    values = np.array([st.mean(per_day[d].values()) for d in test_days])
    is_fri = np.array([labels[d]["weekday"] == "Fri" for d in test_days])
    gap = gap_of(values, is_fri)
    p, band = bootstrap_p(values, is_fri)
    verdict = "PASS" if gap >= GAP_MIN and p <= P_MAX else "KILL"
    print(
        f"\nREGISTERED TEST: Friday {values[is_fri].mean():,.0f} ({is_fri.sum()} sessions) vs other "
        f"{values[~is_fri].mean():,.0f} ({(~is_fri).sum()}); gap {gap:,.0f} (bar {GAP_MIN:,.0f}); "
        f"one-sided p {p:.3f} (bar {P_MAX}); 90% band of the gap {band[0]:,.0f} .. {band[1]:,.0f} -> {verdict}"
    )
    print(f"Fridays left out (within 1 weekday of expiry): {near or 'none'}")

    print("\nDescriptive (not part of the verdict): session mean ± SE (sessions)")
    by_w = collections.defaultdict(list)
    for d, v in zip(test_days, values, strict=True):
        by_w[labels[d]["weekday"]].append(v)
    print("weekday: " + " | ".join(f"{w} {mean_se(by_w[w])}" for w in DAYS))
    for fam in ("Widesl", "Dir ATM", "Buy"):
        row = []
        for w in DAYS:
            xs = [
                st.mean(v for s, v in per_day[d].items() if family(s) == fam)
                for d in test_days
                if labels[d]["weekday"] == w and any(family(s) == fam for s in per_day[d])
            ]
            row.append(f"{w} {mean_se(xs)}")
        print(f"{fam}: " + " | ".join(row))
    by_dte = collections.defaultdict(list)
    for d, v in zip(test_days, values, strict=True):
        by_dte[(labels[d]["weekday"], labels[d]["dte_n"])].append(v)
    print(
        "weekday x NIFTY calendar days to expiry: "
        + " | ".join(f"{w} dte {k} {mean_se(v)}" for (w, k), v in sorted(by_dte.items()))
    )
    for year in ("2022", "2023", "2024"):
        fri = [
            v
            for d, v in zip(test_days, values, strict=True)
            if d.startswith(year) and labels[d]["weekday"] == "Fri"
        ]
        oth = [
            v
            for d, v in zip(test_days, values, strict=True)
            if d.startswith(year) and labels[d]["weekday"] != "Fri"
        ]
        print(f"{year}: Friday {mean_se(fri)} | other {mean_se(oth)}")


if __name__ == "__main__":
    main()
