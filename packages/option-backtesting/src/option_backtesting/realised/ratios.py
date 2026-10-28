"""The owner's sheet ("Trade Book") by its own formulas, from the contract-notes store.

One row per session the store has a line for (the sheet's rows). Per day:

- `net` — the notes' final net, added over the F&O accounts (the sheet's Final Net columns);
- `algo_fees` — AlgoTest's fee for the day's algos, the sheet's column O:
  `ROUNDUP((algos − 3) × 12.5 + 62.5)`, from `manual/<day>.json`; nothing with no algos typed;
- `profit` (Q) = net − algo fees; `charges` (P) = the notes' total charges + algo fees. A day with
  no note on any account has neither (the sheet's "N/A" rows), and the averages skip it;
- `cumulative` (R) and `drawdown` (S) = cumulative − its running peak;
- `avg_profit_50` (T), `avg_profit_100` (U), `avg_charges_100` (V): averages of the last 50 / 100
  rows' figures (rows without one skipped), rounded to the rupee, blank until that many rows;
- `charge_profit_pct` (W) = V × 100 ÷ U, one decimal;
- `capital` (X): the day's typed `capital_total` from `manual/`; else each broker's last figure
  (typed, or the 15:50 reading written as the next session's), carried separately and added up
  once every F&O broker has one; else the last total carried (`capital_source` says which);
- `avg_capital_100` (Y) and `profit_capital_bps` (Z) = U × 10 000 ÷ Y, rounded.

One account (`account="broker/id"`) uses that account's notes only: the day's algo fees are
the whole book's and are left out. Collateral interest from the ledger is shown beside the
figures (`interest`), never inside them: the sheet never had it. Ledger e-mails dated a weekend
or holiday count on the next session (those after the last session wait for the next one).

`other_debits` is an estimate, not a note figure: the account debits that reach neither a note
nor an e-mail (DP charges, AMC and the like) at ₹1,000 per F&O broker a year (owner,
2026-10-27), accrued per calendar day from each broker's first line in the store. A row carries
the days since the previous row, so a range starting on a Monday carries the weekend before it.
With `account`, the rate is that account's broker's (one account per broker today). It is shown
beside the figures with the interest, and taken off only in the summary's `net_after_debits`.
Averages and rounding are exact decimals, half away from zero, like the sheet's ROUND.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import date
from decimal import Decimal

from .store import Book

ZERO = Decimal(0)
#: The owner's assumption for the debits no note or e-mail shows (2026-10-27).
OTHER_DEBITS_PER_BROKER_YEAR = Decimal(1000)


def algo_fee(algos: int | None) -> Decimal:
    """The sheet's column O: ROUNDUP((algos - 3) * 12.5 + 62.5, 0); none without algos."""
    if not algos or algos <= 0:
        return ZERO
    return Decimal(math.ceil((algos - 3) * 12.5 + 62.5))


def _dec(value: object) -> Decimal:
    return Decimal(str(value)) if value is not None else ZERO


@dataclass
class DayRow:
    day: date
    notes: int
    open: int
    net: Decimal | None
    note_charges: Decimal | None
    algos: int | None
    algo_fees: Decimal
    profit: Decimal | None
    charges: Decimal | None
    capital: Decimal | None
    capital_source: str | None
    interest: Decimal
    deposits: Decimal
    withdrawals: Decimal
    other_debits: Decimal = ZERO
    cumulative: Decimal = ZERO
    drawdown: Decimal = ZERO
    avg_profit_50: int | None = None
    avg_profit_100: int | None = None
    avg_charges_100: int | None = None
    charge_profit_pct: float | None = None
    avg_capital_100: int | None = None
    profit_capital_bps: int | None = None

    def as_dict(self) -> dict:
        out = asdict(self)
        out["day"] = self.day.isoformat()
        return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in out.items()}


FNO = ("finvasia", "angelone")


class _CapitalLine:
    """The day's capital: a typed total (`capital_total`) when there is one; else each broker's
    last figure (typed, or Angel One's 15:50 reading), carried separately, added up once every
    F&O broker has one; else the last total carried."""

    def __init__(self, account: str | None) -> None:
        self.account = account
        self.per: dict[str, Decimal] = {}
        self.last: Decimal | None = None

    def day(self, manual: dict) -> tuple[Decimal | None, str | None]:
        per = manual.get("capital") if isinstance(manual.get("capital"), dict) else {}
        if self.account is not None:
            for key in (self.account, self.account.split("/")[0]):
                if per.get(key) is not None:
                    self.last = _dec(per[key])
                    return self.last, "manual"
            return self.last, "carried" if self.last is not None else None
        fresh = False
        for broker in FNO:
            if per.get(broker) is not None:
                self.per[broker] = _dec(per[broker])
                fresh = True
        if manual.get("capital_total") is not None:
            self.last = _dec(manual["capital_total"])
            return self.last, "manual"
        if fresh and all(b in self.per for b in FNO):
            self.last = sum((self.per[b] for b in FNO), ZERO)
            return self.last, "manual"
        return self.last, "carried" if self.last is not None else None


def _ledger(events: Iterable[dict], account: str | None) -> tuple[Decimal, Decimal, Decimal]:
    interest = deposits = withdrawals = ZERO
    for e in events:
        if account is not None:
            who = f"{e.get('broker')}/{e.get('account')}"
            if e.get("account") is not None and who != account:
                continue
            if e.get("account") is None and e.get("broker") != account.split("/")[0]:
                continue
        elif e.get("broker") not in ("finvasia", "angelone"):
            continue
        amount = _dec(e.get("amount"))
        if e.get("kind") == "collateral_interest":
            interest += amount
        elif e.get("kind") == "deposit":
            deposits += amount
        elif e.get("kind") == "withdrawal":
            withdrawals += amount
    return interest, deposits, withdrawals


def _accrued(brokers: list[str], first: dict[str, date], previous: date | None, day: date):
    """The other-debits estimate for the calendar days since the previous row (one day for the
    first row, and for a broker whose first line is today)."""
    total = ZERO
    for b in brokers:
        if b not in first:
            continue
        since = previous if previous is not None and previous >= first[b] else None
        days = (day - since).days if since is not None else 1
        total += OTHER_DEBITS_PER_BROKER_YEAR * days / 365
    return total.quantize(Decimal("0.01"))


def _mean(values: list) -> Decimal | None:
    vals = [v for v in values if v is not None]
    return sum(vals, ZERO) / len(vals) if vals else None


def _round(value: Decimal | None, places: str = "1") -> Decimal | None:
    # The sheet's ROUND: half away from zero, on exact decimals.
    if value is None:
        return None
    return value.quantize(Decimal(places), rounding="ROUND_HALF_UP")


def _int(value: Decimal | None) -> int | None:
    return None if value is None else int(value)


def daily(
    book: Book,
    *,
    account: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[DayRow]:
    """The sheet's rows. The running figures (cumulative, drawdown, the 50/100-row averages)
    start at the store's first day even when `start` is later, as the sheet's do."""
    rows: list[DayRow] = []
    capital_line = _CapitalLine(account)
    first_line: dict[str, date] = {}  # each F&O broker's first day in the store
    previous: date | None = None
    # Ledger e-mails dated a weekend or holiday count on the next session.
    ledger_days = sorted(book.ledger)
    li = 0
    for day in book.days:
        if end is not None and day > end:
            break
        for ln in book.fno_lines(day):
            first_line.setdefault(ln.get("broker"), day)
        lines = book.fno_lines(day, account)
        if account is not None and not lines:
            continue
        brokers = (
            [account.split("/")[0]] if account is not None else [b for b in FNO if b in first_line]
        )
        other_debits = _accrued(brokers, first_line, previous, day)
        previous = day
        notes = [ln for ln in lines if ln.get("status") == "note" and ln.get("fno")]
        manual = book.manual.get(day, {})
        algos = manual.get("algos")
        fees = algo_fee(algos) if account is None else ZERO
        net = sum((_dec(ln["fno"].get("final_net")) for ln in notes), ZERO) if notes else None
        note_charges = (
            sum((_dec(ln["fno"].get("total_charges")) for ln in notes), ZERO) if notes else None
        )
        capital, source = capital_line.day(manual)
        events = []
        while li < len(ledger_days) and ledger_days[li] <= day:
            events.extend(book.ledger[ledger_days[li]])
            li += 1
        interest, deposits, withdrawals = _ledger(events, account)
        rows.append(
            DayRow(
                day=day,
                notes=len(notes),
                open=sum(1 for ln in lines if ln.get("status") == "failed"),
                net=net,
                note_charges=note_charges,
                algos=algos,
                algo_fees=fees,
                profit=None if net is None else net - fees,
                charges=None if note_charges is None else note_charges + fees,
                capital=capital,
                capital_source=source,
                interest=interest,
                deposits=deposits,
                withdrawals=withdrawals,
                other_debits=other_debits,
            )
        )
    _running(rows)
    return [r for r in rows if start is None or r.day >= start]


def _running(rows: list[DayRow]) -> None:
    cumulative = peak = ZERO
    profits: list[Decimal | None] = []
    charges: list[Decimal | None] = []
    capitals: list[Decimal | None] = []
    for r in rows:
        if r.profit is not None:
            cumulative += r.profit
        peak = max(peak, cumulative)
        r.cumulative = cumulative
        r.drawdown = cumulative - peak
        profits.append(r.profit)
        charges.append(r.charges)
        capitals.append(r.capital)
        n = len(profits)
        if n >= 50:
            r.avg_profit_50 = _int(_round(_mean(profits[-50:])))
        if n >= 100:
            u = _round(_mean(profits[-100:]))
            v = _round(_mean(charges[-100:]))
            cap = _mean(capitals[-100:])
            r.avg_profit_100, r.avg_charges_100 = _int(u), _int(v)
            r.avg_capital_100 = _int(_round(cap))
            if u and v is not None:
                r.charge_profit_pct = float(_round(v * 100 / u, "0.1"))
            if cap and u is not None:
                r.profit_capital_bps = _int(_round(u * 10000 / cap))


def _f(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def summary(rows: list[DayRow]) -> dict:
    """The sheet's summary block over `rows`: net, charges, drawdown (from the rows' own peak),
    win days, averages, and the time-weighted return on the capital of each day."""
    traded = [r for r in rows if r.profit is not None]
    wins = [r.profit for r in traded if r.profit > 0]
    losses = [r.profit for r in traded if r.profit < 0]
    net = sum((r.profit for r in traded), ZERO)
    charges = sum((r.charges for r in rows if r.charges is not None), ZERO)
    # The notes' own charges, apart from the algo fees. A day with algos typed and no note has
    # its fee in `algo_fees` but not in `charges`, so charges − algo fees is not this figure.
    note_charges = sum((r.note_charges for r in rows if r.note_charges is not None), ZERO)
    other_debits = sum((r.other_debits for r in rows), ZERO)
    cumulative = peak = max_dd = ZERO
    run = longest = 0
    growth = Decimal(1)
    for r in rows:
        if r.profit is not None:
            cumulative += r.profit
            if r.capital:
                growth *= 1 + r.profit / r.capital
        peak = max(peak, cumulative)
        dd = cumulative - peak
        max_dd = min(max_dd, dd)
        run = run + 1 if dd < 0 else 0
        longest = max(longest, run)
    caps = [r.capital for r in rows if r.capital is not None]
    capital = sum(caps, ZERO) / len(caps) if caps else None
    pct = (lambda v: round(float(v * 100 / capital), 2)) if capital else (lambda v: None)
    return {
        "first_day": rows[0].day.isoformat() if rows else None,
        "last_day": rows[-1].day.isoformat() if rows else None,
        "sessions": len(rows),
        "traded_sessions": len(traded),
        "net": float(net),
        "charges": float(charges),
        "note_charges": float(note_charges),
        "algo_fees": float(sum((r.algo_fees for r in rows), ZERO)),
        "interest": float(sum((r.interest for r in rows), ZERO)),
        "other_debits": float(other_debits),
        "net_after_debits": float(net - sum((r.interest for r in rows), ZERO) - other_debits),
        "charge_profit_pct": round(float(charges * 100 / net), 1) if net else None,
        "max_drawdown": float(max_dd),
        "max_drawdown_pct": pct(max_dd),
        "longest_drawdown": longest,
        "win_days": len(wins),
        "loss_days": len(losses),
        "win_pct": round(len(wins) * 100 / (len(wins) + len(losses)), 1)
        if wins or losses
        else None,
        "avg_day": _f(net / len(traded)) if traded else None,
        "avg_win": _f(sum(wins, ZERO) / len(wins)) if wins else None,
        "avg_loss": _f(sum(losses, ZERO) / len(losses)) if losses else None,
        "best": _f(max(wins)) if wins else None,
        "worst": _f(min(losses)) if losses else None,
        "capital": _f(capital),
        "profit_pct": pct(net),
        "time_weighted_return_pct": round(float((growth - 1) * 100), 2) if caps else None,
        "deposits": float(sum((r.deposits for r in rows), ZERO)),
        "withdrawals": float(sum((r.withdrawals for r in rows), ZERO)),
    }


def fiscal_year(day: date) -> int:
    """The Indian financial year a day falls in, by its starting year (Apr–Mar)."""
    return day.year if day.month >= 4 else day.year - 1


def months(rows: list[DayRow]) -> list[dict]:
    """The sheet's monthly tab: gain, % of the month's average capital, the 3-month average %."""
    groups: dict[tuple[int, int], list[DayRow]] = {}
    for r in rows:
        groups.setdefault((r.day.year, r.day.month), []).append(r)
    out: list[dict] = []
    for (year, month), rs in sorted(groups.items()):
        s = summary(rs)
        out.append(
            {
                "month": f"{year}-{month:02d}",
                "profit": s["net"],
                "charges": s["charges"],
                "sessions": s["sessions"],
                "capital": s["capital"],
                "pct": s["profit_pct"],
            }
        )
    for i, m in enumerate(out):
        last3 = [x["pct"] for x in out[max(0, i - 2) : i + 1]]
        m["avg3_pct"] = (
            round(sum(last3) / 3, 2) if i >= 2 and all(v is not None for v in last3) else None
        )
    return out


def fiscal_years(rows: list[DayRow]) -> list[dict]:
    """One row per financial year: profit, % of its average capital, sessions, max drawdown."""
    groups: dict[int, list[DayRow]] = {}
    for r in rows:
        groups.setdefault(fiscal_year(r.day), []).append(r)
    out = []
    for fy, rs in sorted(groups.items()):
        s = summary(rs)
        out.append(
            {
                "fy": f"{fy}-{str(fy + 1)[2:]}",
                "profit": s["net"],
                "pct": s["profit_pct"],
                "capital": s["capital"],
                "sessions": s["sessions"],
                "max_drawdown": s["max_drawdown"],
                "charges": s["charges"],
                "algo_fees": s["algo_fees"],
                "interest": s["interest"],
                "other_debits": s["other_debits"],
                "net_after_debits": s["net_after_debits"],
            }
        )
    return out
