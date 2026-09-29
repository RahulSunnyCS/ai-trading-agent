"""
Daily collection: for each underlying, fetch the day's 1-minute index candles,
take the day's low-high range, then fetch every listed CE and PE strike inside
that range plus an adaptive margin on each side, for the configured expiries.
India VIX and each underlying's nearest future are captured alongside.

Width is decided by the data, not a fixed ±N: the collector keeps walking
outward from the traded range (up for CE, down for PE) until the out-of-the-
money leg's intraday HIGH has stayed below `premium_floor` for
`STOP_AFTER_CHEAP` consecutive strikes, capped at `max_extra` strikes per
side. Any strategy picking a strike by premium ("closest to ₹20") or a far
OTM hedge is therefore covered as long as its premium is above the floor at
some point in the day. The per-side widths are written to the manifest so the
floor/cap can be tuned once the real strategies are known.

Output layout under the data dir (one file per underlying per day):
    1m/index/<UNDERLYING|INDIAVIX>/<date>.parquet
    1m/fut/<UNDERLYING>/<date>.parquet
    1m/opt/<UNDERLYING>/<date>.parquet
    symbols/<date>.parquet          contracts listed that day, for the collected underlyings
    manifest/<date>.json            ranges, expiries, widths, counts, errors
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .auth import FyersCredentialsError
from .client import Candle, FyersClient
from .symbols import Contract, download_master, parse_master

DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "fyers"
VIX_SYMBOL = "NSE:INDIAVIX-INDEX"
DEFAULT_PREMIUM_FLOOR = 2.0
DEFAULT_MAX_EXTRA = 60
#: Consecutive below-floor strikes before the walk stops — one illiquid strike
#: with no trades must not end the walk early.
STOP_AFTER_CHEAP = 2


@dataclass(frozen=True)
class UnderlyingSpec:
    name: str
    index_symbol: str
    segment: str
    #: "weekly" → current + next expiry; "monthly" → current month only (plus
    #: next month on the monthly expiry day itself, since that is the contract
    #: anything entering that day would roll into).
    cadence: str


UNDERLYINGS: dict[str, UnderlyingSpec] = {
    "NIFTY": UnderlyingSpec("NIFTY", "NSE:NIFTY50-INDEX", "NSE_FO", "weekly"),
    "BANKNIFTY": UnderlyingSpec("BANKNIFTY", "NSE:NIFTYBANK-INDEX", "NSE_FO", "monthly"),
    "MIDCPNIFTY": UnderlyingSpec("MIDCPNIFTY", "NSE:MIDCPNIFTY-INDEX", "NSE_FO", "monthly"),
    "FINNIFTY": UnderlyingSpec("FINNIFTY", "NSE:FINNIFTY-INDEX", "NSE_FO", "monthly"),
    "SENSEX": UnderlyingSpec("SENSEX", "BSE:SENSEX-INDEX", "BSE_FO", "weekly"),
}


def data_dir() -> Path:
    override = os.environ.get("FYERS_DATA_DIR", "").strip()
    return Path(override).expanduser() if override else DEFAULT_DATA_DIR


# ---------------------------------------------------------------------------
# Pure selection logic (unit-tested)
# ---------------------------------------------------------------------------


def select_expiries(listed: list[date], day: date, cadence: str) -> list[date]:
    upcoming = sorted({e for e in listed if e >= day})
    if cadence == "weekly":
        return upcoming[:2]
    picked = upcoming[:1]
    if picked and picked[0] == day and len(upcoming) > 1:
        picked.append(upcoming[1])
    return picked


@dataclass
class ChainResult:
    candles: dict[tuple[float, str], list[Candle]] = field(default_factory=dict)
    core: tuple[float, float] | None = None
    extra_up: int = 0
    extra_down: int = 0
    top_strike: float | None = None
    bottom_strike: float | None = None
    hit_cap_up: bool = False
    hit_cap_down: bool = False


def _day_high(candles: list[Candle]) -> float:
    return max((c.high for c in candles), default=0.0)


def collect_chain(
    strikes: list[float],
    day_low: float,
    day_high: float,
    fetch: Callable[[float, str], list[Candle]],
    premium_floor: float = DEFAULT_PREMIUM_FLOOR,
    max_extra: int = DEFAULT_MAX_EXTRA,
) -> ChainResult:
    """Fetch CE+PE for every strike covering [day_low, day_high], then walk
    outward on each side until the OTM leg stays below `premium_floor`."""
    strikes = sorted(set(strikes))
    result = ChainResult()
    if not strikes:
        return result

    lo = max((i for i, s in enumerate(strikes) if s <= day_low), default=0)
    hi = min((i for i, s in enumerate(strikes) if s >= day_high), default=len(strikes) - 1)
    result.core = (strikes[lo], strikes[hi])

    def grab(strike: float) -> None:
        for right in ("CE", "PE"):
            result.candles[(strike, right)] = fetch(strike, right)

    for i in range(lo, hi + 1):
        grab(strikes[i])

    cheap = 0
    i = hi + 1
    while i < len(strikes) and cheap < STOP_AFTER_CHEAP:
        if result.extra_up >= max_extra:
            result.hit_cap_up = True
            break
        grab(strikes[i])
        result.extra_up += 1
        cheap = cheap + 1 if _day_high(result.candles[(strikes[i], "CE")]) < premium_floor else 0
        i += 1
    result.top_strike = strikes[min(i, len(strikes)) - 1]

    cheap = 0
    i = lo - 1
    while i >= 0 and cheap < STOP_AFTER_CHEAP:
        if result.extra_down >= max_extra:
            result.hit_cap_down = True
            break
        grab(strikes[i])
        result.extra_down += 1
        cheap = cheap + 1 if _day_high(result.candles[(strikes[i], "PE")]) < premium_floor else 0
        i -= 1
    result.bottom_strike = strikes[max(i, -1) + 1]
    return result


# ---------------------------------------------------------------------------
# Parquet writing
# ---------------------------------------------------------------------------

_TS = pa.timestamp("s", tz="Asia/Kolkata")
_OHLC_FIELDS = [
    pa.field("open", pa.float64()),
    pa.field("high", pa.float64()),
    pa.field("low", pa.float64()),
    pa.field("close", pa.float64()),
    pa.field("volume", pa.float64()),
    pa.field("oi", pa.float64()),
]
BAR_SCHEMA = pa.schema([pa.field("ts", _TS), pa.field("symbol", pa.string()), *_OHLC_FIELDS])
OPT_SCHEMA = pa.schema(
    [
        pa.field("ts", _TS),
        pa.field("symbol", pa.string()),
        pa.field("expiry", pa.date32()),
        pa.field("strike", pa.float64()),
        pa.field("option_type", pa.string()),
        *_OHLC_FIELDS,
    ]
)
SYMBOL_SCHEMA = pa.schema(
    [
        pa.field("symbol", pa.string()),
        pa.field("underlying", pa.string()),
        pa.field("expiry", pa.date32()),
        pa.field("strike", pa.float64()),
        pa.field("option_type", pa.string()),
        pa.field("lot_size", pa.int32()),
    ]
)


def _ohlc_columns(candles: list[Candle]) -> dict[str, list]:
    return {
        "ts": [c.epoch for c in candles],
        "open": [c.open for c in candles],
        "high": [c.high for c in candles],
        "low": [c.low for c in candles],
        "close": [c.close for c in candles],
        "volume": [c.volume for c in candles],
        "oi": [c.oi for c in candles],
    }


def _write(table: pa.Table, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)


def bars_table(symbol: str, candles: list[Candle]) -> pa.Table:
    cols = _ohlc_columns(candles)
    cols["symbol"] = [symbol] * len(candles)
    return pa.Table.from_pydict(cols, schema=BAR_SCHEMA)


def options_table(rows: list[tuple[Contract, list[Candle]]]) -> pa.Table:
    cols: dict[str, list] = {name: [] for name in OPT_SCHEMA.names}
    for contract, candles in rows:
        for key, values in _ohlc_columns(candles).items():
            cols[key].extend(values)
        n = len(candles)
        cols["symbol"].extend([contract.symbol] * n)
        cols["expiry"].extend([contract.expiry] * n)
        cols["strike"].extend([contract.strike] * n)
        cols["option_type"].extend([contract.option_type] * n)
    return pa.Table.from_pydict(cols, schema=OPT_SCHEMA)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _load_manifest(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def _save_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str))


def _contract_fetcher(
    client: FyersClient,
    day: date,
    expiry: date,
    by_key: dict[tuple[date, float | None, str], Contract],
    rows: list[tuple[Contract, list[Candle]]],
    errors: list[str],
) -> Callable[[float, str], list[Candle]]:
    def fetch(strike: float, right: str) -> list[Candle]:
        contract = by_key.get((expiry, strike, right))
        if contract is None:
            return []
        try:
            candles = client.minute_candles(contract.symbol, day)
        except FyersCredentialsError:
            raise
        except RuntimeError as error:  # one bad symbol must not lose the day
            errors.append(str(error))
            return []
        rows.append((contract, candles))
        return candles

    return fetch


def collect_day(
    client: FyersClient,
    day: date,
    underlyings: list[str],
    root: Path,
    premium_floor: float = DEFAULT_PREMIUM_FLOOR,
    max_extra: int = DEFAULT_MAX_EXTRA,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> dict:
    specs = [UNDERLYINGS[u] for u in underlyings]
    manifest_path = root / "manifest" / f"{day}.json"
    manifest = _load_manifest(manifest_path)

    contracts: list[Contract] = []
    for segment in sorted({s.segment for s in specs}):
        contracts += parse_master(download_master(segment), {s.name for s in specs})
    _write(
        pa.Table.from_pylist(
            [c.__dict__ for c in contracts if c.expiry >= day], schema=SYMBOL_SCHEMA
        ),
        root / "symbols" / f"{day}.parquet",
    )

    vix_path = root / "1m" / "index" / "INDIAVIX" / f"{day}.parquet"
    if force or not vix_path.exists():
        vix = client.minute_candles(VIX_SYMBOL, day)
        if vix:
            _write(bars_table(VIX_SYMBOL, vix), vix_path)
        manifest["INDIAVIX"] = {"bars": len(vix)}
        log(f"INDIAVIX: {len(vix)} bars")

    for spec in specs:
        opt_path = root / "1m" / "opt" / spec.name / f"{day}.parquet"
        if opt_path.exists() and not force:
            log(f"{spec.name}: already collected for {day} — skipped (--force to redo)")
            continue
        calls_before = client.calls
        entry: dict = {"errors": []}
        manifest[spec.name] = entry

        index = client.minute_candles(spec.index_symbol, day)
        entry["index_bars"] = len(index)
        if not index:
            entry["errors"].append("no index candles — holiday, or data not published yet")
            log(f"{spec.name}: no index candles for {day} — skipped")
            _save_manifest(manifest_path, manifest)
            continue
        _write(
            bars_table(spec.index_symbol, index),
            root / "1m" / "index" / spec.name / f"{day}.parquet",
        )
        day_low = min(c.low for c in index)
        day_high = max(c.high for c in index)
        entry["range"] = [day_low, day_high]

        mine = [c for c in contracts if c.underlying == spec.name]
        futures = sorted(
            (c for c in mine if c.option_type == "FUT" and c.expiry >= day), key=lambda c: c.expiry
        )
        if futures:
            fut = futures[0]
            fut_candles = client.minute_candles(fut.symbol, day)
            entry["future"] = {"symbol": fut.symbol, "bars": len(fut_candles)}
            if fut_candles:
                _write(
                    bars_table(fut.symbol, fut_candles),
                    root / "1m" / "fut" / spec.name / f"{day}.parquet",
                )

        options = [c for c in mine if c.option_type in ("CE", "PE")]
        expiries = select_expiries([c.expiry for c in options], day, spec.cadence)
        by_key = {(c.expiry, c.strike, c.option_type): c for c in options}
        rows: list[tuple[Contract, list[Candle]]] = []
        entry["expiries"] = {}

        for expiry in expiries:
            strikes = sorted(
                {c.strike for c in options if c.expiry == expiry and c.strike is not None}
            )

            fetch = _contract_fetcher(client, day, expiry, by_key, rows, entry["errors"])
            chain = collect_chain(strikes, day_low, day_high, fetch, premium_floor, max_extra)
            with_bars = sum(1 for c in chain.candles.values() if c)
            entry["expiries"][str(expiry)] = {
                "core": chain.core,
                "strikes_above_range": chain.extra_up,
                "strikes_below_range": chain.extra_down,
                "top_strike": chain.top_strike,
                "bottom_strike": chain.bottom_strike,
                "hit_cap_up": chain.hit_cap_up,
                "hit_cap_down": chain.hit_cap_down,
                "contracts_requested": len(chain.candles),
                "contracts_with_bars": with_bars,
            }
            cap = " (hit cap)" if chain.hit_cap_up or chain.hit_cap_down else ""
            log(
                f"{spec.name} {expiry}: {chain.bottom_strike:g}..{chain.top_strike:g} "
                f"(range {day_low:g}-{day_high:g}, +{chain.extra_up}/-{chain.extra_down} strikes), "
                f"{with_bars}/{len(chain.candles)} contracts traded{cap}"
            )

        table = options_table(rows)
        _write(table, opt_path)
        entry["option_rows"] = table.num_rows
        entry["requests"] = client.calls - calls_before
        _save_manifest(manifest_path, manifest)
        log(f"{spec.name}: {table.num_rows} option bars, {entry['requests']} requests")

    _save_manifest(manifest_path, manifest)
    return manifest
