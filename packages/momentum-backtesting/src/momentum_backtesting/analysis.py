"""Turn a backtest Result into everything the UI shows: KPIs, chart series, the rotation
behind each chart marker, closed trades, per-instrument attribution, a holdings timeline and
this week's signal. Values are plain JSON types (NaN -> None, dates -> ISO strings)."""

import itertools
import math
from collections.abc import Callable

import pandas as pd

from . import metrics, reference_benchmarks
from .engine import CASH, IDLE, Config, Result, cadence_weeks

CAPITAL = 100_000  # rupee figures are shown for Rs 1 lakh invested at the start


def _clean(value):
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_clean(v) for v in value]
    if value is pd.NaT:
        # A missing timestamp in an otherwise-datetime64 column (e.g. `entry_week` on a raw BUY
        # trade row mixed with SELL rows that do have one, dtype-inferred datetime64 by
        # `pd.DataFrame(list_of_dicts)`) - `NaT` is its own singleton type, not a `pd.Timestamp`
        # instance and not float-NaN, so neither branch below catches it and it would otherwise
        # reach the JSON encoder unconverted. Confirmed live (2026-09) against a real Custom
        # Index backtest: FastAPI/pydantic-core's serializer failed on it with a
        # `TypeError: 'float' object cannot be interpreted as an integer` - every prior caller of
        # `_clean` only ever fed it fully-populated timestamp columns (e.g. `closed_trades()`
        # narrows to SELL rows, whose `entry_week` is always set), so this gap was real but
        # latent until inner-category trade rows (BUY and SELL mixed in one column) exercised it.
        return None
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if hasattr(value, "item"):  # numpy scalars
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _of(trades: pd.DataFrame, *actions: str) -> pd.DataFrame:
    return trades[trades["action"].isin(actions)] if not trades.empty else trades


def closed_trades(result: Result) -> pd.DataFrame:
    """One row per position fully sold. Returns are the position's own (value / cost), so a
    topped-up position counts all its purchases."""
    sells = _of(result.trades, "SELL").copy()
    if sells.empty:
        return sells
    buys = _of(result.trades, "BUY")
    entry_rank = {(r.asset, r.week): r.rank for r in buys.itertuples()}
    sells["entry_rank"] = [entry_rank.get((r.asset, r.entry_week)) for r in sells.itertuples()]
    sells["pnl"] = (sells["value"] - sells["entry_value"]) * CAPITAL
    return sells.rename(columns={"week": "exit_week", "rank": "exit_rank"})


def _holdings_on(result: Result, week) -> list[dict]:
    if week not in result.weights.index:
        return []
    row = result.weights.loc[week]
    return [
        {"asset": asset, "share": share}
        for asset, share in row[row > 1e-9].sort_values(ascending=False).items()
    ]


def rotations(result: Result) -> list[dict]:
    """One entry per week that traded: what went out, what came in, what's held after.

    Works on the trade log's columns as plain lists, in the log's own order within each week:
    cutting a DataFrame into per-week, per-action sub-frames (three boolean filters and an
    `itertuples` each) was over a second of a Broad run for what is a few thousand rows."""
    trades = result.trades
    if trades.empty:
        return []
    n = len(trades)

    def column(name: str) -> list:
        # `weeks_held` and `position_return` exist only once something has been sold.
        return trades[name].tolist() if name in trades else [None] * n

    weeks, actions, assets = column("week"), column("action"), column("asset")
    ranks, reasons = column("rank"), column("reason")
    held, returns = column("weeks_held"), column("position_return")
    # A row with no week belongs to no group, as in groupby. The engine writes the log in week
    # order, so the sort normally has nothing to do; when it does, sorted() is stable, so rows
    # keep the log's order inside a week, as groupby does.
    rows = [i for i in range(n) if not pd.isna(weeks[i])]
    if any(weeks[b] < weeks[a] for a, b in itertools.pairwise(rows)):
        rows.sort(key=weeks.__getitem__)
    out = []
    for week, members in itertools.groupby(rows, key=weeks.__getitem__):
        idx = list(members)
        sells = [i for i in idx if actions[i] == "SELL"]
        ins = [i for i in idx if actions[i] in ("BUY", "ADD")]
        trims = [i for i in idx if actions[i] == "TRIM"]
        out.append(
            {
                "week": week,
                "value": result.equity.get(week, float("nan")) * CAPITAL,
                "outs": [
                    {
                        "asset": assets[i],
                        "rank": ranks[i],
                        "reason": reasons[i],
                        "weeks_held": held[i],
                        "return": returns[i],
                    }
                    for i in sells
                ],
                "ins": [
                    {"asset": assets[i], "rank": ranks[i], "top_up": actions[i] == "ADD"}
                    for i in ins
                ],
                "trims": [{"asset": assets[i], "reason": reasons[i]} for i in trims],
                "parked": any(actions[i] == "PARK" for i in idx),
                "holdings": _holdings_on(result, week),
            }
        )
    return out


def kpis(result: Result, closed: pd.DataFrame) -> dict:
    stats = metrics.summary(result)
    eq = result.equity
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    weekly = eq.pct_change().dropna()
    downside = weekly[weekly < 0].std() * math.sqrt(52)
    turnover = metrics.turnover(result)
    rets = closed["position_return"] if len(closed) else pd.Series(dtype=float)
    wins, losses = rets[rets > 0], rets[rets <= 0]
    rolling = (eq / eq.shift(52)) - (result.benchmark / result.benchmark.shift(52))
    yearly = metrics.yearly(result)
    return {
        "cagr": stats["CAGR"],
        "benchmark_cagr": stats["benchmark CAGR"],
        "cash_cagr": stats["cash CAGR"],
        "excess_cagr": stats["CAGR"] - stats["benchmark CAGR"],
        "total_return": stats["total return"],
        "benchmark_total_return": result.benchmark.iloc[-1] - 1,
        "final_value": eq.iloc[-1] * CAPITAL,
        "benchmark_final_value": result.benchmark.iloc[-1] * CAPITAL,
        "volatility": stats["volatility"],
        "sharpe": stats["Sharpe (vs cash)"],
        "sortino": (stats["CAGR"] - stats["cash CAGR"]) / downside if downside else None,
        "max_drawdown": stats["max drawdown"],
        "max_drawdown_peak": stats["max drawdown peak"],
        "max_drawdown_trough": stats["max drawdown trough"],
        "benchmark_max_drawdown": stats["benchmark max drawdown"],
        "exits_per_year": len(closed) / years,
        "new_buys_per_year": len(_of(result.trades, "BUY")) / years,
        "top_ups_per_year": len(_of(result.trades, "ADD")) / years,
        "turnover_per_year": turnover,
        "avg_weeks_held": stats["avg weeks held"],
        "avg_holdings": stats["avg holdings"],
        "max_position_share": stats["max position share"],
        "win_rate": len(wins) / len(rets) if len(rets) else None,
        "avg_win": wins.mean() if len(wins) else None,
        "avg_loss": losses.mean() if len(losses) else None,
        "best_trade": rets.max() if len(rets) else None,
        "worst_trade": rets.min() if len(rets) else None,
        "time_in_cash": stats["time in cash/debt"],
        "years_beating_benchmark": int((yearly["vs benchmark"] > 0).sum()),
        "years": len(yearly),
        "pct_rolling_52w_ahead": (rolling.dropna() > 0).mean() if rolling.notna().any() else None,
        "tax_paid": result.tax_ledger.paid * CAPITAL if result.tax_ledger else None,
    }


def instrument_table(result: Result, closed: pd.DataFrame, groups: dict[str, str]) -> list[dict]:
    weights = result.weights
    open_pos = result.open_positions

    def pnl_of(frame: pd.DataFrame, current_col: str) -> float:
        return float(((frame[current_col] - frame["entry_value"]) * CAPITAL).sum())

    total_pnl = (closed["pnl"].sum() if len(closed) else 0.0) + (
        pnl_of(open_pos, "value") if len(open_pos) else 0.0
    )
    held_ever = [c for c in weights.columns if c != IDLE and weights[c].gt(0).any()]
    rows = []
    for name in sorted(set(result.ranked_names) | set(held_ever)):
        mine = closed[closed["asset"] == name] if len(closed) else closed
        still = open_pos[open_pos["asset"] == name] if len(open_pos) else open_pos
        pnl = (mine["pnl"].sum() if len(mine) else 0.0) + (
            pnl_of(still, "value") if len(still) else 0.0
        )
        share = weights[name] if name in weights else pd.Series(0.0, index=weights.index)
        rows.append(
            {
                "asset": name,
                "group": groups.get(name, ""),
                "positions": len(mine) + len(still),
                "top_ups": int(
                    ((result.trades["action"] == "ADD") & (result.trades["asset"] == name)).sum()
                )
                if not result.trades.empty
                else 0,
                "weeks_held": int(share.gt(0).sum()),
                "avg_share": float(share.mean()),
                "win_rate": float((mine["position_return"] > 0).mean()) if len(mine) else None,
                "avg_return": float(mine["position_return"].mean()) if len(mine) else None,
                "pnl": pnl,
                "pnl_share": pnl / total_pnl if total_pnl else None,
                "held_now": bool(len(still)),
            }
        )
    return sorted(rows, key=lambda r: -r["pnl"])


def timeline(result: Result, closed: pd.DataFrame) -> list[dict]:
    segments = []
    for r in closed.itertuples() if len(closed) else []:
        segments.append(
            {
                "asset": r.asset,
                "start": r.entry_week,
                "end": r.exit_week,
                "return": r.position_return,
                "weeks": r.weeks_held,
                "open": False,
            }
        )
    last = result.equity.index[-1]
    for r in result.open_positions.itertuples() if len(result.open_positions) else []:
        segments.append(
            {
                "asset": r.asset,
                "start": r.entry_week,
                "end": last,
                "return": r.position_return,
                "weeks": r.weeks_held,
                "open": True,
            }
        )
    return segments


def rebalance_weeks(
    week: pd.Timestamp, rebalance: str, every: int, offset: int
) -> tuple[bool, pd.Timestamp | None]:
    """(whether `week` trades, the next Friday after it that does; None when every week trades).
    Mirrors `engine.run_backtest`'s `trade_weeks`: every `every` weeks on the calendar phase
    `offset` (`engine.cadence_weeks`), or, monthly, the last Friday of the month (the next Friday
    falls in another month)."""

    def trades(w: pd.Timestamp) -> bool:
        if rebalance == "monthly":
            return (w + pd.Timedelta(days=7)).month != w.month
        return bool(cadence_weeks([w], every, offset))

    if rebalance != "monthly" and every <= 1:
        return True, None
    following = week + pd.Timedelta(days=7)
    while not trades(following):  # at most 5 Fridays on
        following += pd.Timedelta(days=7)
    return trades(week), following


def cadence_explain(
    week: pd.Timestamp,
    rebalance: str,
    every: int,
    offset: int,
    sell_every_week: bool,
) -> str | None:
    """None when `week` is a rebalance week under the cadence (`rebalance_weeks`), else the
    sentence saying it is not, when the next one is and what still happens. With
    `sell_every_week` an off week still sells holdings that dropped out; buys and cap trims
    wait."""
    on, following = rebalance_weeks(week, rebalance, every, offset)
    if on:
        return None
    rule = (
        "monthly: trades on the last Friday of the month"
        if rebalance == "monthly"
        else f"every {every} weeks, phase {offset + 1} of {every}"
    )
    note = f"Not a rebalance week ({rule}; next {following:%d %b %Y})"
    if sell_every_week:
        return f"{note}: only holdings that dropped out are sold; buys and trims wait."
    return f"{note}: no trades this week."


def latest_signal(
    result: Result,
    prices: pd.DataFrame,
    config: Config,
    membership: pd.DataFrame | None = None,
    no_buy: pd.DataFrame | None = None,
) -> dict:
    """What the rules say to do at the most recent week's close.

    On a week the cadence does not trade (`cadence_explain`) nothing is bought, trimmed or sold,
    except the sells `sell_every_week` allows, exactly as the engine would do.

    `membership` (week x instrument booleans, stock backtests only) mirrors the engine's own
    `_Sim.top_names` gate: an instrument absent from `membership.columns` (an ETF, benchmark or
    CASH) is always eligible; one tracked but not a member this week can't be freshly bought,
    even if it ranks well - only the engine's real trading loop enforces this during a backtest,
    so this advisory panel has to apply the same rule itself or it would recommend a trade the
    engine would refuse.

    `no_buy` (week x instrument booleans, the same table passed to `run_backtest`) does the same
    for an entry-only gate: a flagged name not already held is skipped and the next-best
    buyable name within `exit_rank` takes its place, exactly as `_Sim.top_names` refills.
    """
    week = result.ranks.index[-1]
    ranks = result.ranks.loc[week]
    scores = result.scores.loc[week]
    history = prices.loc[:week]
    held = set(result.open_positions["asset"]) if len(result.open_positions) else set()
    lookback_returns = {
        k: history.iloc[-1] / history.iloc[-1 - k] - 1 for k in config.lookbacks if len(history) > k
    }
    filter_ret = history.iloc[-1] / history.iloc[-1 - config.filter_lookback] - 1

    def passes(name):
        return config.defensive != "filter" or filter_ret.get(name, -1) > filter_ret.get(CASH, 0)

    def must_sell(name):
        rank = ranks.get(name)
        return pd.isna(rank) or rank > config.exit_rank or not passes(name)

    sells = {n for n in held if must_sell(n)}
    cap = config.max_position if config.portfolio == "buffer" else None
    values = (
        dict(zip(result.open_positions["asset"], result.open_positions["value"], strict=True))
        if len(result.open_positions)
        else {}
    )
    total = sum(values.values()) + result.idle_value
    shares = {name: value / total for name, value in values.items()} if total else {}
    trims = {
        n for n in held - sells if cap is not None and shares.get(n, 0) > cap + config.cap_band
    }

    def at_cap(name: str) -> bool:
        return cap is not None and name not in trims and shares.get(name, 0) >= cap - 1e-6

    def eligible_to_buy(name: str) -> bool:
        return (
            membership is None or name not in membership.columns or bool(membership.at[week, name])
        )

    ordered = ranks.dropna().sort_values()
    tops = [n for n in ordered.index if ordered[n] <= config.top_n and passes(n)]
    skipped: set[str] = set()
    if no_buy is not None and week in no_buy.index:
        flagged = no_buy.loc[week]

        def blocked(name: str) -> bool:
            return name in flagged.index and bool(flagged[name])

        skipped = {n for n in tops if n not in held and blocked(n)}
        tops = [n for n in tops if n not in skipped]
        for n in ordered.index:
            if len(tops) >= config.top_n or ordered[n] > config.exit_rank:
                break
            fresh = n not in tops and n not in skipped and not blocked(n)
            if fresh and passes(n) and eligible_to_buy(n):
                tops.append(n)
    not_a_member = {n for n in tops if n not in held and not eligible_to_buy(n)}
    actions: dict[str, str] = {n: "SELL" for n in sells}
    actions.update(dict.fromkeys(not_a_member, "NOT A MEMBER"))
    actions.update(dict.fromkeys(skipped, "SKIP (no new buy)"))
    if config.portfolio == "slots":
        open_slots = config.top_n - (len(held) - len(sells))
        candidates = [n for n in tops if n not in held and eligible_to_buy(n)]
        for name in candidates[: max(open_slots, 0)]:
            actions[name] = "BUY"
        explain = "Fixed slots: each sale's money buys the best-ranked name not already held."
    else:
        new = [n for n in tops if n not in held and eligible_to_buy(n)]
        for name in trims:
            actions[name] = f"TRIM to {cap:.0%}"
        if sells or trims:
            for name in tops:
                if at_cap(name):
                    actions.setdefault(name, "AT CAP")
                else:
                    actions.setdefault(name, "ADD" if name in held else "BUY")
            explain = "Sale money is split equally across the top N (ADD = top up a holding)."
            if cap is not None:
                explain += f" No ETF goes above {cap:.0%} of the portfolio."
        elif new and config.entry == "make_room":
            for name in new:
                actions[name] = "BUY (make room)"
            explain = "New top-N names are bought now by trimming every holding equally."
        else:
            for name in new:
                actions[name] = "WAIT"
            explain = "Nothing to sell, so new top-N names wait for the next sale."
    off_week = cadence_explain(
        week,
        config.rebalance,
        config.rebalance_every,
        config.rebalance_offset,
        config.sell_every_week,
    )
    if off_week is not None:
        actions = {n: "SELL" for n in sells} if config.sell_every_week else {}
        explain = off_week
    for name in held:
        actions.setdefault(name, "HOLD")

    rows = [
        {
            "asset": name,
            "rank": ranks.get(name),
            "score": scores.get(name),
            "returns": {str(k): r.get(name) for k, r in lookback_returns.items()},
            "held": name in held,
            "action": actions.get(name, ""),
        }
        for name in result.ranked_names
    ]
    rows.sort(key=lambda r: (pd.isna(r["rank"]), r["rank"] if pd.notna(r["rank"]) else 0))
    delay = (
        f" With a {config.signal_delay}-week signal delay, the ranks shown are that old."
        if config.signal_delay
        else ""
    )
    return {"week": week, "rows": rows, "explain": explain + delay}


def _proxied(proxy: pd.DataFrame | None, asset: str, *weeks) -> bool:
    """True if any of `weeks` priced `asset` on its index because the ETF didn't exist yet."""
    if proxy is None or asset not in proxy:
        return False
    return any(w in proxy.index and bool(proxy.at[w, asset]) for w in weeks if pd.notna(w))


def payload_parts(
    result: Result,
    prices: pd.DataFrame,
    config: Config,
    groups: dict[str, str],
    proxy: pd.DataFrame | None = None,
    fill_warnings: list[str] | None = None,
    membership: pd.DataFrame | None = None,
    share_prices: bool = False,
    references: pd.DataFrame | None = None,
    no_buy: pd.DataFrame | None = None,
) -> dict:
    """The same payload as `payload()`, split in two: (core, lazy). `core` is what every view needs
    the moment a run finishes (KPIs, chart series, rotations, yearly, crashes, comparisons, open
    positions); `lazy` maps each of the four heavy sections (`trades`, `instruments`, `timeline`,
    `latest`: ~60% of a Broad response, and `instrument_table` alone ~4 s) to a function that
    builds it, cleaned, on demand. The functions read the objects they were given, so build them
    only for a result that is kept; each returns what `payload()` puts under that key.

    `share_prices` adds each open position's last-week price (`open_positions[].price`) so the
    UI's "Trade split" tab can turn a rupee amount into whole shares. Off by default: only pass
    True where the frame's columns are the raw traded prices of what you'd actually buy (Broad
    Momentum's stocks) - an ETF ranked on its index, or a category's synthetic equity curve, has
    no share price to divide by.

    `proxy` (week x instrument, from trade_prices) marks fills where an ETF was priced on
    its index because it hadn't listed yet. `membership` is passed straight through to
    `latest_signal` (see its docstring) - it never affects the historical `result` itself, which
    the engine has already computed correctly; it only stops the "This week" advisory panel from
    recommending a trade the engine's own rules wouldn't have allowed.

    `references` (reference_benchmarks.load_references) adds `comparisons`: dividend-inclusive
    lines the strategy is also measured against, whatever the dataset's own benchmark is; and
    `benchmarks`: the dashboard picker's five indices (`reference_benchmarks.picker`), each with
    its curve on `series.dates` and headline statistics, so the page can switch benchmark
    without a re-run."""
    closed = closed_trades(result)
    eq, bench, cash = result.equity, result.benchmark, result.cash
    rolling = (eq / eq.shift(52)) - (bench / bench.shift(52))
    idle = result.weights[IDLE] if IDLE in result.weights else pd.Series(0.0, index=eq.index)
    positions = result.weights.drop(columns=[IDLE], errors="ignore")
    series = {
        "dates": [d.strftime("%Y-%m-%d") for d in eq.index],
        "strategy": (eq * CAPITAL).tolist(),
        "benchmark": (bench * CAPITAL).tolist(),
        "cash": (cash * CAPITAL).tolist(),
        "drawdown_strategy": metrics.drawdown(eq).tolist(),
        "drawdown_benchmark": metrics.drawdown(bench).tolist(),
        "rolling_52w_excess": rolling.tolist(),
        "idle_share": idle.reindex(eq.index).tolist(),
        "holdings_count": positions.gt(1e-9).sum(axis=1).reindex(eq.index).tolist(),
    }
    yearly = metrics.yearly(result).reset_index()
    yearly.columns = ["year", "strategy", "benchmark", "cash", "vs_benchmark"]
    columns = [
        "asset",
        "entry_week",
        "exit_week",
        "weeks_held",
        "entry_rank",
        "exit_rank",
        "position_return",
        "pnl",
        "reason",
        "tax",
    ]
    trade_rows = closed[columns].to_dict("records") if len(closed) else []
    for row in trade_rows:
        row["proxy"] = _proxied(proxy, row["asset"], row["entry_week"], row["exit_week"])
    open_rows = []
    last_week = result.equity.index[-1]
    for r in result.open_positions.itertuples() if len(result.open_positions) else []:
        price = prices.at[last_week, r.asset] if share_prices and r.asset in prices else None
        open_rows.append(
            {
                "asset": r.asset,
                "price": None if price is None or pd.isna(price) else float(price),
                "entry_week": r.entry_week,
                "weeks_held": r.weeks_held,
                "rank": r.rank,
                "position_return": r.position_return,
                "value": r.value * CAPITAL,
                "pnl": (r.value - r.entry_value) * CAPITAL,
                "proxy": _proxied(proxy, r.asset, r.entry_week),
            }
        )
    core = _clean(
        {
            "benchmark_name": config.benchmark,
            "kpis": kpis(result, closed),
            "comparisons": [
                {
                    "name": c["name"],
                    "cagr": c["cagr"],
                    "excess_cagr": c["excess_cagr"],
                    "max_drawdown": c["max_drawdown"],
                    "note": c["note"],
                    "series": (c["curve"] * CAPITAL).tolist(),
                }
                for c in reference_benchmarks.compare(eq, references)
            ],
            "benchmarks": [
                {
                    **{key: value for key, value in entry.items() if key != "curve"},
                    "final_value": (entry["total_return"] + 1) * CAPITAL,
                    "series": (entry["curve"] * CAPITAL).tolist(),
                }
                if entry["available"]
                else entry
                for entry in reference_benchmarks.picker(eq, cash, references)
            ],
            "series": series,
            "rotations": rotations(result),
            "fills": {
                "track": config.track,
                "execution": config.execution,
                "proxy_trades": sum(r["proxy"] for r in trade_rows),
                "warnings": fill_warnings or [],
            },
            "open_positions": open_rows,
            "yearly": yearly.to_dict("records"),
            "crashes": metrics.crash_table(result).to_dict("records"),
            "universe": result.ranked_names,
        }
    )
    lazy: dict[str, Callable[[], object]] = {
        "trades": lambda: _clean(trade_rows),
        "instruments": lambda: _clean(instrument_table(result, closed, groups)),
        "timeline": lambda: _clean(timeline(result, closed)),
        "latest": lambda: _clean(latest_signal(result, prices, config, membership, no_buy)),
    }
    return core, lazy


def payload(
    result: Result,
    prices: pd.DataFrame,
    config: Config,
    groups: dict[str, str],
    proxy: pd.DataFrame | None = None,
    fill_warnings: list[str] | None = None,
    membership: pd.DataFrame | None = None,
    share_prices: bool = False,
    references: pd.DataFrame | None = None,
    no_buy: pd.DataFrame | None = None,
) -> dict:
    """Everything the UI shows for one backtest, in one dict. The arguments are described on
    `payload_parts`, which returns the same result split into what is needed at once and what
    can wait."""
    core, lazy = payload_parts(
        result,
        prices,
        config,
        groups,
        proxy,
        fill_warnings,
        membership,
        share_prices,
        references,
        no_buy,
    )
    return {**core, **{name: build() for name, build in lazy.items()}}
