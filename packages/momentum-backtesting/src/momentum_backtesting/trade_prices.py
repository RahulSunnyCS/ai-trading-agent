"""The prices trades fill at - separate from the prices the ranking uses.

The ranking always runs on the underlying index (weekly_closes.csv). What you actually earn is
the ETF's price, at the time you actually trade. This builds that second table, indexed by
*signal* week W: row W holds the price at which a trade decided on W's Friday close fills.

track
  index   the index itself (what the backtest has always assumed)
  etf     the ETF you'd trade. Before it listed, the index stands in (scaled to join the ETF
          on its first day, less the ETF's expense ratio `ter_pct` per year) - those weeks are
          flagged as proxy.
execution
  fri_close  W's last close (the backtest's original assumption)
  mon_open   the open of the first trading day after W
  mon_10am   the price at 10:00 on that day (needs `mbt fetch --intraday`); days without one
             fall back to that day's open and are counted in the notes

A series with no open (a NAV, a foreign index converted to rupees) uses that day's close for
the Monday modes. For the previous-US-close series that is already known at India's open; the
Hang Seng index series (same-day close, 13:30 IST) is slightly late - its ETF isn't.
"""

from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from .config import DATA_DIR
from .fetch import Instrument, load_universe

TRACKS = ("index", "etf")
EXECUTIONS = ("fri_close", "mon_open", "mon_10am")
MAX_GAP_DAYS = 7  # a fill more than a week after the signal is treated as missing


@dataclass
class TradePrices:
    prices: pd.DataFrame  # signal week x instrument
    proxy: pd.DataFrame  # True where the fill is the index standing in for an unlisted ETF
    notes: pd.DataFrame  # per instrument: source, listed, proxy weeks, fallbacks
    track: str
    execution: str
    warnings: list[str] = field(default_factory=list)


def _read(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    return pd.read_csv(path, index_col=0, parse_dates=True).sort_index()


def splice_proxy(
    etf: pd.DataFrame, index: pd.DataFrame, ter_pct: float | None
) -> tuple[pd.DataFrame, pd.Timestamp]:
    """ETF history, extended back before its listing with the index: scaled to meet the ETF's
    first close, and lifted by the expense ratio so the proxy grows by (1 - TER) a year less
    than the index - roughly what the ETF would have returned. Returns (daily, listing day)."""
    listed = etf["close"].first_valid_index()
    before = index[index.index < listed]
    if before.empty:
        return etf, listed
    join = index["close"].asof(listed)
    scale = etf.at[listed, "close"] / join
    years = (listed - before.index).days / 365.25
    drag = (1 - (ter_pct or 0.0) / 100) ** years
    head = before.mul(scale, axis=0).div(pd.Series(drag, index=before.index), axis=0)
    head = head.reindex(columns=etf.columns)
    return pd.concat([head, etf]), listed


def fills(
    daily: pd.DataFrame,
    weeks: pd.DatetimeIndex,
    execution: str,
    at_ten: pd.Series | None = None,
) -> tuple[pd.Series, int]:
    """Fill price per signal week, and how many Monday fills fell back to a cruder price."""
    close = daily["close"].dropna()
    if execution == "fri_close":
        return close.resample("W-FRI").last().reindex(weeks), 0
    opens = daily["open"] if "open" in daily else pd.Series(dtype=float)
    out, fallbacks = {}, 0
    days = close.index[close.index.dayofweek < 5]  # NAVs are also published for weekends
    for week in weeks:
        after = days[(days > week) & (days <= week + pd.Timedelta(days=MAX_GAP_DAYS))]
        if after.empty:
            out[week] = float("nan")
            continue
        day = after[0]
        price = float("nan")
        if execution == "mon_10am" and at_ten is not None:
            price = at_ten.get(day, float("nan"))
        if pd.isna(price):
            if execution == "mon_10am":
                fallbacks += 1
            price = opens.get(day, float("nan"))
        if pd.isna(price):
            if "open" in daily:
                fallbacks += 1
            price = close[day]
        out[week] = price
    return pd.Series(out, dtype=float).reindex(weeks), fallbacks


def build_trade_prices(
    signal: pd.DataFrame,
    track: str,
    execution: str,
    universe: list[Instrument] | None = None,
    data_dir: Path | None = None,
) -> TradePrices | None:
    """Fill prices for every column of the weekly signal table. None for index + fri_close,
    which is exactly the signal table (the engine then behaves as it always has)."""
    if track not in TRACKS:
        raise ValueError(f"unknown track {track!r}")
    if execution not in EXECUTIONS:
        raise ValueError(f"unknown execution {execution!r}")
    if track == "index" and execution == "fri_close":
        return None
    data_dir = data_dir or DATA_DIR
    by_name = {inst.name: inst for inst in universe or load_universe()}
    weeks = signal.index
    prices, proxy, notes, missing = {}, {}, [], []
    for name in signal.columns:
        inst = by_name.get(name)
        daily = _read(data_dir / "daily" / f"{name}.csv")
        if daily is None:
            missing.append(name)
            continue
        kind, listed, source = "index", None, "signal series"
        if track == "etf" and inst is not None and inst.has_etf:
            etf = _read(data_dir / "daily_etf" / f"{name}.csv")
            if etf is not None and etf["close"].notna().any():
                daily, listed = splice_proxy(etf, daily, inst.ter_pct)
                kind, source = "etf", inst.trade_etf
            else:
                source = "signal series (no ETF data - run `mbt fetch`)"
        at_ten = None
        if execution == "mon_10am":
            frame = _read(data_dir / "intraday" / kind / f"{name}.csv")
            at_ten = frame["price"] if frame is not None else None
        series, fallbacks = fills(daily, weeks, execution, at_ten)
        # Keep the signal table's gaps: an instrument isn't tradeable before it's rankable.
        prices[name] = series.where(signal[name].notna())
        is_proxy = pd.Series(False, index=weeks)
        if listed is not None:
            is_proxy = pd.Series(weeks < listed, index=weeks) & signal[name].notna()
        proxy[name] = is_proxy
        notes.append(
            {
                "instrument": name,
                "priced on": source,
                "ETF listed": listed.date() if listed is not None else None,
                "proxy weeks": int(is_proxy.sum()),
                "TER used (%)": inst.ter_pct if inst is not None and listed is not None else None,
                "fills falling back": fallbacks,
            }
        )
    if missing:
        raise ValueError(
            f"no daily prices for {missing} - run `mbt fetch` again (older data folders only "
            "kept weekly closes)"
        )
    warnings = []
    if execution == "mon_10am":
        weak = [n["instrument"] for n in notes if n["fills falling back"] > len(weeks) // 2]
        if weak:
            shown = ", ".join(weak[:3]) + (f" and {len(weak) - 3} more" if len(weak) > 3 else "")
            warnings.append(
                f"no 10:00 prices for most weeks of {shown}, so those fills use the Monday open "
                "- run `mbt fetch --intraday`"
            )
    return TradePrices(
        prices=pd.DataFrame(prices, index=weeks),
        proxy=pd.DataFrame(proxy, index=weeks),
        notes=pd.DataFrame(notes).set_index("instrument"),
        track=track,
        execution=execution,
        warnings=warnings,
    )


def load_premiums(data_dir: Path | None = None) -> pd.DataFrame:
    """Daily ETF premium to NAV (close / NAV - 1), one column per instrument; may be empty."""
    frame = _read((data_dir or DATA_DIR) / "etf_premium.csv")
    return frame if frame is not None else pd.DataFrame()
