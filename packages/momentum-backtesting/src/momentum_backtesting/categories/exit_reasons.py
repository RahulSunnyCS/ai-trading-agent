"""Plain-English reasons, and a usable rank, for Broad Momentum exits the engine calls "ineligible".

The engine only sees the final per-stock rank table, in which a stock has a rank only while it is
selected (through a held category, or inside the pool in the no-category mode). When a holding
stops being selected its rank is NaN, so the trade list showed a blank exit rank and the reason
"ineligible" - without saying whether the stock failed the liquidity gate, left the momentum pool,
or simply lost its category. This explains each such exit from the same tables the run used and
fills the blank rank with the nearest meaningful one.

Display-only: it edits the payload's trade rows, never the backtest. Ranks are shifted by
`signal_delay` inside the engine, so an exit filled in week W was decided from week W - delay.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from . import liquidity as liquidity_mod
from .broad import ATOMIC_NAMES, UniverseRanking, _quarter_end_weeks

#: Reasons that mean "no rank" rather than a rank test; anything else is already specific.
_UNEXPLAINED = "ineligible"


def _short(category_ids: list[str], limit: int = 2) -> str:
    names = [cid.split(" :: ", 1)[-1] for cid in category_ids]
    more = f" +{len(names) - limit} more" if len(names) > limit else ""
    return ", ".join(names[:limit]) + more


def _number(value: Any) -> int | None:
    return None if value is None or pd.isna(value) else int(value)


def _series_break(
    ranking: UniverseRanking, symbol: str, asset: str, week: pd.Timestamp
) -> str | None:
    """If the sold column is an old price segment retired by a detected break (a one-day drop
    the price builder treats as a possible split or bonus), say so. Such a break starts a new
    column (`SYMBOL#2`) with no history, so the held segment drops out of the pool at once."""
    events = ranking.events
    if events is None or events.empty:
        return None
    mine = events[(events["symbol"] == symbol) & (events["new_column"] != asset)]
    mine = mine[pd.to_datetime(mine["event_date"]) <= week + pd.Timedelta(days=7)]
    if mine.empty:
        return None
    last = mine.sort_values("event_date").iloc[-1]
    when = pd.Timestamp(last["event_date"])
    if (week - when).days > 200 or last["new_column"] == "":
        return None
    return (
        f"Price series restarted after a {float(last['drop_pct']):.1%} one-day drop on "
        f"{when:%d %b %Y} (treated as a possible split or bonus), so this position's series "
        "was retired"
    )


def explain_exits(
    rows: list[dict],
    *,
    ranking: UniverseRanking,
    held_by_week: dict[pd.Timestamp, list[str]] | None,
    group_members: dict[str, set[str]],
    signal_delay: int,
    pool_exit_rank: int,
    picks_per_category: int,
    liquidity_cfg: liquidity_mod.LiquidityConfig | None,
) -> None:
    """Fill in `exit_rank`, `exit_rank_basis`, `exit_cause` and a specific `reason`, in place, on
    every closed-trade row that was sold with no rank."""
    columns = set(ranking.global_ranks.columns)
    quarter_ends = _quarter_end_weeks(list(ranking.weeks))
    index = {week: i for i, week in enumerate(ranking.weeks)}
    todo: list[tuple[dict, str, pd.Timestamp]] = []
    for row in rows:
        asset = row.get("asset")
        if asset not in columns:
            continue
        if row.get("exit_rank") is not None and row.get("reason") != _UNEXPLAINED:
            continue
        exit_week = pd.Timestamp(row["exit_week"]) if row.get("exit_week") else None
        if exit_week is None or exit_week not in index:
            continue
        signal_week = ranking.weeks[max(index[exit_week] - signal_delay, 0)]
        todo.append((row, asset, signal_week))
    if not todo:
        return

    gate = ranking.liquidity_gate

    def gate_false(asset: str, week: pd.Timestamp | None) -> bool:
        return (
            gate is not None
            and week is not None
            and asset in gate.columns
            and week in gate.index
            and not bool(gate.at[week, asset])
        )

    def reselection(week: pd.Timestamp) -> pd.Timestamp | None:
        earlier = [q for q in quarter_ends if q <= week]
        return earlier[-1] if earlier else None

    # The week whose liquidity verdict explains the exit: the sale's own signal week, or (for a
    # stock dropped from the quarterly pool) the re-selection date, when the gate was also applied.
    gate_week: dict[int, pd.Timestamp] = {}
    for i, (_, asset, week) in enumerate(todo):
        if gate_false(asset, week):
            gate_week[i] = week
        elif asset not in ATOMIC_NAMES and not bool(ranking.pool_membership.at[week, asset]):
            then = reselection(week)
            if gate_false(asset, then):
                gate_week[i] = then
    features = pd.DataFrame()
    if liquidity_cfg is not None and gate_week:
        symbols = sorted(
            {ranking.column_to_base_symbol.get(todo[i][1], todo[i][1]) for i in gate_week}
        )
        features = liquidity_mod.compute_weekly_features(symbols)

    categories_of: dict[str, list[str]] = {}
    for cid, members in group_members.items():
        for symbol in members:
            categories_of.setdefault(symbol, []).append(cid)

    for i, (row, asset, week) in enumerate(todo):
        if asset in ATOMIC_NAMES:
            # Gold, silver and the two index funds compete with the categories on their own rank.
            own = _number(ranking.combined_pool_ranks.at[week, asset])
            if own is not None:
                row["exit_rank"], row["exit_rank_basis"] = own, "rank among stocks and atomics"
            row["exit_cause"] = "category"
            row["reason"] = f"{asset} dropped out of the selected top categories" + (
                f" (its rank among stocks and atomics: {own})" if own is not None else ""
            )
            continue
        symbol = ranking.column_to_base_symbol.get(asset, asset)
        glob = _number(ranking.global_ranks.at[week, asset])
        pool = _number(ranking.stock_pool_ranks.at[week, asset])
        in_pool = bool(ranking.pool_membership.at[week, asset])
        if pool is not None:
            row["exit_rank"], row["exit_rank_basis"] = pool, "pool rank"
        elif glob is not None:
            row["exit_rank"], row["exit_rank_basis"] = glob, "momentum rank"
        rank_note = f" (momentum rank {glob})" if glob is not None else ""

        if i in gate_week:
            gw = gate_week[i]
            cause = "liquidity"
            if features.empty:
                snap = features
            else:
                snap = features[(features["symbol"] == symbol) & (features["wk"] <= gw)]
                snap = snap.sort_values("wk").tail(1)
            recent = not snap.empty and (gw - snap["wk"].iloc[0]).days <= 14
            detail = (
                liquidity_mod.failure_detail(snap.iloc[0], liquidity_cfg)
                if recent and liquidity_cfg is not None
                else "no recent trading"
            )
            if detail == "eligible":
                detail = "no recent trading"
            if gw == week:
                text = f"Liquidity gate failed: {detail}{rank_note}"
            else:
                text = (
                    "Dropped from the quarterly momentum pool: it failed the liquidity gate "
                    f"at the {gw:%d %b %Y} re-selection ({detail}){rank_note}"
                )
        elif not in_pool and (break_text := _series_break(ranking, symbol, asset, week)):
            cause, text = "series_break", f"{break_text}{rank_note}"
        elif not in_pool:
            # The pool is re-selected once a quarter and then held fixed, so what matters is the
            # stock's rank on that re-selection date, not its rank in the week it was sold.
            reselected = [q for q in quarter_ends if q <= week]
            then = reselected[-1] if reselected else None
            at_then = _number(ranking.global_ranks.at[then, asset]) if then is not None else None
            if glob is None and at_then is None:
                cause, text = "unranked", "Not tradeable that week (no price or not listed)"
            else:
                cause = "pool"
                when = f"{then:%d %b %Y}" if then is not None else "the last re-selection"
                if at_then is None:
                    why = "it was not ranked or not eligible then"
                elif at_then > pool_exit_rank:
                    why = (
                        f"its momentum rank was {at_then}, past the pool exit rank {pool_exit_rank}"
                    )
                else:
                    why = f"its momentum rank was {at_then} but it failed the eligibility check"
                now = f" (momentum rank {glob} when sold)" if glob is not None else ""
                text = f"Dropped from the quarterly momentum pool re-selected {when}: {why}{now}"
        elif held_by_week is not None:
            own = categories_of.get(symbol, [])
            held = set(held_by_week.get(week, ()))
            if own and not (set(own) & held):
                cause = "category"
                text = f"Its category ({_short(own)}) fell out of the top categories{rank_note}"
            elif own:
                cause = "category"
                text = (
                    f"No longer one of the top {picks_per_category} picks in its category "
                    f"({_short(own)}){rank_note}"
                )
            else:
                cause, text = "category", f"Not in any category this week{rank_note}"
        else:
            cause, text = "unranked", f"Not selected that week{rank_note}"
        row["exit_cause"] = cause
        row["reason"] = text
