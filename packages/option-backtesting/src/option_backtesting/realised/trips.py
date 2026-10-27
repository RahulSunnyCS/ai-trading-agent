"""Round trips: each contract's fills on a note, from flat back to flat.

A note line's `trades` are either the annexure's fills (`trades_check: fills`, each with its
time) or the trade summary (`summary`: one row per contract and side, no time). A trip is one
contract from a flat position back to flat: its first fill opens it (`direction` short when that
is a sell), and it closes when the quantity bought equals the quantity sold. Each fill's
`net_total` is signed (a sell received, a buy paid) and already net of brokerage, so a trip's
`pnl` is the sum of its fills' totals.

What a note does not close is `expired` when the contract expires that day (settled at nothing:
the premium kept or lost is the trip's P&L) and `open` otherwise (carried; no P&L yet).

`charges` share out what the note charged on top of the fills (its final net minus the fills'
sum) by each trip's turnover, so a line's trips add up to its final net (`check` says how far
they are when they do not). Lines whose trades did not add up (`unmatched`) give no trips.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
from decimal import Decimal

from .store import Book

ZERO = Decimal(0)
READ = ("fills", "summary")


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
    day: date
    broker: str
    account: str
    underlying: str
    instrument: str
    expiry: date | None
    strike: float | None
    kind: str | None
    direction: str | None  # short | long | None (summary rows: the order is not printed)
    qty: int
    entry_time: str | None
    exit_time: str | None
    entry_price: float | None
    exit_price: float | None
    pnl: Decimal | None
    charges: Decimal
    status: str  # closed | expired | open
    fills: int
    source_check: str  # the line's trades_check
    dte: int | None
    turnover: Decimal = ZERO

    @property
    def net(self) -> Decimal | None:
        return None if self.pnl is None else self.pnl - self.charges

    @property
    def holding_minutes(self) -> int | None:
        if not self.entry_time or not self.exit_time:
            return None
        h1, m1, *_ = (int(x) for x in self.entry_time.split(":"))
        h2, m2, *_ = (int(x) for x in self.exit_time.split(":"))
        return (h2 * 60 + m2) - (h1 * 60 + m1)

    def key(self) -> tuple:
        return (self.underlying, self.expiry, self.strike, self.kind)

    def as_dict(self) -> dict:
        out = asdict(self)
        out["day"] = self.day.isoformat()
        out["expiry"] = self.expiry.isoformat() if self.expiry else None
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


def _unit(t: dict) -> Decimal | None:
    qty = _dec(t.get("qty"))
    return abs(_dec(t.get("net_total"))) / qty if qty else None


def _trip(day, line, contract, fills, status, direction) -> Trip:
    instrument, underlying, expiry, strike, kind = contract
    exp = date.fromisoformat(expiry) if expiry else None
    opening = [f for f in fills if f["side"] == ("sell" if direction == "short" else "buy")]
    closing = [f for f in fills if f not in opening]
    qty = (
        int(sum(_dec(f.get("qty")) for f in opening))
        if direction
        else int(
            max(
                sum(_dec(f.get("qty")) for f in fills if f["side"] == "buy"),
                sum(_dec(f.get("qty")) for f in fills if f["side"] == "sell"),
            )
        )
    )

    def avg(group):
        q = sum((_dec(f.get("qty")) for f in group), ZERO)
        v = sum((abs(_dec(f.get("net_total"))) for f in group), ZERO)
        return float(round(v / q, 4)) if q else None

    if direction is None:  # summary: the two sides, order unknown
        buys = [f for f in fills if f["side"] == "buy"]
        sells = [f for f in fills if f["side"] == "sell"]
        entry_price, exit_price = avg(sells), avg(buys)
    else:
        entry_price, exit_price = avg(opening), avg(closing) if closing else None
    times = [f.get("time") for f in fills if f.get("time")]
    pnl = sum((_dec(f.get("net_total")) for f in fills), ZERO) if status != "open" else None
    return Trip(
        day=day,
        broker=line["broker"],
        account=line["account"],
        underlying=underlying,
        instrument=instrument,
        expiry=exp,
        strike=float(strike) if strike is not None else None,
        kind=kind,
        direction=direction,
        qty=qty,
        entry_time=min(times) if times else None,
        exit_time=max(times) if times and status == "closed" else None,
        entry_price=entry_price,
        exit_price=exit_price,
        pnl=pnl,
        charges=ZERO,
        status=status,
        fills=len(fills),
        source_check=line.get("trades_check"),
        dte=weekdays_between(day, exp) if exp else None,
        turnover=sum((abs(_dec(f.get("net_total"))) for f in fills), ZERO),
    )


def line_trips(day: date, line: dict) -> list[Trip]:
    """The round trips of one note line (none unless its trades add up to the note)."""
    if line.get("status") != "note" or line.get("trades_check") not in READ:
        return []
    by_contract: dict[tuple, list[dict]] = {}
    for t in line.get("trades") or []:
        by_contract.setdefault(_contract(t), []).append(t)
    trips: list[Trip] = []
    for contract, fills in by_contract.items():
        expiry = contract[2]
        expires_today = expiry == day.isoformat()
        leftover_status = "expired" if expires_today else "open"
        if line.get("trades_check") == "summary":
            buys = sum(_dec(f.get("qty")) for f in fills if f["side"] == "buy")
            sells = sum(_dec(f.get("qty")) for f in fills if f["side"] == "sell")
            trips.append(
                _trip(
                    day, line, contract, fills, "closed" if buys == sells else leftover_status, None
                )
            )
            continue
        fills = sorted(fills, key=lambda f: f.get("time") or "")
        position = ZERO
        current: list[dict] = []
        direction = None
        for f in fills:
            if not current:
                direction = "short" if f["side"] == "sell" else "long"
            current.append(f)
            position += _dec(f.get("qty")) * (1 if f["side"] == "buy" else -1)
            if position == 0:
                trips.append(_trip(day, line, contract, current, "closed", direction))
                current = []
        if current:
            trips.append(_trip(day, line, contract, current, leftover_status, direction))
    _share_charges(line, trips)
    return trips


def _share_charges(line: dict, trips: list[Trip]) -> None:
    """Share out the note's charges beyond the fills (final net − the fills' sum) by turnover."""
    fno = line.get("fno") or {}
    fills_sum = sum((_dec(t.get("net_total")) for t in line.get("trades") or []), ZERO)
    extra = fills_sum - _dec(fno.get("final_net"))
    turnover = sum((t.turnover for t in trips), ZERO)
    if not turnover:
        return
    shared = ZERO
    for i, t in enumerate(trips):
        if i == len(trips) - 1:
            t.charges = extra - shared  # the last takes the rounding
        else:
            t.charges = (extra * t.turnover / turnover).quantize(Decimal("0.01"))
            shared += t.charges


def trips(
    book: Book,
    *,
    account: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[Trip]:
    out: list[Trip] = []
    for day in book.days:
        if (start and day < start) or (end and day > end):
            continue
        for line in book.fno_lines(day, account):
            out.extend(line_trips(day, line))
    return out


def coverage(book: Book, *, start: date | None = None, end: date | None = None) -> dict:
    """How many F&O notes give trips (their trades add up) and how many do not."""
    counts: dict[str, int] = {}
    for day in book.days:
        if (start and day < start) or (end and day > end):
            continue
        for line in book.fno_lines(day):
            if line.get("status") == "note":
                k = line.get("trades_check") or "none"
                counts[k] = counts.get(k, 0) + 1
    return counts


def turnover(trip_list: list[Trip]) -> dict[str, float]:
    """F&O turnover by financial year for the owner's CA: the sum of each closed or expired
    trip's absolute P&L (net of brokerage), with the trips' charges beside it. A figure, not
    tax advice."""
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
