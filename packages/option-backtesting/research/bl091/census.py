"""BL-091 Phase 1: the episode census on P2 + P3 (E.2, E.4). Counts only; no rule is chosen here.

    uv run --with pandas python research/bl091/census.py [--days N] [--workers 4]
    uv run --with pandas python research/bl091/census.py --day 2025-03-05 --underlying NIFTY

Writes out/episodes.csv (one row per episode) and out/days.csv (one row per index-day, including
the days skipped and why). `--day` prints one day's minute table instead (for inspection).
"""

from __future__ import annotations

import argparse
import csv
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

from episodes import Episode, scan_episodes
from periods import (
    M_1500,
    M_1512,
    M_1528,
    UNDERLYINGS,
    assert_learning_day,
    learning_days,
    period_of,
)
from series import (
    ChainDay,
    Rolling,
    Spliced,
    level,
    load_chain_day,
    rolling_straddle,
    splice,
    stale_mask,
)

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import minute_label
from option_backtesting.rotation.attrs import vix_open_from_lake
from option_backtesting.rotation.score import dte_label, vix_band

HERE = Path(__file__).parent
OUT = HERE / "out"

DAY_COLUMNS = [
    "period", "underlying", "day", "status", "reason", "expiry", "dte", "vix_open", "vix_band",
    "n_episodes", "n_switches", "stale_minutes", "missing_minutes", "defined_minutes", "level_change",
    "spliced_change",
]  # fmt: skip
EPISODE_COLUMNS = [
    "period", "underlying", "day", "episode_idx", "expiry", "dte", "dte_label", "vix_open",
    "vix_band", "start_min", "start", "trigger_min", "trigger", "trigger_hour", "high_min", "high",
    "high_hour", "first_pause_min", "first_pause", "decay_min", "decay", "end_min", "end",
    "end_reason", "outcome", "n_pauses", "low_x", "high_x", "rise", "rise_at_trigger", "trough_x",
    "giveback", "end_x", "straddle_start", "straddle_trigger", "straddle_high", "straddle_end",
    "atm_trigger", "spot_start", "spot_trigger", "spot_high", "spot_1528", "rise_dir",
    "spot_move_rise", "spot_move_after", "spot_path", "n_switches",
    "stale_minutes", "missing_minutes", "late_trigger", "settlement_window",
]  # fmt: skip


def _label(m: int | None) -> str:
    return minute_label(m) if m is not None else ""


def spot_path(spot: list[float | None], ep: Episode, step: float) -> dict:
    s0, sh, se = spot[ep.start_min], spot[ep.high_min], spot[M_1528]
    out = {"rise_dir": "", "spot_move_rise": None, "spot_move_after": None, "spot_path": ""}
    if s0 is None or sh is None or se is None:
        return out
    rise_move, after = sh - s0, se - sh
    rise_dir = "flat" if abs(rise_move) < step else ("up" if rise_move > 0 else "down")
    sign = (rise_move > 0) - (rise_move < 0)
    if abs(after) < step:
        path = "stalled"
    elif sign == 0:
        path = "moved"
    else:
        path = "continued" if (after > 0) == (sign > 0) else "reversed"
    return {"rise_dir": rise_dir, "spot_move_rise": round(rise_move, 2),
            "spot_move_after": round(after, 2), "spot_path": path}  # fmt: skip


def episode_row(
    period: str, chain: ChainDay, rolling: Rolling, sp: Spliced, stale: list[bool],
    ep: Episode, idx: int, attrs: dict,
) -> dict:  # fmt: skip
    span = range(ep.start_min, ep.end_min + 1)
    s = rolling.s
    row = {
        "period": period, "underlying": chain.underlying, "day": chain.day.isoformat(),
        "episode_idx": idx, **attrs,
        "start_min": ep.start_min, "start": _label(ep.start_min),
        "trigger_min": ep.trigger_min, "trigger": _label(ep.trigger_min),
        "trigger_hour": _label(ep.trigger_min)[:2],
        "high_min": ep.high_min, "high": _label(ep.high_min), "high_hour": _label(ep.high_min)[:2],
        "first_pause_min": ep.first_pause_min, "first_pause": _label(ep.first_pause_min),
        "decay_min": ep.decay_min, "decay": _label(ep.decay_min),
        "end_min": ep.end_min, "end": _label(ep.end_min), "end_reason": ep.end_reason,
        "outcome": ep.outcome, "n_pauses": ep.n_pauses,
        "low_x": round(ep.low_x, 2), "high_x": round(ep.high_x, 2),
        "rise": round(ep.high_x - ep.low_x, 2), "rise_at_trigger": round(ep.rise_at_trigger, 2),
        "trough_x": round(ep.trough_x, 2) if ep.trough_x is not None else None,
        "giveback": round(ep.high_x - ep.trough_x, 2) if ep.trough_x is not None else None,
        "end_x": round(ep.end_x, 2),
        "straddle_start": s[ep.start_min], "straddle_trigger": s[ep.trigger_min],
        "straddle_high": s[ep.high_min], "straddle_end": s[ep.end_min],
        "atm_trigger": rolling.atm[ep.trigger_min],
        "spot_start": chain.spot[ep.start_min], "spot_trigger": chain.spot[ep.trigger_min],
        "spot_high": chain.spot[ep.high_min], "spot_1528": chain.spot[M_1528],
        **spot_path(chain.spot, ep, chain.step),
        "n_switches": sum(sp.switch[m] for m in span),
        "stale_minutes": sum(stale[m] for m in span),
        "missing_minutes": sum(sp.missing[m] for m in span),
        "late_trigger": ep.trigger_min >= M_1512,
        # expiry day from 15:00: options price the settlement average, not the live index, so the
        # index-ATM pair is not at the money (SENSEX 2025-01-14 15:21: 76600 PE at 98, index 76580)
        "settlement_window": attrs["dte"] == 0 and ep.trigger_min >= M_1500,
    }  # fmt: skip
    return row


def day_work(task: tuple[str, str, str]) -> tuple[dict, list[dict]]:
    period, underlying, day_s = task
    day = date.fromisoformat(day_s)
    assert_learning_day(underlying, day)
    base = {c: None for c in DAY_COLUMNS}
    base.update(period=period, underlying=underlying, day=day_s)
    if day.weekday() >= 5:
        return {**base, "status": "skipped", "reason": "weekend special session"}, []
    root = data_dir()
    try:
        chain = load_chain_day(root, underlying, day)
    except (FileNotFoundError, LookupError) as e:
        return {**base, "status": "skipped", "reason": f"{type(e).__name__}: {e}"}, []
    rolling = rolling_straddle(chain)
    sp = level(rolling)
    spliced = splice(rolling, chain)  # diagnostic only: its drift is why `level` is the series
    stale = stale_mask(rolling.pair_real)
    vix = vix_open_from_lake(root, day)
    dte = (chain.expiry - day).days
    attrs = {"expiry": chain.expiry.isoformat(), "dte": dte, "dte_label": dte_label(dte),
             "vix_open": vix, "vix_band": vix_band(vix)}  # fmt: skip
    window = range(5, M_1528 + 1)
    defined = sum(rolling.s[m] is not None for m in window)
    if defined == 0:
        return {**base, **{k: attrs[k] for k in ("expiry", "dte", "vix_open", "vix_band")},
                "status": "skipped", "reason": "no priced ATM pair all day"}, []  # fmt: skip
    episodes = scan_episodes(sp.x)
    rows = [episode_row(period, chain, rolling, sp, stale, ep, i, attrs)
            for i, ep in enumerate(episodes)]  # fmt: skip
    summary = {
        **base, **{k: attrs[k] for k in ("expiry", "dte", "vix_open", "vix_band")},
        "status": "loaded", "reason": "", "n_episodes": len(episodes),
        "n_switches": sum(sp.switch[m] for m in window),
        "level_change": round(sp.x[M_1528] - sp.x[5], 2),
        "spliced_change": round(spliced.x[M_1528], 2),
        "stale_minutes": sum(stale[m] for m in window),
        "missing_minutes": sum(sp.missing[m] for m in window),
        "defined_minutes": defined,
    }  # fmt: skip
    return summary, rows


def tasks(limit: int | None) -> tuple[list[tuple[str, str, str]], list[dict]]:
    root = data_dir()
    out: list[tuple[str, str, str]] = []
    excluded: list[dict] = []
    for period, unds in UNDERLYINGS.items():
        for und in unds:
            days, skipped = learning_days(root, und, period)
            out += [(period, und, d.isoformat()) for d in (days[:limit] if limit else days)]
            for d, why in sorted(skipped.items()):
                if period_of(und, d) == period:
                    row = {c: None for c in DAY_COLUMNS}
                    row.update(period=period, underlying=und, day=d.isoformat(),
                               status="skipped", reason=why)  # fmt: skip
                    excluded.append(row)
    return out, excluded


def show_day(underlying: str, day: date) -> None:
    chain = load_chain_day(data_dir(), underlying, day)
    rolling = rolling_straddle(chain)
    sp = level(rolling)
    print(f"{underlying} {day} expiry {chain.expiry} rows {chain.n_rows}")
    print("time  spot      atm      straddle  x       flags")
    for m in range(5, M_1528 + 1):
        flags = "".join(f for f, on in (("S", sp.switch[m]), ("F", sp.fallback[m]),
                                         ("M", sp.missing[m])) if on)  # fmt: skip
        print(f"{minute_label(m)} {chain.spot[m]!s:9} {rolling.atm[m]!s:8} {rolling.s[m]!s:9} "
              f"{sp.x[m]:7.2f} {flags}")  # fmt: skip
    for i, ep in enumerate(scan_episodes(sp.x)):
        print(i, ep)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=None, help="first N days per period (smoke run)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--day")
    ap.add_argument("--underlying", default="NIFTY")
    a = ap.parse_args()
    if a.day:
        show_day(a.underlying, date.fromisoformat(a.day))
        return 0
    todo, excluded = tasks(a.days)
    print(
        f"{len(todo)} index-days to scan, {len(excluded)} excluded by data_quality", file=sys.stderr
    )
    days_rows: list[dict] = list(excluded)
    ep_rows: list[dict] = []
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        for i, (summary, rows) in enumerate(pool.map(day_work, todo, chunksize=4)):
            days_rows.append(summary)
            ep_rows += rows
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(todo)} days, {len(ep_rows)} episodes", file=sys.stderr)
    OUT.mkdir(exist_ok=True)
    days_rows.sort(key=lambda r: (r["period"], r["underlying"], r["day"]))
    with open(OUT / "days.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=DAY_COLUMNS)
        w.writeheader()
        w.writerows(days_rows)
    with open(OUT / "episodes.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=EPISODE_COLUMNS)
        w.writeheader()
        w.writerows(ep_rows)
    loaded = sum(r["status"] == "loaded" for r in days_rows)
    print(f"done: {loaded} days loaded, {len(days_rows) - loaded} skipped, {len(ep_rows)} episodes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
