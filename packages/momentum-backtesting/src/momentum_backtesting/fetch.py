"""Build the weekly close table for every index in universe.csv.

Price source prefixes in the `price_source` column:
  NSE:...                      Fyers daily candles (index or ETF symbol)
  AMFI:<code>                  mutual fund NAV (cash series)
  INDEXFX:<index>:<fx>:<when>  foreign index x FX from Yahoo; <when> is `prev` (use the
                               previous close - US markets) or `same` (Hong Kong)
  SILVER                       COMEX x USD/INR spliced with SILVERBEES

The optional `backfill` column (`NIFTYINDICES:<NSE index name>`) extends a Fyers series
back in time with NSE's official history where Fyers' own history starts later.

Besides the weekly signal table, fetch also keeps what trade_prices.py needs to price fills:
  data/daily/<name>.csv         the signal series, daily open (where known) and close
  data/daily_etf/<name>.csv     the traded ETF, daily open and close, unit splits undone
  data/etf_premium.csv          ETF close / NAV - 1 per day (for rows with an amfi_code)
  data/intraday/<kind>/<name>.csv  the 10:00 price per day (`--intraday` only; Fyers only)
`etf_source` is `NSE:<ETF>-EQ` (Fyers, Yahoo `<ETF>.NS` as fallback) or `SAME` when the
signal series already is what you'd hold (Gold, Silver, the liquid fund).
"""

import csv
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

import pandas as pd

from . import fyers
from .config import DATA_DIR, HISTORY_START, UNIVERSE_CSV
from .sources import (
    amfi_nav,
    index_in_inr,
    niftyindices_candles,
    silver_daily,
    silver_weekly,
    split_factors,
    weekly,
    yahoo_candles,
)

ETF_SAME = "SAME"
MAX_PREMIUM = 0.5  # |price/NAV - 1| beyond this is a unit mismatch, not a real premium


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
    etf_source: str = ETF_SAME
    amfi_code: str = ""
    ter_pct: float | None = None

    @property
    def has_etf(self) -> bool:
        return self.etf_source != ETF_SAME


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
                r.get("etf_source") or ETF_SAME,
                r.get("amfi_code") or "",
                float(r["ter_pct"]) if r.get("ter_pct") else None,
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


def backfill_frame(primary: pd.DataFrame, older: pd.DataFrame) -> tuple[pd.DataFrame, float]:
    """backfill() for open/close frames: both columns of the older history are scaled by the
    close's join ratio."""
    combined, ratio = backfill(primary["close"], older["close"])
    if combined.index[0] >= primary.index[0] or pd.isna(ratio):
        return primary, ratio
    head = older[older.index < primary.index[0]] / ratio
    return pd.concat([head, primary]), ratio


def _write(frame: pd.DataFrame | pd.Series, path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index_label="date")


def _signal_daily(inst: Instrument, start: date, end: date, creds) -> pd.DataFrame | None:
    """Daily open/close of the ranked series (open missing where the source has none).
    None for the silver splice, which is weekly - handled by the caller."""
    source = inst.price_source
    if source.startswith("NSE:"):
        return fyers.daily_candles(source, start, end, creds)
    if source.startswith("AMFI:"):
        return amfi_nav(source.removeprefix("AMFI:"), start).to_frame("close")
    if source.startswith("INDEXFX:"):
        _, index_symbol, fx_symbol, when = source.split(":")
        closes = index_in_inr(index_symbol, fx_symbol, start, previous_close=when == "prev")
        return closes.to_frame("close")
    if source == "SILVER":
        return None
    raise ValueError(f"unknown price source {source!r}")


def _etf_daily(inst: Instrument, start: date, end: date, creds) -> tuple[pd.DataFrame, str]:
    """The ETF's own daily open/close: Fyers when logged in, Yahoo otherwise."""
    if creds is not None:
        try:
            return fyers.daily_candles(inst.etf_source, start, end, creds), "fyers"
        except fyers.FyersCredentialsError:
            raise
        except Exception:  # fall through to Yahoo
            pass
    return yahoo_candles(f"{inst.trade_etf}.NS", start), "yahoo"


def fetch_etfs(
    start: date,
    end: date,
    creds,
    signal: dict[str, pd.DataFrame],
    log: Callable[[str], None] = print,
    intraday: bool = False,
) -> pd.DataFrame:
    """Fetch the traded ETFs (and, with an amfi_code, their NAV). Returns daily premiums."""
    premiums: dict[str, pd.Series] = {}
    for inst in load_universe():
        if not inst.has_etf or inst.name not in signal:
            continue
        try:
            raw, source = _etf_daily(inst, start, end, creds)
        except fyers.FyersCredentialsError:
            raise
        except Exception as error:
            log(f"  {inst.trade_etf:<12} ETF FAILED: {error}")
            continue
        if raw.empty:
            log(f"  {inst.trade_etf:<12} ETF: no data")
            continue
        factors = split_factors(raw["close"], signal[inst.name]["close"])
        adjusted = raw.mul(factors, axis=0)
        _write(adjusted, DATA_DIR / "daily_etf" / f"{inst.name}.csv")
        extra = ""
        splits = factors[factors.ne(factors.shift(-1))].iloc[:-1]
        if len(splits):
            days = ", ".join(str(d.date()) for d in splits.index)
            extra += f"  (unit split(s) undone before {days})"
        if inst.amfi_code:
            try:
                nav = amfi_nav(inst.amfi_code, start, adjust=False)
                premium = (raw["close"] / nav.reindex(raw.index) - 1).dropna()
                bad = premium.abs() > MAX_PREMIUM
                premiums[inst.name] = premium[~bad]
                last = premium[~bad].iloc[-1] if (~bad).any() else float("nan")
                extra += f"  premium now {last:+.2%}"
                if bad.any():
                    extra += f"  ({int(bad.sum())} days dropped: NAV/price units disagree)"
            except Exception as error:
                extra += f"  (NAV failed: {error})"
        if intraday and creds is not None:
            try:
                at10 = fyers.price_at(inst.etf_source, max(start, INTRADAY_START), end, creds)
                at10 = at10 * factors.reindex(at10.index).fillna(1.0)
                _write(at10.rename("price"), DATA_DIR / "intraday" / "etf" / f"{inst.name}.csv")
            except Exception as error:
                extra += f"  (10:00 prices failed: {error})"
        log(
            f"  {inst.trade_etf:<12} {len(raw):>4} days from {raw.index[0].date()} "
            f"via {source}{extra}"
        )
    table = pd.DataFrame(premiums).sort_index()
    table.index.name = "date"
    return table


# Fyers' 15-minute history is only used for the Monday-10:00 fill, so it isn't fetched for
# years before the backtest starts.
INTRADAY_START = date(2017, 1, 1)


def fetch_all(
    use_fyers: bool = True,
    log: Callable[[str], None] = print,
    etfs: bool = True,
    intraday: bool = False,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (weekly closes: week x index, coverage per index) and writes both to DATA_DIR,
    plus the daily files trade_prices.py reads (see the module docstring)."""
    start, end = HISTORY_START, date.today()
    creds = fyers.resolve_credentials() if use_fyers else None
    if creds:
        log(f"Fyers token from {creds.source}")

    daily_dir = DATA_DIR / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)
    columns: dict[str, pd.Series] = {}
    signal: dict[str, pd.DataFrame] = {}
    failures: dict[str, str] = {}

    for inst in load_universe():
        source = inst.price_source
        try:
            if source.startswith("NSE:") and creds is None:
                continue
            daily = _signal_daily(inst, start, end, creds)
            if daily is None:  # silver
                prices, labels = silver_weekly(start)
                pd.DataFrame({"close": prices, "source": labels}).to_csv(
                    daily_dir / "Silver (weekly).csv", index_label="week_ending"
                )
                columns[inst.name] = prices
                try:
                    signal[inst.name] = silver_daily(start).to_frame("close")
                    _write(signal[inst.name], daily_dir / f"{inst.name}.csv")
                except Exception as error:
                    log(f"  {inst.name:<24} (daily silver for fills failed: {error})")
                log(f"  {inst.name:<24} {len(prices):>4} weeks from {prices.index[0].date()}")
                continue
        except fyers.FyersCredentialsError:
            raise
        except Exception as error:  # one bad symbol shouldn't stop the rest
            failures[inst.name] = str(error)
            log(f"  {inst.name:<24} FAILED: {error}")
            continue

        extra = ""
        if inst.backfill.startswith("NIFTYINDICES:"):
            try:
                older = niftyindices_candles(
                    inst.backfill.removeprefix("NIFTYINDICES:"), start, end
                )
                before = daily.index[0] if not daily.empty else None
                daily, ratio = backfill_frame(daily, older) if before is not None else (older, 1.0)
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
        _write(daily, daily_dir / f"{inst.name}.csv")
        signal[inst.name] = daily
        columns[inst.name] = weekly(daily["close"])
        if intraday and creds is not None and source.startswith("NSE:"):
            try:
                at10 = fyers.price_at(source, max(start, INTRADAY_START), end, creds)
                _write(at10.rename("price"), DATA_DIR / "intraday" / "index" / f"{inst.name}.csv")
            except Exception as error:
                extra += f"  (10:00 prices failed: {error})"
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

    premiums = pd.DataFrame()
    if etfs:
        log("\nETFs (what you'd actually trade):")
        premiums = fetch_etfs(start, end, creds, signal, log, intraday)
        premiums.to_csv(DATA_DIR / "etf_premium.csv")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    table.to_csv(DATA_DIR / "weekly_closes.csv")
    with pd.ExcelWriter(DATA_DIR / "weekly_closes.xlsx") as xl:
        table.to_excel(xl, sheet_name="weekly_closes")
        coverage.to_excel(xl, sheet_name="coverage")
        if not premiums.empty:
            premiums.to_excel(xl, sheet_name="etf_premium")
    return table, coverage
