"""Review large stock-price drops against the cached, whole-market NSE action feed.

The volume/turnover ratio estimates the reciprocal change in traded price; it is
not evidence of a split by itself. An exchange split/bonus filing with a
compatible factor, or a recorded human review, can adjust a backtest.
Other drops remain review items.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import duckdb
import pandas as pd

from .stocks import adjust, corporate_actions
from .stocks.schemas import EventKind

MIN_DROP = 0.201
FACTOR_TOLERANCE = 0.30
CURATED_REVIEWS_PATH = (
    Path(__file__).with_name("stocks") / "curated" / "historical_action_reviews.csv"
)
_BONUS_RATIO = re.compile(
    r"\bbonus(?:\s+shares)?(?:\s+in\s+the\s+ratio\s+of)?\s*[-–]?\s*(\d+)\s*:\s*(\d+)",
    re.IGNORECASE,
)
_SPLIT_RATIO = re.compile(
    r"\bfrom\s+R[se]\.?\s*(\d+(?:\.\d+)?)\s*/?-?\s*(?:each\s*)?"
    r"to\s+R[se]\.?\s*(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def _exchange_events(
    raw_dir: Path,
) -> tuple[
    dict[tuple[str, date], tuple[float, str, str]],
    dict[tuple[str, date], tuple[str, str]],
]:
    """Share factors and other same-day filings from the cached NSE feed."""
    feed = adjust.load_ca_feed_local(raw_dir)
    found: dict[tuple[str, date], list[tuple[float, str, str]]] = defaultdict(list)
    other: dict[tuple[str, date], tuple[str, str]] = {}
    for row in feed.itertuples(index=False):
        symbol = str(row.symbol).strip().upper()
        ex_date = corporate_actions.parse_ca_date(row.exDate)
        if not symbol or ex_date is None:
            continue
        subject = str(row.subject)
        lower = subject.lower()
        other_kind = next(
            (
                kind
                for word, kind in (
                    ("demerger", "demerger"),
                    ("scheme", "scheme"),
                    ("rights", "rights"),
                    ("dividend", "dividend"),
                )
                if word in lower
            ),
            None,
        )
        if other_kind is not None:
            other[(symbol, ex_date)] = (other_kind, subject)
        face_value = pd.to_numeric(row.faceVal, errors="coerce")
        parsed = corporate_actions.parse_subject(
            str(row.subject), float(face_value) if pd.notna(face_value) else 0.0
        )
        # The full stock-data parser deliberately leaves combined dividend+bonus
        # subjects manual, because it also needs an exact cash-dividend basis.
        # Here we need only the explicit *share-count* ratio. The NSE feed also
        # writes "Bonus - 1:1", which that parser's anchored ratio misses.
        if len(parsed) == 1 and parsed[0].kind == EventKind.MANUAL_ONLY:
            subject = str(row.subject)
            blocked = re.search(
                r"scheme|demerger|rights|capital reduction|debenture|preference",
                subject,
                re.IGNORECASE,
            )
            if not blocked:
                parsed = []
                bonus = _BONUS_RATIO.search(subject)
                if bonus:
                    new, old = int(bonus.group(1)), int(bonus.group(2))
                    if old > 0:
                        parsed.append((EventKind.BONUS, (new + old) / old))
                split = corporate_actions._SPLIT_RE.search(subject)
                if split is None and "split" in subject.lower():
                    split = _SPLIT_RATIO.search(subject)
                if split and float(split.group(2)) > 0:
                    parsed.append((EventKind.SPLIT, float(split.group(1)) / float(split.group(2))))
            else:
                parsed = []
        else:
            parsed = [
                (event.kind, 1.0 / float(event.factor))
                for event in parsed
                if event.kind in (EventKind.SPLIT, EventKind.BONUS) and event.factor
            ]
        for kind, share_factor in parsed:
            if share_factor <= 0:
                continue
            item = (share_factor, str(kind), str(row.subject))
            if item not in found[(symbol, ex_date)]:
                found[(symbol, ex_date)].append(item)

    out = {}
    for key, items in found.items():
        factor = 1.0
        for item in items:
            factor *= item[0]
        out[key] = (
            factor,
            "+".join(sorted({item[1] for item in items})),
            "; ".join(dict.fromkeys(item[2] for item in items)),
        )
    return out, other


def scan_and_store(con: duckdb.DuckDBPyConnection, raw_dir: Path) -> dict[str, int]:
    """Scan all available stock history after migration; replace the derived review table."""
    with CURATED_REVIEWS_PATH.open(newline="") as handle:
        curated = list(csv.DictReader(handle))
    con.executemany(
        """INSERT INTO stock_action_reviews
           (symbol, ex_date, decision, factor, source_url, note)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (symbol, ex_date) DO NOTHING""",
        [
            (
                row["symbol"],
                date.fromisoformat(row["ex_date"]),
                row["decision"],
                float(row["factor"]) if row["factor"] else None,
                row["source_url"] or None,
                row["note"] or None,
            )
            for row in curated
        ],
    )
    baseline = con.execute(
        "SELECT manual_review_after FROM stock_action_scan_state WHERE id=1"
    ).fetchone()
    if baseline is None:
        latest = con.execute("SELECT max(date) FROM bars_1d_stock").fetchone()[0]
        if latest is not None:
            con.execute(
                "INSERT INTO stock_action_scan_state (id, manual_review_after) VALUES (1, ?)",
                [latest],
            )
    exchange, other_filings = _exchange_events(raw_dir)
    reviews = {
        (symbol, ex_date): (decision, factor, source_url, note)
        for symbol, ex_date, decision, factor, source_url, note in con.execute(
            "SELECT symbol, ex_date, decision, factor, source_url, note FROM stock_action_reviews"
        ).fetchall()
    }
    rows = con.execute(
        """
        WITH daily AS (
            SELECT i.symbol, b.date AS ex_date, b.close, b.volume, b.turnover,
                   lag(b.close) OVER w AS previous_close,
                   lag(b.volume) OVER w AS previous_volume,
                   lag(b.turnover) OVER w AS previous_turnover
            FROM bars_1d_stock b JOIN instruments i USING (instrument_id)
            WINDOW w AS (PARTITION BY i.symbol ORDER BY b.date)
        )
        SELECT symbol, ex_date, previous_close, close, previous_volume, volume,
               previous_turnover, turnover
        FROM daily
        WHERE previous_close > 0 AND close > 0
          AND close / previous_close <= ?
        ORDER BY symbol, ex_date
        """,
        [1.0 - MIN_DROP],
    ).fetchall()

    records = []
    cumulative: dict[str, float] = defaultdict(lambda: 1.0)
    for (
        symbol,
        ex_date,
        previous_close,
        close,
        previous_volume,
        volume,
        previous_turnover,
        turnover,
    ) in rows:
        ex_date = pd.Timestamp(ex_date).date()
        implied = None
        if previous_volume and volume and previous_turnover and turnover:
            implied = (volume / previous_volume) / (turnover / previous_turnover)
        suggested = round(implied, 1) if implied is not None else None
        filing = exchange.get((symbol, ex_date))
        other_filing = other_filings.get((symbol, ex_date))
        manual = reviews.get((symbol, ex_date))
        filing_confirmed = (
            filing is not None
            and implied is not None
            and abs(implied / filing[0] - 1.0) <= FACTOR_TOLERANCE
        )
        status = "confirmed" if filing_confirmed else "review"
        factor = filing[0] if filing_confirmed and filing is not None else None
        event_kind = filing[1] if filing else other_filing[0] if other_filing else None
        source = "NSE corporate actions" if filing or other_filing else None
        subject = filing[2] if filing else other_filing[1] if other_filing else None
        if manual is not None:
            decision, manual_factor, source_url, note = manual
            status = "crash" if decision == "crash" else "confirmed"
            factor = float(manual_factor) if status == "confirmed" else None
            event_kind = decision
            source = source_url or "Manual review"
            subject = note
        if factor is not None:
            cumulative[symbol] *= factor
        records.append(
            (
                symbol,
                ex_date,
                previous_close,
                close,
                previous_volume,
                volume,
                previous_turnover,
                turnover,
                implied,
                suggested,
                factor,
                cumulative[symbol] if factor is not None else None,
                status,
                event_kind,
                source,
                subject,
            )
        )

    con.execute("BEGIN TRANSACTION")
    try:
        con.execute("DELETE FROM stock_action_candidates")
        if records:
            con.executemany(
                "INSERT INTO stock_action_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                records,
            )
        con.execute("UPDATE stock_action_scan_state SET last_scanned_at=now() WHERE id=1")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {
        "candidates": len(records),
        "confirmed": sum(row[12] == "confirmed" for row in records),
        "crash": sum(row[12] == "crash" for row in records),
        "review": sum(row[12] == "review" for row in records),
    }


def confirmed_factors(
    con: duckdb.DuckDBPyConnection, symbols: list[str]
) -> dict[str, list[tuple[pd.Timestamp, float]]]:
    """Confirmed share-count multipliers; never return heuristic-only suggestions."""
    if not symbols:
        return {}
    rows = con.execute(
        "SELECT symbol, ex_date, confirmed_factor FROM stock_action_candidates "
        "WHERE status = 'confirmed' AND symbol IN (SELECT unnest(?)) ORDER BY symbol, ex_date",
        [symbols],
    ).fetchall()
    out: dict[str, list[tuple[pd.Timestamp, float]]] = defaultdict(list)
    for symbol, ex_date, factor in rows:
        out[symbol].append((pd.Timestamp(ex_date), float(factor)))
    return dict(out)


def classified_crashes(
    con: duckdb.DuckDBPyConnection, symbols: list[str]
) -> set[tuple[str, pd.Timestamp]]:
    """Known genuine falls must not be segmented by the old turnover heuristic."""
    if not symbols:
        return set()
    rows = con.execute(
        "SELECT symbol, ex_date FROM stock_action_candidates "
        "WHERE status='crash' AND symbol IN (SELECT unnest(?))",
        [symbols],
    ).fetchall()
    return {(symbol, pd.Timestamp(ex_date)) for symbol, ex_date in rows}


def review_snapshot(con: duckdb.DuckDBPyConnection, limit: int = 50) -> dict:
    baseline_row = con.execute(
        "SELECT manual_review_after FROM stock_action_scan_state WHERE id=1"
    ).fetchone()
    baseline = baseline_row[0] if baseline_row else date.today()
    counts = dict(
        con.execute(
            """SELECT a.status, count(*) FROM stock_action_candidates a
           WHERE EXISTS (SELECT 1 FROM category_membership m
                         WHERE m.category='Total Market' AND m.symbol=a.symbol)
           GROUP BY a.status"""
        ).fetchall()
    )
    pending_count = con.execute(
        """SELECT count(*) FROM stock_action_candidates a
           WHERE a.status='review' AND a.ex_date > ?
             AND EXISTS (SELECT 1 FROM category_membership m
                         WHERE m.category='Total Market' AND m.symbol=a.symbol)""",
        [baseline],
    ).fetchone()[0]
    rows = con.execute(
        """SELECT symbol, ex_date, previous_close, close, previous_volume, volume,
                  previous_turnover, turnover, implied_factor, suggested_factor,
                  confirmed_factor, cumulative_factor, status, event_kind, subject
           FROM stock_action_candidates a
           WHERE a.status='review' AND a.ex_date > ?
             AND EXISTS (SELECT 1 FROM category_membership m
                         WHERE m.category='Total Market' AND m.symbol=a.symbol)
           ORDER BY a.ex_date DESC
           LIMIT ?""",
        [baseline, limit],
    ).fetchall()
    columns = (
        "symbol",
        "ex_date",
        "previous_close",
        "close",
        "previous_volume",
        "volume",
        "previous_turnover",
        "turnover",
        "implied_factor",
        "suggested_factor",
        "confirmed_factor",
        "cumulative_factor",
        "status",
        "event_kind",
        "subject",
    )
    return {
        "counts": {
            "confirmed": counts.get("confirmed", 0),
            "crash": counts.get("crash", 0),
            "review": counts.get("review", 0),
        },
        "manual_review_after": baseline.isoformat(),
        "pending_count": pending_count,
        "items": [
            {**dict(zip(columns, row, strict=True)), "ex_date": row[1].isoformat()} for row in rows
        ],
    }


def save_review(
    con: duckdb.DuckDBPyConnection,
    *,
    symbol: str,
    ex_date: date,
    decision: str,
    factor: float | None,
    source_url: str | None,
    note: str | None,
) -> None:
    """Record a human classification and recompute cumulative factors in date order."""
    if decision not in {"split", "bonus", "crash"}:
        raise ValueError("decision must be split, bonus, or crash")
    if decision == "crash":
        factor = None
    elif factor is None or not 1.1 <= factor <= 100:
        raise ValueError("split/bonus share multiplier must be between 1.1 and 100")
    candidate = con.execute(
        "SELECT event_kind FROM stock_action_candidates WHERE symbol=? AND ex_date=?",
        [symbol, ex_date],
    ).fetchone()
    if candidate is None:
        raise ValueError("candidate not found")
    if candidate[0] in {"demerger", "scheme", "rights", "dividend"}:
        raise ValueError("this filing needs entitlement or cash payout valuation")
    con.execute(
        """INSERT INTO stock_action_reviews
           (symbol, ex_date, decision, factor, source_url, note)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (symbol, ex_date) DO UPDATE SET decision=excluded.decision,
             factor=excluded.factor, source_url=excluded.source_url,
             note=excluded.note, updated_at=now()""",
        [symbol, ex_date, decision, factor, source_url, note],
    )
    con.execute(
        """UPDATE stock_action_candidates
           SET status=?, confirmed_factor=?, event_kind=?, source=?, subject=?
           WHERE symbol=? AND ex_date=?""",
        [
            "crash" if decision == "crash" else "confirmed",
            factor,
            decision,
            source_url or "Manual review",
            note,
            symbol,
            ex_date,
        ],
    )
    rows = con.execute(
        "SELECT ex_date, confirmed_factor FROM stock_action_candidates "
        "WHERE symbol=? ORDER BY ex_date",
        [symbol],
    ).fetchall()
    cumulative = 1.0
    for event_date, event_factor in rows:
        if event_factor is not None:
            cumulative *= float(event_factor)
        con.execute(
            "UPDATE stock_action_candidates SET cumulative_factor=? WHERE symbol=? AND ex_date=?",
            [cumulative if event_factor is not None else None, symbol, event_date],
        )
