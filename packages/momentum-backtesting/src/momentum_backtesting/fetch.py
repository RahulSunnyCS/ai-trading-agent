"""Build the weekly close table for every index in universe.csv.

Price source prefixes in the `price_source` column:
  NSE:...                      Fyers daily candles (index or ETF symbol)
  AMFI:<code>                  mutual fund NAV (cash series)
  INDEXFX:<index>:<fx>:<when>  foreign index x FX from Yahoo; <when> is `prev` (use the
                               previous close - US markets) or `same` (Hong Kong)
  SILVER                       COMEX x USD/INR spliced with SILVERBEES

The optional `backfill` column (`NIFTYINDICES:<NSE index name>`) extends a Fyers series
back in time with NSE's official history where Fyers' own history starts later.
"""

import csv
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

import pandas as pd

from . import fyers
from .config import DATA_DIR, HISTORY_START, UNIVERSE_CSV
from .sources import amfi_nav, index_in_inr, niftyindices_daily, silver_weekly, weekly


@dataclass(frozen=True)
class Instrument:
    include: str  # core / optional / defensive
    group: str
    name: str
    trade_etf: str
    tax_class: str
    price_source: str
    backfill: str
    note: str


def load_universe() -> list[Instrument]:
    with UNIVERSE_CSV.open() as f:
        return [
            Instrument(
                r["include"],
                r["group"],
                r["index"],
                r["trade_etf"],
                r["tax_class"],
                r["price_source"],
                r.get("backfill", ""),
                r["note"],
            )
            for r in csv.DictReader(f)
        ]


def backfill(primary: pd.Series, older: pd.Series) -> tuple[pd.Series, float]:
    """Prepend `older` history from before `primary` starts, scaled so the two join
    without a jump. Returns (combined series, older/primary level ratio at the join)."""
    if primary.empty or older.empty:
        return (older if primary.empty else primary), float("nan")
    first = primary.index[0]
    overlap = older.index[older.index >= first]
    if overlap.empty or older.index[0] >= first:
        return primary, float("nan")
    join = overlap[0]
    ratio = older[join] / primary[primary.index >= join].iloc[0]
    head = older[older.index < first] / ratio
    return pd.concat([head, primary]), ratio


def fetch_all(
    use_fyers: bool = True, log: Callable[[str], None] = print
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (weekly closes: week x index, coverage per index) and writes both to DATA_DIR."""
    start, end = HISTORY_START, date.today()
    creds = fyers.resolve_credentials() if use_fyers else None
    if creds:
        log(f"Fyers token from {creds.source}")

    daily_dir = DATA_DIR / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)
    columns: dict[str, pd.Series] = {}
    failures: dict[str, str] = {}

    for inst in load_universe():
        source = inst.price_source
        try:
            if source.startswith("NSE:"):
                if creds is None:
                    continue
                daily = fyers.daily_closes(source, start, end, creds)
            elif source.startswith("AMFI:"):
                daily = amfi_nav(source.removeprefix("AMFI:"), start)
            elif source.startswith("INDEXFX:"):
                _, index_symbol, fx_symbol, when = source.split(":")
                daily = index_in_inr(index_symbol, fx_symbol, start, previous_close=when == "prev")
            elif source == "SILVER":
                prices, labels = silver_weekly(start)
                pd.DataFrame({"close": prices, "source": labels}).to_csv(
                    daily_dir / "Silver (weekly).csv", index_label="week_ending"
                )
                columns[inst.name] = prices
                log(f"  {inst.name:<24} {len(prices):>4} weeks from {prices.index[0].date()}")
                continue
            else:
                raise ValueError(f"unknown price source {source!r}")
        except fyers.FyersCredentialsError:
            raise
        except Exception as error:  # one bad symbol shouldn't stop the rest
            failures[inst.name] = str(error)
            log(f"  {inst.name:<24} FAILED: {error}")
            continue

        extra = ""
        if inst.backfill.startswith("NIFTYINDICES:"):
            try:
                older = niftyindices_daily(inst.backfill.removeprefix("NIFTYINDICES:"), start, end)
                before = daily.index[0] if not daily.empty else None
                daily, ratio = backfill(daily, older)
                if before is not None and daily.index[0] < before:
                    extra = f"  (NSE backfill before {before.date()}, levels match {ratio:.4f})"
                    if abs(ratio - 1) > 0.02:
                        extra += "  <- CHECK: sources disagree on level"
            except Exception as error:
                extra = f"  (backfill failed: {error})"

        if daily.empty:
            failures[inst.name] = "no data returned"
            log(f"  {inst.name:<24} no data returned")
            continue
        daily.rename("close").to_csv(daily_dir / f"{inst.name}.csv", index_label="date")
        columns[inst.name] = weekly(daily)
        log(f"  {inst.name:<24} {len(daily):>4} days  from {daily.index[0].date()}{extra}")

    table = pd.DataFrame(columns).sort_index()
    table = table[table.index >= pd.Timestamp(start)]
    if len(table) and table.index[-1].date() > end:
        table = table.iloc[:-1]  # current week isn't finished yet
    table.index.name = "week_ending"

    coverage = pd.DataFrame(
        {
            "first_week": {c: table[c].first_valid_index() for c in table},
            "last_week": {c: table[c].last_valid_index() for c in table},
            "weeks": table.notna().sum(),
        }
    )
    for name, error in failures.items():
        coverage.loc[name, "error"] = error
    coverage.index.name = "index"

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    table.to_csv(DATA_DIR / "weekly_closes.csv")
    with pd.ExcelWriter(DATA_DIR / "weekly_closes.xlsx") as xl:
        table.to_excel(xl, sheet_name="weekly_closes")
        coverage.to_excel(xl, sheet_name="coverage")
    return table, coverage
