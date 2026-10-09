"""Read-only intraday rebalance preview for stock momentum portfolios.

The live quote row exists only in memory. Holdings are the user's current portfolio
weights, while the target is produced by the existing backtest engine and rules.
"""

import calendar
import csv
import math
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from . import db_read, engine, fyers
from .categories import broad
from .categories.liquidity import LiquidityConfig
from .config import DATA_DIR
from .engine import CASH, IDLE, Config, Result, run_backtest
from .fetch import load_universe
from .stocks.ui_data import StockDataset


def signal_week(today: date) -> pd.Timestamp:
    """Friday label for the current trading week, including a weekday preview."""
    return pd.Timestamp(today + timedelta(days=(4 - today.weekday()) % 7))


def _friday_on_or_after(day: date) -> date:
    return day + timedelta(days=(4 - day.weekday()) % 7)


def _last_friday(year: int, month: int) -> date:
    last = date(year, month, calendar.monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - 4) % 7)


def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def operational_rebalance_schedule(
    signal: date,
    *,
    strategy_start: date,
    rebalance_kind: str,
    every: int,
) -> dict[str, object]:
    """Previous/current/next live dates, anchored to the user's operational start.

    The backtest's historical ``start`` remains a research-window setting. This separate date
    chooses the live cadence phase: the first Friday on or after the operational start for an
    every-K-weeks strategy, or the first month-end Friday on/after it for monthly rotation.
    Previous and next are strict neighbours, so a current rebalance week can show all three.
    """
    if every < 1:
        raise ValueError("Rebalance interval must be at least one week.")

    if rebalance_kind == "monthly":
        year, month = strategy_start.year, strategy_start.month
        first = _last_friday(year, month)
        if first < strategy_start:
            year, month = _next_month(year, month)
            first = _last_friday(year, month)

        dates: list[date] = []
        scheduled = first
        while scheduled <= signal:
            dates.append(scheduled)
            year, month = _next_month(scheduled.year, scheduled.month)
            scheduled = _last_friday(year, month)
        on_schedule = bool(dates and dates[-1] == signal)
        previous = dates[-2] if on_schedule and len(dates) > 1 else (dates[-1] if dates else None)
        current = signal if on_schedule else None
        following = scheduled
        return {
            "strategy_start_date": strategy_start.isoformat(),
            "cadence": "monthly",
            "interval_weeks": None,
            "effective_rebalance_offset": None,
            "is_rebalance_week": on_schedule,
            "previous_rebalance_date": previous.isoformat() if previous else None,
            "current_rebalance_date": current.isoformat() if current else None,
            "next_rebalance_date": following.isoformat(),
        }

    first = _friday_on_or_after(strategy_start)
    interval = timedelta(weeks=every)
    if signal < first:
        previous = None
        current = None
        following = first
    else:
        elapsed = (signal - first).days // 7
        periods = elapsed // every
        latest = first + periods * interval
        on_schedule = latest == signal
        current = signal if on_schedule else None
        previous = latest - interval if on_schedule else latest
        if previous < first:
            previous = None
        following = latest + interval

    offset = round((pd.Timestamp(first) - engine.CADENCE_EPOCH).days / 7) % every
    return {
        "strategy_start_date": strategy_start.isoformat(),
        "cadence": "weekly" if every == 1 else "every_n_weeks",
        "interval_weeks": every,
        "effective_rebalance_offset": offset,
        "is_rebalance_week": current is not None,
        "previous_rebalance_date": previous.isoformat() if previous else None,
        "current_rebalance_date": current.isoformat() if current else None,
        "next_rebalance_date": following.isoformat(),
    }


def active_aliases(today: date, path: Path | None = None) -> dict[str, str]:
    path = path or Path(__file__).parent / "stocks" / "curated" / "aliases.csv"
    with path.open(newline="") as source:
        return {
            row["company_id"]: row["symbol"]
            for row in csv.DictReader(source)
            if date.fromisoformat(row["from"]) <= today
            and (not row["to"] or today <= date.fromisoformat(row["to"]))
        }


def last_raw_closes(data_dir: Path = DATA_DIR) -> dict[str, float]:
    path = data_dir / "stocks" / "last_trade.csv"
    if not path.exists():
        raise ValueError("No stock trade-price reference; run `mbt stocks fetch` first.")
    with path.open(newline="") as source:
        return {row["company_id"]: float(row["last_close"]) for row in csv.DictReader(source)}


def extra_symbols(names: set[str]) -> dict[str, str]:
    by_name = {item.name: item for item in load_universe()}
    return {
        name: f"NSE:{by_name[name].trade_etf}-EQ"
        for name in names
        if name != CASH and name in by_name
    }


def persisted_stock_prices(
    stock: StockDataset,
    universe: list[str],
    holdings: dict[str, float],
    as_of: date,
    *,
    data_dir: Path = DATA_DIR,
) -> tuple[dict[str, float], dict[str, str]]:
    """Per-share closes for an off-hours Stock preview, preferring the shared DB."""
    member_row = stock.membership.iloc[-1]
    names = {
        name for name in universe if name in stock.companies and bool(member_row.get(name, False))
    }
    names.update(name for name in holdings if name in stock.companies)
    stored = db_read.latest_company_closes_from_db_or_none(sorted(names), as_of)
    ltp: dict[str, float] = {}
    symbols: dict[str, str] = {}
    if stored is not None:
        for name, (close, symbol, _day) in stored.items():
            ltp[name] = close
            symbols[name] = f"NSE:{symbol}-EQ"
    else:
        raw = last_raw_closes(data_dir)
        aliases = active_aliases(as_of)
        for name in names:
            if name in raw and name in aliases:
                ltp[name] = raw[name]
                symbols[name] = f"NSE:{aliases[name]}-EQ"

    extras = ((set(universe) | set(holdings)) & set(stock.extra_instruments)) - {CASH}
    extra_trade_symbols = extra_symbols(extras)
    stored_extras = db_read.latest_momentum_closes_from_db_or_none(sorted(extras), "etf", as_of)
    if stored_extras is not None:
        for name, (close, _day) in stored_extras.items():
            ltp[name] = close
            if name in extra_trade_symbols:
                symbols[name] = extra_trade_symbols[name]
    else:
        for name, symbol in extra_trade_symbols.items():
            path = data_dir / "daily_etf" / f"{name}.csv"
            if path.exists():
                ltp[name] = float(pd.read_csv(path)["close"].dropna().iloc[-1])
                symbols[name] = symbol
    return ltp, symbols


def live_stock_prices(
    stock: StockDataset,
    universe: list[str],
    holdings: dict[str, float],
    quotes: dict[str, float],
    today: date,
    *,
    data_dir: Path = DATA_DIR,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, float], dict[str, str]]:
    """Extend the stock frame with Fyers LTPs, scaled to total-return series units.

    The raw Fyers share price and the total-return history use different units.
    Scaling by the most recent raw close preserves the history's return basis.
    Every currently eligible selected stock must have a quote; silent stale
    substitutions could change the recommended buys and are rejected.
    """
    if stock.prices.empty:
        raise ValueError("No stock history is available.")
    week = signal_week(today)
    last = stock.prices.index[-1]
    if week < last:
        raise ValueError("Historical data is newer than the preview date.")
    if (today - last.date()).days > 10:
        raise ValueError("Stock history is more than 10 days old; refresh it before previewing.")

    aliases = active_aliases(today)
    raw = last_raw_closes(data_dir)
    membership = stock.membership.copy()
    member_row = membership.iloc[-1]
    selected = {
        name for name in universe if name in stock.companies and bool(member_row.get(name, False))
    }
    selected.update(name for name in holdings if name in stock.companies)
    symbols = {name: f"NSE:{aliases[name]}-EQ" for name in selected if name in aliases}
    extras = (set(universe) | set(holdings)) & set(stock.extra_instruments)
    symbols.update(extra_symbols(extras))
    missing_aliases = selected - symbols.keys()
    if missing_aliases:
        raise ValueError(f"No current exchange symbol for: {', '.join(sorted(missing_aliases))}.")
    missing = sorted(name for name, symbol in symbols.items() if symbol not in quotes)
    if missing:
        raise ValueError(f"Fyers returned no LTP for: {', '.join(missing)}. Preview cancelled.")

    prices = stock.prices.copy()
    live = prices.loc[last].copy()
    ltp: dict[str, float] = {}
    trade_symbols: dict[str, str] = {}
    for name, symbol in symbols.items():
        price = quotes[symbol]
        historical = prices.at[last, name] if name in prices else float("nan")
        if name in stock.extra_instruments:
            reference = historical
            if name == "Gilt 8-13 yr":
                etf_path = data_dir / "daily_etf" / f"{name}.csv"
                if not etf_path.exists():
                    raise ValueError("No Gilt ETF reference; run `mbt fetch --etfs` first.")
                reference = float(pd.read_csv(etf_path)["close"].iloc[-1])
        else:
            reference = raw.get(name)
        if not (price > 0 and reference and reference > 0 and pd.notna(historical)):
            raise ValueError(f"No valid price reference for {name}; preview cancelled.")
        ratio = price / reference
        if ratio < 0.5 or ratio > 1.5:
            raise ValueError(
                f"{name} LTP differs by more than 50% from its last raw close; "
                "refresh corporate actions before previewing."
            )
        live[name] = float(historical) * ratio
        ltp[name] = price
        trade_symbols[name] = symbol

    if week > last:
        prices.loc[week] = live
        membership.loc[week] = member_row
    else:
        prices.loc[week] = live
    return prices.sort_index(), membership.sort_index(), ltp, trade_symbols


def stock_target(
    stock: StockDataset,
    prices: pd.DataFrame,
    membership: pd.DataFrame,
    config: Config,
) -> Result:
    includes = {name: "core" for name in stock.companies}
    includes.update({name: extra["tag"] for name, extra in stock.extra_instruments.items()})
    return run_backtest(
        prices,
        includes,
        config,
        stock.tax_classes,
        membership=membership,
    )


def model_holdings(result: Result, week: pd.Timestamp) -> dict[str, float]:
    """Weights decided on the live signal week, not the previous week's row."""
    if week not in result.weights.index:
        raise ValueError("The strategy did not produce a live-week target.")
    row = result.weights.loc[week]
    return {name: float(value) for name, value in row.items() if pd.notna(value) and value > 1e-6}


def build_plan(
    current_percent: dict[str, float],
    target_weights: dict[str, float],
    ltp: dict[str, float],
    trade_symbols: dict[str, str],
    capital: float,
    *,
    allow_missing_prices: bool = False,
) -> list[dict]:
    """Translate model target versus actual percentages into indicative trade quantities."""
    if not math.isfinite(capital) or capital <= 0:
        raise ValueError("Portfolio value must be positive.")
    if any(
        not math.isfinite(value) or value < 0 or value > 100 for value in current_percent.values()
    ):
        raise ValueError("Each holding must be a percentage between 0 and 100.")
    if sum(current_percent.values()) > 100.0001:
        raise ValueError("Current holding percentages total more than 100%.")
    if any(not math.isfinite(value) or value < 0 for value in target_weights.values()):
        raise ValueError("Model target contains an invalid weight.")
    names = sorted(set(current_percent) | set(target_weights))
    rows = []
    for name in names:
        current = current_percent.get(name, 0.0)
        target = target_weights.get(name, 0.0) * 100
        delta = target - current
        if abs(delta) < 0.01:
            continue
        price = ltp.get(name)
        if (
            not allow_missing_prices
            and name != IDLE
            and name != CASH
            and (price is None or price <= 0)
        ):
            raise ValueError(f"No tradeable LTP for {name}; preview cancelled.")
        notional = abs(delta) / 100 * capital
        rows.append(
            {
                "asset": name,
                "symbol": trade_symbols.get(name),
                "action": "BUY" if delta > 0 else "SELL",
                "current_pct": round(current, 4),
                "target_pct": round(target, 4),
                "delta_pct": round(delta, 4),
                "ltp": price,
                "indicative_value": round(notional, 2),
                "indicative_quantity": math.floor(notional / price) if price else None,
            }
        )
    return sorted(rows, key=lambda row: (row["action"] != "SELL", -abs(row["delta_pct"])))


def quote_stock_universe(
    stock: StockDataset,
    universe: list[str],
    holdings: dict[str, float],
    today: date,
    creds: fyers.Credentials,
) -> dict[str, float]:
    aliases = active_aliases(today)
    member_row = stock.membership.iloc[-1]
    names = {
        name for name in universe if name in stock.companies and bool(member_row.get(name, False))
    }
    names.update(name for name in holdings if name in stock.companies)
    missing = names - aliases.keys()
    if missing:
        raise ValueError(f"No current exchange symbol for: {', '.join(sorted(missing))}.")
    symbols = {f"NSE:{aliases[name]}-EQ" for name in names}
    extras = (set(universe) | set(holdings)) & set(stock.extra_instruments)
    symbols.update(extra_symbols(extras).values())
    return fyers.quotes(sorted(symbols), creds)


def broad_quote_symbols(ranking: broad.UniverseRanking) -> dict[str, str]:
    """All currently priceable stocks, including potential new pool entrants."""
    latest = ranking.prices.iloc[-1]
    return {
        name: f"NSE:{base}-EQ"
        for name, base in ranking.column_to_base_symbol.items()
        if name not in ranking.stale_columns
        and pd.notna(latest.get(name))
        and pd.notna(ranking.global_ranks.iloc[-1].get(name))
    } | extra_symbols(set(broad.ATOMIC_NAMES))


def persisted_broad_prices(
    ranking: broad.UniverseRanking,
    as_of: date,
    *,
    data_dir: Path = DATA_DIR,
) -> tuple[dict[str, float], dict[str, str]]:
    """Latest stored per-share prices for an off-hours Broad preview."""
    symbols = broad_quote_symbols(ranking)
    raw = ranking.raw_prices if ranking.raw_prices is not None else ranking.prices
    latest = raw.loc[raw.index[-1]]
    ltp = {
        name: float(latest[name])
        for name in symbols
        if name not in broad.ATOMIC_NAMES and pd.notna(latest.get(name))
    }

    atomics = sorted(set(symbols) & set(broad.ATOMIC_NAMES))
    stored = db_read.latest_momentum_closes_from_db_or_none(atomics, "etf", as_of)
    if stored is not None:
        ltp.update({name: close for name, (close, _day) in stored.items()})
    else:
        for name in atomics:
            path = data_dir / "daily_etf" / f"{name}.csv"
            if path.exists():
                ltp[name] = float(pd.read_csv(path)["close"].dropna().iloc[-1])
    return ltp, symbols


def persisted_broad_ranking(ranking: broad.UniverseRanking) -> broad.UniverseRanking:
    """Add one flat sentinel week so the engine can decide on the last stored week."""
    week = ranking.prices.index[-1]
    sentinel = week + pd.Timedelta(days=7)

    def extended(frame: pd.DataFrame | None) -> pd.DataFrame | None:
        if frame is None:
            return None
        result = frame.copy()
        result.loc[sentinel] = result.loc[week]
        return result.sort_index()

    prices = extended(ranking.prices)
    assert prices is not None
    return replace(
        ranking,
        prices=prices,
        raw_prices=extended(ranking.raw_prices),
        weeks=[*ranking.weeks, sentinel],
        global_ranks=extended(ranking.global_ranks),
        pool_membership=extended(ranking.pool_membership),
        stock_pool_ranks=extended(ranking.stock_pool_ranks),
        combined_pool_ranks=extended(ranking.combined_pool_ranks),
    )


def live_broad_ranking(
    ranking: broad.UniverseRanking,
    quotes: dict[str, float],
    today: date,
    config: Config,
    *,
    pool_top_n: int,
    pool_exit_rank: int,
    data_dir: Path = DATA_DIR,
    liquidity: LiquidityConfig | None = None,
    universe_kind: str = "total_market",
    series_breaks: str = "verified",
) -> tuple[broad.UniverseRanking, dict[str, float], dict[str, str]]:
    """Recompute the Broad funnel on a temporary LTP week; never write history.

    `series_breaks` must be the policy `ranking` was built with: the pool membership and
    liquidity gate are rebuilt here, and their columns only line up with the ranking's when
    both come from the same price-series rule."""
    last = ranking.prices.index[-1]
    week = signal_week(today)
    settlement_week = week + pd.Timedelta(days=7)
    if week < last or (today - last.date()).days > 10:
        raise ValueError("Broad Momentum history is stale; refresh it before previewing.")
    symbols = broad_quote_symbols(ranking)
    missing = sorted(name for name, symbol in symbols.items() if symbol not in quotes)
    if missing:
        raise ValueError(
            f"Fyers returned no LTP for {len(missing)} Broad instruments "
            f"({', '.join(missing[:8])}); preview cancelled."
        )

    prices = ranking.prices.copy()
    raw_prices = ranking.raw_prices.copy() if ranking.raw_prices is not None else prices.copy()
    live = prices.loc[last].copy()
    raw_live = raw_prices.loc[last].copy()
    ltp: dict[str, float] = {}
    for name, symbol in symbols.items():
        price = quotes[symbol]
        if not math.isfinite(price) or price <= 0:
            raise ValueError(f"Invalid Fyers LTP for {name}.")
        if name in broad.ATOMIC_NAMES:
            reference = float(prices.at[last, name])
            if name in ("Nasdaq 100", "Hang Seng"):
                etf_path = data_dir / "daily_etf" / f"{name}.csv"
                if not etf_path.exists():
                    raise ValueError(f"No {name} ETF reference; run `mbt fetch --etfs` first.")
                reference = float(pd.read_csv(etf_path)["close"].iloc[-1])
            live[name] = float(prices.at[last, name]) * price / reference
        else:
            reference = float(prices.at[last, name])
            if price / reference < 0.5 or price / reference > 1.5:
                raise ValueError(
                    f"{name} LTP differs by more than 50% from its last close; "
                    "refresh corporate actions before previewing."
                )
            live[name] = price
        ltp[name] = price
        raw_live[name] = live[name] if name in broad.ATOMIC_NAMES else price

    if week > last:
        prices.loc[week] = live
    else:
        prices.loc[week] = live
    # Include the flat engine sentinel before deriving quarter-end membership.
    # Otherwise a mid-quarter live week looks like the final quarter week and
    # forces an unscheduled Broad pool refresh.
    prices.loc[settlement_week] = live
    prices = prices.sort_index()
    raw_prices.loc[week] = raw_live
    raw_prices.loc[settlement_week] = raw_live
    raw_prices = raw_prices.sort_index()
    ranks, _ = engine.compute_ranks(prices, config)
    stock_columns = list(ranking.column_to_base_symbol)
    if ranking.stock_membership is not None:
        # The ranking was built from this very universe (same membership, gate and series
        # rule, by its cache key): reuse it rather than reload every stock from disk.
        membership_source, gate_source = ranking.stock_membership, ranking.liquidity_gate
    else:
        universe = broad.load_stock_universe_frame(
            stocks_data_dir=data_dir / "stocks",
            categories_data_dir=data_dir / "categories",
            liquidity=liquidity,
            universe=universe_kind,  # type: ignore[arg-type]
            series_breaks=series_breaks,  # type: ignore[arg-type]
        )
        membership_source, gate_source = universe.stock_membership, universe.liquidity_gate
    membership = membership_source.copy()
    if week > last:
        membership.loc[week] = membership.iloc[-1]
    membership.loc[settlement_week] = membership.loc[week]
    membership = membership.reindex(prices.index, fill_value=False)
    pool = broad._compute_pool_membership(
        ranks[stock_columns],
        membership[stock_columns],
        list(prices.index),
        top_n=pool_top_n,
        exit_rank=pool_exit_rank,
    )
    if gate_source is not None:
        gate = gate_source.copy()
        if week > last:
            gate.loc[week] = gate.iloc[-1]
        gate.loc[settlement_week] = gate.loc[week]
        pool = pool & gate.reindex(index=prices.index, columns=pool.columns).fillna(False)
    # As `broad.finish_universe_ranking` does: a series that has ended (delisted, the old half
    # of a demerger) leaves the pool after its last real week; its price is only carried
    # forward, so a buy would fill at a frozen price.
    for column, last_real_week in ranking.stale_columns.items():
        if column in pool.columns:
            pool.loc[pool.index > last_real_week, column] = False
    stock_pool = broad._dense_rank(ranks[stock_columns].where(pool))
    eligible = pd.DataFrame(False, index=prices.index, columns=prices.columns)
    eligible[stock_columns] = pool
    for name in broad.ATOMIC_NAMES:
        eligible[name] = prices[name].notna()
    combined_pool = broad._dense_rank(ranks.where(eligible))
    updated = replace(
        ranking,
        prices=prices,
        raw_prices=raw_prices,
        weeks=list(prices.index),
        global_ranks=ranks,
        pool_membership=pool,
        stock_pool_ranks=stock_pool,
        combined_pool_ranks=combined_pool,
    )
    return updated, ltp, symbols
