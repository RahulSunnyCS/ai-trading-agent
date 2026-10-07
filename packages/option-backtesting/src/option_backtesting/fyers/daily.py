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
some point in the day. The per-side widths are recorded in the run's
`ingest_runs.details` so the floor/cap can be tuned.

Storage is packages/trading-data's (TRADING_DATA_ROOT): every listed contract is
registered in `instruments` (+ a `fyers` alias), bars go to the Parquet lake
(`lake.bars_1m_path`) carrying `instrument_id`, the day's symbol master to
`lake/symbol_master`, every raw Fyers response to `raw/fyers/`, and one
`ingest_runs` row per call. The catalog connection is only held for the short
register/finish steps — never across the minutes of downloading.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import ingest, lake
from trading_data.db import connect, data_root
from trading_data.instruments import InstrumentSpec, instrument_key, register
from trading_data.lake import BAR_SCHEMA, OPT_SCHEMA

from .auth import FyersCredentialsError
from .client import Candle, FyersClient
from .symbols import Contract, download_master, parse_master

VIX_SYMBOL = "NSE:INDIAVIX-INDEX"
VIX_NAME = "INDIAVIX"
DEFAULT_PREMIUM_FLOOR = 2.0
DEFAULT_MAX_EXTRA = 60
#: Index futures kept per underlying each day: the nearest and the next (BL-034 Phase 4).
FUTURES_KEPT = 2
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
    """The shared research data root (TRADING_DATA_ROOT, default ~/TradingData) —
    owned by packages/trading-data."""
    return data_root()


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
# Parquet tables (partition values — asset, underlying/symbol, date — live in the
# folder names, not in the files). BAR_SCHEMA and OPT_SCHEMA are owned by
# trading_data.lake, so the vendor importer writes the same shape.
# ---------------------------------------------------------------------------

SYMBOL_SCHEMA = pa.schema(
    [
        pa.field("vendor_symbol", pa.string()),
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


def bars_table(instrument_id: int, symbol: str, candles: list[Candle]) -> pa.Table:
    cols = _ohlc_columns(candles)
    cols["instrument_id"] = [instrument_id] * len(candles)
    cols["vendor_symbol"] = [symbol] * len(candles)
    return pa.Table.from_pydict(cols, schema=BAR_SCHEMA)


def options_table(rows: list[tuple[Contract, int, list[Candle]]]) -> pa.Table:
    cols: dict[str, list] = {name: [] for name in OPT_SCHEMA.names}
    for contract, instrument_id, candles in rows:
        for key, values in _ohlc_columns(candles).items():
            cols[key].extend(values)
        n = len(candles)
        cols["instrument_id"].extend([instrument_id] * n)
        cols["vendor_symbol"].extend([contract.symbol] * n)
        cols["expiry"].extend([contract.expiry] * n)
        cols["strike"].extend([contract.strike] * n)
        cols["option_type"].extend([contract.option_type] * n)
    return pa.Table.from_pydict(cols, schema=OPT_SCHEMA)


def symbols_table(contracts: list[Contract]) -> pa.Table:
    return pa.Table.from_pylist(
        [
            {
                "vendor_symbol": c.symbol,
                "underlying": c.underlying,
                "expiry": c.expiry,
                "strike": c.strike,
                "option_type": c.option_type,
                "lot_size": c.lot_size,
            }
            for c in contracts
        ],
        schema=SYMBOL_SCHEMA,
    )


def write_symbol_master(root: Path, day: date, contracts: list[Contract]) -> None:
    """Merge into the day's saved symbol master rather than overwrite it: a later run
    for fewer underlyings (e.g. a SENSEX-only backfill) must not drop the others'."""
    path = lake.symbol_master_path(root, "fyers", day)
    table = symbols_table(contracts)
    if path.exists():
        new = set(table.column("vendor_symbol").to_pylist())
        old = pq.read_table(path).cast(SYMBOL_SCHEMA)
        keep = [s not in new for s in old.column("vendor_symbol").to_pylist()]
        table = pa.concat_tables([old.filter(pa.array(keep)), table])
    lake.write_parquet(table, path)


# ---------------------------------------------------------------------------
# Instrument registration
# ---------------------------------------------------------------------------


def _exchange(spec: UnderlyingSpec) -> str:
    return spec.index_symbol.split(":")[0]


def instrument_specs(
    contracts: list[Contract], specs: list[UnderlyingSpec]
) -> list[InstrumentSpec]:
    """Every index (plus VIX) and every listed option/future contract of the collected
    underlyings, with its Fyers symbol as the vendor alias."""
    by_name = {s.name: s for s in specs}
    out = [InstrumentSpec("index", "NSE", VIX_NAME, vendor="fyers", vendor_symbol=VIX_SYMBOL)]
    for s in specs:
        out.append(
            InstrumentSpec(
                "index", _exchange(s), s.name, vendor="fyers", vendor_symbol=s.index_symbol
            )
        )
    for c in contracts:
        spec = by_name.get(c.underlying)
        if spec is None:
            continue
        ex = _exchange(spec)
        is_fut = c.option_type == "FUT"
        out.append(
            InstrumentSpec(
                "future" if is_fut else "option",
                ex,
                c.underlying,
                expiry=c.expiry,
                strike=None if is_fut else c.strike,
                option_type=None if is_fut else c.option_type,
                lot_size=c.lot_size,
                underlying_key=instrument_key(ex, "index", c.underlying),
                vendor="fyers",
                vendor_symbol=c.symbol,
            )
        )
    return out


def register_contracts(
    root: Path, contracts: list[Contract], specs: list[UnderlyingSpec]
) -> dict[str, int]:
    """Register everything; return {fyers_symbol: instrument_id}."""
    inst = instrument_specs(contracts, specs)
    with connect(root) as con:
        ids = register(con, inst)
    return {s.vendor_symbol: ids[s.key] for s in inst if s.vendor_symbol}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _contract_fetcher(
    client: FyersClient,
    day: date,
    expiry: date,
    by_key: dict[tuple[date, float | None, str], Contract],
    ids: dict[str, int],
    rows: list[tuple[Contract, int, list[Candle]]],
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
        rows.append((contract, ids[contract.symbol], candles))
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
    """Collect one day. Returns the per-underlying details (also stored in
    ingest_runs.details); each entry's "errors" list counts toward the run status."""
    specs = [UNDERLYINGS[u] for u in underlyings]
    details: dict = {"premium_floor": premium_floor, "max_extra": max_extra}

    contracts: list[Contract] = []
    for segment in sorted({s.segment for s in specs}):
        contracts += parse_master(download_master(segment), {s.name for s in specs})
    contracts = [c for c in contracts if c.expiry >= day]
    write_symbol_master(root, day, contracts)
    ids = register_contracts(root, contracts, specs)
    with connect(root) as con:
        run_id = ingest.start_run(con, "fyers", "bars_1m", day, ",".join(underlyings))

    raw = lake.RawSink(root, "fyers", day)
    current = {"name": VIX_NAME}
    client.on_response = lambda symbol, params, body: raw.add(current["name"], symbol, params, body)
    calls_at_start, rows_total = client.calls, 0
    try:
        vix_path = lake.bars_1m_path(root, "index", VIX_NAME, day)
        if force or not vix_path.exists():
            vix = client.minute_candles(VIX_SYMBOL, day)
            if vix:
                lake.write_parquet(bars_table(ids[VIX_SYMBOL], VIX_SYMBOL, vix), vix_path)
                rows_total += len(vix)
            details[VIX_NAME] = {"bars": len(vix)}
            log(f"{VIX_NAME}: {len(vix)} bars")
            raw.flush(VIX_NAME)

        for spec in specs:
            opt_path = lake.bars_1m_path(root, "option", spec.name, day)
            if opt_path.exists() and not force:
                log(f"{spec.name}: already collected for {day} — skipped (--force to redo)")
                continue
            current["name"] = spec.name
            calls_before = client.calls
            entry: dict = {"errors": []}
            details[spec.name] = entry

            index = client.minute_candles(spec.index_symbol, day)
            entry["index_bars"] = len(index)
            if not index:
                entry["errors"].append("no index candles — holiday, or data not published yet")
                log(f"{spec.name}: no index candles for {day} — skipped")
                raw.flush(spec.name)
                continue
            lake.write_parquet(
                bars_table(ids[spec.index_symbol], spec.index_symbol, index),
                lake.bars_1m_path(root, "index", spec.name, day),
            )
            rows_total += len(index)
            day_low = min(c.low for c in index)
            day_high = max(c.high for c in index)
            entry["range"] = [day_low, day_high]

            mine = [c for c in contracts if c.underlying == spec.name]
            # the nearest and the next future (BL-034 Phase 4), in one day file: each row's
            # instrument_id / vendor_symbol tells them apart
            futures = sorted((c for c in mine if c.option_type == "FUT"), key=lambda c: c.expiry)
            fut_tables = []
            entry["futures"] = []
            for fut in futures[:FUTURES_KEPT]:
                fut_candles = client.minute_candles(fut.symbol, day)
                entry["futures"].append({"symbol": fut.symbol, "bars": len(fut_candles)})
                if fut_candles:
                    fut_tables.append(bars_table(ids[fut.symbol], fut.symbol, fut_candles))
                    rows_total += len(fut_candles)
            if fut_tables:
                lake.write_parquet(
                    pa.concat_tables(fut_tables), lake.bars_1m_path(root, "future", spec.name, day)
                )

            options = [c for c in mine if c.option_type in ("CE", "PE")]
            expiries = select_expiries([c.expiry for c in options], day, spec.cadence)
            by_key = {(c.expiry, c.strike, c.option_type): c for c in options}
            rows: list[tuple[Contract, int, list[Candle]]] = []
            entry["expiries"] = {}

            for expiry in expiries:
                strikes = sorted(
                    {c.strike for c in options if c.expiry == expiry and c.strike is not None}
                )
                fetch = _contract_fetcher(client, day, expiry, by_key, ids, rows, entry["errors"])
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
                    f"(range {day_low:g}-{day_high:g}, "
                    f"+{chain.extra_up}/-{chain.extra_down} strikes), "
                    f"{with_bars}/{len(chain.candles)} contracts traded{cap}"
                )

            table = options_table(rows)
            lake.write_parquet(table, opt_path)
            raw.flush(spec.name)
            rows_total += table.num_rows
            entry["option_rows"] = table.num_rows
            entry["requests"] = client.calls - calls_before
            log(f"{spec.name}: {table.num_rows} option bars, {entry['requests']} requests")
    except Exception:
        with connect(root) as con:
            ingest.finish_run(
                con,
                run_id,
                requests=client.calls - calls_at_start,
                rows_written=rows_total,
                errors=1,
                details=details,
                failed=True,
            )
        raise
    finally:
        client.on_response = None

    errors = sum(len(v.get("errors", [])) for v in details.values() if isinstance(v, dict))
    with connect(root) as con:
        ingest.finish_run(
            con,
            run_id,
            requests=client.calls - calls_at_start,
            rows_written=rows_total,
            errors=errors,
            details=details,
        )
    return details


# ---------------------------------------------------------------------------
# One-off: move the pre-trading-data layout (FYERS_DATA_DIR, 2026-09-29) into the lake
# ---------------------------------------------------------------------------


def migrate_legacy(old: Path, root: Path, log: Callable[[str], None] = print) -> int:
    """Copy <old>/1m/{index,fut,opt}/<U>/<day>.parquet + symbols/ + manifest/ +
    results/ into the lake/catalog layout, registering instruments from each day's
    saved symbol master. Idempotent: days already in the lake are skipped."""
    import json
    import shutil

    days = sorted(p.stem for p in (old / "symbols").glob("*.parquet"))
    # The old layout overwrote a day's symbols file on every run, so a later
    # single-index backfill left only that index's contracts. Contracts are the
    # same whichever day listed them, so look symbols up across every snapshot.
    by_symbol: dict[str, Contract] = {}
    for d in days:
        for r in pq.read_table(old / "symbols" / f"{d}.parquet").to_pylist():
            by_symbol[r["symbol"]] = Contract(
                symbol=r["symbol"],
                underlying=r["underlying"],
                expiry=r["expiry"],
                strike=r["strike"],
                option_type=r["option_type"],
                lot_size=r["lot_size"],
            )
    migrated = 0
    for d in days:
        day = date.fromisoformat(d)
        contracts = [c for c in by_symbol.values() if c.expiry >= day]
        present = {p.parent.name for p in (old / "1m" / "opt").glob(f"*/{d}.parquet")}
        specs = [UNDERLYINGS[u] for u in sorted(present)]
        ids = register_contracts(root, contracts, specs)
        write_symbol_master(root, day, contracts)

        rows_total = 0
        for asset, folder, names in (
            ("index", "index", [*sorted(present), VIX_NAME]),
            ("future", "fut", sorted(present)),
            ("option", "opt", sorted(present)),
        ):
            for name in names:
                src = old / "1m" / folder / name / f"{d}.parquet"
                dst = lake.bars_1m_path(root, asset, name, day)
                if not src.exists() or dst.exists():
                    continue
                t = pq.read_table(src).rename_columns(
                    ["vendor_symbol" if c == "symbol" else c for c in pq.read_schema(src).names]
                )
                t = t.append_column(
                    "instrument_id",
                    pa.array([ids[s] for s in t.column("vendor_symbol").to_pylist()], pa.int64()),
                )
                target = OPT_SCHEMA if asset == "option" else BAR_SCHEMA
                lake.write_parquet(t.select(target.names).cast(target), dst)
                rows_total += t.num_rows
        if rows_total:
            manifest = old / "manifest" / f"{d}.json"
            with connect(root) as con:
                run_id = ingest.start_run(
                    con, "migration", "bars_1m", day, ",".join(sorted(present))
                )
                ingest.finish_run(
                    con,
                    run_id,
                    requests=0,
                    rows_written=rows_total,
                    errors=0,
                    details=json.loads(manifest.read_text()) if manifest.exists() else {},
                )
            migrated += 1
            log(f"{d}: {rows_total:,} rows moved into the lake")
        else:
            log(f"{d}: already in the lake")

    old_results = old / "results"
    if old_results.exists():
        shutil.copytree(old_results, root / "results", dirs_exist_ok=True)
        log(f"results copied to {root / 'results'}")
    return migrated
