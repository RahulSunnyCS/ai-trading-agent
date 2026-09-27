"""Price sources that don't need Fyers: AMFI mutual fund NAVs, Yahoo Finance, and NSE's
niftyindices.com (official index history, used to backfill what Fyers lacks)."""

import json
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

import pandas as pd

_UA = {"User-Agent": "Mozilla/5.0"}


def weekly(series: pd.Series) -> pd.Series:
    """Last close of each Mon-Fri week, labelled by that week's Friday. Holiday-safe."""
    return series.resample("W-FRI").last()


def adjust_nav_splits(nav: pd.Series) -> pd.Series:
    """Undo unit splits/consolidations in a liquid-fund NAV series.

    A liquid fund can't move 1% in a day, so a jump that size is a rebase (UTI Liquid
    split 10:1 on 2026-06-20, showing as a -90% day). History before the jump is
    rescaled so returns stay continuous.
    """
    nav = nav.copy()
    for day, ratio in (nav.shift(1) / nav).items():
        if pd.isna(ratio) or abs(ratio - 1) < 0.01:
            continue
        factor = round(ratio) if ratio > 1 else 1 / round(1 / ratio)
        nav[nav.index < day] /= factor
    return nav


def split_factors(close: pd.Series, reference: pd.Series) -> pd.Series:
    """Multiplier per day that undoes ETF unit splits/consolidations, judged against the index
    the ETF tracks.

    An ETF can't fall 50% on a day its index is flat, so a daily move that far from the
    index's (ratio < 0.55 or > 1.8) is a rebase. Every day before it is multiplied by the
    rounded factor, so returns stay continuous and the latest prices stay as traded. Apply the
    same multipliers to opens and intraday prices of that ETF.
    """
    ref = reference.reindex(close.index.union(reference.index)).ffill().reindex(close.index)
    ratio = (close / close.shift(1)) / (ref / ref.shift(1))
    factors = pd.Series(1.0, index=close.index)
    for day, r in ratio.items():
        if pd.isna(r) or 0.55 <= r <= 1.8:
            continue
        factor = 1 / round(1 / r) if r < 1 else float(round(r))
        factors[factors.index < day] *= factor
    return factors


def amfi_nav(scheme_code: str, start: date, adjust: bool = True) -> pd.Series:
    """Daily NAV of an AMFI scheme. `adjust` undoes unit splits - only valid for liquid funds,
    whose NAV can't move 1% in a day; ETF NAVs are fetched raw."""
    url = f"https://api.mfapi.in/mf/{scheme_code}"
    rows = json.load(urllib.request.urlopen(url, timeout=60))["data"]
    nav = pd.Series(
        {pd.to_datetime(r["date"], format="%d-%m-%Y"): float(r["nav"]) for r in rows}
    ).sort_index()
    nav = nav[nav.index >= pd.Timestamp(start)]
    return adjust_nav_splits(nav) if adjust else nav


def amfi_search(query: str) -> list[dict]:
    """[{schemeCode, schemeName}, ...] from mfapi.in's scheme search."""
    url = f"https://api.mfapi.in/mf/search?q={urllib.parse.quote(query)}"
    return json.load(urllib.request.urlopen(url, timeout=30))


def yahoo_daily(symbol: str, start: date) -> pd.Series:
    return yahoo_candles(symbol, start)["close"]


def yahoo_candles(symbol: str, start: date) -> pd.DataFrame:
    """Daily open and close from Yahoo, indexed by the exchange's local (IST) date."""
    period1 = int(pd.Timestamp(start, tz="UTC").timestamp())
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1={period1}&period2=9999999999&interval=1d"
    )
    request = urllib.request.Request(url, headers=_UA)
    result = json.load(urllib.request.urlopen(request, timeout=30))["chart"]["result"][0]
    stamps = pd.to_datetime(result["timestamp"], unit="s", utc=True).tz_convert("Asia/Kolkata")
    quote = result["indicators"]["quote"][0]
    frame = pd.DataFrame(
        {"open": quote.get("open"), "close": quote["close"]}, index=pd.to_datetime(stamps.date)
    )
    frame = frame.dropna(subset=["close"])
    return frame.groupby(level=0).last()


def yahoo_quote(symbol: str) -> tuple[float, pd.Timestamp]:
    """Latest traded price (Yahoo's NSE quotes are ~15 minutes delayed) and when it traded."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=5m"
    request = urllib.request.Request(url, headers=_UA)
    meta = json.load(urllib.request.urlopen(request, timeout=30))["chart"]["result"][0]["meta"]
    when = pd.Timestamp(meta["regularMarketTime"], unit="s", tz="UTC").tz_convert("Asia/Kolkata")
    return float(meta["regularMarketPrice"]), when


def index_in_inr(index_symbol: str, fx_symbol: str, start: date, previous_close: bool) -> pd.Series:
    """Daily foreign index (or commodity) value converted to rupees, from Yahoo.

    `previous_close` is for US markets: they close ~01:30-02:30 IST, after India, so the
    latest value known at an Indian close is the previous US session's. Hong Kong closes
    13:30 IST, before India, so it uses the same day's close.
    """
    index = yahoo_daily(index_symbol, start)
    fx = yahoo_daily(fx_symbol, start).reindex(index.index).ffill()
    inr = (index * fx).dropna()
    return inr.shift(1).dropna() if previous_close else inr


NIFTYINDICES_URL = "https://www.niftyindices.com/BackPage/getHistoricaldatatabletoString"


def parse_niftyindices(rows: list[dict]) -> pd.Series:
    return parse_niftyindices_candles(rows)["close"]


def _number(value) -> float:
    return float(value) if value not in (None, "", "-") else float("nan")


def parse_niftyindices_candles(rows: list[dict]) -> pd.DataFrame:
    by_day = {
        pd.to_datetime(r["HistoricalDate"], format="%d %b %Y"): (
            _number(r.get("OPEN")),
            float(r["CLOSE"]),
        )
        for r in rows
        if r.get("CLOSE") not in (None, "", "-")
    }
    frame = pd.DataFrame.from_dict(by_day, orient="index", columns=["open", "close"], dtype=float)
    return frame.sort_index()


def niftyindices_daily(name: str, start: date, end: date) -> pd.Series:
    return niftyindices_candles(name, start, end)["close"]


def niftyindices_candles(name: str, start: date, end: date) -> pd.DataFrame:
    """Official NSE index closes from niftyindices.com, including NSE's back-calculated
    history before an index launched. The site allows at most a year per request."""
    parts = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(chunk_start + timedelta(days=364), end)
        cinfo = str(
            {
                "name": name,
                "startDate": f"{chunk_start:%d-%b-%Y}",
                "endDate": f"{chunk_end:%d-%b-%Y}",
                "indexName": name,
            }
        )
        request = urllib.request.Request(
            NIFTYINDICES_URL,
            data=json.dumps({"cinfo": cinfo}).encode(),
            headers={
                **_UA,
                "Content-Type": "application/json; charset=UTF-8",
                "Referer": "https://www.niftyindices.com/reports/historical-data",
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        body = json.load(urllib.request.urlopen(request, timeout=60))
        payload = body.get("d", body) if isinstance(body, dict) else body
        rows = json.loads(payload) if isinstance(payload, str) else payload
        parts.append(parse_niftyindices_candles(rows or []))
        chunk_start = chunk_end + timedelta(days=1)
        time.sleep(0.5)
    if not parts:
        return pd.DataFrame(columns=["open", "close"], dtype=float)
    frame = pd.concat(parts).sort_index()
    return frame[~frame.index.duplicated()]


def silver_daily(start: date) -> pd.Series:
    """Daily INR silver on the same basis as silver_weekly (previous COMEX close x USD/INR,
    scaled to join SILVERBEES), spliced to SILVERBEES from its first full week. Used only for
    fills on days other than Friday; the ranking keeps using silver_weekly."""
    synthetic = index_in_inr("SI=F", "INR=X", start, previous_close=True)
    silverbees = yahoo_daily("SILVERBEES.NS", start)
    splice_at = weekly(silverbees).dropna().index[1]
    first_real = silverbees[silverbees.index > splice_at - pd.Timedelta(days=7)].index[0]
    join = synthetic.asof(first_real)
    head = synthetic[synthetic.index < first_real] * (silverbees[first_real] / join)
    return pd.concat([head, silverbees[silverbees.index >= first_real]])


def silver_weekly(start: date) -> tuple[pd.Series, pd.Series]:
    """Weekly INR silver: COMEX silver x USD/INR before SILVERBEES listed, SILVERBEES after.

    COMEX settles ~02:30 IST, after India closes, so each Indian day uses the PREVIOUS
    US close. On 2022-26 weekly closes that alignment lifts correlation with SILVERBEES
    from 0.73 to 0.83 weekly (0.92 monthly). Returns (prices, source label per week).
    """
    synthetic = weekly(index_in_inr("SI=F", "INR=X", start, previous_close=True)).dropna()
    silverbees = weekly(yahoo_daily("SILVERBEES.NS", start)).dropna()

    splice_at = silverbees.index[1]  # skip the partial listing week
    scale = silverbees[splice_at] / synthetic[splice_at]
    prices = pd.concat(
        [synthetic[synthetic.index < splice_at] * scale, silverbees[silverbees.index >= splice_at]]
    )
    labels = pd.Series(
        ["synthetic" if d < splice_at else "SILVERBEES" for d in prices.index], index=prices.index
    )
    return prices, labels
