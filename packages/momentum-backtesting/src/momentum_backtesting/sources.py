"""Price sources that don't need Fyers: AMFI mutual fund NAVs, Yahoo Finance, and NSE's
niftyindices.com (official index history, used to backfill what Fyers lacks)."""

import json
import time
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


def amfi_nav(scheme_code: str, start: date) -> pd.Series:
    url = f"https://api.mfapi.in/mf/{scheme_code}"
    rows = json.load(urllib.request.urlopen(url, timeout=60))["data"]
    nav = pd.Series(
        {pd.to_datetime(r["date"], format="%d-%m-%Y"): float(r["nav"]) for r in rows}
    ).sort_index()
    return adjust_nav_splits(nav[nav.index >= pd.Timestamp(start)])


def yahoo_daily(symbol: str, start: date) -> pd.Series:
    period1 = int(pd.Timestamp(start, tz="UTC").timestamp())
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1={period1}&period2=9999999999&interval=1d"
    )
    request = urllib.request.Request(url, headers=_UA)
    result = json.load(urllib.request.urlopen(request, timeout=30))["chart"]["result"][0]
    stamps = pd.to_datetime(result["timestamp"], unit="s", utc=True).tz_convert("Asia/Kolkata")
    close = pd.Series(result["indicators"]["quote"][0]["close"], index=stamps.date)
    close.index = pd.to_datetime(close.index)
    return close.dropna().groupby(level=0).last()


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
    closes = {
        pd.to_datetime(r["HistoricalDate"], format="%d %b %Y"): float(r["CLOSE"])
        for r in rows
        if r.get("CLOSE") not in (None, "", "-")
    }
    return pd.Series(closes, dtype=float).sort_index()


def niftyindices_daily(name: str, start: date, end: date) -> pd.Series:
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
        parts.append(parse_niftyindices(rows or []))
        chunk_start = chunk_end + timedelta(days=1)
        time.sleep(0.5)
    series = pd.concat(parts).sort_index() if parts else pd.Series(dtype=float)
    return series[~series.index.duplicated()]


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
