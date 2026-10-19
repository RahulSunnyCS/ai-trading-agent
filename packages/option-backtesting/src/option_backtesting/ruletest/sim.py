"""Simulate a rule's template on collected days with the legwise engine, and keep every result in a
cache keyed by (template, day, entry minute, side, slippage), so the placebo and random-time
controls are lookups after their first fill and a second test of the same template is fast.

Each simulation runs the template with `entry_time` set to the wanted minute (the BL-083
convention), `lot_sizing: current` and the rotation's sizing date, and with the same early-date
reference fallback BL-083's study used for sessions before the reference tables begin. The cache
stores the gross P&L and the turnover, not a net: charges are applied by `charges.day_charges`
when a test reads them, so a change of the charge model never invalidates a simulation.
"""

from __future__ import annotations

import csv
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path
from typing import Any

from . import charges, store
from .spec import CompiledRule, from_dict

COLUMNS = [
    "day",
    "entry",
    "side",
    "slip",
    "gross",
    "worst_mtm",
    "best_mtm",
    "stopped_by",
    "orders",
    "buy_value",
    "sell_value",
    "n_trades",
    "weekly_expiry",
    "spot_entry",
    "spot_exit",
    "error",
]
Key = tuple[str, str, str, float]  # day, entry, side, slippage_pct


def cache_path(root: Path, template_hash: str) -> Path:
    return store.simcache_dir(root) / f"{template_hash}.csv"


#: the fields a cached row must carry, parsed, before it is trusted
_FLOATS = ("slip", "gross", "worst_mtm", "best_mtm", "buy_value", "sell_value")
_INTS = ("orders", "n_trades")


def _complete(row: dict[Any, Any]) -> bool:
    """Every column present and none extra. A line cut short by a killed process, or one glued
    onto such a line, fails this."""
    return None not in row and all(row.get(c) is not None for c in COLUMNS)


def _parses(row: dict[str, Any]) -> bool:
    """The day and the numbers parse (a complete row can still hold a cut or merged number)."""
    try:
        date.fromisoformat(row["day"])
        for c in _FLOATS:
            float(row[c])
        for c in _INTS:
            int(row[c])
    except ValueError:
        return False
    return True


def read_cache_counted(root: Path, template_hash: str) -> tuple[dict[Key, dict[str, Any]], int]:
    """(the trusted rows, how many lines were skipped as torn or unreadable)."""
    path = cache_path(root, template_hash)
    out: dict[Key, dict[str, Any]] = {}
    skipped = 0
    if not path.exists():
        return out, skipped
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            if not _complete(row):
                skipped += 1  # torn: simulated again, never trusted
                continue
            if row["error"]:
                continue  # an error row is retried, never trusted
            if not _parses(row):
                skipped += 1
                continue
            out[(row["day"], row["entry"], row["side"], float(row["slip"]))] = row
    return out, skipped


def read_cache(root: Path, template_hash: str) -> dict[Key, dict[str, Any]]:
    return read_cache_counted(root, template_hash)[0]


def _end_line(path: Path) -> None:
    """Make sure the next append starts on a line of its own (a killed writer can leave the file
    ending part-way through a row)."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with path.open("rb") as handle:
        handle.seek(-1, 2)
        last = handle.read(1)
    if last != b"\n":
        with path.open("a", newline="") as handle:
            handle.write("\r\n")


def _early_reference():
    """The study's reference-table fallback: a session before the tables begin uses the 2024-10-03
    lot and strike rules (sizing is `current`, so the lot is today's either way)."""
    from ..data.reference.loader import MissingReferenceData, default_reference_data

    class Early:
        def __init__(self, ref):
            self._ref = ref

        def __getattr__(self, name):
            return getattr(self._ref, name)

        def _early(self, call, u, when):
            try:
                return call(u, when)
            except MissingReferenceData:
                return call(u, date(2024, 10, 3))

        def lot_size(self, u, expiry):
            return self._early(self._ref.lot_size, u, expiry)

        def strike_step(self, u, as_of):
            return self._early(self._ref.strike_step, u, as_of)

    return Early(default_reference_data())


def simulate_items(
    rule: CompiledRule, data: Any, items: list[tuple[str, str, float]], reference: Any
) -> list[dict[str, Any]]:
    """Run (entry, side, slippage) items on one loaded day; one row each."""
    from ..legwise.engine import simulate_day
    from ..legwise.market import minute_index, pick_expiry
    from ..rotation.lists import SIZING_DATE

    sizing = date.fromisoformat(SIZING_DATE)
    expiry = pick_expiry(data, "weekly")
    rows = []
    for entry, side, slip in items:
        base = {"day": data.day.isoformat(), "entry": entry, "side": side, "slip": slip}
        try:
            strategy = rule.strategy_for(entry, side, slip or None)
            result = simulate_day(strategy, data, reference, sizing)
        except Exception as error:  # noqa: BLE001 - recorded and retried, never fatal to a test
            rows.append({**base, "error": f"ERR {type(error).__name__}: {error}"[:200]})
            continue
        orders, buy, sell = charges.trade_values(result.trades)
        exit_minute = minute_index(strategy.exit_time)
        rows.append(
            {
                **base,
                "gross": round(result.gross, 2),
                "worst_mtm": round(result.worst_mtm, 2),
                "best_mtm": round(result.best_mtm, 2),
                "stopped_by": result.stopped_by or "",
                "orders": orders,
                "buy_value": round(buy, 2),
                "sell_value": round(sell, 2),
                "n_trades": len(result.trades),
                "weekly_expiry": expiry.isoformat() if expiry else "",
                "spot_entry": data.spot.price_at(minute_index(entry)),
                "spot_exit": data.spot.price_at(exit_minute),
                "error": "",
            }
        )
    return rows


def _work(task: tuple[str, dict, str, list[tuple[str, str, float]]]) -> list[dict[str, Any]]:
    root_text, spec_data, day, items = task
    from ..legwise.market import load_day

    rule = from_dict(spec_data)
    try:
        data = load_day(Path(root_text), rule.spec.underlying, date.fromisoformat(day))
    except FileNotFoundError:
        return [
            {"day": day, "entry": e, "side": s, "slip": p, "error": "ERR no data"}
            for e, s, p in items
        ]
    return simulate_items(rule, data, items, _early_reference())


def ensure(
    root: Path,
    rule: CompiledRule,
    wanted: set[Key],
    workers: int = 4,
    progress: Callable[[str], None] | None = None,
) -> dict[Key, dict[str, Any]]:
    """Every wanted simulation, from the cache or run now (and appended to the cache). A day with no
    data, or a simulation that errors, is simply absent from the answer."""
    cache, torn = read_cache_counted(root, rule.template_hash)
    if torn and progress:
        progress(f"skipped {torn} torn simulation-cache rows; they are simulated again")
    missing = sorted(k for k in wanted if k not in cache)
    if missing:
        by_day: dict[str, list[tuple[str, str, float]]] = {}
        for day, entry, side, slip in missing:
            by_day.setdefault(day, []).append((entry, side, slip))
        spec_data = rule.spec.model_dump(by_alias=True)
        tasks = [
            (str(root), spec_data, day, sorted(items)) for day, items in sorted(by_day.items())
        ]
        if progress:
            progress(
                f"simulating {len(missing)} entries over {len(tasks)} days "
                f"({len(wanted) - len(missing)} cached)"
            )
        path = cache_path(root, rule.template_hash)
        path.parent.mkdir(parents=True, exist_ok=True)
        new = not path.exists() or path.stat().st_size == 0
        _end_line(path)
        with path.open("a", newline="") as handle, ProcessPoolExecutor(workers) as pool:
            writer = csv.DictWriter(handle, fieldnames=COLUMNS, restval="")
            if new:
                writer.writeheader()
            for k, rows in enumerate(pool.map(_work, tasks, chunksize=2), 1):
                for row in rows:
                    writer.writerow({c: row.get(c, "") for c in COLUMNS})
                    if not row.get("error"):
                        cache[(row["day"], row["entry"], row["side"], float(row["slip"]))] = row
                handle.flush()  # one day at a time, so a kill loses at most a part-written row
                if k % 25 == 0 and progress:
                    progress(f"  {k}/{len(tasks)} days")
    return {k: cache[k] for k in wanted if k in cache}


def net(underlying: str, row: dict[str, Any]) -> float:
    """Net after brokerage and statutory charges."""
    c = charges.day_charges(
        underlying,
        row["day"],
        int(row["orders"]),
        float(row["buy_value"]),
        float(row["sell_value"]),
    )
    return float(row["gross"]) - c.total
