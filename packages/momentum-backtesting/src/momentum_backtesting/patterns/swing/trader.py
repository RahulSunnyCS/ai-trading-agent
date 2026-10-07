"""BL-043 Phase 2: the trade simulator (bl043_criteria.json `entries`, `exits`, `costs`,
`portfolio`).

Two layers:

- `simulate_trade`: one candidate's trade. Fill at the next session's open; a stop and target
  fixed at the fill; each session (the fill day included) checked in this order: an open at or
  below the stop exits at the open; an open at or above the target exits at the open; a low at
  or below the stop exits at the stop; a high at or above the target exits at the target (so
  when both are touched intraday, the stop is assumed first). Otherwise the 65th session's close
  ends it, or the last bar the data has. Costs: the engine's itemised delivery rates plus
  slippage, both sides.
- `run_portfolio`: which trades a 10-slot portfolio takes, best score first, one position per
  stock, a base traded once, and the daily equity marked at each close.

Prices are the forward-adjusted bars (`bars.adjust`): ratios inside a trade are exact.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from ...engine import (
    DP_CHARGE_FRACTION_CAP,
    DP_CHARGE_RS,
    EXCHANGE_FEES_RATE,
    STAMP_DUTY_BUY_RATE,
    STT_RATE,
)
from ..bars import SymbolBars
from . import criteria


def costs() -> tuple[float, float]:
    """(buy, sell) cost as a fraction of trade value for one slot-sized position."""
    spec = criteria()
    slip = spec["costs"]["slippage_bps_each_side"] / 10000
    slot_value = spec["portfolio"]["capital_rs"] / spec["portfolio"]["slots"]
    dp = min(DP_CHARGE_RS / slot_value, DP_CHARGE_FRACTION_CAP)
    buy = STT_RATE + STAMP_DUTY_BUY_RATE + EXCHANGE_FEES_RATE + slip
    sell = STT_RATE + EXCHANGE_FEES_RATE + slip + dp
    return buy, sell


def stop_price(rule: str, fill: float, base_low: float, atr: float) -> float:
    if rule == "base_low":
        return base_low
    if rule == "atr_1.5":
        return fill - 1.5 * atr
    if rule == "pct_8":
        return fill * 0.92
    raise ValueError(rule)


def simulate_trade(
    bars: SymbolBars,
    signal: int,
    *,
    base_low: float,
    atr: float,
    stop_rule: str,
    target_r: float | None,
) -> dict | None:
    """The trade a candidate signalled at daily index `signal` makes, or None when there is no
    next session or the risk is not in (0, skip_if_risk_above]."""
    spec = criteria()["exits"]
    entry = signal + 1
    if entry >= len(bars.close):
        return None
    fill = float(bars.open[entry])
    stop = stop_price(stop_rule, fill, base_low, atr)
    risk = (fill - stop) / fill
    if not (0 < risk <= spec["skip_if_risk_above"]) or not math.isfinite(risk):
        return None
    target = fill + target_r * (fill - stop) if target_r else math.inf
    last = min(entry + spec["time_stop_sessions"] - 1, len(bars.close) - 1)
    exit_i, exit_px, reason = last, float(bars.close[last]), "time"
    for i in range(entry, last + 1):
        o, h, lo = bars.open[i], bars.high[i], bars.low[i]
        if i > entry and o <= stop:
            exit_i, exit_px, reason = i, float(o), "stop_gap"
            break
        if i > entry and o >= target:
            exit_i, exit_px, reason = i, float(o), "target_gap"
            break
        if lo <= stop:
            exit_i, exit_px, reason = i, float(stop), "stop"
            break
        if h >= target:
            exit_i, exit_px, reason = i, float(target), "target"
            break
    else:
        if last == len(bars.close) - 1 and last < entry + spec["time_stop_sessions"] - 1:
            reason = "data_end"
    buy, sell = costs()
    gross = exit_px / fill - 1
    net = (1 + gross) * (1 - sell) / (1 + buy) - 1
    path_lo = float(bars.low[entry : exit_i + 1].min())
    path_hi = float(bars.high[entry : exit_i + 1].max())
    return {
        "entry_date": pd.Timestamp(bars.dates[entry]),
        "exit_date": pd.Timestamp(bars.dates[exit_i]),
        "entry_idx": entry,
        "exit_idx": exit_i,
        "fill": fill,
        "stop": stop,
        "target": target if math.isfinite(target) else np.nan,
        "exit_price": exit_px,
        "reason": reason,
        "risk": risk,
        "net_return": net,
        "r": net / risk,
        "mae": path_lo / fill - 1,
        "mfe": path_hi / fill - 1,
        "sessions": exit_i - entry + 1,
    }


def trade_outcomes(
    candidates: pd.DataFrame,
    bars_by_symbol: dict[str, SymbolBars],
    *,
    stop_rule: str,
    target_r: float | None,
) -> pd.DataFrame:
    """The trade for every candidate row (index aligned with `candidates`), NaN where none."""
    rows = []
    for sym, part in candidates.groupby("symbol", sort=False):
        bars = bars_by_symbol[sym]
        pos = {np.datetime64(d, "ns"): i for i, d in enumerate(bars.dates)}
        for idx, c in part.iterrows():
            signal = pos.get(np.datetime64(c["date"], "ns"))
            t = None
            if signal is not None:
                t = simulate_trade(
                    bars, signal, base_low=c["base_low"], atr=c["atr"],
                    stop_rule=stop_rule, target_r=target_r,
                )  # fmt: skip
            rows.append({"index": idx, **(t or {})})
    out = pd.DataFrame(rows).set_index("index").reindex(candidates.index)
    return out


def run_portfolio(
    candidates: pd.DataFrame,
    trades: pd.DataFrame,
    closes: pd.DataFrame,
    *,
    allowed: pd.Series,
    start: str | pd.Timestamp,
    end: str | pd.Timestamp,
) -> tuple[pd.Series, pd.DataFrame]:
    """Daily equity (starting at 1.0) and the trades taken.

    `candidates` and `trades` are index-aligned (`trade_outcomes`); `allowed` (same index,
    bool) says which candidates pass the score cut-off and the health switch on their signal
    day; `closes` is the date x symbol table of adjusted closes used to mark positions. On each
    signal day the allowed candidates with a trade fill best `score` first while slots are free,
    skipping a stock already held and a base already traded."""
    spec = criteria()["portfolio"]
    slots = spec["slots"]
    buy, sell = costs()
    days = closes.loc[start:end].index
    pick = candidates[allowed & trades["fill"].notna()].copy()
    pick = pick.join(trades[["entry_date", "exit_date", "fill", "exit_price"]])
    pick = pick[
        (pick["entry_date"] >= pd.Timestamp(start)) & (pick["entry_date"] <= pd.Timestamp(end))
    ]
    pick = pick.sort_values(["entry_date", "score", "symbol"], ascending=[True, False, True])
    by_entry = {d: g for d, g in pick.groupby("entry_date", sort=False)}

    cash, equity_prev = 1.0, 1.0
    held: dict[str, dict] = {}
    traded_bases: set[str] = set()
    curve, log = [], []
    close_arr = closes.reindex(days).ffill()
    for day in days:
        # entries at the open, sized on the previous close's equity; a position that exits
        # today still holds its slot this morning (its exit comes at or after the open)
        if day in by_entry:
            for _, c in by_entry[day].iterrows():
                if len(held) >= slots:
                    break
                if c["symbol"] in held or c["base_id"] in traded_bases:
                    continue
                size = min(equity_prev / slots, cash / (1 + buy))
                if size <= 0:
                    break
                cash -= size * (1 + buy)
                traded_bases.add(c["base_id"])
                held[c["symbol"]] = {
                    "units": size / c["fill"],
                    "exit_date": c["exit_date"],
                    "exit_price": c["exit_price"],
                    "cost_value": size * (1 + buy),
                    "row": c.to_dict(),
                }
        # exits (at the open on a gap, intraday at the stop/target, or at the close)
        for sym in [s for s, p in held.items() if p["exit_date"] == day]:
            p = held.pop(sym)
            proceeds = p["units"] * p["exit_price"] * (1 - sell)
            cash += proceeds
            log.append({**p["row"], "exit_value": proceeds, "cost_value": p["cost_value"]})
        marked = sum(p["units"] * close_arr.at[day, s] for s, p in held.items())
        equity_prev = cash + marked
        curve.append(equity_prev)
    return pd.Series(curve, index=days, name="equity"), pd.DataFrame(log)
