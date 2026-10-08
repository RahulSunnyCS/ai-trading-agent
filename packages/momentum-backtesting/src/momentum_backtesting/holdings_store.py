"""Your orders' state in the shared catalog (BL-051 Phase 3; trading-data migration 011): the
owner's holdings snapshots, holding rules, order settings, and the orders computed each Friday.

Every row carries an owner ID (`owner()`: MOMENTUM_OWNER, default "rahul") so friends can be
added later; only the owner exists for now. Callers pass a connection from `db_read` and keep it
short (the package's catalog rule).
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any

import duckdb

from .notify import IST

DEFAULT_OWNER = "rahul"
SETTINGS_DEFAULTS = {
    "min_trade_rs": 10_000.0,
    "extra_cash_rs": 0.0,
    "holdings_source": "paper",
    "paper_capital_rs": 100_000.0,
    "updated_at": None,
}
SETTING_FIELDS = ("min_trade_rs", "extra_cash_rs", "holdings_source", "paper_capital_rs")


def owner() -> str:
    return os.environ.get("MOMENTUM_OWNER", "").strip() or DEFAULT_OWNER


def _now() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def settings(con: duckdb.DuckDBPyConnection, who: str) -> dict[str, Any]:
    row = con.execute(
        "SELECT min_trade_rs, extra_cash_rs, holdings_source, paper_capital_rs, updated_at "
        "FROM momentum_owner_settings WHERE owner = ?",
        [who],
    ).fetchone()
    if row is None:
        return {"owner": who, **SETTINGS_DEFAULTS}
    return {
        "owner": who,
        **dict(
            zip(
                (*SETTING_FIELDS[:2], "holdings_source", "paper_capital_rs", "updated_at"),
                row,
                strict=True,
            )
        ),
    }


def save_settings(con: duckdb.DuckDBPyConnection, who: str, **changes: Any) -> dict[str, Any]:
    current = settings(con, who)
    unknown = set(changes) - set(SETTING_FIELDS)
    if unknown:
        raise ValueError(f"Unknown settings: {', '.join(sorted(unknown))}")
    merged = {**current, **{k: v for k, v in changes.items() if v is not None}}
    if merged["holdings_source"] not in ("paper", "fyers"):
        raise ValueError("holdings_source must be 'paper' or 'fyers'.")
    for key in ("min_trade_rs", "extra_cash_rs", "paper_capital_rs"):
        if float(merged[key]) < 0:
            raise ValueError(f"{key} cannot be negative.")
    con.execute(
        "INSERT OR REPLACE INTO momentum_owner_settings "
        "(owner, min_trade_rs, extra_cash_rs, holdings_source, paper_capital_rs, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            who,
            float(merged["min_trade_rs"]),
            float(merged["extra_cash_rs"]),
            merged["holdings_source"],
            float(merged["paper_capital_rs"]),
            _now(),
        ],
    )
    return settings(con, who)


def save_holdings(
    con: duckdb.DuckDBPyConnection, who: str, source: str, rows: list[dict[str, Any]]
) -> str:
    """Store one complete snapshot; returns its `synced_at`."""
    synced_at = _now()
    con.execute("BEGIN")
    try:
        for row in rows:
            con.execute(
                "INSERT INTO momentum_holdings (owner, synced_at, source, symbol, quantity, "
                "avg_price) VALUES (?, ?, ?, ?, ?, ?)",
                [
                    who,
                    synced_at,
                    source,
                    row["symbol"],
                    float(row["quantity"]),
                    row.get("avg_price"),
                ],
            )
        if not rows:  # an empty account is a snapshot too: keep its time
            con.execute(
                "INSERT INTO momentum_holdings (owner, synced_at, source, symbol, quantity, "
                "avg_price) VALUES (?, ?, ?, '', 0, NULL)",
                [who, synced_at, source],
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return synced_at


def latest_holdings(con: duckdb.DuckDBPyConnection, who: str) -> dict[str, Any] | None:
    head = con.execute(
        "SELECT synced_at, source FROM momentum_holdings WHERE owner = ? "
        "ORDER BY synced_at DESC LIMIT 1",
        [who],
    ).fetchone()
    if head is None:
        return None
    rows = con.execute(
        "SELECT symbol, quantity, avg_price FROM momentum_holdings "
        "WHERE owner = ? AND synced_at = ? AND symbol <> '' ORDER BY symbol",
        [who, head[0]],
    ).fetchall()
    return {
        "synced_at": head[0],
        "source": head[1],
        "rows": [{"symbol": s, "quantity": q, "avg_price": p} for s, q, p in rows],
    }


def rules(con: duckdb.DuckDBPyConnection, who: str) -> dict[str, str]:
    return dict(
        con.execute(
            "SELECT symbol, treatment FROM momentum_holding_rules WHERE owner = ?", [who]
        ).fetchall()
    )


def set_rule(con: duckdb.DuckDBPyConnection, who: str, symbol: str, treatment: str | None) -> None:
    con.execute("DELETE FROM momentum_holding_rules WHERE owner = ? AND symbol = ?", [who, symbol])
    if treatment is not None:
        if treatment not in ("exclude", "cash"):
            raise ValueError("treatment must be 'exclude' or 'cash'.")
        con.execute(
            "INSERT INTO momentum_holding_rules (owner, symbol, treatment) VALUES (?, ?, ?)",
            [who, symbol, treatment],
        )


def save_orders(
    con: duckdb.DuckDBPyConnection,
    who: str,
    *,
    week: str,
    trigger: str,
    favourite_id: str,
    holdings_source: str,
    payload: dict[str, Any],
) -> str:
    created_at = _now()
    con.execute(
        "INSERT INTO momentum_orders (owner, week, created_at, trigger, favourite_id, "
        "holdings_source, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            who,
            week,
            created_at,
            trigger,
            favourite_id,
            holdings_source,
            json.dumps(payload, default=str),
        ],
    )
    return created_at


def orders_for(con: duckdb.DuckDBPyConnection, who: str, week: str) -> list[dict[str, Any]]:
    """Every set of orders made for `week`, oldest first."""
    rows = con.execute(
        "SELECT created_at, trigger, favourite_id, holdings_source, payload FROM momentum_orders "
        "WHERE owner = ? AND week = ? ORDER BY created_at",
        [who, week],
    ).fetchall()
    return [
        {
            "created_at": created_at,
            "trigger": trigger,
            "favourite_id": favourite_id,
            "holdings_source": source,
            **json.loads(payload),
        }
        for created_at, trigger, favourite_id, source, payload in rows
    ]
