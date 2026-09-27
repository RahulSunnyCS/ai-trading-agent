"""Price history and weekly signals in Postgres (Neon free tier), so the weekly job in CI
starts from the full history instead of re-downloading it, and every signal is kept.

Connection: MOMENTUM_DATABASE_URL - deliberately not DATABASE_URL, which fyers.py already
reads for the trading database's broker_tokens.

The tables mirror the files in data/ one to one (see fetch.py), so `mbt db push` / `mbt db
pull` move a data folder in and out losslessly:

  momentum_prices   (instrument, kind, date) -> open, close
      kind: signal     data/daily/<name>.csv
            etf        data/daily_etf/<name>.csv
            at10_index data/intraday/index/<name>.csv   (close = the 10:00 price)
            at10_etf   data/intraday/etf/<name>.csv
            premium    data/etf_premium.csv             (close = close / NAV - 1)
            weekly     data/weekly_closes.csv           (date = the week's Friday)
  momentum_signals  (week, run_kind, config_label) -> the signal JSON sent to Telegram

Writes are upserts, so re-running a week is harmless.
"""

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pandas as pd

SCHEMA = """
CREATE TABLE IF NOT EXISTS momentum_prices (
    instrument  text             NOT NULL,
    kind        text             NOT NULL CHECK (
        kind IN ('signal', 'etf', 'at10_index', 'at10_etf', 'premium', 'weekly')
    ),
    date        date             NOT NULL,
    open        double precision,
    close       double precision NOT NULL,
    updated_at  timestamptz      NOT NULL DEFAULT now(),
    PRIMARY KEY (instrument, kind, date)
);
CREATE TABLE IF NOT EXISTS momentum_signals (
    week          date        NOT NULL,
    run_kind      text        NOT NULL CHECK (run_kind IN ('preview', 'final')),
    config_label  text        NOT NULL,
    generated_at  timestamptz NOT NULL DEFAULT now(),
    payload       jsonb       NOT NULL,
    PRIMARY KEY (week, run_kind, config_label)
);
"""

# kind -> (folder under data/, value column in the file)
FOLDERS = {
    "signal": ("daily", None),
    "etf": ("daily_etf", None),
    "at10_index": ("intraday/index", "price"),
    "at10_etf": ("intraday/etf", "price"),
}

Row = tuple[str, str, pd.Timestamp, float | None, float]


class StoreNotConfigured(RuntimeError):
    pass


def database_url() -> str:
    url = os.environ.get("MOMENTUM_DATABASE_URL", "").strip()
    if not url:
        raise StoreNotConfigured("MOMENTUM_DATABASE_URL is not set")
    return url


def connect(url: str | None = None):
    import psycopg

    return psycopg.connect(url or database_url(), connect_timeout=20)


def init_schema(conn) -> None:
    conn.execute(SCHEMA)
    conn.commit()


def _num(value) -> float | None:
    return None if pd.isna(value) else float(value)


def rows_from_dir(data_dir: Path, since: pd.Timestamp | None = None) -> Iterator[Row]:
    """Every price point in a data folder as (instrument, kind, date, open, close)."""
    for kind, (folder, value_col) in FOLDERS.items():
        for path in sorted((data_dir / folder).glob("*.csv")):
            if path.stem.endswith("(weekly)"):  # silver's splice log, rebuilt by fetch
                continue
            frame = pd.read_csv(path, index_col=0, parse_dates=True)
            name = path.stem
            if since is not None:
                frame = frame[frame.index >= since]
            close_col = value_col or "close"
            for day, row in frame.iterrows():
                if pd.isna(row[close_col]):
                    continue
                opened = _num(row["open"]) if value_col is None and "open" in frame else None
                yield name, kind, day, opened, float(row[close_col])
    for kind, file in (("premium", "etf_premium.csv"), ("weekly", "weekly_closes.csv")):
        path = data_dir / file
        if not path.exists():
            continue
        frame = pd.read_csv(path, index_col=0, parse_dates=True)
        if since is not None:
            frame = frame[frame.index >= since]
        for name in frame:
            for day, value in frame[name].dropna().items():
                yield name, kind, day, None, float(value)


def write_dir(rows: list[Row], data_dir: Path) -> None:
    """The inverse of rows_from_dir: rebuild the data folder's files from stored rows."""
    frame = pd.DataFrame(rows, columns=["instrument", "kind", "date", "open", "close"])
    frame["date"] = pd.to_datetime(frame["date"])
    for kind, (folder, value_col) in FOLDERS.items():
        part = frame[frame["kind"] == kind]
        for name, group in part.groupby("instrument"):
            out = group.set_index("date").sort_index()
            out.index.name = "date"
            target = data_dir / folder / f"{name}.csv"
            target.parent.mkdir(parents=True, exist_ok=True)
            if value_col:
                out[["close"]].rename(columns={"close": value_col}).to_csv(target)
            elif out["open"].notna().any():
                out[["open", "close"]].to_csv(target)
            else:
                out[["close"]].to_csv(target)
    for kind, file, index_name in (
        ("premium", "etf_premium.csv", "date"),
        ("weekly", "weekly_closes.csv", "week_ending"),
    ):
        part = frame[frame["kind"] == kind]
        if part.empty:
            continue
        wide = part.pivot(index="date", columns="instrument", values="close").sort_index()
        wide.index.name = index_name
        wide.columns.name = None
        data_dir.mkdir(parents=True, exist_ok=True)
        wide.to_csv(data_dir / file)


def upsert(conn, rows: list[Row]) -> int:
    """Insert or update price rows in one COPY + one INSERT ... ON CONFLICT."""
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TEMP TABLE incoming (LIKE momentum_prices INCLUDING DEFAULTS) ON COMMIT DROP"
        )
        with cur.copy("COPY incoming (instrument, kind, date, open, close) FROM STDIN") as copy:
            for name, kind, day, opened, close in rows:
                copy.write_row((name, kind, pd.Timestamp(day).date(), opened, close))
        cur.execute(
            """
            INSERT INTO momentum_prices (instrument, kind, date, open, close)
            SELECT DISTINCT ON (instrument, kind, date) instrument, kind, date, open, close
            FROM incoming
            ON CONFLICT (instrument, kind, date) DO UPDATE
               SET open = EXCLUDED.open, close = EXCLUDED.close, updated_at = now()
            """
        )
    conn.commit()
    return len(rows)


def fetch_rows(conn) -> list[Row]:
    with conn.cursor() as cur:
        cur.execute("SELECT instrument, kind, date, open, close FROM momentum_prices")
        return list(cur.fetchall())


def push_dir(conn, data_dir: Path, since: pd.Timestamp | None = None) -> int:
    return upsert(conn, list(rows_from_dir(data_dir, since)))


def pull_dir(conn, data_dir: Path) -> int:
    rows = fetch_rows(conn)
    write_dir(rows, data_dir)
    return len(rows)


def save_signal(conn, week: str, run_kind: str, label: str, payload: dict) -> None:
    conn.execute(
        """
        INSERT INTO momentum_signals (week, run_kind, config_label, payload)
        VALUES (%s, %s, %s, %s::jsonb)
        ON CONFLICT (week, run_kind, config_label) DO UPDATE
           SET payload = EXCLUDED.payload, generated_at = now()
        """,
        (week, run_kind, label, json.dumps(payload)),
    )
    conn.commit()


def load_signal(conn, week: str, run_kind: str, label: str) -> dict | None:
    row = conn.execute(
        "SELECT payload FROM momentum_signals WHERE week = %s AND run_kind = %s"
        " AND config_label = %s",
        (week, run_kind, label),
    ).fetchone()
    return row[0] if row else None
