"""The backtest's side of an audit: run a configuration and write an audit bundle.

A bundle is one JSON file with two parts kept apart on purpose:

  orders   what the replay is allowed to read: the simulated weeks, each order's week, action,
           instrument and amount, which raw series each instrument name stands for, and the
           run's cost and tax settings
  claims   what the backtest says came of them: fill prices, share counts, costs, tax, the
           weekly price of everything held, the equity curve, CAGR and max drawdown

`replay.py` rebuilds the claims from the orders and raw data and compares.
"""

from __future__ import annotations

import dataclasses
import json
import subprocess
import time
from pathlib import Path
from typing import Any

import pandas as pd

from .. import metrics
from ..categories.broad import ATOMIC_NAMES
from ..engine import _POOL, CASH, IDLE, Result

SCHEMA = 1


def _day(ts: Any) -> str:
    return pd.Timestamp(ts).date().isoformat()


def _number(value: Any) -> float | None:
    return None if value is None or pd.isna(value) else float(value)


def asset_definitions(
    names: set[str], column_to_base_symbol: dict[str, str], events: pd.DataFrame
) -> dict[str, dict]:
    """What raw series each traded name stands for.

    A stock column is a symbol's whole history, unless the price builder split the symbol at a
    corporate action it could not adjust for (a demerger, say). Then `SYM` ends, and `SYM#2`
    starts, on the Monday of the event's week: `from` is the first day in the column and
    `until` the first day after it."""
    starts: dict[str, pd.Timestamp] = {}
    for row in events.itertuples(index=False):
        if row.new_column:
            event = pd.Timestamp(row.event_date)
            starts[row.new_column] = event - pd.Timedelta(days=event.weekday())
    by_symbol: dict[str, list[tuple[pd.Timestamp, str]]] = {}
    for column, start in starts.items():
        by_symbol.setdefault(column_to_base_symbol.get(column, column.split("#", 1)[0]), []).append(
            (start, column)
        )

    out: dict[str, dict] = {}
    for name in sorted(names):
        if name in (CASH, IDLE, _POOL):
            out[CASH] = {"kind": "liquid_fund", "instrument": CASH}
            continue
        if name in ATOMIC_NAMES:
            out[name] = {"kind": "series", "instrument": name}
            continue
        symbol = column_to_base_symbol.get(name, name.split("#", 1)[0])
        later = sorted(by_symbol.get(symbol, []))
        start = starts.get(name)
        following = [s for s, _ in later if start is None or s > start]
        out[name] = {
            "kind": "stock",
            "symbol": symbol,
            "from": _day(start) if start is not None else None,
            "until": _day(following[0]) if following else None,
        }
    return out


def _category(categories: pd.DataFrame | None, week: Any, asset: str) -> str | None:
    if categories is None or asset not in categories.columns or week not in categories.index:
        return None
    label = categories.at[week, asset]
    return label if isinstance(label, str) else None


def _provenance() -> dict:
    package = Path(__file__).resolve().parents[3]

    def git(*args: str) -> str:
        done = subprocess.run(
            ["git", *args], cwd=package, capture_output=True, text=True, timeout=20, check=False
        )
        return done.stdout.strip()

    return {
        "commit": git("rev-parse", "HEAD"),
        "uncommitted_changes": bool(git("status", "--porcelain", "--", ".", "../trading-data")),
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def build_bundle(
    result: Result,
    *,
    prices: pd.DataFrame,
    column_to_base_symbol: dict[str, str],
    events: pd.DataFrame,
    label: str,
    run_id: str,
    variant: str,
    params: dict | None = None,
    categories: pd.DataFrame | None = None,
) -> dict:
    """One run as a bundle. `prices` is the weekly table the backtest filled and valued at
    (it goes into the claims, never to the replay's own pricing). `categories` (fill week x
    instrument) is the category each stock was picked through, for the profit breakdown."""
    config = result.config
    weeks = list(result.equity.index)
    trades = result.trades
    # A week with nothing held has no row in `weights`; reindexing gives it an all-zero one.
    weights = result.weights.reindex(weeks[:-1]).fillna(0.0)
    held_names = set(weights.columns[(weights > 0).any()])
    traded = set(trades["asset"]) if len(trades) else set()
    assets = asset_definitions(traded | held_names, column_to_base_symbol, events)

    orders, fills = [], []
    for row in trades.to_dict("records"):
        asset = CASH if row["asset"] in (CASH, IDLE, _POOL) else row["asset"]
        orders.append(
            {
                "week": _day(row["week"]),
                "action": row["action"],
                "asset": asset,
                "value": float(row["value"]),
            }
        )
        fills.append(
            {
                "fill_price": _number(row.get("fill_price")),
                "units": _number(row.get("units")),
                "prev_units": _number(row.get("prev_units")),
                "cost": _number(row.get("cost")),
                "tax": _number(row.get("tax")),
                "reason": row.get("reason"),
                "category": _category(categories, row["week"], row["asset"]),
            }
        )

    # The price of everything held through each week, at that week's end.
    marks: dict[str, dict[str, float]] = {}
    for i, week in enumerate(weeks[:-1]):
        row = weights.loc[week]
        held = [a for a in row.index if row[a] > 0]
        marks[_day(weeks[i + 1])] = {
            (CASH if a == IDLE else a): float(prices.at[weeks[i + 1], CASH if a == IDLE else a])
            for a in held
        }

    depth, _, _ = metrics.max_drawdown(result.equity)
    return {
        "schema": SCHEMA,
        "label": label,
        "run_id": run_id,
        "variant": variant,
        "code": _provenance(),
        "params": params or {},
        "settings": {
            "portfolio": config.portfolio,
            "cost_model": config.cost_model,
            "cost_pct": config.cost_pct,
            "capital": config.capital,
            "slippage_bps": config.slippage_bps,
            "tax": dataclasses.asdict(config.tax) if config.tax is not None else None,
            "signal_delay": config.signal_delay,
            "rebalance_every": config.rebalance_every,
            "rebalance_offset": config.rebalance_offset,
        },
        "assets": assets,
        "weeks": [_day(w) for w in weeks],
        "orders": orders,
        "claims": {
            "fills": fills,
            "marks": marks,
            "equity": [float(v) for v in result.equity],
            "kpis": {
                "cagr": float(metrics.cagr(result.equity)),
                "mdd": float(depth),
                "turnover_x": float(metrics.turnover(result)),
            },
            "open_positions": [
                {"asset": row["asset"], "value": float(row["value"])}
                for row in result.open_positions.to_dict("records")
            ],
            "idle_value": float(result.idle_value),
        },
    }


def bundle_search_runs(
    space_path: Path,
    results_dir: Path,
    picks: dict[str, str],
    out_dir: Path,
    *,
    variant: str,
    tax: Any = None,
    echo=print,
    **override: Any,
) -> list[Path]:
    """Re-run stored search configs (`picks`: label -> run id) on the current code and write one
    bundle each. `override` replaces fixed settings of the space for this variant (e.g.
    `capital=500000`, `signal_delay=0`); the stored parameters are otherwise untouched."""
    from .. import bias, search

    space = search.load_space(space_path)
    records = bias.load_records(results_dir, set(picks.values()))
    missing = sorted(set(picks.values()) - set(records))
    if missing:
        raise ValueError(f"run ids not found in {results_dir}: {missing}")
    runner = bias.Runner(space)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for label, run_id in picks.items():
        rec = records[run_id]
        started = time.time()
        base = runner.base(rec["heavy"])
        outcome, ranking = runner.run(base, rec["heavy"], rec["light"], tax=tax, **override)
        prices = ranking.prices.ffill()
        prices[CASH] = runner.common["outer_prices"].reindex(prices.index)[CASH]
        groups = outcome.effective.groups
        if groups is not None:  # labelled by signal week; an order fills `signal_delay` later
            groups = groups.reindex(prices.index).shift(outcome.result.config.signal_delay)
        bundle = build_bundle(
            outcome.result,
            prices=prices,
            column_to_base_symbol=ranking.column_to_base_symbol,
            events=ranking.events,
            label=label,
            run_id=run_id,
            variant=variant,
            params={
                "space": space.name,
                "heavy": rec["heavy"],
                "light": rec["light"],
                "fixed": space.fixed,
                "override": {k: v for k, v in override.items()},
                "stored_metrics": rec.get("metrics"),
            },
            categories=groups,
        )
        path = out_dir / f"{label}__{variant}.json"
        path.write_text(json.dumps(bundle, indent=1, default=str))
        kpis = bundle["claims"]["kpis"]
        echo(
            f"{label} [{variant}]: CAGR {kpis['cagr']:.4%}, max drawdown {kpis['mdd']:.4%}, "
            f"{len(bundle['orders'])} orders ({time.time() - started:.0f} s) -> {path.name}"
        )
        written.append(path)
    return written
