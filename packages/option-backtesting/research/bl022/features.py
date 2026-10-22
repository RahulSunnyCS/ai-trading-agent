"""BL-022 Phase 1: the day vector at 10:30 / 11:00 / 12:00 for every NIFTY and SENSEX session, plus
the rest-of-day outcome and the raw values the baselines need. Read-only on the lake; writes only
under this folder.

    uv run --with pandas --with pyarrow python research/bl022/features.py

Writes out/features.parquet: one row per (index, day, check).
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from option_backtesting.rotation.dte import weekdays_between

sys.path.insert(0, str(Path(__file__).parent))
import analog as A  # noqa: E402

OUT = Path(__file__).parent / "out"
INDICES = ("NIFTY", "SENSEX")


def nearest_expiries(c, through: str) -> pd.DataFrame:
    """(underlying, day) -> the nearest listed expiry on or after the day, from contracts_daily.
    Cached (the scan takes about a minute); rebuilt when the cache ends before `through`."""
    path = OUT / "expiries.csv"
    if path.exists():
        cached = pd.read_csv(path, dtype=str)
        if cached.d.max() >= through:
            return cached
    df = c.execute(
        f"""select underlying, date::varchar d, min(expiry)::varchar expiry
            from read_parquet('{A.LAKE}/derived/contracts_daily/**/*.parquet', hive_partitioning=true)
            where underlying in ('NIFTY', 'SENSEX') and expiry >= date
            group by 1, 2 order by 1, 2"""
    ).df()
    df.to_csv(path, index=False)
    return df


def build() -> pd.DataFrame:
    OUT.mkdir(exist_ok=True)
    c = A.con()
    vix = A.load_grid(c, "INDIAVIX")
    vix_ix = {d: i for i, d in enumerate(vix.days)}
    exp = nearest_expiries(c, through=vix.days[-1])
    rows = []
    for und in INDICES:
        g = A.load_grid(c, und)
        atr = A.atr_pct(g)
        e = dict(zip(exp[exp.underlying == und].d, exp[exp.underlying == und].expiry, strict=True))
        dropped = {"partial": 0, "no_atr": 0}
        for i, d in enumerate(g.days):
            if not g.full[i]:
                dropped["partial"] += 1
                continue
            if np.isnan(atr[i]):
                dropped["no_atr"] += 1
                continue
            vi = vix_ix.get(d)
            vix_c = vix.C[vi] if vi is not None else None
            vix_open = vix.O[vi, 0] if vi is not None else None
            dte = (
                weekdays_between(date.fromisoformat(d), date.fromisoformat(e[d]))
                if d in e
                else np.nan
            )
            prev_close = g.C[i - 1, -1]
            for check, tmin in A.CHECKS.items():
                j = tmin - A.OPEN_MIN
                f = A.day_features(
                    g.O[i], g.H[i], g.L[i], g.C[i], tmin, atr[i], prev_close, vix_c, vix_open, dte
                )
                f.update(
                    index=und,
                    day=d,
                    check=check,
                    rod=A.outcome(g.H[i], g.L[i], g.C[i], tmin),
                    rsf_raw=(g.H[i, :j].max() - g.L[i, :j].min()) / g.O[i, 0],
                    minutes_left=A.LAST_OUTCOME_COL + 1 - j,
                    atr_pct=atr[i],
                )
                rows.append(f)
        print(f"{und}: {len(g.days)} sessions, dropped {dropped}", file=sys.stderr)
    df = pd.DataFrame(rows)
    df.to_parquet(OUT / "features.parquet", index=False)
    return df


if __name__ == "__main__":
    df = build()
    for (und, check), g in df.groupby(["index", "check"]):
        print(
            f"{und} {check}: {len(g)} rows {g.day.min()} -> {g.day.max()}; "
            f"no VIX {int(g.vix.isna().sum())}, no DTE {int(g.dte.isna().sum())}; "
            f"rest-of-day range median {g.rod.median():.4f}"
        )
