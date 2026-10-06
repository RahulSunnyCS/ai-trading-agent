"""Worst circuit (LC / UC) situations a Broad Momentum backtest actually walked into.

Display only: this reads a finished `Result` and the daily bars, and changes nothing about what
the backtest bought, so it works with the tradability filter off (that is the point -- it shows
what the ungated strategy would have run into).

For every period the backtest held a stock, the daily bars inside it are scanned for closes at a
price-band edge (1.9-2%, 4.9-5%, 9.9-10%, 19.9-20% from the previous close; bhavcopy carries no
band data, so this is inferred). Consecutive same-direction band-edge closes form a *run*:

  * lower-circuit (LC) run -- a falling stock nobody would buy, so a holding could not be sold;
  * upper-circuit (UC) run -- a rising stock nobody would sell, so it could not be bought.

A run that covers the entry day (UC) or the exit day (LC) is flagged: the backtest filled at that
close, which in real life would have been unfillable.

For lower circuits the more useful question is whether the strategy was *already out* when the
lock began. Every LC run of at least `MIN_LOCK_DAYS` sessions on a stock held within
`ESCAPE_WINDOW_DAYS` before it is classified as TRAPPED (held when it began) or ESCAPED (sold
shortly before it began), with how many days of notice the strategy had.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from trading_data.db import connect, data_root

from ..engine import IDLE, Result

#: Same four close-to-close bands as categories/liquidity.py.
_BANDS = ((0.019, 0.0205), (0.049, 0.0505), (0.099, 0.1005), (0.199, 0.2005))
_BAND_LABELS = (0.02, 0.05, 0.10, 0.20)
_EPS = 1e-9
#: A band-edge run counts as a *lock* (nobody on the other side) from this many sessions on, the
#: owner's own rule. Used for the "respect circuit locks" backtest mode and the blocked-fill counts;
#: a single 2% or 5% close is an ordinary move, not a lock.
LOCK_MIN_DAYS = 3
#: An LC run shorter than this is an ordinary bad day, not a lock worth classifying.
MIN_LOCK_DAYS = 2
#: A stock sold up to this long before an LC run began counts as "got out in time".
ESCAPE_WINDOW_DAYS = 56


def _band_sql() -> str:
    return " or ".join(f"abs(r) between {lo} and {hi}" for lo, hi in _BANDS)


_mask_cache: dict[tuple, tuple[pd.DataFrame, pd.DataFrame]] = {}


def lock_masks(
    column_to_base: dict[str, str],
    weeks: pd.Index,
    *,
    min_days: int = LOCK_MIN_DAYS,
    root: Path | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(uc_locked, lc_locked): week x column booleans, True when the stock's last session of
    that week (the day a weekly trade fills) sits inside a same-direction band-edge run of at
    least `min_days` sessions. The whole run counts, from its first day, because that is known
    only in hindsight -- which is the point: this is a what-would-have-been-impossible check,
    not something a live rule could see coming.

    Both are also True in a week the stock did not trade at all, between its first and last
    session (a suspension, or FORCEMOT's 3.5 months off NSE in 2023-24): with no session there
    is nobody to buy from or sell to, and the only price is a stale one."""
    from .. import db_read  # noqa: PLC0415 (avoid an import cycle at module load)

    symbols = sorted(set(column_to_base.values()))
    key = (db_read.data_version(root), tuple(symbols), tuple(weeks), min_days)
    hit = _mask_cache.get(key)
    if hit is not None:
        return hit
    n = int(min_days)
    sql = f"""
    with d as (
      select i.symbol, b.date, b.close / nullif(b.prevclose, 0) - 1 as r
      from bars_1d_stock b join instruments i using (instrument_id)
      where i.symbol in (select unnest(?)) and b.series = 'EQ' and b.date >= ?),
    h as (select *, case when {_band_sql()} then sign(r) else 0 end as hit from d),
    c as (select *, lag(hit) over (partition by symbol order by date) as lh from h),
    g as (
      select *, sum(case when hit is distinct from lh then 1 else 0 end)
                over (partition by symbol order by date) as grp from c),
    t as (
      select *, count(*) over (partition by symbol, grp) as run_total from g where hit <> 0)
    select symbol, (date_trunc('week', date) + interval 4 day)::date as wk,
           arg_max(case when hit = 1 and run_total >= {n} then 1 else 0 end, date) as up,
           arg_max(case when hit = -1 and run_total >= {n} then 1 else 0 end, date) as down
    from (
      select d2.symbol, d2.date, coalesce(t.hit, 0) as hit, t.run_total
      from d d2 left join t on t.symbol = d2.symbol and t.date = d2.date)
    group by 1, 2"""
    start = (pd.Timestamp(weeks.min()) - pd.Timedelta(days=14)).date()
    traded_sql = """
    select i.symbol, cast(b.date + ((5 - dayofweek(b.date) + 7) % 7) * interval 1 day as date) as wk
    from bars_1d_stock b join instruments i using (instrument_id)
    where i.symbol in (select unnest(?)) group by 1, 2"""
    with connect(root or data_root(), read_only=True) as con:
        frame = con.execute(sql, [symbols, start]).df()
        traded = con.execute(traded_sql, [symbols]).df()
    frame["wk"] = pd.to_datetime(frame["wk"])
    traded["wk"] = pd.to_datetime(traded["wk"])
    # Weeks ending Friday in which the stock had any session, in any series.
    active = (
        traded.assign(on=True)
        .pivot_table(index="wk", columns="symbol", values="on", aggfunc="max")
        .reindex(columns=symbols)
    )
    listed = active.ffill().notna() & active.bfill().notna()  # between first and last session
    halted = (listed & active.isna()).reindex(index=weeks).fillna(False).astype(bool)
    out = []
    for field in ("up", "down"):
        wide = frame.pivot_table(index="wk", columns="symbol", values=field, aggfunc="max")
        wide = wide.reindex(index=weeks, columns=symbols).fillna(0).astype(bool) | halted
        out.append(pd.DataFrame({col: wide[base] for col, base in column_to_base.items()}))
    if len(_mask_cache) > 4:
        _mask_cache.clear()
    _mask_cache[key] = (out[0], out[1])
    return out[0], out[1]


def holding_periods(result: Result, column_to_base: dict[str, str]) -> pd.DataFrame:
    """One row per unbroken holding of a stock: base symbol, first week held (buy day), the week it
    was sold (the Friday after the last held week), and the largest portfolio share it reached."""
    weights = result.weights.drop(columns=[IDLE], errors="ignore")
    weeks = list(weights.index)
    rows: list[dict] = []
    for column in weights.columns:
        base = column_to_base.get(column)
        if base is None:
            continue
        held = weights[column].to_numpy() > _EPS
        i = 0
        while i < len(weeks):
            if not held[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(weeks) and held[j + 1]:
                j += 1
            rows.append(
                {
                    "symbol": base,
                    "buy": weeks[i],
                    "sell": weeks[j + 1] if j + 1 < len(weeks) else None,
                    "peak_share": float(weights[column].iloc[i : j + 1].max()),
                    "share_by_week": weights[column].iloc[i : j + 1],
                }
            )
            i = j + 1
    return pd.DataFrame(rows)


def _between(frame: pd.DataFrame, start: pd.Timestamp | None, end: pd.Timestamp | None):
    """The rows dated from `start` to `end`, both inclusive (None = no limit). A stock's bars come
    sorted by date, so this is a slice found by bisection rather than a comparison of every row,
    which was a fifth of the circuit card's time; an unsorted frame gets the comparison."""
    dates = frame["date"]
    if not dates.is_monotonic_increasing:
        keep = pd.Series(True, index=frame.index)
        if start is not None:
            keep &= dates >= start
        if end is not None:
            keep &= dates <= end
        return frame[keep]
    low = 0 if start is None else int(dates.searchsorted(start, side="left"))
    high = len(frame) if end is None else int(dates.searchsorted(end, side="right"))
    return frame.iloc[low:high]


def _runs(bars: pd.DataFrame) -> list[dict]:
    """Same-direction band-edge runs inside one stock's already-windowed daily bars.

    A run is consecutive sessions that each closed on a band edge in the same direction; a session
    that closed anywhere else, or on the other side, ends it. Every bar is classified at once and
    only the (few) edge sessions are walked: this used to test each of a stock's thousands of bars
    in a Python loop, which was most of the circuit card's time (BL-005 Phase 3)."""
    if bars.empty:
        return []
    move = bars["move"].to_numpy(dtype=float)
    size = np.abs(move)
    band = np.full(len(move), np.nan)
    for (low, high), label in zip(_BANDS, _BAND_LABELS, strict=True):  # the bands do not overlap
        band[(size >= low) & (size <= high)] = label
    sign = np.where(np.isnan(band), 0, np.where(move > 0, 1, -1))
    edge = np.flatnonzero(sign != 0)
    if not len(edge):
        return []
    # A new run starts at an edge session unless the session just before it was an edge session
    # in the same direction.
    starts = np.ones(len(edge), dtype=bool)
    starts[1:] = (edge[1:] != edge[:-1] + 1) | (sign[edge[1:]] != sign[edge[:-1]])
    first = np.flatnonzero(starts)
    last = [*first[1:], len(edge)]
    dates = bars["date"]
    out: list[dict] = []
    for begin, stop in zip(first, last, strict=True):
        members = edge[begin:stop]
        cumulative = 1.0
        for k in members:  # in order, one multiplication at a time, as the loop always did
            cumulative *= 1 + float(move[k])
        out.append(
            {
                "start": dates.iloc[members[0]],
                "end": dates.iloc[members[-1]],
                "days": len(members),
                "direction": "UC" if sign[members[0]] > 0 else "LC",
                "band": float(band[members].max()),
                "move": cumulative - 1,
            }
        )
    return out


def _realised_move(frame: pd.DataFrame, start: pd.Timestamp, until: pd.Timestamp) -> float:
    """Compounded close-to-close move from the first locked day through `until` (inclusive)."""
    window = _between(frame, start, until).dropna(subset=["move"])
    value = 1.0
    for move in window["move"]:
        value *= 1 + float(move)
    return value - 1


def lc_outcomes(
    by_symbol: dict[str, pd.DataFrame], periods: pd.DataFrame, last_day: pd.Timestamp
) -> dict:
    """Classify each lower-circuit run on a stock the strategy held shortly before or during it."""
    trapped: list[dict] = []
    escaped: list[dict] = []
    for symbol, held in periods.groupby("symbol"):
        frame = by_symbol.get(symbol)
        if frame is None:
            continue
        spans = [
            (
                pd.Timestamp(p.buy),
                last_day if pd.isna(p.sell) else pd.Timestamp(p.sell),
                bool(pd.isna(p.sell)),
                p.share_by_week,
            )
            for p in held.itertuples()
        ]
        first_buy = min(buy for buy, *_ in spans)
        scan = _between(frame, first_buy - pd.Timedelta(days=ESCAPE_WINDOW_DAYS), None)
        for run in _runs(scan.dropna(subset=["move"]).reset_index(drop=True)):
            if run["direction"] != "LC" or run["days"] < MIN_LOCK_DAYS:
                continue
            start, end = run["start"], run["end"]
            base = {
                "symbol": symbol,
                "start": f"{start:%Y-%m-%d}",
                "end": f"{end:%Y-%m-%d}",
                "days": run["days"],
                "band_pct": round(run["band"] * 100),
                "move_pct": round(run["move"] * 100, 1),
            }
            inside = next((sp for sp in spans if sp[0] <= start <= sp[1]), None)
            if inside is not None:
                buy, sell, still_held, shares = inside
                prior = shares.index[shares.index <= start]
                share = float(shares.loc[prior[-1]]) if len(prior) else float(shares.iloc[0])
                exit_kind = (
                    "still_held" if still_held else "sold_during" if sell <= end else "sold_after"
                )
                realised = _realised_move(frame, start, sell)
                trapped.append(
                    {
                        **base,
                        "exit": exit_kind,
                        "exit_date": None if still_held else f"{sell:%Y-%m-%d}",
                        "realised_move_pct": round(realised * 100, 1),
                        "portfolio_share_pct": round(share * 100, 1),
                        "portfolio_impact_pct": round(share * realised * 100, 2),
                    }
                )
                continue
            before = [
                sp for sp in spans if not sp[2] and 0 < (start - sp[1]).days <= ESCAPE_WINDOW_DAYS
            ]
            if before:
                buy, sell, _, shares = max(before, key=lambda sp: sp[1])
                share = float(shares.iloc[-1])
                escaped.append(
                    {
                        **base,
                        "exit_date": f"{sell:%Y-%m-%d}",
                        "days_before": int((start - sell).days),
                        "portfolio_share_pct": round(share * 100, 1),
                        "avoided_impact_pct": round(share * run["move"] * 100, 2),
                    }
                )
    return {"trapped": trapped, "escaped": escaped}


def circuit_exposure(
    result: Result,
    column_to_base: dict[str, str],
    *,
    top: int = 5,
    root: Path | None = None,
) -> dict:
    periods = holding_periods(result, column_to_base)
    if periods.empty:
        return {
            "positions": 0,
            "touched": 0,
            "lc": [],
            "uc": [],
            "lc_escaped": [],
            "lc_trapped_count": 0,
            "lc_escaped_count": 0,
            "lc_trapped_sold_during": 0,
        }

    last_day = pd.Timestamp(result.weights.index[-1]) + pd.Timedelta(days=7)
    first_day = pd.Timestamp(periods["buy"].min()) - pd.Timedelta(days=10)
    symbols = sorted(periods["symbol"].unique())
    with connect(root or data_root(), read_only=True) as con:
        bars = con.execute(
            "SELECT i.symbol, b.date, b.close / NULLIF(b.prevclose, 0) - 1 AS move "
            "FROM bars_1d_stock b JOIN instruments i USING (instrument_id) "
            "WHERE i.symbol IN (SELECT unnest(?)) AND b.series = 'EQ' "
            "AND b.date BETWEEN ? AND ? ORDER BY i.symbol, b.date",
            [symbols, first_day.date(), last_day.date()],
        ).df()
    bars["date"] = pd.to_datetime(bars["date"])
    by_symbol = {sym: grp.reset_index(drop=True) for sym, grp in bars.groupby("symbol")}

    episodes: list[dict] = []
    touched = 0
    for period in periods.itertuples():
        frame = by_symbol.get(period.symbol)
        if frame is None:
            continue
        buy = pd.Timestamp(period.buy)
        sell = last_day if pd.isna(period.sell) else pd.Timestamp(period.sell)
        window = _between(frame, buy, sell).dropna(subset=["move"])
        runs = _runs(window)
        if runs:
            touched += 1
        shares = period.share_by_week
        for run in runs:
            share_idx = shares.index[shares.index <= run["start"]]
            share = float(shares.loc[share_idx[-1]]) if len(share_idx) else float(period.peak_share)
            episodes.append(
                {
                    "symbol": period.symbol,
                    "direction": run["direction"],
                    "start": f"{run['start']:%Y-%m-%d}",
                    "end": f"{run['end']:%Y-%m-%d}",
                    "days": run["days"],
                    "band_pct": round(run["band"] * 100),
                    "move_pct": round(run["move"] * 100, 1),
                    "portfolio_share_pct": round(share * 100, 1),
                    "portfolio_impact_pct": round(share * run["move"] * 100, 2),
                    # Backtest filled on the very close that was locked: not achievable live.
                    "blocked_entry": run["direction"] == "UC"
                    and run["days"] >= LOCK_MIN_DAYS
                    and run["start"] <= buy <= run["end"],
                    "blocked_exit": run["direction"] == "LC"
                    and run["days"] >= LOCK_MIN_DAYS
                    and run["start"] <= sell <= run["end"],
                    "held_through": run["start"] > buy and run["end"] < sell,
                }
            )

    outcomes = lc_outcomes(by_symbol, periods, last_day)

    def worst(direction: str) -> list[dict]:
        # The same lock can sit inside several separate holdings of one stock; show it once,
        # at the position size where it hurt (or helped) most.
        by_symbol: dict[str, list[dict]] = {}
        for episode in (e for e in episodes if e["direction"] == direction):
            by_symbol.setdefault(episode["symbol"], []).append(episode)
        rows: list[dict] = []
        for items in by_symbol.values():
            items.sort(key=lambda e: e["start"])
            cluster: list[dict] = []
            for episode in [*items, None]:
                if episode is not None and (
                    not cluster or episode["start"] <= max(e["end"] for e in cluster)
                ):
                    cluster.append(episode)
                    continue
                if cluster:
                    pick = max(cluster, key=lambda e: (e["days"], abs(e["portfolio_impact_pct"])))
                    rows.append({**pick, "times_held": len(cluster)})
                cluster = [episode] if episode is not None else []
        sign = 1 if direction == "UC" else -1
        return sorted(rows, key=lambda e: (e["days"], sign * e["move_pct"]), reverse=True)[:top]

    return {
        "positions": int(len(periods)),
        "touched": touched,
        "episodes": len(episodes),
        "blocked_entries": sum(1 for e in episodes if e["blocked_entry"]),
        "blocked_exits": sum(1 for e in episodes if e["blocked_exit"]),
        "lc": sorted(
            outcomes["trapped"],
            key=lambda e: (e["days"], -e["move_pct"]),
            reverse=True,
        )[:top],
        "uc": worst("UC"),
        "lc_escaped": sorted(outcomes["escaped"], key=lambda e: e["avoided_impact_pct"])[:top],
        "lc_trapped_count": len(outcomes["trapped"]),
        "lc_escaped_count": len(outcomes["escaped"]),
        "lc_trapped_sold_during": sum(1 for e in outcomes["trapped"] if e["exit"] == "sold_during"),
    }
