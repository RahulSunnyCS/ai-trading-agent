"""The live board (BL-203): today's Adaptive picks, Classic and Tuned, run through the backtest
engine on the session so far, read from Angel One while the market is open.

Every refresh reads the day's 1-minute bars of what the picks need and nothing else: the index and
India VIX, and for each index a pick trades, its picked expiry's strikes from `BAND` below the
day's low to `BAND` above its high. That is about 70 requests a refresh for one index. The bars stay
in memory. Nothing goes to the lake or the catalog, so the evening collection and its checks are
untouched. The figures are the engine's (`legwise.engine.simulate_day`, the same call `rotation
update` scores the day with), so they are what the evening result will say if the bars agree.

A pick whose entry minute has not come is *waiting*. A leg still held is *open* and marked at the
last complete bar's close. The engine runs on to the exit time on forward-filled prices that never
move, which can fire nothing new; anything it reports after the last bar is treated as open.

Per lot and after the same costs as the evening message (the stored results' costs, nil today),
with a copy at `slip_store.SLIP_PCT` % slippage on every fill, the evening message's figure.
"Your lots" multiplies each pick by the lots the Settings › Automation rows trade it at
(`real_lots`): P&L scales with lots because every stop scales with them.

Files, all under `TRADING_DATA_ROOT/rotation/live-board/` (small JSON, never the lake):

    <day>.json     the latest snapshot for that day
    state.json     whether a refresh is running, the last error
    loop.json      the 5-minute loop's heartbeat (pid, last beat, next refresh)
    request.json   a refresh asked for by the dashboard's button, picked up by the loop

One Angel One login per day: the loop keeps the session in memory and holds the login guard's
lock only while it reads (`angelone.check.held`), so a connection test or a collection never logs
in on the same account mid-refresh. A rejected session is logged in again once.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import threading
import time
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..data.reference.loader import default_reference_data
from ..fyers.daily import data_dir
from ..legwise.engine import DayResult, simulate_day
from ..legwise.market import (
    N_MINUTES,
    DayData,
    Series,
    minute_index,
    minute_label,
    pick_expiry,
)
from ..legwise.schema import LegwiseStrategy, load_legwise
from . import journal, labels, live_lots, slip_store, store
from .automation_settings import BROKERS, PLATFORMS, paused_for
from .automation_settings import read as read_settings
from .lists import SIZING_DATE
from .variants import strategy_path, underlying_of

IST = timezone(timedelta(hours=5, minutes=30))
#: strikes fetched beyond the day's range so far, on each side of the picked expiry
BAND = 12
#: the 5-minute loop
EVERY_S = 300
#: the loop stops after this IST time (the session closes 15:30; one last refresh after it)
UNTIL = "15:31"
#: a loop whose heartbeat is older than this is not running (it beats every few seconds)
STALE_S = 30
#: the Adaptive list in a journal entry
LIST_KEY = "C"
#: (book, track, display name) — the names the dashboard's cards use
BOOKS: tuple[tuple[str, str | None, str], ...] = (
    ("core", None, "Adaptive Classic"),
    ("t1", "t1", "Adaptive Tuned"),
)
SLIP_PCT = slip_store.SLIP_PCT
#: Angel One's index rows (instrumenttype AMXIDX), by the collector's names
INDEX_ROWS = {
    "NIFTY": ("NSE", "Nifty 50"),
    "SENSEX": ("BSE", "SENSEX"),
    "INDIAVIX": ("NSE", "India VIX"),
}
OPTION_SEGMENT = {"NIFTY": "NFO", "SENSEX": "BFO"}

Bars = dict[int, tuple[float, float, float, float]]  # bar start epoch -> OHLC
Log = Callable[[str], None]


class BoardError(RuntimeError):
    """The board cannot be built (no picks recorded, the data could not be read)."""


class NotRead(BoardError):
    """Angel One would not answer for an index or a held contract (its rate limit): the refresh is
    dropped and the last snapshot kept, so a throttled minute never shows a wrong figure."""


# --- paths ----------------------------------------------------------------------------------


def board_dir(root: Path | None = None) -> Path:
    return store.rotation_dir(root) / "live-board"


def snapshot_path(day: date, root: Path | None = None) -> Path:
    return board_dir(root) / f"{day.isoformat()}.json"


def _write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=1) + "\n")
    tmp.replace(path)


def _read_json(path: Path) -> dict | None:
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def now_ist() -> datetime:
    return datetime.now(IST)


def _iso(at: datetime) -> str:
    return at.astimezone(IST).isoformat(timespec="seconds")


# --- the picks ------------------------------------------------------------------------------


@dataclass(frozen=True)
class BookPicks:
    book: str
    name: str
    core: list[str]
    buy: list[str]
    dte: dict[str, str] | None
    late: bool
    expiry_only: str | None


def todays_picks(day: date, root: Path | None = None) -> list[BookPicks]:
    """Each book's journal entry for `day` (Classic's live journal, Tuned's T1 track); a book with
    no entry for the day is left out."""
    out: list[BookPicks] = []
    for book, track, name in BOOKS:
        try:
            entries = journal.read(store.journal_path(root, track))
        except OSError:
            continue
        entry = next((e for e in entries if e.get("day") == day.isoformat()), None)
        block = (entry or {}).get("lists", {}).get(LIST_KEY)
        if not block:
            continue
        out.append(
            BookPicks(
                book=book,
                name=name,
                core=list(block.get("core") or []),
                buy=list(block.get("buy") or []),
                dte=entry.get("dte"),
                late=not entry.get("before_first_entry", True),
                expiry_only=entry.get("expiry_only"),
            )
        )
    return out


def real_lots(
    picks: BookPicks, settings: dict, day: date | None = None
) -> tuple[dict[str, int], list[str]]:
    """({variant: lots across every account that trades this list}, ["quantiply · angelone ×1"]).
    An account is a Settings › Automation row whose list is this book and that uploads it; its
    lots are its multiplier, times 2 for the Dir on a non-expiry day when its Dir ×2 is on
    (`live_lots.lots_for_day`), and the Buy add-on only when its add-on is on. Nothing trades
    while the uploads master is off or the settings pause covers `day`."""
    lots = {n: 0 for n in [*picks.core, *picks.buy]}
    accounts: list[str] = []
    if not (settings.get("masters") or {}).get("uploads", True):
        return lots, []
    if day is not None and paused_for(settings, day.isoformat()):
        return lots, []
    for platform in PLATFORMS:
        for broker in BROKERS:
            row = settings.get("rows", {}).get(f"{platform}.{broker}") or {}
            if row.get("list") != picks.book or not row.get("upload"):
                continue
            mult = int(row.get("multiplier") or 1)
            accounts.append(f"{platform} · {broker} ×{mult}")
            per = live_lots.lots_for_day(picks.core, picks.dte, on=bool(row.get("dirBoost")))
            for n in picks.core:
                lots[n] += mult * per.get(n, 1)
            if row.get("addon", True):
                for n in picks.buy:
                    lots[n] += mult
    return lots, accounts


# --- bars -> DayData ------------------------------------------------------------------------


def bar_minute(epoch: int) -> int:
    """The session minute index (0 = 09:15) of a bar starting at `epoch`."""
    at = datetime.fromtimestamp(epoch, IST)
    return at.hour * 60 + at.minute - (9 * 60 + 15)


def complete(bars: Bars, cutoff: float) -> Bars:
    """The bars that had closed by `cutoff` (epoch seconds): a bar starting at t closes at t + 60.
    The bar still forming is left out, so a refresh never reads a price that is still moving."""
    return {e: v for e, v in bars.items() if e + 60 <= cutoff}


def to_series(bars: Bars, last: int) -> Series:
    """A Series on the session grid up to minute `last`, forward-filled (as `market._load_bars`)."""
    series = Series.empty()
    for epoch, (o, h, lo, c) in bars.items():
        m = bar_minute(epoch)
        if 0 <= m <= last:
            series.open[m], series.high[m], series.low[m], series.close[m] = o, h, lo, c
    return series.forward_fill()


def last_minute(bars: Bars) -> int | None:
    minutes = [bar_minute(e) for e in bars]
    inside = [m for m in minutes if 0 <= m < N_MINUTES]
    return max(inside) if inside else None


@dataclass(frozen=True)
class OptionRow:
    expiry: date
    strike: float
    side: str  # CE | PE
    token: str
    exchange: str
    lot_size: int


def chain_rows(master: Iterable[dict], underlying: str, day: date) -> list[OptionRow]:
    """The underlying's listed options from Angel One's scrip master, expiring on or after `day`."""
    exchange = OPTION_SEGMENT[underlying]
    out: list[OptionRow] = []
    for row in master:
        if row.get("exch_seg") != exchange or row.get("instrumenttype") != "OPTIDX":
            continue
        if row.get("name") != underlying:
            continue
        side = str(row.get("symbol", ""))[-2:]
        if side not in ("CE", "PE"):
            continue
        try:
            expiry = datetime.strptime(str(row["expiry"]), "%d%b%Y").date()
            strike = round(float(row["strike"]) / 100, 2)
        except (KeyError, ValueError):
            continue
        if expiry < day:
            continue
        lot = int(float(row.get("lotsize") or 0)) or 1
        out.append(OptionRow(expiry, strike, side, str(row["token"]), exchange, lot))
    return out


def index_token(master: Iterable[dict], name: str) -> tuple[str, str] | None:
    """(exchange, token) of an index (or India VIX) in the scrip master."""
    exchange, symbol = INDEX_ROWS[name]
    for row in master:
        if (
            row.get("instrumenttype") == "AMXIDX"
            and row.get("exch_seg") == exchange
            and row.get("symbol") == symbol
        ):
            return exchange, str(row["token"])
    return None


def band(strikes: list[float], low: float, high: float, width: int = BAND) -> list[float]:
    """The listed strikes from `width` below the day's low to `width` above its high."""
    strikes = sorted(set(strikes))
    if not strikes:
        return []
    lo = max(0, bisect_left(strikes, low) - width)
    hi = min(len(strikes), bisect_right(strikes, high) + width)
    return strikes[lo:hi]


def expiries_needed(specs: Iterable[LegwiseStrategy], day: date, listed: list[date]) -> list[date]:
    """The expiries the picks' legs resolve to on `day` (weekly, next weekly, monthly)."""
    probe = DayData(day, "", Series.empty(), {}, listed, None)
    kinds = {leg.expiry for spec in specs for leg in spec.legs}
    out = {e for kind in kinds if (e := pick_expiry(probe, kind)) is not None}
    return sorted(out)


# --- running a pick -------------------------------------------------------------------------


def _with_slippage(spec: LegwiseStrategy, pct: float) -> LegwiseStrategy:
    return spec.model_copy(
        update={"execution": spec.execution.model_copy(update={"slippage_pct": pct})}
    )


def _trade_rows(
    result: DayResult, data: DayData, last: int, exit_slip_pct: float = 0.0
) -> tuple[list[dict], float, bool]:
    """(legs, gross, any open) for the trades entered by the last bar; a leg the engine closed
    after the last bar is open, marked at that bar's close. `exit_slip_pct` fills that mark against
    the trade (a sell bought back higher), as its exit will be, for the slipped copy."""
    legs: list[dict] = []
    gross = 0.0
    any_open = False
    for t in result.trades:
        if t.entry_min > last + 1:
            continue
        sign = 1 if t.position == "buy" else -1
        expiry, strike, side = t.contract
        held = t.exit_min is None or t.exit_min > last + 1
        if held:
            series = data.chain.get(t.contract)
            mark = series.close[last] if series is not None else None
            if mark is None:
                mark = t.exit_price if t.exit_price is not None else t.entry_price
            elif exit_slip_pct:
                mark = mark * (1 - sign * exit_slip_pct / 100)
            pnl = sign * (mark - t.entry_price) * t.qty
            any_open = True
        else:
            mark = t.exit_price
            pnl = t.pnl
        gross += pnl
        legs.append(
            {
                "leg": t.leg_id,
                "contract": f"{strike:g}{side} {expiry:%d%b}",
                "expiry": expiry.isoformat(),
                "strike": strike,
                "option_type": side,
                "side": t.position,
                "qty": t.qty,
                "entry": minute_label(t.entry_min),
                "entry_price": round(t.entry_price, 2),
                "exit": None if held else minute_label(t.exit_min),  # type: ignore[arg-type]
                "price": None if mark is None else round(mark, 2),
                "reason": "open" if held else (t.exit_reason or "exit"),
                "pnl": round(pnl, 2),
            }
        )
    return legs, gross, any_open


def blank_row(name: str, spec: LegwiseStrategy, state: str, role: str = "core") -> dict:
    """A pick with nothing to show yet: `waiting` (before its entry) or `no_data` (no bars)."""
    head, params = labels.label(name)
    return {
        "variant": name,
        "label": head,
        "params": params,
        "role": role,
        "underlying": spec.underlying,
        "entry_time": spec.entry_time,
        "exit_time": spec.exit_time,
        "state": state,
        "legs": [],
        "gross": 0.0,
        "net": 0.0,
        "net_slipped": 0.0,
        "worst_mtm": 0.0,
        "stopped_by": None,
        "curve": [],
    }


def run_pick(
    name: str,
    spec: LegwiseStrategy,
    data: DayData,
    last: int,
    *,
    role: str = "core",
    reference=None,
    sizing: date | None = None,
    slip_pct: float = SLIP_PCT,
) -> dict:
    """One pick on the session so far: its state, legs and figures at one lot."""
    head, params = labels.label(name)
    base: dict[str, Any] = {
        "variant": name,
        "label": head,
        "params": params,
        "role": role,
        "underlying": spec.underlying,
        "entry_time": spec.entry_time,
        "exit_time": spec.exit_time,
    }
    if minute_index(spec.entry_time) > last + 1:
        return blank_row(name, spec, "waiting", role)
    reference = reference or default_reference_data()
    sizing = sizing or date.fromisoformat(SIZING_DATE)
    result = simulate_day(spec, data, reference, sizing)
    legs, gross, any_open = _trade_rows(result, data, last)
    slipped = simulate_day(_with_slippage(spec, slip_pct), data, reference, sizing)
    _, gross_slipped, _ = _trade_rows(slipped, data, last, exit_slip_pct=slip_pct)
    curve = [(m, v) for m, v in result.mtm if m <= last]
    # an overall stop closes every leg, so one reported while a leg is open came after the last bar
    stopped = None if any_open else result.stopped_by
    return {
        **base,
        "state": "open" if any_open else "closed",
        "legs": legs,
        "gross": round(gross, 2),
        "net": round(gross - result.costs, 2),
        "net_slipped": round(gross_slipped - slipped.costs, 2),
        "worst_mtm": round(min((v for _, v in curve), default=0.0), 2),
        "stopped_by": stopped,
        "curve": [[m, round(v, 2)] for m, v in curve],
    }


def book_curve(picks: list[dict], last: int, lots: dict[str, int] | None = None) -> list[list]:
    """The list's MTM per minute up to `last`: each pick's curve summed, 0 before it enters and its
    last value after it ends; times `lots` per pick when given."""
    total = [0.0] * (last + 1)
    started = last + 1
    for p in picks:
        points = p.get("curve") or []
        if not points:
            continue
        k = (lots or {}).get(p["variant"], 1)
        by_min = {int(m): float(v) for m, v in points}
        first = min(by_min)
        started = min(started, first)
        value = 0.0
        for m in range(first, last + 1):
            value = by_min.get(m, value)
            total[m] += k * value
    return [[m, round(total[m], 2)] for m in range(started, last + 1)]


# --- the board ------------------------------------------------------------------------------


def build_board(
    day: date,
    books: list[BookPicks],
    days: dict[str, DayData],
    last: dict[str, int],
    settings: dict,
    *,
    refreshed_at: datetime,
    source: str = "angelone",
    notes: list[str] | None = None,
    edges: dict[tuple[str, str], tuple[float, float]] | None = None,
    unfixed: set[str] | None = None,
    unsure: set[str] | None = None,
    specs: dict[str, LegwiseStrategy] | None = None,
) -> dict:
    """The snapshot: every book's picks run on the bars so far, per lot and at your lots."""
    reference = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    notes = list(notes or [])
    out_books = []
    for b in books:
        lots, accounts = real_lots(b, settings, day)
        rows = []
        for role, names in (("core", b.core), ("buy", b.buy)):
            for name in names:
                u = underlying_of(name)
                spec = (specs or {}).get(name) or load_legwise(strategy_path(name))
                if u not in days:
                    blank = blank_row(name, spec, "no_data", role)
                    rows.append({**blank, "lots": lots.get(name, 0)})
                    continue
                row = run_pick(
                    name, spec, days[u], last[u], role=role, reference=reference, sizing=sizing
                )
                row["lots"] = lots.get(name, 0)
                row["strikes_sure"] = name not in (unsure or set())
                for leg in row["legs"] if unfixed is None or name in unfixed else []:
                    edge = (edges or {}).get((u, leg["expiry"]))
                    if edge is not None and (leg["strike"] <= edge[0] or leg["strike"] >= edge[1]):
                        notes.append(
                            f"{name}: {leg['contract']} is at the edge of the strikes read; "
                            "its strike choice may differ from the evening run"
                        )
                rows.append(row)
        common_last = min((last[u] for u in last), default=-1)
        per_lot = {
            "net": round(sum(r["net"] for r in rows), 2),
            "net_slipped": round(sum(r["net_slipped"] for r in rows), 2),
        }
        yours = {
            "net": round(sum(r.get("lots", 0) * r["net"] for r in rows), 2),
            "net_slipped": round(sum(r.get("lots", 0) * r["net_slipped"] for r in rows), 2),
            "lots": sum(lots.values()),
        }
        out_books.append(
            {
                "book": b.book,
                "name": b.name,
                "late": b.late,
                "expiry_only": b.expiry_only,
                "dte": b.dte,
                "accounts": accounts,
                "picks": rows,
                "per_lot": per_lot,
                "yours": yours,
                "curve": book_curve(rows, common_last) if common_last >= 0 else [],
                "curve_yours": book_curve(rows, common_last, lots) if common_last >= 0 else [],
            }
        )
    spot = {}
    for u, d in days.items():
        m = last[u]
        spot[u] = {"last": d.spot.close[m], "open": d.spot.open[0], "as_of": minute_label(m)}
        if d.vix is not None and d.vix.close[m] is not None:
            spot["INDIAVIX"] = {
                "last": d.vix.close[m],
                "open": d.vix.open[0],
                "as_of": minute_label(m),
            }
    as_of = min(last.values()) if last else None
    return {
        "v": 1,
        "day": day.isoformat(),
        "refreshed_at": _iso(refreshed_at),
        # the time of the last complete bar: the board is "as at" the end of that minute
        "as_of": None if as_of is None else minute_label(as_of + 1),
        "source": source,
        "slippage_pct": SLIP_PCT,
        "spot": spot,
        "books": out_books,
        "notes": sorted(set(notes)),
    }


# --- reading Angel One ----------------------------------------------------------------------

_MASTER: tuple[date, list[dict]] | None = None


def _wanted(row: dict) -> bool:
    """The master rows the board reads: the index rows, and NIFTY / SENSEX index options."""
    if row.get("instrumenttype") == "AMXIDX":
        return (row.get("exch_seg"), row.get("symbol")) in set(INDEX_ROWS.values())
    return row.get("instrumenttype") == "OPTIDX" and row.get("name") in OPTION_SEGMENT


def scrip_master(day: date, loader: Callable[[], list[dict]] | None = None) -> list[dict]:
    """The rows of Angel One's scrip master the board reads, downloaded once a day per process.
    Only those are kept: the whole master is about 40 MB, the rows a few thousand."""
    global _MASTER
    if _MASTER is None or _MASTER[0] != day:
        from ..angelone.symbols import download_master

        _MASTER = (day, [row for row in (loader or download_master)() if _wanted(row)])
    return _MASTER[1]


def fixed_contracts(previous: dict | None, specs: dict[str, LegwiseStrategy]) -> dict[str, set]:
    """{variant: its contracts} for every pick an earlier snapshot of the day shows with all its
    legs entered: its strikes are chosen once, at entry, so later refreshes read only those
    contracts (about 15 requests instead of 70). A pick not yet fully entered is not fixed."""
    out: dict[str, set] = {}
    for b in (previous or {}).get("books", []):
        for p in b.get("picks", []):
            spec = specs.get(p.get("variant"))
            legs = p.get("legs") or []
            if spec is None or p.get("state") not in ("open", "closed"):
                continue
            if not p.get("strikes_sure", True):  # chosen from a band Angel One sent only in part
                continue
            if len({leg["leg"] for leg in legs}) < len(spec.legs):
                continue
            try:
                out[p["variant"]] = {
                    (date.fromisoformat(leg["expiry"]), float(leg["strike"]), leg["option_type"])
                    for leg in legs
                }
            except (KeyError, TypeError, ValueError):
                continue
    return out


def _read_bars(client, exchange: str, token: str, day: date, cutoff: float) -> Bars | None:
    """One instrument's bars so far; None when Angel One would not answer (rate limit, an error)
    after one more try. A rejected session is raised (the caller logs in again)."""
    from ..angelone.auth import AngelCredentialsError

    for attempt in range(2):
        try:
            return complete(client.bars(exchange, token, day), cutoff)
        except AngelCredentialsError:
            raise  # a rejected session: the caller logs in again (it subclasses RuntimeError)
        except RuntimeError:
            if attempt == 0:
                time.sleep(3)
    return None


def fetch_and_build(
    client,
    day: date,
    books: list[BookPicks],
    settings: dict,
    *,
    master: list[dict],
    previous: dict | None = None,
    now: Callable[[], float] = time.time,
    log: Log = print,
) -> dict:
    """Read the bars the picks need through `client` (an AngelClient with a live session) and
    build the snapshot. Per index: its bars, India VIX's, each fully entered pick's own contracts
    (`fixed_contracts`) and, only for a pick that has just entered, the strike band of its expiry
    (a pick still waiting needs nothing). Raises AngelCredentialsError when the session is
    rejected."""
    cutoff = now()
    names = [n for b in books for n in (*b.core, *b.buy)]
    by_name = {n: load_legwise(strategy_path(n)) for n in names}
    fixed = fixed_contracts(previous, by_name)
    notes: list[str] = []
    days: dict[str, DayData] = {}
    last: dict[str, int] = {}
    edges: dict[tuple[str, str], tuple[float, float]] = {}
    failed = 0
    unsure: set[str] = set()
    vix_bars: Bars = {}
    vix = index_token(master, "INDIAVIX")
    if vix is not None:
        vix_bars = _read_bars(client, *vix, day, cutoff) or {}
    for u in sorted({underlying_of(n) for n in names}):
        mine_names = [n for n in names if underlying_of(n) == u]
        token = index_token(master, u)
        if token is None:
            notes.append(f"{u}: not found in Angel One's scrip master")
            continue
        read = _read_bars(client, *token, day, cutoff)
        if read is None:
            raise NotRead(f"Angel One would not send {u}'s bars (rate limit); last snapshot kept")
        spot_bars = read
        m = last_minute(spot_bars)
        if m is None:
            notes.append(f"{u}: no index bars yet")
            continue
        rows = chain_rows(master, u, day)
        listed = sorted({r.expiry for r in rows})
        by_key = {(r.expiry, r.strike, r.side): r for r in rows}
        entered = [n for n in mine_names if minute_index(by_name[n].entry_time) <= m + 1]
        want: set = set()
        for n in entered:
            want |= fixed.get(n, set())
        fresh = [n for n in entered if n not in fixed]
        if fresh:
            lows = [v[2] for v in spot_bars.values()]
            highs = [v[1] for v in spot_bars.values()]
            for expiry in expiries_needed([by_name[n] for n in fresh], day, listed):
                listed_strikes = [r.strike for r in rows if r.expiry == expiry]
                strikes = band(listed_strikes, min(lows), max(highs))
                if strikes:
                    edges[(u, expiry.isoformat())] = (strikes[0], strikes[-1])
                want |= {k for k in by_key if k[0] == expiry and k[1] in set(strikes)}
        held = set().union(*(fixed.get(n, set()) for n in entered)) if entered else set()
        chain: dict = {}
        for key in sorted(want):
            r = by_key.get(key)
            if r is None:
                continue
            bars = _read_bars(client, r.exchange, r.token, day, cutoff)
            if bars is None and key in held:
                raise NotRead(
                    f"Angel One would not send {u} {key[1]:g}{key[2]} (rate limit); "
                    "last snapshot kept"
                )
            if bars is None:
                failed += 1
                unsure |= set(fresh)
            elif bars:
                chain[key] = to_series(bars, m)
        days[u] = DayData(
            day=day,
            underlying=u,
            spot=to_series(spot_bars, m),
            chain=chain,
            listed_expiries=listed,
            master_lot_size=rows[0].lot_size if rows else None,
            vix=to_series(vix_bars, m) if vix_bars else None,
        )
        last[u] = m
        log(f"{u}: {len(chain)} contracts to {minute_label(m + 1)}, {client.calls} requests so far")
    if failed:
        notes.append(
            f"{failed} strike(s) near the edge of the band could not be read from Angel One "
            "(rate limit); a pick that entered just now may choose its strike again next refresh"
        )
    # only a pick chosen from the band this refresh can sit on its edge
    return build_board(
        day,
        books,
        days,
        last,
        settings,
        refreshed_at=datetime.fromtimestamp(cutoff, IST),
        notes=notes,
        edges=edges,
        unfixed={n for n in names if n not in fixed},
        unsure=unsure,
        specs=by_name,
    )


# --- state, heartbeat and the button's request ----------------------------------------------


def read_state(root: Path | None = None) -> dict:
    return _read_json(board_dir(root) / "state.json") or {}


def _update_state(root: Path | None, **fields) -> None:
    """Merge `fields` into state.json under an exclusive lock: the loop and the API both write it.
    A finished refresh (`refreshing` False) stamps `last_done_at` whatever its outcome, which is
    what the card waits for after a Refresh click."""
    folder = board_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    if fields.get("refreshing") is False:
        fields.setdefault("last_done_at", _iso(now_ist()))
    with open(folder / "state.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_state(root)
        state.update(fields)
        _write_json(folder / "state.json", state)


def mark_refreshing(by: str, root: Path | None = None) -> None:
    """The card's spinner from the moment a refresh is asked, before its login answers."""
    _update_state(root, refreshing=True, started_at=_iso(now_ist()), by=by)


def record_error(message: str, root: Path | None = None) -> None:
    _update_state(root, refreshing=False, last_error=message[:300], last_error_at=_iso(now_ist()))


def loop_status(root: Path | None = None, now: Callable[[], float] = time.time) -> dict:
    beat = _read_json(board_dir(root) / "loop.json") or {}
    pid = beat.get("pid")
    alive = False
    if isinstance(pid, int) and now() - float(beat.get("beat_at") or 0) <= STALE_S:
        try:
            os.kill(pid, 0)
            alive = True
        except OSError:
            alive = False
    return {
        "running": alive,
        "every_s": beat.get("every_s"),
        "next_at": beat.get("next_at") if alive else None,
    }


def request_refresh(root: Path | None = None) -> None:
    _write_json(board_dir(root) / "request.json", {"requested_at": _iso(now_ist())})


def _take_request(root: Path | None) -> bool:
    path = board_dir(root) / "request.json"
    if not path.exists():
        return False
    with contextlib.suppress(OSError):
        path.unlink()
    return True


def read_board(root: Path | None = None, day: date | None = None) -> dict:
    """What the dashboard reads: the day's snapshot (else the newest one), the refresh state and
    whether the loop runs."""
    folder = board_dir(root)
    day = day or now_ist().date()
    snap = _read_json(snapshot_path(day, root))
    if snap is None and folder.exists():
        days = sorted(p.stem for p in folder.glob("????-??-??.json"))
        snap = _read_json(folder / f"{days[-1]}.json") if days else None
    return {
        "today": day.isoformat(),
        "snapshot": snap,
        "state": read_state(root),
        "loop": loop_status(root),
    }


# --- one refresh ----------------------------------------------------------------------------


def refresh(
    session,
    day: date | None = None,
    root: Path | None = None,
    *,
    by: str = "loop",
    log: Log = print,
    client_factory=None,
    master_loader: Callable[[], list[dict]] | None = None,
) -> dict | None:
    """One refresh with a live Angel One `session`, written to the day's snapshot. The caller holds
    the login guard's lock. Returns the snapshot, or None when no picks are recorded yet. Raises
    AngelCredentialsError when the session is rejected (the caller logs in again)."""
    from ..angelone.auth import AngelCredentialsError

    root = root or data_dir()
    day = day or now_ist().date()
    books = todays_picks(day, root)
    started = now_ist()
    _update_state(root, refreshing=True, started_at=_iso(started), by=by)
    try:
        if not books:
            _update_state(
                root,
                refreshing=False,
                last_error=None,
                last_note=f"no picks recorded for {day} yet",
            )
            return None
        settings, _ = read_settings()
        if client_factory is None:
            from ..angelone.client import AngelClient

            client_factory = AngelClient
        client = client_factory(session)
        master = scrip_master(day, master_loader)
        previous = _read_json(snapshot_path(day, root))
        snap = fetch_and_build(
            client, day, books, settings, master=master, previous=previous, log=log
        )
        snap["requests"] = client.calls
        snap["took_s"] = round((now_ist() - started).total_seconds(), 1)
        snap["by"] = by
        _write_json(snapshot_path(day, root), snap)
        _update_state(
            root, refreshing=False, last_ok_at=snap["refreshed_at"], last_error=None, last_note=None
        )
        return snap
    except AngelCredentialsError:
        _update_state(root, refreshing=False)
        raise
    except Exception as error:  # noqa: BLE001 - recorded for the card; the loop carries on
        _update_state(
            root,
            refreshing=False,
            last_error=f"{type(error).__name__}: {error}"[:300],
            last_error_at=_iso(now_ist()),
        )
        raise


def login(source: str = "live-board", wait: bool = True, root: Path | None = None):
    """ONE guarded Angel One login; returns the session (the lock is released at once)."""
    from ..angelone import auth, check

    pending = check.begin(source, wait=wait, root=root)
    try:
        result, sess, error = pending.attempt()
    finally:
        pending.release()
    if sess is None:
        raise error or auth.AngelCredentialsError(result.message)
    return sess


class Board:
    """The loop's session: logged in once, logged in again once when Angel One rejects it."""

    #: re-logins a day before the loop gives up (each counts toward Angel One's lockout)
    MAX_LOGINS = 4

    def __init__(self, root: Path | None = None, log: Log = print) -> None:
        self.root = root or data_dir()
        self.log = log
        self.session = None
        self.logins = 0

    def _login(self) -> None:
        if self.logins >= self.MAX_LOGINS:
            from ..angelone.auth import AngelCredentialsError

            raise AngelCredentialsError(f"gave up after {self.logins} Angel One logins today")
        self.logins += 1
        self.session = login(root=self.root)
        self.log(f"logged in to Angel One ({self.logins} today)")

    def refresh(self, by: str = "loop") -> dict | None:
        from ..angelone import check
        from ..angelone.auth import AngelCredentialsError

        day = now_ist().date()
        if not todays_picks(day, self.root):
            _update_state(
                self.root,
                refreshing=False,
                last_error=None,
                last_note=f"no picks recorded for {day} yet",
            )
            return None
        for attempt in range(2):
            if self.session is None:
                self._login()
            try:
                with check.held("live-board", root=self.root):
                    return refresh(self.session, day, self.root, by=by, log=self.log)
            except AngelCredentialsError as error:
                if "rejected the session" not in str(error) or attempt == 1:
                    raise
                self.log("Angel One rejected the session; logging in again")
                self.session = None
        return None


class _Heartbeat:
    """Writes the loop's heartbeat every few seconds from a thread, so the loop reads as running
    through a refresh that takes minutes (a first band read, a wait for the guard's lock)."""

    def __init__(self, path: Path, every_s: int, interval_s: float = 5.0) -> None:
        self.path, self.every_s, self.interval_s = path, every_s, interval_s
        self.started = _iso(now_ist())
        self.next_at: float = time.time()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="live-board-beat", daemon=True)

    def beat(self) -> None:
        with contextlib.suppress(OSError):
            _write_json(
                self.path,
                {
                    "pid": os.getpid(),
                    "started_at": self.started,
                    "beat_at": time.time(),
                    "every_s": self.every_s,
                    "next_at": _iso(datetime.fromtimestamp(self.next_at, IST)),
                },
            )

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            self.beat()

    def __enter__(self) -> _Heartbeat:
        self.beat()
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=self.interval_s * 2)
        with contextlib.suppress(OSError):
            self.path.unlink()


def run_loop(
    every_s: int = EVERY_S,
    until: str = UNTIL,
    root: Path | None = None,
    log: Log = print,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Refresh every `every_s` seconds and whenever the dashboard's button asks, until `until`
    (IST). A failed refresh, Angel One unreachable or rate-limiting the login, or the guard's lock
    busy is recorded and retried at the next slot; a refused login stops the loop (exit 3:
    retrying would only repeat it)."""
    from ..angelone import check
    from ..angelone.auth import AngelCredentialsError, AngelNetworkError

    root = root or data_dir()
    board = Board(root, log)
    last_run = 0.0
    with _Heartbeat(board_dir(root) / "loop.json", every_s) as heart:
        while now_ist().strftime("%H:%M") < until:
            asked = _take_request(root)
            if asked or time.time() - last_run >= every_s:
                last_run = time.time()
                heart.next_at = last_run + every_s
                try:
                    snap = board.refresh(by="button" if asked else "loop")
                    if snap is not None:
                        totals = ", ".join(
                            f"{b['name']} {b['per_lot']['net']:+,.0f}" for b in snap["books"]
                        )
                        log(f"{snap['as_of']}: {totals} (a lot each)")
                # AngelNetworkError (and AngelUnavailableError, a rate-limited login) subclass
                # AngelCredentialsError: they must be caught first, or a blip would end the day
                except (AngelNetworkError, check.CheckRefused) as error:
                    record_error(f"refresh skipped: {error}", root)
                    log(f"refresh skipped: {error}")
                except AngelCredentialsError as error:
                    record_error(f"stopped: {error}", root)
                    log(f"stopped: {error}")
                    return 3
                except Exception as error:  # noqa: BLE001 - recorded in state.json; carry on
                    log(f"refresh failed: {type(error).__name__}: {error}")
            sleep(5)
        # one last refresh after the close, so the board ends on the session's final bars
        with contextlib.suppress(Exception):
            board.refresh(by="loop")
    return 0
