"""Round trips: each account's contract from a flat position back to flat, across sessions.

A note line's `trades` are either the annexure's fills (`trades_check: fills`, each with its
time) or the trade summary (`summary`: one row per contract and side, no time). Each fill's
`net_total` is signed (a sell received, a buy paid) and already net of brokerage.

Per account and contract, the notes are read in session order and the position kept:

- the first fill opens a trip (`direction` short for a sell); fills the same way add to it;
- a fill the other way closes it, and when it closes more than is open the rest opens a new trip
  the other way (the fill is split pro rata);
- a position left at the end of a session is carried to the next note of the account; a trip's
  `entry_day` and `day` (the day it closed) can differ;
- a position still open when its contract expires is `expired`, dated its expiry: settled at
  nothing unless the note prints the settlement as a fill (then it closes it like any fill);
- what is still open after the last note is `open` (no P&L yet); after a note whose trades could
  not be read (`unmatched`), that account's open positions are `unresolved` (no P&L: the closing
  fill may be on that note).

A summary line has no times: per contract its sells and buys are paired with each other (or with
a carried position first); a pair made inside one summary line has no `direction`.

A broker in `TRADES_FROM` gives only the trips opened from that day: its earlier notes' trades
did not all read (older layouts), so its trips start where every note reads (owner, 2026-10-27).
The earlier notes are still read into the book, so a position opened before the day and closed
after it pairs (and is left out) rather than its closing fill opening a trip of its own. The day
figures (`ratios`) still use every note; `coverage` counts the earlier notes apart.

`charges` share out what each note charged on top of its fills (its final net minus the fills'
sum) by each trip's turnover on that note, so the trips of a day whose positions all closed add
up to the notes' final nets.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from .store import Book

ZERO = Decimal(0)
READ = ("fills", "summary")
PAISE = Decimal("0.01")
#: The first session from which every one of the broker's notes reads its trades.
TRADES_FROM = {"angelone": date(2026, 2, 2)}


def _before_trades(line: dict, day: date) -> bool:
    start = TRADES_FROM.get(line.get("broker"))
    return start is not None and day < start


def partial_years() -> dict[str, list[str]]:
    """Per financial year ("2025-26"), the brokers whose trips start inside or after it."""
    from .ratios import fiscal_year

    out: dict[str, list[str]] = {}
    for broker, start in TRADES_FROM.items():
        fy = fiscal_year(start)
        out.setdefault(f"{fy}-{str(fy + 1)[2:]}", []).append(broker)
    return out


def _dec(value: object) -> Decimal:
    return Decimal(str(value)) if value is not None else ZERO


def weekdays_between(start: date, end: date) -> int:
    """Weekdays after `start` up to and including `end` (0 on the expiry day itself)."""
    if end <= start:
        return 0
    return sum(
        1
        for n in range(1, (end - start).days + 1)
        if date.fromordinal(start.toordinal() + n).weekday() < 5
    )


@dataclass
class Trip:
    day: date  # the day it closed (or expired; for an open trip, the last note's day)
    entry_day: date
    broker: str
    account: str
    underlying: str
    instrument: str
    expiry: date | None
    strike: float | None
    kind: str | None
    direction: str | None  # short | long | None (paired inside one summary line)
    qty: int
    entry_time: str | None
    exit_time: str | None
    entry_price: float | None
    exit_price: float | None
    pnl: Decimal | None
    charges: Decimal
    status: str  # closed | expired | open | unresolved
    fills: int
    source_check: str | None  # the opening line's trades_check
    dte: int | None  # weekdays from the entry day to the expiry
    turnover: Decimal = ZERO

    @property
    def net(self) -> Decimal | None:
        return None if self.pnl is None else self.pnl - self.charges

    @property
    def holding_minutes(self) -> int | None:
        if not self.entry_time or not self.exit_time or self.entry_day != self.day:
            return None
        h1, m1, *_ = (int(x) for x in self.entry_time.split(":"))
        h2, m2, *_ = (int(x) for x in self.exit_time.split(":"))
        return (h2 * 60 + m2) - (h1 * 60 + m1)

    def as_dict(self) -> dict:
        out = {k: getattr(self, k) for k in self.__dataclass_fields__}
        for k in ("day", "entry_day", "expiry"):
            out[k] = out[k].isoformat() if out[k] else None
        out["net"] = self.net
        out["holding_minutes"] = self.holding_minutes
        return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in out.items()}


def _contract(t: dict) -> tuple:
    return (
        t.get("instrument"),
        t.get("underlying"),
        t.get("expiry"),
        t.get("strike"),
        t.get("kind"),
    )


def _gross(t: dict) -> Decimal | None:
    """The fill's price before brokerage (Finvasia `price`, Angel One `wap`)."""
    for k in ("price", "wap"):
        if t.get(k) is not None:
            return _dec(t[k])
    return None


@dataclass
class _Open:
    """A trip being built."""

    broker: str
    account: str
    contract: tuple
    direction: str | None
    entry_day: date
    check: str | None
    position: Decimal = ZERO  # signed: + long, − short
    qty: Decimal = ZERO  # the most it held
    cash: Decimal = ZERO
    open_qty: Decimal = ZERO
    open_value: Decimal = ZERO  # gross price × qty of the opening fills
    close_qty: Decimal = ZERO
    close_value: Decimal = ZERO
    times: list = field(default_factory=list)
    exit_time: str | None = None
    fills: int = 0
    turnover: Decimal = ZERO
    charges: Decimal = ZERO
    line_turnover: Decimal = ZERO  # on the line being read (for its charges)

    def trip(self, day: date, status: str) -> Trip:
        instrument, underlying, expiry, strike, kind = self.contract
        exp = date.fromisoformat(expiry) if expiry else None
        return Trip(
            day=day,
            entry_day=self.entry_day,
            broker=self.broker,
            account=self.account,
            underlying=underlying,
            instrument=instrument,
            expiry=exp,
            strike=float(strike) if strike is not None else None,
            kind=kind,
            direction=self.direction,
            qty=int(self.qty),
            entry_time=min(self.times) if self.times else None,
            exit_time=self.exit_time if status == "closed" else None,
            entry_price=float(round(self.open_value / self.open_qty, 4)) if self.open_qty else None,
            exit_price=float(round(self.close_value / self.close_qty, 4))
            if self.close_qty
            else None,
            pnl=self.cash if status in ("closed", "expired") else None,
            charges=self.charges,
            status=status,
            fills=self.fills,
            source_check=self.check,
            dte=weekdays_between(self.entry_day, exp) if exp else None,
            turnover=self.turnover,
        )


class _Book:
    """Positions per account and contract, read note by note."""

    def __init__(self) -> None:
        self.open: dict[tuple, _Open] = {}
        # Finished positions keep their builder: a note's charges are shared after its fills.
        self.done: list[tuple[_Open, date, str]] = []
        self.touched: list[_Open] = []

    def _start(self, key, line, contract, side, day) -> _Open:
        o = _Open(
            broker=line["broker"],
            account=line["account"],
            contract=contract,
            direction=("short" if side == "sell" else "long") if side else None,
            entry_day=day,
            check=line.get("trades_check"),
        )
        self.open[key] = o
        return o

    def _touch(self, o: _Open) -> None:
        if all(x is not o for x in self.touched):
            self.touched.append(o)

    def add(self, day: date, line: dict, contract: tuple, f: dict, *, paired: bool = False):
        """One fill (or a summary side). `paired`: a summary pair with no known order."""
        key = (line["broker"], line["account"], contract)
        qty = _dec(f.get("qty"))
        if not qty:
            return
        sign = Decimal(1) if f["side"] == "buy" else Decimal(-1)
        total = _dec(f.get("net_total"))
        gross = _gross(f)
        while qty > 0:
            o = self.open.get(key)
            if o is None:
                o = self._start(key, line, contract, None if paired else f["side"], day)
            same_way = o.position == 0 or (o.position > 0) == (sign > 0)
            take = qty if same_way else min(qty, abs(o.position))
            part = total * take / _dec(f.get("qty"))
            o.position += sign * take
            o.qty = max(o.qty, abs(o.position))
            o.cash += part
            o.turnover += abs(part)
            o.line_turnover += abs(part)
            o.fills += 1
            unit = gross if gross is not None else abs(total) / _dec(f.get("qty"))
            if same_way:
                o.open_qty += take
                o.open_value += unit * take
            else:
                o.close_qty += take
                o.close_value += unit * take
            if f.get("time"):
                if same_way:
                    o.times.append(f["time"])
                else:
                    o.exit_time = f["time"]
            self._touch(o)
            if o.position == 0:
                self.done.append((o, day, "closed"))
                del self.open[key]
            qty -= take

    def share_charges(self, line: dict) -> None:
        """The line's charges beyond its fills, shared by each trip's turnover on it."""
        fills_sum = sum((_dec(t.get("net_total")) for t in line.get("trades") or []), ZERO)
        extra = fills_sum - _dec((line.get("fno") or {}).get("final_net"))
        total = sum((o.line_turnover for o in self.touched), ZERO)
        shared = ZERO
        for i, o in enumerate(self.touched):
            if not total:
                break
            part = (
                extra - shared
                if i == len(self.touched) - 1
                else (extra * o.line_turnover / total).quantize(PAISE)
            )
            shared += part
            o.charges += part
            o.line_turnover = ZERO
        self.touched = []

    def expire(self, before: date, account: tuple | None = None) -> None:
        """Positions whose contract expired before `before` (or all of `account`'s, unresolved)."""
        for key, o in list(self.open.items()):
            if account is not None:
                if (o.broker, o.account) == account:
                    self.done.append((o, before, "unresolved"))
                    del self.open[key]
                continue
            expiry = o.contract[2]
            if expiry and date.fromisoformat(expiry) < before:
                self.done.append((o, date.fromisoformat(expiry), "expired"))
                del self.open[key]


def _summary(b: _Book, day: date, line: dict) -> None:
    by_contract: dict[tuple, list[dict]] = {}
    for t in line.get("trades") or []:
        by_contract.setdefault(_contract(t), []).append(t)
    for contract, rows in by_contract.items():
        key = (line["broker"], line["account"], contract)
        carried = b.open.get(key)
        if carried is not None and carried.position != 0:
            # The side that closes the carried position goes first.
            closing = "buy" if carried.position < 0 else "sell"
            rows = sorted(rows, key=lambda r: r["side"] != closing)
            for r in rows:
                b.add(day, line, contract, r)
            continue
        sells = [r for r in rows if r["side"] == "sell"]
        buys = [r for r in rows if r["side"] == "buy"]
        paired = bool(sells) and bool(buys)
        for r in sells + buys:
            b.add(day, line, contract, r, paired=paired)
        o = b.open.get(key)
        if o is not None and o.direction is None:
            o.direction = "short" if o.position < 0 else "long"


def trips(
    book: Book,
    *,
    account: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[Trip]:
    """Every trip, built over the whole store (a position may open before `start`); those that
    closed (or are still open) within [start, end] are returned."""
    b = _Book()
    last = None
    for day in book.days:
        b.expire(day)
        for line in book.fno_lines(day, account):
            if line.get("status") != "note":
                continue
            if line.get("trades_check") not in READ:
                if line.get("trades"):
                    b.expire(day, account=(line["broker"], line["account"]))
                continue
            if line.get("trades_check") == "summary":
                _summary(b, day, line)
            else:
                for f in sorted(line.get("trades") or [], key=lambda t: t.get("time") or ""):
                    b.add(day, line, _contract(f), f)
            b.share_charges(line)
        last = day
    if last is not None:
        b.expire(last + timedelta(days=1))
    out = [o.trip(d, status) for o, d, status in b.done]
    out += [o.trip(last, "open") for o in b.open.values()]
    out = [t for t in out if not _before_trades({"broker": t.broker}, t.entry_day)]
    out = [t for t in out if (start is None or t.day >= start) and (end is None or t.day <= end)]
    return sorted(out, key=lambda t: (t.day, t.entry_time or "", t.broker, t.account))


def day_trips(book: Book, day: date) -> list[Trip]:
    """The trips that closed, expired or were still open on `day`."""
    return trips(book, start=day, end=day)


def coverage(book: Book, *, start: date | None = None, end: date | None = None) -> dict:
    """How many F&O notes give trips (their trades add up), how many do not, and how many are
    before their broker's `TRADES_FROM` (`before_trades_from`)."""
    counts: dict[str, int] = {}
    for day in book.days:
        if (start and day < start) or (end and day > end):
            continue
        for line in book.fno_lines(day):
            if line.get("status") == "note":
                k = (
                    "before_trades_from"
                    if _before_trades(line, day)
                    else line.get("trades_check") or "none"
                )
                counts[k] = counts.get(k, 0) + 1
    return counts


def turnover(trip_list: list[Trip]) -> dict[str, dict]:
    """F&O turnover by financial year, for the owner's CA: the sum of each closed or expired
    trip's absolute P&L, net of brokerage (open and unresolved trips left out), with the trips'
    other charges beside it. A figure to check with the CA, not tax advice."""
    from .ratios import fiscal_year

    out: dict[str, dict] = {}
    for t in trip_list:
        if t.pnl is None:
            continue
        fy = fiscal_year(t.day)
        row = out.setdefault(
            f"{fy}-{str(fy + 1)[2:]}",
            {"turnover": ZERO, "profit": ZERO, "charges": ZERO, "trips": 0},
        )
        row["turnover"] += abs(t.pnl)
        row["profit"] += t.pnl
        row["charges"] += t.charges
        row["trips"] += 1
    return {
        fy: {k: (float(v) if isinstance(v, Decimal) else v) for k, v in row.items()}
        for fy, row in sorted(out.items())
    }
