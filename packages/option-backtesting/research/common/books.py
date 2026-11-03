"""Adaptive books for book-rule items (BL-188, BL-189, BL-190): the seen set (BL-185's A0, NIFTY and
SENSEX 2024-10-09 -> 2026-10-27) and the clean set (BL-188's N22, NIFTY 2022-01-03 -> 2024-10-08),
list C's picks and composite per day, and the engine re-runs those items need.

The replay is BL-185's (`two_session/replay.py`): list C's composite on gross over the pool,
`score.select`, 63-day warm-up, no Buy add-on, no expiry-only rule. Per margin lot-day = book / 3.
"""

from __future__ import annotations

import csv
import functools
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "two_session"))
import replay as rp  # noqa: E402
import split_replay as sr  # noqa: E402
from early_ref import early_reference  # noqa: E402

from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day, minute_index  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import LISTS, WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.score import (  # noqa: E402
    composite,
    dte_matrix,
    family_index,
    select,
)
from option_backtesting.ruletest.charges import day_charges, trade_values  # noqa: E402

RESEARCH = HERE.parent
A0 = Path(os.environ.get("BL187_A0") or RESEARCH / "bl185" / "a0")
N22 = RESEARCH / "bl188" / "n22"
N22_DAYS = RESEARCH / "bl188" / "out" / "n22_days.csv"
N22_END = date(2024, 10, 8)
SEEN_P1_END = date(2025, 10, 8)
SEED, GST, MARGIN_LOTS = 20261028, 1.18, 3

__all__ = ["block_bootstrap_mean", "max_drawdown", "minute_index"]


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


def interval(x: np.ndarray, level: float = 0.90) -> tuple[float, float, float]:
    return block_bootstrap_mean(np.asarray(x, dtype=float), seed=SEED, level=level)


def ftxt(x: np.ndarray, level: float = 0.90) -> str:
    m, lo, hi = interval(x, level)
    return f"{fmt(m)} [{fmt(lo)}, {fmt(hi)}]"


def underlying_of(name: str) -> str:
    return "NIFTY" if name.startswith("N_") else "SENSEX"


def slot_of(name: str) -> str:
    return name.rsplit("_", 1)[1]


def slot_index(name: str) -> int:
    """The variant's entry minute as an engine minute index (09:15 = 0)."""
    s = slot_of(name)
    return minute_index(f"{s[:2]}:{s[2:]}")


def strategy_file(name: str) -> Path:
    p = sr.ROTATION / f"{name}.yaml"
    return p if p.exists() else sr.ROTATION.parent / "rotation_t1" / f"{name}.yaml"


@functools.cache
def strategy(name: str):
    return load_legwise(strategy_file(name))


# --- the two sets ---------------------------------------------------------------------------


def seen_set() -> dict:
    attrs = store.read_days(sr.data_dir(), "weekdays")
    pool = rp.pool_from_csv(A0)
    if not pool:
        raise SystemExit(
            f"no A0 CSVs in {A0}: run research/common/two_session/a0.py or set BL187_A0"
        )
    return {
        "attrs": attrs,
        "days_all": sorted(attrs),
        "pools": {"T1": pool, "Core": [s for s in pool if "-t1s" not in s.name]},
        "split": SEEN_P1_END,
    }


def clean_set() -> dict:
    if not N22_DAYS.exists() or not any(N22.glob("*.csv")):
        raise SystemExit("no N22 set: run research/bl188/n22.py simulate and attrs first")
    with open(N22_DAYS) as f:
        attrs = {date.fromisoformat(r["day"]): r for r in csv.DictReader(f)}
    pool = rp.pool_from_csv(N22)
    for s in pool:  # the days after the end were simulated for gate 1 only
        s.rows = {d: v for d, v in s.rows.items() if d <= N22_END}
    return {
        "attrs": attrs,
        "days_all": sorted(attrs),
        "pools": {"T1-N": pool, "Core-N": [s for s in pool if "-t1s" not in s.name]},
        "split": None,  # the middle pick day
    }


def rank_book(pool, attrs, days_all) -> dict:
    """List C's picks and the full composite per pick day (BL-185's replay, keeping the composite)."""
    days = sorted(set.intersection(*(set(s.rows) for s in pool)) & set(attrs) & set(days_all))
    days = [d for d in days if d.weekday() < 5]
    names = [s.name for s in pool]
    G = np.array([[s.rows[d][0] for s in pool] for d in days])
    wd = np.array([attrs[d]["weekday"] for d in days])
    bd = np.array([attrs[d]["vix_band"] for d in days])
    dn = np.array([attrs[d]["dte_n"] for d in days])
    ds = np.array([attrs[d]["dte_s"] for d in days])
    fam = family_index(names)
    comps, picks = {}, {}
    for i in range(WARMUP, len(days)):
        comp = composite(
            G[: i + 1], wd[: i + 1], bd[: i + 1], dte_matrix(dn[: i + 1], ds[: i + 1], names),
            names, LISTS["C"], fam,
        )  # fmt: skip
        comps[days[i]] = comp
        picks[days[i]] = [names.index(n) for n in select(comp, names).core]
    rows = {s.name: s.rows for s in pool}
    return {"days": sorted(picks), "names": names, "comp": comps, "picks": picks, "rows": rows}


def books(which: str) -> tuple[dict, dict]:
    """({book: rank_book(...)}, the set) for which = 'seen' | 'clean'."""
    st = seen_set() if which == "seen" else clean_set()
    out = {k: rank_book(p, st["attrs"], st["days_all"]) for k, p in st["pools"].items()}
    if which == "seen":  # the picks must be BL-185's A0 replay exactly
        for k, p in st["pools"].items():
            ref = rp.replay(p, st["attrs"], st["days_all"])
            assert ref["picks"] == out[k]["picks"], f"{k}: picks differ from BL-185's replay"
    return out, st


def periods(days: list[date], split: date | None) -> np.ndarray:
    """True for the first period: to `split` on the seen set, the first half of the pick days on
    the clean set."""
    if split is None:
        split = days[(len(days) - 1) // 2]
    return np.array([d <= split for d in days])


def row(book: dict, name: str, d: date) -> np.ndarray:
    """(gross, net, orders) of a variant's stored row."""
    g, n, o, _ = book["rows"][name][d]
    return np.array([g, n, o], dtype=float)


# --- engine re-runs -------------------------------------------------------------------------


def run_jobs(jobs, path_of=None):
    """{(name, tag, day): (DayResult, charges)} for jobs (name, tag, day); `path_of(name, tag)`
    gives the strategy file (tag None = the variant as it is). Days are loaded once each."""
    root, ref = sr.data_dir(), early_reference()
    cache: dict = {}
    out = {}
    data_key, data = None, None
    for name, tag, d in sorted(jobs, key=lambda j: (j[2], underlying_of(j[0]), j[0], str(j[1]))):
        u = underlying_of(name)
        if data_key != (u, d):
            data_key, data = (u, d), load_day(root, u, d)
        k = (name, tag)
        if k not in cache:
            if tag is not None and path_of is None:
                raise ValueError(f"job {name} has tag {tag!r} but no path_of was given")
            cache[k] = load_legwise(strategy_file(name) if tag is None else path_of(name, tag))
        r = simulate_day(cache[k], data, ref, sr.SIZING)
        orders, buy, sell = trade_values(r.trades)
        out[(name, tag, d)] = (r, day_charges(u, d.isoformat(), orders, buy, sell).total, orders)
    return out
