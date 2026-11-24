"""BL-219: the forward paper test of GOLDM Dir in the expiry week (the one cell BL-218 passed);
BL-242: the same machinery for SILVERM Dir in the week before expiry. A `Rule` names one frozen
setting; each rule has its own journal, window and pass rule.

Nothing here places an order. Each night `score` takes every session in an expiry window
that has its data and has no journal line yet, simulates the frozen rule on it with the BL-218
engine (the same code that produced the backtest), and appends one hash-chained line to
`TRADING_DATA_ROOT/mcx-forward/goldm-dir/journal.jsonl`. `spread` reads Fyers' live quotes at
18:00 for the two entry contracts and keeps their bid/ask, to set beside the backtest's 1%
slippage. The rule, the start expiry and the pass rule are frozen in backlog/BL-219 (gold) and
backlog/BL-242 (silver).

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
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.compute
import pyarrow.parquet as pq
from trading_data import lake

from .data.providers.base import Right
from .data.reference.loader import default_reference_data
from .data.resolver import resolve_strike
from .fyers.client import DATA_API, FyersClient
from .fyers.daily import bars_table
from .fyers.mcx import MASTER_SEGMENT
from .fyers.mcx_futures import (
    FuturePlan,
    future_symbol,
    merge_future_day,
    register_futures,
    settling_future,
)
from .fyers.symbols import IST, download_master, parse_master
from .legwise.engine import simulate_day
from .legwise.market import load_day, mcx_calendar, mcx_calendar_path, minute_label
from .legwise.mcx_charges import trade_charges
from .legwise.schema import LegwiseStrategy
from .rotation import journal


@dataclass(frozen=True)
class Rule:
    """One frozen forward-test setting (a BL-218 grid cell on one root and one week type)."""

    key: str  # the CLI / API name; the journal folder is `mcx-forward/<key>`
    root: str
    cell_id: str  # BL-218's cell id, the same string the grid builds
    label: str  # "Gold Dir paper": the Telegram line's lead
    entry: str  # HH:MM, the entry minute
    strike: str  # the entry strike rule (ITM1 / ATM): which snapshot contracts are the entries
    sl: int  # leg stop, percent
    reentry: bool  # one re-entry at cost after a stop
    start_expiry: date  # the first option expiry whose window is scored
    week_offset: int  # 0 = the expiry week (E-4..E0), 1 = the week before (E-9..E-5)
    spot_key: str  # the journal field for the settling future at entry
    dirname: str = ""
    expiries_needed: int = 6
    expiries_up_needed: int = 4

    @property
    def folder(self) -> str:
        return self.dirname or self.key


#: the frozen rule: BL-218's grid cell, kept in one place so the pre-registration, the journal
#: entries and the test that holds it equal to the grid all name the same string
CELL_ID = "dir|entry=18:00|strike=ITM1|sl=21|reentry=cost1|exit=close"
GRID_SHA = "88bc794621b0ee32"
GOLD = Rule(
    key="goldm-dir",
    root="GOLDM",
    cell_id=CELL_ID,
    label="Gold Dir paper",
    entry="18:00",
    strike="ITM1",
    sl=21,
    reentry=True,
    start_expiry=date(2026, 11, 27),  # the first gold option expiry whose window is scored
    week_offset=0,
    spot_key="future_at_18",
)
SILVER = Rule(
    key="silverm-dir-before",
    root="SILVERM",
    cell_id="dir|entry=17:05|strike=ATM|sl=21|reentry=none|exit=close",
    label="Silver Dir paper (week before)",
    entry="17:05",
    strike="ATM",
    sl=21,
    reentry=False,
    start_expiry=date(2026, 12, 28),  # BL-242: its week before starts on 15 Dec 2026
    week_offset=1,
    spot_key="future_at_entry",
)
#: every rule, in the order the nightly score runs them
RULES: dict[str, Rule] = {r.key: r for r in (GOLD, SILVER)}
#: the default rule of every function below, and the module's original names (BL-219)
ROOT = GOLD.root
START_EXPIRY = GOLD.start_expiry
WINDOW = 5  # sessions in a window
SLIPPAGE_PCT = 1.0
EXITS = {"summer": "23:15", "winter": "23:40"}  # 15 minutes before the 23:30 / 23:55 close
#: the day's close: the last future bar at or after this is a 23:55-close (winter) session
WINTER_FROM_MIN = 23 * 60 + 30
SIZING_DATE = date(2026, 11, 11)  # lot sizing as in BL-218: a fixed date, not today


def forward_dir(root_dir: Path, rule: Rule = GOLD) -> Path:
    return root_dir / "mcx-forward" / rule.folder


def journal_path(root_dir: Path, rule: Rule = GOLD) -> Path:
    return forward_dir(root_dir, rule) / "journal.jsonl"


def strategy(season: str, rule: Rule = GOLD) -> LegwiseStrategy:
    """The frozen rule as a legwise strategy (equal to BL-218's `grid.build`, held by a test)."""
    leg = {
        "lots": 1,
        "position": "sell",
        "expiry": "weekly",
        "strike": {"strike_type": rule.strike},
        "stop_loss": {"percent": rule.sl},
        **({"reentry_on_sl": {"mode": "cost", "count": 1}} if rule.reentry else {}),
    }
    return LegwiseStrategy.model_validate(
        {
            "id": f"bl218:{rule.root}:{rule.cell_id}",
            "underlying": rule.root,
            "entry_time": rule.entry,
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


def extend_calendar(
    root_dir: Path, today: date, master_text: str | None = None, rule: Rule = GOLD
) -> dict:
    """Add every option expiry of the rule's root that the live MCX master lists (and its settling
    future) to the contract calendar. An expiry already in it is left as it is. Returns
    {added, expiries}."""
    text = master_text if master_text is not None else download_master(MASTER_SEGMENT)
    root = rule.root
    contracts = parse_master(text, {root})
    futures = sorted({c.expiry for c in contracts if c.option_type == "FUT"})
    options = sorted({c.expiry for c in contracts if c.option_type in ("CE", "PE")})
    path = mcx_calendar_path(root_dir, root)
    cal = json.loads(path.read_text()) if path.exists() else {"options": {}, "futures": {}}
    added = []
    for e in options:
        if e.isoformat() in cal["options"] and cal["options"][e.isoformat()]:
            continue
        fut = settling_future(e, futures)
        if fut is None:
            continue
        cal["options"][e.isoformat()] = future_symbol(root, fut)
        cal["futures"][future_symbol(root, fut)] = fut.isoformat()
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


def window(
    expiry: date, collected: list[date], upto: date, rule: Rule = GOLD, settled: bool = True
) -> list[date]:
    """The rule's WINDOW sessions: the last five ending on `expiry` (the expiry week) or the five
    before those (`week_offset` 1), as known on the night of session `upto`: the days the lake
    holds option bars for (and `upto` itself when it is a weekday, collected or not), then the
    weekdays still to come. A holiday not yet known can only widen the real window of the expiry
    week, never drop a day scored here. The week before is different: a holiday in the expiry
    week moves its whole block one session earlier (BL-218 counts sessions, not weekdays), so with
    `settled` (the default, what scoring uses) it is empty until `upto` reaches the expiry day,
    when every session of the expiry week is known. `settled=False` is the provisional dates the
    dashboard shows ahead of that."""
    known = {d for d in collected if d <= min(upto, expiry)}
    if upto <= expiry and upto.weekday() < 5:
        known.add(upto)
    days = sorted(known)
    last = max(days[-1] if days else upto, upto)
    future = _weekdays_after(last, expiry) if last < expiry else []
    if rule.week_offset and settled and upto < expiry:
        return []
    span = WINDOW * (rule.week_offset + 1)
    seq = (days + future)[-span:]
    return seq[:WINDOW] if rule.week_offset else seq


def option_days(root_dir: Path, rule: Rule = GOLD) -> list[date]:
    return lake.available_days(root_dir, "option", rule.root)


def sessions_to_score(
    root_dir: Path, last_session: date, rule: Rule = GOLD
) -> list[tuple[date, date]]:
    """[(session, expiry)] still to journal: in a window of an expiry from START_EXPIRY on, not
    after `last_session` (the session just closed), with option bars collected and no journal
    line."""
    cal = mcx_calendar(root_dir, rule.root)["options"]
    collected = option_days(root_dir, rule)
    done = {e["day"] for e in journal.read(journal_path(root_dir, rule))}
    out = []
    for e_s in sorted(cal):
        expiry = date.fromisoformat(e_s)
        if expiry < rule.start_expiry:
            continue
        for d in window(expiry, collected, last_session, rule):
            if d <= last_session and d.isoformat() not in done and d in collected:
                out.append((d, expiry))
    return out


def expected_without_data(root_dir: Path, last_session: date, rule: Rule = GOLD) -> date | None:
    """`last_session` when it falls in a window but has no option bars (a holiday, or the
    collector has not delivered) and has not been alerted about yet: the one session a night can
    alert about, once (the marker keeps retries and later nights quiet)."""
    marker = forward_dir(root_dir, rule) / "alerted" / f"{last_session}"
    if marker.exists():
        return None
    cal = mcx_calendar(root_dir, rule.root)["options"]
    collected = option_days(root_dir, rule)
    if last_session in collected or last_session.weekday() >= 5:
        return None
    for e_s in sorted(cal):
        expiry = date.fromisoformat(e_s)
        if expiry >= rule.start_expiry and last_session in window(
            expiry, collected, last_session, rule
        ):
            return last_session
    return None


def mark_alerted(root_dir: Path, day: date, rule: Rule = GOLD) -> None:
    marker = forward_dir(root_dir, rule) / "alerted" / f"{day}"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(datetime.now(IST).isoformat(timespec="seconds"))


# -- the settling future's bars -------------------------------------------------------------


def ensure_future_day(
    root_dir: Path, client: FyersClient, day: date, expiry: date, rule: Rule = GOLD
) -> str:
    """Make sure the lake holds the settling future's bars for `day`; returns its symbol. One
    `/data/history` call when missing; only this future's rows of the day's file are replaced."""
    root = rule.root
    cal = mcx_calendar(root_dir, root)
    symbol = cal["options"][expiry.isoformat()]
    path = lake.bars_1m_path(root_dir, "future", root, day)
    if path.exists():
        have = pq.read_table(path, columns=["vendor_symbol"]).column("vendor_symbol").to_pylist()
        if symbol in have:
            return symbol
    candles = client.minute_candles(symbol, day)
    if not candles:
        raise RuntimeError(f"no {symbol} bars for {day}: not a session, or not collectable yet")
    plan = FuturePlan(root, expiry, symbol, day, day, date.fromisoformat(cal["futures"][symbol]))
    ids = register_futures(root_dir, [plan])
    new = merge_future_day(path, bars_table(ids[symbol], symbol, candles), {symbol})
    lake.write_parquet(new, path)
    return symbol


class NotComplete(RuntimeError):
    """The day's bars stop before the close: the collector has not finished (or failed). The
    journal refuses edits, so such a session is left pending, never scored from a partial file."""


#: the expiring contracts and the future trade to the close (23:29 / 23:54 last bar): a day
#: whose latest bar is earlier than this is not whole
COMPLETE_FROM_MIN = 23 * 60 + 25


def _last_bar_min(table: pa.Table) -> int:
    stamps = [t.astimezone(IST) for t in table.column("ts").to_pylist()]
    return max((t.hour * 60 + t.minute for t in stamps), default=0)


def check_complete(root_dir: Path, day: date, expiry: date, symbol: str, rule: Rule = GOLD) -> None:
    """Raise NotComplete unless the settling future's and the expiring options' bars both reach
    the close."""
    fut = pq.read_table(
        lake.bars_1m_path(root_dir, "future", rule.root, day), columns=["ts", "vendor_symbol"]
    )
    fut = fut.filter(pa.compute.equal(fut.column("vendor_symbol"), symbol))
    opt = pq.read_table(
        lake.bars_1m_path(root_dir, "option", rule.root, day), columns=["ts", "expiry"]
    )
    opt = opt.filter(pa.compute.equal(opt.column("expiry"), pa.scalar(expiry)))
    for name, table in (("future", fut), ("options", opt)):
        last = _last_bar_min(table)
        if last < COMPLETE_FROM_MIN:
            raise NotComplete(
                f"{day}: the {name} bars stop at {last // 60:02d}:{last % 60:02d}, before the "
                "close: not scored (a later night completes it)"
            )


def season_of(root_dir: Path, symbol: str, day: date, rule: Rule = GOLD) -> str:
    """winter when the settling future traded at or after 23:30 that day (a 23:55 close)."""
    path = lake.bars_1m_path(root_dir, "future", rule.root, day)
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
    rule: Rule = GOLD,
) -> dict:
    """Simulate the frozen rule on `day`, charge it and append its journal line (raises
    `journal.AlreadyRecorded` for a recorded day). Returns the entry."""
    symbol = ensure_future_day(root_dir, client, day, expiry, rule)
    check_complete(root_dir, day, expiry, symbol, rule)
    data = load_day(root_dir, rule.root, day)
    season = season_of(root_dir, symbol, day, rule)
    ref = default_reference_data()

    def run(slip: float):
        s = strategy(season, rule)
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
    collected = option_days(root_dir, rule)
    entry_min = int(rule.entry[:2]) * 60 + int(rule.entry[3:])
    fields = {
        "day": day.isoformat(),
        "expiry": expiry.isoformat(),
        "k": _k(expiry, day, collected),
        "rule": rule.cell_id,
        "grid_sha": GRID_SHA,
        "future": symbol,
        "season": season,
        rule.spot_key: data.spot.price_at(entry_min - data.session_start),
        "trades": trades,
        "gross": round(result.gross, 2),
        "charges": round(charges, 2),
        "net": round(result.gross - charges, 2),
        "stopped_by": result.stopped_by,
        "notes": result.notes,
        **sensitivity,
        "recorded_at": (now or datetime.now(IST)).astimezone(IST).isoformat(timespec="seconds"),
    }
    return journal.append(journal_path(root_dir, rule), fields)


def summary(root_dir: Path, rule: Rule = GOLD) -> dict:
    """Running totals over the journal, by expiry, with the registered pass rule."""
    entries = journal.read(journal_path(root_dir, rule))
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
        "pass_rule_met": len(by) >= rule.expiries_needed
        and net > 0
        and sum(1 for v in by.values() if v > 0) >= rule.expiries_up_needed,
    }


def _out(trade: dict) -> object:
    return trade["out_price"] if trade["out_price"] is not None else "open"


def telegram_line(entry: dict, totals: dict, rule: Rule = GOLD) -> str:
    """One short line a session for the owner's private chat."""
    day = date.fromisoformat(entry["day"])
    legs = " ".join(
        f"{t['contract']} {t['in_price']}→{_out(t)} {t['reason'] or 'open'}"
        for t in entry["trades"]
    )
    k = entry["k"]
    return (
        f"{rule.label}, {day:%a %d %b} (expiry −{k}): net ₹{entry['net']:,.0f} "
        f"(gross {entry['gross']:,.0f}, charges {entry['charges']:,.0f}). {legs or 'no entry'}. "
        f"Run so far: {totals['sessions']} sessions, ₹{totals['net']:,.0f}, "
        f"{totals['expiries_up']}/{totals['expiries']} expiries up."
    )


# -- the 18:00 spread snapshot --------------------------------------------------------------


def in_expected_window(today: date, expiry: date, rule: Rule = GOLD) -> bool:
    """`today` may be a session of the rule's window: its weekdays to expiry fall in the window's
    band (0-4 for the expiry week, 5-9 for the week before). The week before's band is two
    weekdays wider (a holiday in the expiry week or the window moves its sessions out): a snapshot
    of a neighbouring day is harmless, a missed window day is not."""
    k = len(_weekdays_after(today, expiry))
    slack = 2 if rule.week_offset else 0
    return (
        expiry >= rule.start_expiry
        and today <= expiry
        and WINDOW * rule.week_offset <= k < WINDOW * (rule.week_offset + 1) + slack
    )


def nearest_expiry(root_dir: Path, today: date, rule: Rule = GOLD) -> date | None:
    cal = mcx_calendar(root_dir, rule.root)["options"]
    later = sorted(date.fromisoformat(e) for e in cal if date.fromisoformat(e) >= today)
    return later[0] if later else None


def _quotes(client: FyersClient, symbols: list[str]) -> dict[str, dict]:
    body = client._get({"symbols": ",".join(symbols)}, endpoint=f"{DATA_API}/quotes")
    if body.get("s") != "ok":
        raise RuntimeError(f"quotes: {body.get('message') or body}")
    return {row["n"]: row["v"] for row in body.get("d", []) if row.get("s") == "ok"}


def spread_snapshot(
    root_dir: Path,
    client: FyersClient,
    today: date,
    master_text: str | None = None,
    rule: Rule = GOLD,
) -> dict | None:
    """At 18:00 on a window weekday: bid/ask of the future and the ITM1 pair (and the ATM
    pair), read-only. None when today is outside the window. Writes
    mcx-forward/goldm-dir/spread/<day>.json."""
    expiry = nearest_expiry(root_dir, today, rule)
    if expiry is None or not in_expected_window(today, expiry, rule):
        return None
    cal = mcx_calendar(root_dir, rule.root)
    future = cal["options"][expiry.isoformat()]
    text = master_text if master_text is not None else download_master(MASTER_SEGMENT)
    options = {
        (c.strike, c.option_type): c.symbol
        for c in parse_master(text, {rule.root})
        if c.option_type in ("CE", "PE") and c.expiry == expiry
    }
    ltp = _quotes(client, [future])[future]["lp"]

    def strike(method: str, right: Right) -> float:  # the engine's resolver: half-up, per right
        return resolve_strike(rule.root, method, right, ltp, as_of=today).strike

    atm = strike("ATM", Right.CE)
    wanted = {
        "ITM1_CE": (strike("ITM1", Right.CE), "CE"),
        "ITM1_PE": (strike("ITM1", Right.PE), "PE"),
        "ATM_CE": (atm, "CE"),
        "ATM_PE": (strike("ATM", Right.PE), "PE"),
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
    path = forward_dir(root_dir, rule) / "spread" / f"{today}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1, sort_keys=True))
    return out
