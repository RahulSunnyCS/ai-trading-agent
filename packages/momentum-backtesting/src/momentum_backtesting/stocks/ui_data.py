"""Loader for the curated stock-momentum dataset (data/stocks/*.csv, built by `mbt stocks
fetch`), in the shape api.py's stock-momentum endpoints will serve. Mirrors fetch.py's
Instrument/load_universe style - a plain dataclass plus a `load_*` function - but reads the
already-built CSVs rather than fetching anything itself.
"""

import csv
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from ..config import DATA_DIR
from ..engine import CASH, GILT
from ..tax import DEBT, EQUITY, GOLD_SILVER

# Exact column names this module produces for the three curated benchmark series (not the source
# CSV's own column names) - api.py must match these strings exactly.
NIFTY50_TRI = "Nifty 50 TRI"
NIFTY200_MOMENTUM30_TRI = "Nifty200 Momentum 30 TRI"
NIFTY50_EQUAL_WEIGHT_TRI = "Nifty50 Equal Weight TRI"

# benchmarks_weekly.csv column -> the output column name above. Deliberately excludes that CSV's
# `nifty200_momentum30_back_calculated` column, which is a per-week bool flag, not a price series.
_BENCHMARK_COLUMNS = {
    "nifty50_tri": NIFTY50_TRI,
    "nifty200_momentum30_tri": NIFTY200_MOMENTUM30_TRI,
    "nifty50_ew_tri": NIFTY50_EQUAL_WEIGHT_TRI,
}

# Comparison-only TRIs (BL-010 Phase 5): the broader-market and factor indices a momentum basket
# is judged against. They live in benchmarks_weekly.csv / stock_weekly_series next to the three
# above but are deliberately NOT in `_BENCHMARK_COLUMNS` - the stock dataset's price frame (and so
# every ranking, backtest and API payload built on it) must not gain columns because of them.
# Only reference_benchmarks.load_references reads them; db_migrate carries them across.
NIFTY_MIDCAP150_TRI = "Nifty Midcap 150 TRI"
NIFTY_SMALLCAP250_TRI = "Nifty Smallcap 250 TRI"
NIFTY_MIDCAP150_MOMENTUM50_TRI = "Nifty Midcap150 Momentum 50 TRI"
NIFTY500_MOMENTUM50_TRI = "Nifty500 Momentum 50 TRI"

# benchmarks_weekly.csv column -> display name, for the comparison-only TRIs above.
REFERENCE_ONLY_COLUMNS = {
    "nifty_midcap150_tri": NIFTY_MIDCAP150_TRI,
    "nifty_smallcap250_tri": NIFTY_SMALLCAP250_TRI,
    "nifty_midcap150_momentum50_tri": NIFTY_MIDCAP150_MOMENTUM50_TRI,
    "nifty500_momentum50_tri": NIFTY500_MOMENTUM50_TRI,
}

_COMPANIES_CSV = Path(__file__).with_name("curated") / "companies.csv"

# The five data/stocks/ files this loader reads. last_trade.csv isn't needed here - it's a
# latest-close reference the (future) API layer may use elsewhere, not part of the weekly frames.
_REQUIRED_FILES = (
    "nifty50_weekly_tr.csv",
    "nifty50_weekly_price.csv",
    "nifty50_membership_weekly.csv",
    "benchmarks_weekly.csv",
    "cash_weekly.csv",
)

# Extra, non-company instruments that compete in the SAME rank table as the 95 stocks when
# Config.defensive="ranked" (see engine.py's ranked_universe/Config.defensive) - they are NOT
# gated behind data/stocks/ at all; their prices come from the shared weekly_closes.csv that the
# ETF pipeline (`mbt fetch`) already builds. Each uses its own real name as its identifier - no
# company_id-style code, no id-to-name translation, unlike the 95 curated companies.
#
# Gold/Silver are tagged "core": always rankable, exactly like any stock, never gated behind the
# defensive-mode toggle. Cash (liquid fund)/Gilt 8-13 yr are tagged "defensive": they only
# compete in ranking under defensive="ranked" - a deliberate distinction that mirrors how the ETF
# universe (universe.csv) already treats these same two instruments.
#
# CASH is deliberately excluded from `_EXTRA_PRICE_COLUMNS` below: it is already loaded into
# `prices`/`price_only` from cash_weekly.csv (dense back to the start of the stock dataset, used
# internally for idle-cash parking - see engine.py's _Sim.price()). Re-reading the same-named
# column out of weekly_closes.csv (which only starts in 2016) would either collide with that
# existing column or overwrite its full-history density with a shorter, NaN-prefixed series. It
# only needs a new `extra_instruments` entry here to become independently rankable - no new price
# data.
_EXTRA_GROUPS_AND_TAGS: dict[str, tuple[str, str]] = {
    "Gold": ("Commodity", "core"),
    "Silver": ("Commodity", "core"),
    CASH: ("Debt", "defensive"),
    GILT: ("Debt", "defensive"),
}
_EXTRA_TAX_CLASSES: dict[str, str] = {
    "Gold": GOLD_SILVER,
    "Silver": GOLD_SILVER,
    CASH: DEBT,
    GILT: DEBT,
}
# The weekly_closes.csv columns actually merged into prices/price_only - CASH is excluded (see
# above); Gold/Silver/Gilt have no pre-existing series in the stock dataset.
_EXTRA_PRICE_COLUMNS = ("Gold", "Silver", GILT)


class StockDataUnavailable(FileNotFoundError):
    """The data/stocks/ dataset hasn't been built yet (or a required file is missing)."""


@dataclass(frozen=True)
class StockDataset:
    # week x (company_id, CASH, and the 3 benchmark names above), total-return series - what the
    # engine ranks and trades on by default.
    prices: pd.DataFrame
    # Same shape, ex-dividend price series - wired for a future price-only toggle in the UI.
    price_only: pd.DataFrame
    membership: pd.DataFrame  # week x company_id booleans; True = index member that week
    companies: dict[str, str]  # company_id -> company name
    tax_classes: dict[str, str]  # company_id/extra name -> tax.py class (EQUITY/GOLD_SILVER/DEBT)
    last_week: pd.Timestamp
    # Gold/Silver/Cash (liquid fund)/Gilt 8-13 yr -> {"group": "Commodity"|"Debt",
    # "tag": "core"|"defensive"}. Kept separate from `companies`/`tax_classes` (which are
    # company_id-keyed) because these 4 use their own real name as their identifier - see
    # _EXTRA_GROUPS_AND_TAGS above.
    extra_instruments: dict[str, dict] = field(default_factory=dict)


def _load_companies() -> dict[str, str]:
    with _COMPANIES_CSV.open() as f:
        return {row["company_id"]: row["name"] for row in csv.DictReader(f)}


def _read_weekly(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, index_col=0, parse_dates=True)


def load_stock_dataset(data_dir: Path | None = None) -> StockDataset:
    """Read data/stocks/ (built by `mbt stocks fetch`) into the shape the API/UI layer consumes.

    Prefers the shared local database (`stock_weekly_prices`/`stock_membership_weekly`/
    `momentum_prices`, populated by `mbt local migrate`) over these five files once it has
    data — see `db_read.py`'s module docstring — falling back to the files on a fresh
    checkout or when the catalog has none of this dataset's rows yet.

    `data_dir` defaults to config.DATA_DIR / "stocks". Raises StockDataUnavailable (a
    FileNotFoundError) with guidance to run `mbt stocks fetch` if NEITHER source has the
    data yet - callers that want an HTTP 409 (mirroring api.py's "no data yet" pattern)
    should catch this and wrap it themselves; this module doesn't depend on FastAPI.
    """
    from .. import db_read  # noqa: PLC0415 (avoid a hard import cycle at module load)

    base = data_dir if data_dir is not None else DATA_DIR / "stocks"
    from_db = db_read.stock_dataset_from_db_or_none()
    if from_db is not None:
        tr, price, membership, benchmarks, cash = from_db
    else:
        missing = [name for name in _REQUIRED_FILES if not (base / name).exists()]
        if missing:
            raise StockDataUnavailable(
                f"stock data not found in {base} (missing {missing}) - run `mbt stocks fetch` first"
            )
        tr = _read_weekly(base / "nifty50_weekly_tr.csv")
        price = _read_weekly(base / "nifty50_weekly_price.csv")
        membership = _read_weekly(base / "nifty50_membership_weekly.csv")
        benchmarks = _read_weekly(base / "benchmarks_weekly.csv")
        cash = pd.read_csv(base / "cash_weekly.csv", index_col="date", parse_dates=True)["close"]

    # The stock weekly-close calendar (tr's index) is the canonical week list: cash_weekly.csv
    # can run a week ahead of the stock data (a liquid-fund NAV needs no market session), and
    # reindexing onto `weeks` drops that dangling week rather than adding an all-NaN-except-cash
    # row via a naive outer-join concat.
    weeks = tr.index
    benchmark_cols = (
        benchmarks[list(_BENCHMARK_COLUMNS)].rename(columns=_BENCHMARK_COLUMNS).reindex(weeks)
    )
    cash_col = cash.reindex(weeks).rename(CASH)

    extra_price_cols, extra_instruments, extra_tax_classes = _load_extra_instruments(base, weeks)

    prices = pd.concat([tr, benchmark_cols, cash_col, extra_price_cols], axis=1)
    price_only = pd.concat([price, benchmark_cols, cash_col, extra_price_cols], axis=1)

    companies = _load_companies()
    tax_classes = dict.fromkeys(tr.columns, EQUITY)
    tax_classes.update(extra_tax_classes)

    return StockDataset(
        prices=prices,
        price_only=price_only,
        membership=membership,
        companies=companies,
        tax_classes=tax_classes,
        last_week=weeks.max(),
        extra_instruments=extra_instruments,
    )


def _load_extra_instruments(
    base: Path, weeks: pd.DatetimeIndex
) -> tuple[pd.DataFrame, dict[str, dict], dict[str, str]]:
    """Gold/Silver/Cash (liquid fund)/Gilt 8-13 yr - read from the shared weekly_closes.csv
    (built by the ETF pipeline's `mbt fetch`, a sibling of `base` rather than something under
    it - NOT the data/stocks/ files the rest of this loader reads) and reindexed onto the stock
    dataset's own week list, same pattern as the benchmark/cash columns above.

    Returns (price columns to merge in, extra_instruments metadata, extra tax classes). CASH's
    price series is deliberately never re-read here - see _EXTRA_PRICE_COLUMNS's docstring above
    - so its price-column DataFrame contribution is Gold/Silver/Gilt only, while its
    extra_instruments/tax_classes entries are still emitted (it is already priced via
    cash_weekly.csv, and just needs to become independently rankable).

    Gracefully degrades if weekly_closes.csv hasn't been built yet (`mbt fetch` never run) or has
    none of the expected columns - a stock dataset with only `mbt stocks fetch` run should still
    load; CASH still becomes rankable (it needs no weekly_closes.csv column), but Gold/Silver/Gilt
    are simply absent from `extra_instruments` until `mbt fetch` has run.
    """
    from .. import db_read  # noqa: PLC0415 (avoid a hard import cycle at module load)

    weekly_closes_path = base.parent / "weekly_closes.csv"
    weekly_closes = db_read.weekly_closes_from_db_or_none()
    if weekly_closes is None and weekly_closes_path.exists():
        weekly_closes = _read_weekly(weekly_closes_path)
    available_price_cols: list[str] = []
    if weekly_closes is not None:
        available_price_cols = [c for c in _EXTRA_PRICE_COLUMNS if c in weekly_closes.columns]

    extra_price_cols = (
        weekly_closes[available_price_cols].reindex(weeks)
        if available_price_cols
        else pd.DataFrame(index=weeks)
    )

    # CASH is always available (already priced via cash_weekly.csv, required unconditionally by
    # _REQUIRED_FILES); Gold/Silver/Gilt are available only if weekly_closes.csv had that column.
    available_names = {CASH, *available_price_cols}
    extra_instruments = {
        name: {"group": group, "tag": tag}
        for name, (group, tag) in _EXTRA_GROUPS_AND_TAGS.items()
        if name in available_names
    }
    extra_tax_classes = {name: _EXTRA_TAX_CLASSES[name] for name in extra_instruments}
    return extra_price_cols, extra_instruments, extra_tax_classes
