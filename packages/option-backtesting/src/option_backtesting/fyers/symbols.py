"""
Fyers' public symbol master (https://public.fyers.in/sym_details/<SEG>.csv) —
the list of every currently-listed contract. Looking symbols up here is
sturdier than encoding them (weekly vs monthly formats, holiday-shifted
expiries, strike grids that differ by expiry).

Only lists *live* contracts: once a contract expires it drops out, which is
one more reason the collector must run on each contract's expiry day.
"""

from __future__ import annotations

import csv
import io
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone

from .client import USER_AGENT

MASTER_URL = "https://public.fyers.in/sym_details/{segment}.csv"
IST = timezone(timedelta(hours=5, minutes=30))

# Column positions in the headerless master CSV.
_COL_EXPIRY_EPOCH = 8
_COL_SYMBOL = 9
_COL_UNDERLYING = 13
_COL_STRIKE = 15
_COL_OPTION_TYPE = 16
_COL_LOT = 3


@dataclass(frozen=True)
class Contract:
    symbol: str
    underlying: str
    expiry: date
    strike: float | None  # None for futures
    option_type: str  # "CE" | "PE" | "FUT"
    lot_size: int


def download_master(segment: str) -> str:
    request = urllib.request.Request(
        MASTER_URL.format(segment=segment), headers={"User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode()


def parse_master(text: str, underlyings: set[str]) -> list[Contract]:
    contracts: list[Contract] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) <= _COL_OPTION_TYPE or row[_COL_UNDERLYING] not in underlyings:
            continue
        symbol = row[_COL_SYMBOL]
        option_type = row[_COL_OPTION_TYPE].strip()
        if option_type in ("CE", "PE"):
            kind, strike = option_type, float(row[_COL_STRIKE])
        elif symbol.endswith("FUT"):
            kind, strike = "FUT", None
        else:
            continue
        expiry = datetime.fromtimestamp(int(row[_COL_EXPIRY_EPOCH]), UTC).astimezone(IST).date()
        contracts.append(
            Contract(
                symbol=symbol,
                underlying=row[_COL_UNDERLYING],
                expiry=expiry,
                strike=strike,
                option_type=kind,
                lot_size=int(float(row[_COL_LOT])),
            )
        )
    return contracts
