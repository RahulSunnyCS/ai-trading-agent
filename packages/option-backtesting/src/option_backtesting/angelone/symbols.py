"""
Angel One scrip master -> tokens for the contracts the Fyers symbol master lists.

Identity stays Fyers': the collector registers and stores every contract under its Fyers ticker.
This module only answers "which Angel One (exchange, token) is that contract?" by matching
underlying, expiry, strike and option type, so a day collected here is stored like a Fyers day.
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime

from ..fyers.client import USER_AGENT
from ..fyers.symbols import Contract

MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

#: Angel One's index rows (instrumenttype AMXIDX), by the name the collector uses.
INDEX_ROWS: dict[str, tuple[str, str]] = {
    "NIFTY": ("NSE", "Nifty 50"),
    "BANKNIFTY": ("NSE", "Nifty Bank"),
    "FINNIFTY": ("NSE", "Nifty Fin Service"),
    "MIDCPNIFTY": ("NSE", "NIFTY MID SELECT"),
    "SENSEX": ("BSE", "SENSEX"),
    "INDIAVIX": ("NSE", "India VIX"),
}
FO_EXCHANGE = {"NSE": "NFO", "BSE": "BFO"}


@dataclass(frozen=True)
class Target:
    exchange: str  # NSE | BSE | NFO | BFO
    token: str
    kind: str  # "index" | "future" | "option"
    underlying: str
    lot_size: int = 1


def download_master() -> list[dict]:
    request = urllib.request.Request(MASTER_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def _expiry(row: dict) -> date | None:
    try:
        return datetime.strptime(row["expiry"], "%d%b%Y").date()
    except (KeyError, ValueError):
        return None


def build_targets(
    master: Iterable[dict],
    contracts: list[Contract],
    index_symbols: dict[str, str],
) -> dict[str, Target]:
    """{fyers_symbol: Target}. `index_symbols` maps a Fyers index ticker to the collector's name
    ("NSE:NIFTY50-INDEX" -> "NIFTY"; the VIX ticker -> "INDIAVIX"). Contracts with no match are
    simply absent: the client reports them as unmapped rather than failing the day."""
    wanted_index = {INDEX_ROWS[name] for name in index_symbols.values() if name in INDEX_ROWS}
    index_by_row: dict[tuple[str, str], str] = {}
    derivs: dict[tuple, str] = {}
    for row in master:
        seg, kind, symbol = row.get("exch_seg"), row.get("instrumenttype"), row.get("symbol", "")
        if kind == "AMXIDX" and (seg, symbol) in wanted_index:
            index_by_row[(seg, symbol)] = row["token"]
        elif seg in ("NFO", "BFO") and kind in ("OPTIDX", "FUTIDX"):
            expiry = _expiry(row)
            if expiry is None:
                continue
            if kind == "FUTIDX":
                derivs[(seg, row["name"], expiry, None, "FUT")] = row["token"]
            else:
                side = symbol[-2:]
                if side in ("CE", "PE"):
                    strike = round(float(row["strike"]) / 100, 2)
                    derivs[(seg, row["name"], expiry, strike, side)] = row["token"]

    out: dict[str, Target] = {}
    for ticker, name in index_symbols.items():
        exchange, row_symbol = INDEX_ROWS[name]
        token = index_by_row.get((exchange, row_symbol))
        if token:
            out[ticker] = Target(exchange, token, "index", name)
    for c in contracts:
        exchange = "BFO" if c.underlying == "SENSEX" else "NFO"
        strike = None if c.strike is None else round(c.strike, 2)
        token = derivs.get((exchange, c.underlying, c.expiry, strike, c.option_type))
        if token:
            out[c.symbol] = Target(
                exchange,
                token,
                "future" if c.option_type == "FUT" else "option",
                c.underlying,
                c.lot_size,
            )
    return out
