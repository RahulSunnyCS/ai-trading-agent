"""
BL-024 Phases 2-3 wired to the data: the forward score (`forward_score.score`) over the real
journal and price tables, and the Kite fills reconciliation (`forward_fills.reconcile`) over the
contract notes, the lot ledger and the 14:15 orders.

Used by `mbt journal score` (the Friday 20:30 `momentum-journal-score` job), by
`GET /api/journal/forward`, and by the 19:30 weekly run for the headline's one Telegram line.
Read-only everywhere: the only write is `forward_scores.json` in the state dir, by the CLI.
Catalog rule as everywhere here: a connection is open only around one short read, never across
a ranking or a backtest.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any

import pandas as pd

from . import forward_fills as ff
from . import forward_journal as journal
from . import forward_score as fs
from . import holdings_store, lots, monday_fills, runs_store, this_week
from .config import PACKAGE_ROOT
from .db_read import read_catalog, stock_bars
from .engine import CASH


def _names(rows: list[dict]) -> set[str]:
    out = {CASH}
    for row in rows:
        out |= set(json.loads(row["holdings_before"]))
        signal = json.loads(row["signal"])
        out |= set(signal.get("target_weights") or {})
    return out


def compute_score(*, only: set[str] | None = None, rerun: bool = True) -> dict:
    """Phase 2 over the live journal. `rerun` also runs each scored config through today's code
    for the "backtest now" figure (one engine pass per config; the rankings are cached)."""
    from . import api

    with read_catalog() as con:
        rows = journal.entries(con)
        groups = runs_store.list_groups(con)
    names = _names(rows)
    first_week = pd.Timestamp(min((r["week"] for r in rows), default="2026-01-01"))
    # Keyed by id(ranking) and holding the ranking itself, so an evicted ranking's id is never
    # reused for another (DATA keeps only a few rankings).
    tables: dict[int, tuple[Any, fs.PriceTables]] = {}
    results: dict[str, Any] = {}

    def request(settings: dict):
        return api.BacktestRequest.model_validate(settings)

    def prices_for(settings: dict) -> fs.PriceTables | None:
        if settings.get("dataset") != "broad":
            return None  # only Broad favourites are journalled today; others say so
        ranking = api._broad_ranking(request(settings))
        key = id(ranking)
        if key not in tables or tables[key][0] is not ranking:
            close = ranking.prices
            outer = api.DATA.get()
            extra = [c for c in outer.columns if c not in close.columns and c in names]
            close = close.join(outer[extra].reindex(close.index))
            keep = [c for c in close.columns if c in names]
            close = close.loc[close.index >= first_week - pd.Timedelta(days=21), keep]
            try:
                stock_cols = {
                    c: ranking.column_to_base_symbol[c]
                    for c in keep
                    if c in ranking.column_to_base_symbol
                }
                monday = monday_fills.build(close, stock_cols).prices
            except Exception:  # Monday opens are the second figure; never lose the first
                monday = None
            tables[key] = (ranking, fs.PriceTables(close=close, monday=monday))
        return tables[key][1]

    def backtest_now(settings: dict, week: str, next_week: str) -> float | None:
        if not rerun or settings.get("dataset") != "broad":
            return None
        key = journal.canonical(settings)
        if key not in results:
            req = request(settings)
            results[key] = api._run_broad(req, api._broad_ranking(req), api.DATA.get()).result
        return fs.backtest_week(results[key], week, next_week)

    is_ancestor = fs.git_is_ancestor(PACKAGE_ROOT)
    out = fs.score(
        rows,
        prices_for=prices_for,
        backtest_now=backtest_now if rerun else None,
        versions=lambda commit: fs.ranking_version(commit, is_ancestor=is_ancestor),
        groups=groups,
        only=only,
    )
    out["computed_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    out["code_commit"] = journal.code_commit()
    out["ranking_now"] = fs.ranking_version(out["code_commit"], is_ancestor=is_ancestor)
    out["rerun"] = rerun
    return out


def headline_line() -> str | None:
    """The forward-score line for the headline's Friday message (a group's from its sleeves)."""
    with read_catalog() as con:
        favourites = runs_store.list_favorites(con, include_groups=True)
        groups = runs_store.list_groups(con)
    headline = next((f for f in favourites if f.get("active")), None)
    if headline is None:
        return None
    members = next((g for g in groups if g["id"] == headline["id"]), None)
    only = {m["id"] for m in members["members"]} if members else {headline["id"]}
    # No re-run here: the 19:30 run has just computed these backtests, and the message should
    # not wait for them again. The 20:30 job adds the today's-code figure for the page.
    return fs.headline_line(compute_score(only=only, rerun=False), headline)


def compute_fills() -> dict:
    """Phase 3: every real rebalance of the lots the ledger knows, from the paper start on."""
    from trading_data.db import data_root

    root = data_root()
    start = this_week.paper_start()
    if not (root / "catalog.duckdb").exists():  # a fresh checkout: nothing to reconcile
        return {"paper_start": start, "groups": [], "notes": [], "computed_at": None}
    with read_catalog() as con:
        who = holdings_store.owner()
        rows = journal.entries(con)
        settings = holdings_store.settings(con, who)
        weeks = [
            str(w)[:10]
            for (w,) in con.execute(
                "SELECT DISTINCT week FROM momentum_orders WHERE owner = ? ORDER BY 1", [who]
            ).fetchall()
        ]
        orders = [o for w in weeks for o in holdings_store.orders_for(con, who, w)]
        group_ids = [
            g
            for (g,) in con.execute(
                "SELECT DISTINCT group_id FROM momentum_lot_events WHERE owner = ? "
                "UNION SELECT group_id FROM momentum_lot_state WHERE owner = ?",
                [who, who],
            ).fetchall()
        ]
        books = []
        for group_id in group_ids:
            pending, planned = lots.pending_state(con, who, group_id)
            at = con.execute(
                "SELECT updated_at FROM momentum_lot_state WHERE owner = ? AND group_id = ?",
                [who, group_id],
            ).fetchone()
            books.append(
                {
                    "group_id": group_id,
                    "events": lots.history(con, who, group_id),
                    "planned": planned,
                    "planned_at": at[0] if at else "",
                }
            )
        groups = {g["id"]: g for g in runs_store.list_groups(con)}
    fills, notes = ff.kite_fills(root, start=start)
    out: dict[str, Any] = {"paper_start": start, "groups": [], "notes": notes}
    for book in books:
        group = groups.get(book["group_id"], {"id": book["group_id"], "name": book["group_id"]})
        sleeves = [m["id"] for m in group.get("members", [])] or sorted(
            {e["sleeve_id"] for e in book["events"]}
        )
        labels = _lot_labels(orders, sleeves)
        symbols = {f.symbol for f in fills} | {
            ff._base(n)
            for r in rows
            if r["config_id"] in labels
            for n in json.loads(r["signal"]).get("target_weights") or {}
        }
        raw, days = _raw_prices(sorted(symbols), start)
        result = ff.reconcile(
            journal_rows=rows,
            lot_sleeves=labels,
            events=book["events"],
            planned=book["planned"],
            planned_at=book["planned_at"],
            orders=orders,
            fills=fills,
            notes=notes,
            raw_prices=raw,
            next_session=ff.next_sessions(sorted({str(r["week"])[:10] for r in rows}), days),
            paper_start=start,
            lot_size=float(settings.get("lot_size_rs") or 50000.0),
        )
        out["groups"].append({"group_id": group["id"], "name": group["name"], **result})
    out["computed_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    return out


def _lot_labels(orders: list[dict], sleeves: list[str]) -> dict[str, str]:
    """{sleeve_id: "Lot N"} as the newest orders named them; a sleeve they never named keeps
    its place in the group."""
    labels: dict[str, str] = {}
    for order in orders:
        for lot in order.get("lots") or []:
            if lot.get("id") in sleeves and lot.get("label"):
                labels[lot["id"]] = lot["label"]
    for index, sleeve in enumerate(sleeves, start=1):
        labels.setdefault(sleeve, f"Sleeve {index}")
    return labels


def _raw_prices(
    symbols: list[str], start: str | None
) -> tuple[dict[tuple[str, str], tuple[float | None, float | None]], list[str]]:
    """Each symbol's traded (unadjusted) open and close per day from the stock lake, and every
    day with a bar."""
    if not symbols:
        return {}, []
    since = (pd.Timestamp(start or "2026-01-01") - pd.Timedelta(days=10)).strftime("%Y-%m-%d")
    with stock_bars() as con:
        rows = con.execute(
            "SELECT strftime(b.date, '%Y-%m-%d'), i.symbol, b.open, b.close FROM bars_1d_stock b "
            "JOIN instruments i USING (instrument_id) "
            "WHERE i.symbol IN (SELECT unnest(?)) AND b.date >= CAST(? AS DATE)",
            [symbols, since],
        ).fetchall()
    prices = {(s, d): (o, c) for d, s, o, c in rows}
    return prices, sorted({d for d, *_ in rows})


_FILLS_CACHE: dict[str, Any] = {}


def _fills_stamp() -> tuple:
    """What the fills are computed from: the contract-notes day files (names, sizes, times), the
    catalog's modification time (the ledger, orders and bars live there) and the paper start. A
    page load with none of them changed reuses the last answer."""
    from trading_data.db import data_root

    from .db_read import catalog_mtime

    root = data_root()
    folder = root / "contract-notes" / "days"
    notes = (
        tuple(sorted((e.name, e.stat().st_size, e.stat().st_mtime_ns) for e in os.scandir(folder)))
        if folder.is_dir()
        else ()
    )
    return (str(root), notes, catalog_mtime(root), this_week.paper_start())


def view() -> dict:
    """GET /api/journal/forward: the stored score (the Friday job's) and the fills, live."""
    score = fs.load(this_week.state_dir())
    stored_fills = score.pop("fills", None) if score else None
    try:
        stamp = _fills_stamp()
        cached = _FILLS_CACHE.get("value")
        if cached is not None and _FILLS_CACHE.get("stamp") == stamp:
            fills = cached
        else:
            fills = compute_fills()
            _FILLS_CACHE.update(stamp=stamp, value=fills)
        fills_error = None
    except Exception as error:  # the score must still show; the job's copy is the fallback
        fills, fills_error = stored_fills, f"{type(error).__name__}: {error}"
    return {
        "score": score,
        "fills": fills,
        "fills_error": fills_error,
        "paper_start": this_week.paper_start(),
    }
