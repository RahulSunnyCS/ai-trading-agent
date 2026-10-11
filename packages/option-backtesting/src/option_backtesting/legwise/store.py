"""
Leg-wise strategies and their results in the trading-data catalog
(strategies / strategy_versions / backtest_runs / backtest_days / backtest_trades).

A strategy version is identified by a hash of its VALIDATED spec (not the file's
bytes), so reformatting or re-commenting a YAML file is not a new version, but
changing any setting is. Results always point at the version that produced them.

Daily results (`obt daily`) use a deterministic run id, `daily:<version>:<day>`, so
re-running a day replaces its result instead of adding a second one. Ad-hoc
backtests from the dashboard's builder are kept too (kind `adhoc`, random id).

Returned records keep the shape `obt daily`, the dashboard and Telegram already
use: {strategy_id, strategy_sha, day, gross, costs, net, worst_mtm, best_mtm,
stopped_by, notes, trades: [{leg, contract, entry, entry_price, exit, exit_price,
reason, pnl}]}.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime, time, timedelta, timezone

import duckdb
from trading_data.instruments import instrument_key

from .engine import DayResult
from .market import SESSION_START_MIN, minute_label
from .schema import LegwiseStrategy

PACKAGE = "options_legwise"
_IST = timezone(timedelta(hours=5, minutes=30))
_EXCHANGE = {"SENSEX": "BSE"}  # everything else is NSE


def spec_hash(strategy: LegwiseStrategy) -> str:
    canonical = json.dumps(strategy.model_dump(mode="json"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def ensure_version(con: duckdb.DuckDBPyConnection, strategy: LegwiseStrategy) -> str:
    h = spec_hash(strategy)
    version_id = f"{strategy.id}:{h}"
    con.execute(
        "INSERT INTO strategies (strategy_id, package, name) VALUES (?, ?, ?) "
        "ON CONFLICT DO NOTHING",
        [strategy.id, PACKAGE, strategy.id],
    )
    con.execute(
        "INSERT INTO strategy_versions (version_id, strategy_id, spec_hash, spec) "
        "VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [version_id, strategy.id, h, json.dumps(strategy.model_dump(mode="json"))],
    )
    return version_id


def _epoch(day: date, minute: int) -> float:
    total = SESSION_START_MIN + minute
    return datetime.combine(day, time(total // 60, total % 60), _IST).timestamp()


def _summary(results: list[DayResult]) -> dict:
    nets = [r.net for r in results]
    running = peak = drawdown = 0.0
    for n in nets:
        running += n
        peak = max(peak, running)
        drawdown = min(drawdown, running - peak)
    return {
        "days": len(nets),
        "net": round(sum(nets), 2),
        "win_days": sum(1 for n in nets if n > 0),
        "max_drawdown": round(drawdown, 2),
        "trades": sum(len(r.trades) for r in results),
    }


def _save(
    con: duckdb.DuckDBPyConnection,
    strategy: LegwiseStrategy,
    version_id: str,
    run_id: str,
    kind: str,
    results: list[DayResult],
    params: dict | None = None,
) -> None:
    ex = _EXCHANGE.get(strategy.underlying, "NSE")
    keys = {
        t.contract: instrument_key(ex, "option", strategy.underlying, *t.contract)
        for r in results
        for t in r.trades
    }
    ids = dict(
        con.execute(
            "SELECT instrument_key, instrument_id FROM instruments WHERE instrument_key IN "
            "(SELECT unnest(?))",
            [list(set(keys.values())) or [""]],
        ).fetchall()
    )
    days = [r.day for r in results]
    con.execute("BEGIN")
    try:
        for table in ("backtest_trades", "backtest_days", "backtest_runs"):
            con.execute(f"DELETE FROM {table} WHERE run_id = ?", [run_id])
        con.execute(
            "INSERT INTO backtest_runs (run_id, version_id, kind, date_from, date_to, params, "
            "summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                run_id,
                version_id,
                kind,
                min(days) if days else None,
                max(days) if days else None,
                json.dumps(params or {}),
                json.dumps(_summary(results)),
            ],
        )
        for r in results:
            con.execute(
                "INSERT INTO backtest_days (run_id, day, gross, costs, net, worst_mtm, best_mtm, "
                "stopped_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    run_id,
                    r.day,
                    round(r.gross, 2),
                    round(r.costs, 2),
                    round(r.net, 2),
                    round(r.worst_mtm, 2),
                    round(r.best_mtm, 2),
                    r.stopped_by,
                    json.dumps(r.notes),
                ],
            )
            for seq, t in enumerate(r.trades):
                con.execute(
                    "INSERT INTO backtest_trades (run_id, day, seq, leg, instrument_id, side, qty, "
                    "entry_ts, entry_price, exit_ts, exit_price, exit_reason, pnl) VALUES "
                    "(?, ?, ?, ?, ?, ?, ?, to_timestamp(?), ?, to_timestamp(?), ?, ?, ?)",
                    [
                        run_id,
                        r.day,
                        seq,
                        t.leg_id,
                        ids.get(keys[t.contract]),
                        t.position,
                        t.qty,
                        _epoch(r.day, t.entry_min),
                        round(t.entry_price, 2),
                        _epoch(r.day, t.exit_min) if t.exit_min is not None else None,
                        round(t.exit_price, 2) if t.exit_price is not None else None,
                        t.exit_reason,
                        round(t.pnl, 2),
                    ],
                )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def save_daily(con: duckdb.DuckDBPyConnection, strategy: LegwiseStrategy, result: DayResult) -> str:
    version_id = ensure_version(con, strategy)
    run_id = f"daily:{version_id}:{result.day}"
    _save(con, strategy, version_id, run_id, "daily", [result])
    return run_id


def save_adhoc(
    con: duckdb.DuckDBPyConnection,
    strategy: LegwiseStrategy,
    results: list[DayResult],
    params: dict,
) -> str:
    version_id = ensure_version(con, strategy)
    run_id = f"adhoc:{uuid.uuid4().hex}"
    _save(con, strategy, version_id, run_id, "adhoc", results, params)
    return run_id


def _hhmm(epoch: float | None) -> str | None:
    return None if epoch is None else datetime.fromtimestamp(epoch, _IST).strftime("%H:%M")


def load_daily(con: duckdb.DuckDBPyConnection, day: date | None = None) -> list[dict]:
    """Every saved daily result (optionally one day), oldest first, in the record shape."""
    where = "AND d.day = ?" if day else ""
    rows = con.execute(
        f"""
        SELECT r.run_id, v.strategy_id, v.spec_hash, d.day, d.gross, d.costs, d.net,
               d.worst_mtm, d.best_mtm, d.stopped_by, d.notes
        FROM backtest_runs r
        JOIN strategy_versions v USING (version_id)
        JOIN backtest_days d USING (run_id)
        WHERE r.kind = 'daily' {where}
        ORDER BY d.day, v.strategy_id
        """,
        [day] if day else [],
    ).fetchall()
    trades: dict[str, list[dict]] = {}
    for run_id, leg, side, strike, opt, expiry, e_ts, e_px, x_ts, x_px, reason, pnl in con.execute(
        """
        SELECT t.run_id, t.leg, t.side, i.strike, i.option_type, i.expiry,
               epoch(t.entry_ts), t.entry_price, epoch(t.exit_ts), t.exit_price,
               t.exit_reason, t.pnl
        FROM backtest_trades t
        JOIN backtest_runs r USING (run_id)
        LEFT JOIN instruments i USING (instrument_id)
        WHERE r.kind = 'daily'
        ORDER BY t.run_id, t.seq
        """
    ).fetchall():
        contract = (
            f"{side.upper()} {strike:g}{opt} {expiry:%d%b}" if strike is not None else side.upper()
        )
        trades.setdefault(run_id, []).append(
            {
                "leg": leg,
                "contract": contract,
                "entry": _hhmm(e_ts),
                "entry_price": e_px,
                "exit": _hhmm(x_ts),
                "exit_price": x_px,
                "reason": reason,
                "pnl": pnl,
            }
        )
    return [
        {
            "strategy_id": sid,
            "strategy_sha": sha,
            "day": d.isoformat(),
            "gross": gross,
            "costs": costs,
            "net": net,
            "worst_mtm": worst,
            "best_mtm": best,
            "stopped_by": stopped,
            "notes": json.loads(notes) if notes else [],
            "trades": trades.get(run_id, []),
        }
        for (run_id, sid, sha, d, gross, costs, net, worst, best, stopped, notes) in rows
    ]


def load_daily_net(
    con: duckdb.DuckDBPyConnection, strategy_id: str | None = None
) -> dict[tuple[str, str], dict[date, float]]:
    """{(strategy_id, spec_hash): {day: net}} of the saved daily results: net P&L only, no trades
    (`load_daily` loads every trade of every day and cannot filter by strategy)."""
    where = "AND v.strategy_id = ?" if strategy_id else ""
    rows = con.execute(
        f"""
        SELECT v.strategy_id, v.spec_hash, d.day, d.net
        FROM backtest_runs r
        JOIN strategy_versions v USING (version_id)
        JOIN strategies s ON s.strategy_id = v.strategy_id
        JOIN backtest_days d USING (run_id)
        WHERE r.kind = 'daily' AND s.package = '{PACKAGE}' {where}
        ORDER BY v.strategy_id, v.spec_hash, d.day
        """,
        [strategy_id] if strategy_id else [],
    ).fetchall()
    out: dict[tuple[str, str], dict[date, float]] = {}
    for sid, sha, day, net in rows:
        out.setdefault((sid, sha), {})[day] = float(net)
    return out


def record(result: DayResult, strategy: LegwiseStrategy) -> dict:
    """The same record shape, straight from an in-memory result (no round trip)."""
    return {
        "strategy_id": strategy.id,
        "strategy_sha": spec_hash(strategy),
        "day": result.day.isoformat(),
        "gross": round(result.gross, 2),
        "costs": round(result.costs, 2),
        "net": round(result.net, 2),
        "worst_mtm": round(result.worst_mtm, 2),
        "best_mtm": round(result.best_mtm, 2),
        "stopped_by": result.stopped_by,
        "notes": result.notes,
        "trades": [
            {
                "leg": t.leg_id,
                "contract": t.describe(),
                "entry": minute_label(t.entry_min),
                "entry_price": round(t.entry_price, 2),
                "exit": minute_label(t.exit_min) if t.exit_min is not None else None,
                "exit_price": round(t.exit_price, 2) if t.exit_price is not None else None,
                "reason": t.exit_reason,
                "pnl": round(t.pnl, 2),
            }
            for t in result.trades
        ],
    }
