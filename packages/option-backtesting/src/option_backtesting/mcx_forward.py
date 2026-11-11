"""BL-219: the forward paper test of GOLDM Dir in the expiry week (the one cell BL-218 passed).

Nothing here places an order. Each night `score` takes every session in a GOLDM expiry window
that has its data and has no journal line yet, simulates the frozen rule on it with the BL-218
engine (the same code that produced the backtest), and appends one hash-chained line to
`TRADING_DATA_ROOT/mcx-forward/goldm-dir/journal.jsonl`. `spread` reads Fyers' live quotes at
18:00 for the two entry contracts and keeps their bid/ask, to set beside the backtest's 1%
slippage. The rule, the start expiry and the pass rule are frozen in backlog/BL-219.

Pieces, in the order a night runs them:

* `extend_calendar`: every listed GOLDM option expiry with the future it settles on, from the live
  MCX master, into the contract calendar the engine reads (`legwise.market.mcx_calendar`).
* `sessions_to_score`: the sessions in each expiry window (the last 5 ending on expiry day) that
  are past, have option bars in the lake and are not journaled.
* `ensure_future_day`: the settling future's bars for the session (one `/data/history` call) into
  the lake, replacing only that future's rows.
* `score_session`: load the day, run the rule, charge it, journal it.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.compute
import pyarrow.parquet as pq
from trading_data import lake
from trading_data.lake import BAR_SCHEMA

from .data.reference.loader import default_reference_data
from .fyers.client import DATA_API, FyersClient
from .fyers.daily import bars_table
from .fyers.mcx import MASTER_SEGMENT
from .fyers.mcx_futures import FuturePlan, future_symbol, register_futures, settling_future
from .fyers.symbols import IST, download_master, parse_master
from .legwise.engine import simulate_day
from .legwise.market import load_day, mcx_calendar, mcx_calendar_path, minute_label
from .legwise.mcx_charges import trade_charges
from .legwise.schema import LegwiseStrategy
from .rotation import journal

ROOT = "GOLDM"
#: the frozen rule: BL-218's grid cell, kept in one place so the pre-registration, the journal
#: entries and the test that holds it equal to the grid all name the same string
CELL_ID = "dir|entry=18:00|strike=ITM1|sl=21|reentry=cost1|exit=close"
GRID_SHA = "88bc794621b0ee32"
START_EXPIRY = date(2026, 11, 27)  # the first gold option expiry whose window is scored
WINDOW = 5  # sessions, ending on expiry day
SLIPPAGE_PCT = 1.0
EXITS = {"summer": "23:15", "winter": "23:40"}  # 15 minutes before the 23:30 / 23:55 close
#: the day's close: the last future bar at or after this is a 23:55-close (winter) session
WINTER_FROM_MIN = 23 * 60 + 30
SIZING_DATE = date(2026, 11, 11)  # lot sizing as in BL-218: a fixed date, not today


def forward_dir(root_dir: Path) -> Path:
    return root_dir / "mcx-forward" / "goldm-dir"


def journal_path(root_dir: Path) -> Path:
    return forward_dir(root_dir) / "journal.jsonl"


def strategy(season: str) -> LegwiseStrategy:
    """The frozen rule as a legwise strategy (equal to BL-218's `grid.build`, held by a test)."""
    leg = {
        "lots": 1,
        "position": "sell",
        "expiry": "weekly",
        "strike": {"strike_type": "ITM1"},
        "stop_loss": {"percent": 21},
        "reentry_on_sl": {"mode": "cost", "count": 1},
    }
    return LegwiseStrategy.model_validate(
        {
            "id": f"bl218:{ROOT}:{CELL_ID}",
            "underlying": ROOT,
            "entry_time": "18:00",
            "exit_time": EXITS[season],
            "square_off": "partial",
            "legs": [
                {"id": "ce", "option_type": "CE", **leg},
                {"id": "pe", "option_type": "PE", **leg},
            ],
            "execution": {"slippage_pct": SLIPPAGE_PCT},
        }
    )


# -- the contract calendar ------------------------------------------------------------------


def extend_calendar(root_dir: Path, today: date, master_text: str | None = None) -> dict:
    """Add every GOLDM option expiry the live MCX master lists (and its settling future) to the
    contract calendar. An expiry already in it is left as it is. Returns {added, expiries}."""
    text = master_text if master_text is not None else download_master(MASTER_SEGMENT)
    contracts = parse_master(text, {ROOT})
    futures = sorted({c.expiry for c in contracts if c.option_type == "FUT"})
    options = sorted({c.expiry for c in contracts if c.option_type in ("CE", "PE")})
    path = mcx_calendar_path(root_dir, ROOT)
    cal = json.loads(path.read_text()) if path.exists() else {"options": {}, "futures": {}}
    added = []
    for e in options:
        if e.isoformat() in cal["options"] and cal["options"][e.isoformat()]:
            continue
        fut = settling_future(e, futures)
        if fut is None:
            continue
        cal["options"][e.isoformat()] = future_symbol(ROOT, fut)
        cal["futures"][future_symbol(ROOT, fut)] = fut.isoformat()
        added.append(e.isoformat())
    if added:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cal, indent=1, sort_keys=True))
        tmp.replace(path)
    return {"added": added, "expiries": sorted(cal["options"])}


# -- which sessions -------------------------------------------------------------------------


def _weekdays_after(day: date, until: date) -> list[date]:
    out, d = [], day + timedelta(days=1)
    while d <= until:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def window(expiry: date, collected: list[date], upto: date) -> list[date]:
    """The last WINDOW sessions ending on `expiry`, as known on the night of session `upto`: the
    days the lake holds option bars for (and `upto` itself when it is a weekday, collected or
    not), then the weekdays still to come. A holiday not yet known can only widen the real
    window, never drop a day scored here."""
    known = {d for d in collected if d <= min(upto, expiry)}
    if upto <= expiry and upto.weekday() < 5:
        known.add(upto)
    days = sorted(known)
    last = max(days[-1] if days else upto, upto)
    future = _weekdays_after(last, expiry) if last < expiry else []
    return (days + future)[-WINDOW:]


def option_days(root_dir: Path) -> list[date]:
    return lake.available_days(root_dir, "option", ROOT)


def sessions_to_score(root_dir: Path, last_session: date) -> list[tuple[date, date]]:
    """[(session, expiry)] still to journal: in a window of an expiry from START_EXPIRY on, not
    after `last_session` (the session just closed), with option bars collected and no journal
    line."""
    cal = mcx_calendar(root_dir, ROOT)["options"]
    collected = option_days(root_dir)
    done = {e["day"] for e in journal.read(journal_path(root_dir))}
    out = []
    for e_s in sorted(cal):
        expiry = date.fromisoformat(e_s)
        if expiry < START_EXPIRY:
            continue
        for d in window(expiry, collected, last_session):
            if d <= last_session and d.isoformat() not in done and d in collected:
                out.append((d, expiry))
    return out


def expected_without_data(root_dir: Path, last_session: date) -> date | None:
    """`last_session` when it falls in a window but has no option bars (a holiday, or the
    collector has not delivered): the one session a night can alert about."""
    cal = mcx_calendar(root_dir, ROOT)["options"]
    collected = option_days(root_dir)
    if last_session in collected or last_session.weekday() >= 5:
        return None
    for e_s in sorted(cal):
        expiry = date.fromisoformat(e_s)
        if expiry >= START_EXPIRY and last_session in window(expiry, collected, last_session):
            return last_session
    return None


# -- the settling future's bars -------------------------------------------------------------


def ensure_future_day(root_dir: Path, client: FyersClient, day: date, expiry: date) -> str:
    """Make sure the lake holds the settling future's bars for `day`; returns its symbol. One
    `/data/history` call when missing; only this future's rows of the day's file are replaced."""
    cal = mcx_calendar(root_dir, ROOT)
    symbol = cal["options"][expiry.isoformat()]
    path = lake.bars_1m_path(root_dir, "future", ROOT, day)
    if path.exists():
        have = pq.read_table(path, columns=["vendor_symbol"]).column("vendor_symbol").to_pylist()
        if symbol in have:
            return symbol
    candles = client.minute_candles(symbol, day)
    if not candles:
        raise RuntimeError(f"no {symbol} bars for {day}: not a session, or not collectable yet")
    plan = FuturePlan(ROOT, expiry, symbol, day, day, date.fromisoformat(cal["futures"][symbol]))
    ids = register_futures(root_dir, [plan])
    new = bars_table(ids[symbol], symbol, candles)
    if path.exists():
        old = pq.read_table(path).cast(BAR_SCHEMA)
        keep = [s != symbol for s in old.column("vendor_symbol").to_pylist()]
        new = pa.concat_tables([old.filter(pa.array(keep)), new])
    new = new.sort_by([("ts", "ascending"), ("instrument_id", "ascending")])
    lake.write_parquet(new, path)
    return symbol


def season_of(root_dir: Path, symbol: str, day: date) -> str:
    """winter when the settling future traded at or after 23:30 that day (a 23:55 close)."""
    path = lake.bars_1m_path(root_dir, "future", ROOT, day)
    table = pq.read_table(path, columns=["ts", "vendor_symbol"])
    table = table.filter(pa.compute.equal(table.column("vendor_symbol"), symbol))
    last = max(
        (
            t.astimezone(IST).hour * 60 + t.astimezone(IST).minute
            for t in table.column("ts").to_pylist()
        ),
        default=0,
    )
    return "winter" if last >= WINTER_FROM_MIN else "summer"


# -- scoring --------------------------------------------------------------------------------


def _k(expiry: date, day: date, collected: list[date]) -> int:
    """Sessions after `day` up to expiry day: collected ones, then weekdays still to come."""
    after = [d for d in collected if day < d <= expiry]
    last = max(after[-1] if after else day, day)
    return len(after) + (len(_weekdays_after(last, expiry)) if last < expiry else 0)


def score_session(
    root_dir: Path,
    client: FyersClient,
    day: date,
    expiry: date,
    *,
    now: datetime | None = None,
    slippages: tuple[float, ...] = (0.5, 0.0),
) -> dict:
    """Simulate the frozen rule on `day`, charge it and append its journal line (raises
    `journal.AlreadyRecorded` for a recorded day). Returns the entry."""
    symbol = ensure_future_day(root_dir, client, day, expiry)
    data = load_day(root_dir, ROOT, day)
    season = season_of(root_dir, symbol, day)
    ref = default_reference_data()

    def run(slip: float):
        s = strategy(season)
        s = s.model_copy(
            update={"execution": s.execution.model_copy(update={"slippage_pct": slip})}
        )
        r = simulate_day(s, data, ref, sizing_date=SIZING_DATE)
        charges = sum(trade_charges(t) for t in r.trades)
        return r, charges

    result, charges = run(SLIPPAGE_PCT)
    trades = [
        {
            "leg": t.leg_id,
            "contract": f"{t.contract[1]:g}{t.contract[2]}",
            "side": t.position,
            "qty": t.qty,
            "in": minute_label(t.entry_min, data.session_start),
            "in_price": round(t.entry_price, 2),
            "out": minute_label(t.exit_min, data.session_start) if t.exit_min is not None else None,
            "out_price": round(t.exit_price, 2) if t.exit_price is not None else None,
            "reason": t.exit_reason,
        }
        for t in result.trades
    ]
    sensitivity = {}
    for slip in slippages:
        r, c = run(slip)
        sensitivity[f"net_{slip:g}pct"] = round(r.gross - c, 2)
    collected = option_days(root_dir)
    fields = {
        "day": day.isoformat(),
        "expiry": expiry.isoformat(),
        "k": _k(expiry, day, collected),
        "rule": CELL_ID,
        "grid_sha": GRID_SHA,
        "future": symbol,
        "season": season,
        "future_at_18": data.spot.price_at(18 * 60 - data.session_start),
        "trades": trades,
        "gross": round(result.gross, 2),
        "charges": round(charges, 2),
        "net": round(result.gross - charges, 2),
        "stopped_by": result.stopped_by,
        "notes": result.notes,
        **sensitivity,
        "recorded_at": (now or datetime.now(IST)).astimezone(IST).isoformat(timespec="seconds"),
    }
    return journal.append(journal_path(root_dir), fields)


def summary(root_dir: Path) -> dict:
    """Running totals over the journal, by expiry, with the registered pass rule."""
    entries = journal.read(journal_path(root_dir))
    by: dict[str, float] = {}
    for e in entries:
        by[e["expiry"]] = by.get(e["expiry"], 0.0) + e["net"]
    net = sum(e["net"] for e in entries)
    wins = sum(e["net"] for e in entries if e["net"] > 0)
    losses = -sum(e["net"] for e in entries if e["net"] < 0)
    return {
        "sessions": len(entries),
        "expiries": len(by),
        "net": round(net, 2),
        "net_0.5pct": round(sum(e.get("net_0.5pct", 0.0) for e in entries), 2),
        "net_0pct": round(sum(e.get("net_0pct", 0.0) for e in entries), 2),
        "profit_factor": round(wins / losses, 2) if losses else None,
        "expiries_up": sum(1 for v in by.values() if v > 0),
        "by_expiry": {k: round(v, 2) for k, v in sorted(by.items())},
        "pass_rule_met": len(by) >= 6 and net > 0 and sum(1 for v in by.values() if v > 0) >= 4,
    }


def telegram_line(entry: dict, totals: dict) -> str:
    """One short line a session for the owner's private chat."""
    day = date.fromisoformat(entry["day"])
    legs = " ".join(
        f"{t['contract']} {t['in_price']}→{t['out_price']} {t['reason']}" for t in entry["trades"]
    )
    k = entry["k"]
    return (
        f"Gold Dir paper, {day:%a %d %b} (expiry −{k}): net ₹{entry['net']:,.0f} "
        f"(gross {entry['gross']:,.0f}, charges {entry['charges']:,.0f}). {legs or 'no entry'}. "
        f"Run so far: {totals['sessions']} sessions, ₹{totals['net']:,.0f}, "
        f"{totals['expiries_up']}/{totals['expiries']} expiries up."
    )


# -- the 18:00 spread snapshot --------------------------------------------------------------


def in_expected_window(today: date, expiry: date) -> bool:
    return (
        expiry >= START_EXPIRY and today <= expiry and len(_weekdays_after(today, expiry)) < WINDOW
    )


def nearest_expiry(root_dir: Path, today: date) -> date | None:
    cal = mcx_calendar(root_dir, ROOT)["options"]
    later = sorted(date.fromisoformat(e) for e in cal if date.fromisoformat(e) >= today)
    return later[0] if later else None


def _quotes(client: FyersClient, symbols: list[str]) -> dict[str, dict]:
    body = client._get({"symbols": ",".join(symbols)}, endpoint=f"{DATA_API}/quotes")
    if body.get("s") != "ok":
        raise RuntimeError(f"quotes: {body.get('message') or body}")
    return {row["n"]: row["v"] for row in body.get("d", []) if row.get("s") == "ok"}


def spread_snapshot(
    root_dir: Path, client: FyersClient, today: date, master_text: str | None = None
) -> dict | None:
    """At 18:00 on a window weekday: bid/ask of the future and the ITM1 pair (and the ATM
    pair), read-only. None when today is outside the window. Writes
    mcx-forward/goldm-dir/spread/<day>.json."""
    expiry = nearest_expiry(root_dir, today)
    if expiry is None or not in_expected_window(today, expiry):
        return None
    cal = mcx_calendar(root_dir, ROOT)
    future = cal["options"][expiry.isoformat()]
    text = master_text if master_text is not None else download_master(MASTER_SEGMENT)
    options = {
        (c.strike, c.option_type): c.symbol
        for c in parse_master(text, {ROOT})
        if c.option_type in ("CE", "PE") and c.expiry == expiry
    }
    ref = default_reference_data()
    step = ref.strike_step(ROOT, today)
    ltp = _quotes(client, [future])[future]["lp"]
    atm = round(ltp / step) * step
    wanted = {
        "ITM1_CE": (atm - step, "CE"),
        "ITM1_PE": (atm + step, "PE"),
        "ATM_CE": (atm, "CE"),
        "ATM_PE": (atm, "PE"),
    }
    symbols = {name: options.get(key) for name, key in wanted.items()}
    quotes = _quotes(client, [future] + [s for s in symbols.values() if s])
    out: dict = {
        "day": today.isoformat(),
        "expiry": expiry.isoformat(),
        "read_at": datetime.now(IST).isoformat(timespec="seconds"),
        "future": {"symbol": future, "lp": ltp},
        "atm": atm,
        "contracts": {},
    }
    for name, symbol in symbols.items():
        v = quotes.get(symbol or "", {})
        bid, ask = v.get("bid") or None, v.get("ask") or None
        mid = (bid + ask) / 2 if bid and ask else None
        out["contracts"][name] = {
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "lp": v.get("lp"),
            "spread_pct_of_mid": round(100 * (ask - bid) / mid, 3) if mid else None,
        }
    path = forward_dir(root_dir) / "spread" / f"{today}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1, sort_keys=True))
    return out
