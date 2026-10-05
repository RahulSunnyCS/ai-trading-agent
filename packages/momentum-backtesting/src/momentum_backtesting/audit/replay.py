"""Independent replay of a backtest's trade list from raw exchange data (BL-010 Phase 2).

The backtest says "I bought this here, sold it there, and the portfolio is now worth that".
This module checks the claim without trusting any of the backtest's own numbers. It takes only
the list of orders (week, action, instrument, amount) and rebuilds everything else itself:

  prices   the lake's daily Parquet bars, adjusted for confirmed splits and bonuses, sampled
           as the last close of each week ending Friday
  fills    shares bought or sold at that price, after the itemised costs worked out in rupees
  tax      capital-gains tax lot by lot, when the run was taxed
  equity   the portfolio's value each week, then CAGR and the deepest fall

and compares each with what the backtest reported (the bundle's `claims`).

Rule: this file imports nothing from `momentum_backtesting`. A shared helper would let one
mistake pass on both sides. `tests/test_audit_replay.py` enforces it, and the file also runs on
its own: `python replay.py <bundle.json>`.

What it proves: given the orders, the prices are the exchange's, and the costs, tax, share
counts and equity curve follow from them. What it does not prove: that the orders are the ones
the strategy's rules call for. That is the ranking's job, covered by the look-ahead test.

The same machinery answers "what if" questions about the same decisions (`replay(...,
sizing=...)`): fill at the next day's open instead of Friday's close, or buy whole shares only.
"""

from __future__ import annotations

import bisect
import dataclasses
import hashlib
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import duckdb

# --- what an order may be ---------------------------------------------------------------------

BUYS = ("BUY", "ADD", "PARK")  # a new holding, more of one held, idle money into the fund
FULL_SELL = "SELL"
PART_SELLS = ("TRIM", "UNPARK")  # part of a holding; UNPARK takes money back out of the fund

# --- the itemised cost schedule, in the backtest's own documented terms ------------------------
# NSE cash-market equity delivery. A fraction of the traded value, except the depository charge.
STT = 0.001  # securities transaction tax, both sides
STAMP_DUTY_ON_BUY = 0.00015
EXCHANGE_SEBI_GST = 0.00004  # exchange transaction charge + SEBI fee, with GST on both
DEPOSITORY_CHARGE_RS = 16.0  # per sale of one stock, whatever its size
DEPOSITORY_CHARGE_CAP = 0.05  # never more than 5% of the sale
LIQUID_FUND_STAMP_DUTY = 0.00005  # buying the liquid fund; redeeming it is free

# --- pass levels, from search_spaces/bl010_criteria.json (phase_2_arithmetic.ledger_replay) ----
FILL_PRICE_TOL = 0.0005
WEEKLY_EQUITY_TOL = 0.001
CAGR_TOL = 0.001  # 0.1 point
MAX_DD_TOL = 0.002  # 0.2 point

LAKE_DAILY_GLOB = "lake/bars_1d/asset=stock/*/data.parquet"
LIQUID_FUND = "Cash (liquid fund)"
#: Capital-gains class of each non-stock series (stocks are listed equity, the fund is debt).
SERIES_TAX_CLASS = {
    "Gold": "gold_silver",
    "Silver": "gold_silver",
    "Nasdaq 100": "international",
    "Hang Seng": "international",
}


def week_ending(day: date) -> date:
    """The Friday that closes `day`'s week. Weeks run Saturday to Friday, so a special
    Saturday or Sunday session belongs to the week that follows it."""
    return day + timedelta(days=(4 - day.weekday()) % 7)


# --- raw data ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Bar:
    day: date
    open: float
    close: float
    turnover: float = 0.0  # rupees traded that day (stocks only)
    synthetic: bool = False  # a stand-in close (the broker top-up), not the exchange's own


@dataclass(frozen=True)
class Quote:
    """One instrument's price for one week."""

    price: float  # adjusted: comparable across splits and bonuses
    raw: float  # what one share actually traded at that day
    day: date  # the trading day the price is from
    fresh: bool  # False = no trade that week, so an earlier close was carried forward
    synthetic: bool = False


@dataclass
class _History:
    days: list[date] = field(default_factory=list)
    bars: list[Bar] = field(default_factory=list)
    factors: list[tuple[date, float]] = field(default_factory=list)  # (ex-date, shares multiple)

    def adjustment(self, day: date) -> float:
        """What a share bought on `day` has since multiplied into. Dividing a raw close by it
        puts every close on today's share count, so a split is not read as a fall."""
        out = 1.0
        for ex_date, factor in self.factors:
            if ex_date > day:
                out *= factor
        return out

    def last_on_or_before(self, day: date, start: date | None, until: date | None) -> Bar | None:
        if until is not None:
            day = min(day, until - timedelta(days=1))
        i = bisect.bisect_right(self.days, day) - 1
        if i < 0:
            return None
        bar = self.bars[i]
        return bar if start is None or bar.day >= start else None

    def first_after(self, day: date, until: date | None = None) -> Bar | None:
        i = bisect.bisect_right(self.days, day)
        if i >= len(self.bars):
            return None
        bar = self.bars[i]
        return bar if until is None or bar.day < until else None

    def median_turnover(self, day: date, sessions: int = 60) -> float | None:
        """Median rupee turnover over the `sessions` trading days up to and including `day`."""
        i = bisect.bisect_right(self.days, day)
        window = sorted(bar.turnover for bar in self.bars[max(0, i - sessions) : i])
        if not window:
            return None
        mid = len(window) // 2
        return window[mid] if len(window) % 2 else (window[mid - 1] + window[mid]) / 2


def _open_read_only(path: Path, attempts: int = 40) -> duckdb.DuckDBPyConnection:
    """Another process may hold the catalog for writing for a moment; wait rather than fail."""
    for attempt in range(attempts):
        try:
            return duckdb.connect(str(path), read_only=True)
        except duckdb.IOException as error:
            if "lock" not in str(error).lower() or attempt == attempts - 1:
                raise
            time.sleep(0.25)
    raise AssertionError("unreachable")


@dataclass
class Market:
    """Every price the replay needs, loaded once and held in memory.

    Stocks come from the exchange's daily bars. The index-level instruments (gold, silver, the
    two foreign indices) and the liquid fund have no exchange bar of their own here: their
    weekly close is the stored weekly series, cross-checked against the stored daily one."""

    stocks: dict[str, _History]
    daily_series: dict[str, _History]
    weekly_series: dict[str, dict[date, float]]
    fingerprint: dict

    @classmethod
    def load(cls, root: Path, symbols: set[str], series_names: set[str]) -> Market:
        lake = (root / LAKE_DAILY_GLOB).as_posix().replace("'", "''")
        bars_sql = f"read_parquet('{lake}', hive_partitioning = true, union_by_name = true)"
        catalog = root / "catalog.duckdb"
        con = _open_read_only(catalog)
        try:
            ids = dict(
                con.execute(
                    "SELECT instrument_id, symbol FROM instruments "
                    "WHERE asset_class = 'stock' AND symbol IN (SELECT unnest(?))",
                    [sorted(symbols)],
                ).fetchall()
            )
            rows = con.execute(
                f"SELECT instrument_id, date, open, close, turnover, "
                f"coalesce(synthetic_close, false) FROM {bars_sql} "
                "WHERE instrument_id IN (SELECT unnest(?)) ORDER BY instrument_id, date",
                [sorted(ids)],
            ).fetchall()
            factors = con.execute(
                "SELECT symbol, ex_date, confirmed_factor FROM stock_action_candidates "
                "WHERE status = 'confirmed' AND symbol IN (SELECT unnest(?)) "
                "ORDER BY symbol, ex_date",
                [sorted(symbols)],
            ).fetchall()
            series_rows = con.execute(
                "SELECT instrument, kind, date, open, close FROM momentum_prices "
                "WHERE kind IN ('signal', 'weekly') AND instrument IN (SELECT unnest(?)) "
                "ORDER BY instrument, kind, date",
                [sorted(series_names)],
            ).fetchall()
            last_bar = con.execute(f"SELECT max(date) FROM {bars_sql}").fetchone()[0]
        finally:
            con.close()

        digest = hashlib.sha256()
        stocks: dict[str, _History] = {symbol: _History() for symbol in ids.values()}
        for instrument_id, day, open_, close, turnover, synthetic in rows:
            history = stocks[ids[instrument_id]]
            history.days.append(day)
            history.bars.append(
                Bar(day, float(open_), float(close), float(turnover or 0.0), bool(synthetic))
            )
            digest.update(f"{instrument_id}|{day}|{open_!r}|{close!r}\n".encode())
        for symbol, ex_date, factor in factors:
            if symbol in stocks:
                stocks[symbol].factors.append((ex_date, float(factor)))
                digest.update(f"{symbol}|{ex_date}|{factor!r}\n".encode())
        daily: dict[str, _History] = {}
        weekly: dict[str, dict[date, float]] = {}
        for name, kind, day, open_, close in series_rows:
            digest.update(f"{name}|{kind}|{day}|{close!r}\n".encode())
            if kind == "weekly":
                weekly.setdefault(name, {})[day] = float(close)
                continue
            history = daily.setdefault(name, _History())
            history.days.append(day)
            # Stored as closes; where there is no open, the close stands in for it.
            history.bars.append(Bar(day, float(close if open_ is None else open_), float(close)))
        return cls(
            stocks=stocks,
            daily_series=daily,
            weekly_series=weekly,
            fingerprint={
                "data_root": str(root),
                "catalog_modified": time.strftime(
                    "%Y-%m-%dT%H:%M:%S", time.localtime(catalog.stat().st_mtime)
                ),
                "last_stock_bar": str(last_bar),
                "stock_bars_read": len(rows),
                "sha256_of_prices_read": digest.hexdigest(),
            },
        )

    def _stock(self, asset: dict) -> tuple[_History | None, date | None, date | None]:
        start = date.fromisoformat(asset["from"]) if asset.get("from") else None
        until = date.fromisoformat(asset["until"]) if asset.get("until") else None
        return self.stocks.get(asset["symbol"]), start, until

    def close(self, asset: dict, week: date, daily_basis: bool = False) -> Quote | None:
        """The week's closing price: the last trade on or before that Friday. `fresh` is False
        when the instrument did not trade that week (suspended, or its series had ended).

        `daily_basis` prices a series instrument from its daily table instead of the weekly
        one. The two can sit on different scales (see `series_disagreements`), so a what-if
        that also needs daily opens must take its closes from the daily table too."""
        if asset["kind"] == "stock":
            history, start, until = self._stock(asset)
            if history is None:
                return None
            bar = history.last_on_or_before(week, start, until)
            if bar is None:
                return None
            return Quote(
                price=bar.close / history.adjustment(bar.day),
                raw=bar.close,
                day=bar.day,
                fresh=week_ending(bar.day) == week,
                synthetic=bar.synthetic,
            )
        name = asset["instrument"]
        if daily_basis:
            history = self.daily_series.get(name)
            bar = history.last_on_or_before(week, None, None) if history else None
            if bar is None:
                return None
            return Quote(bar.close, bar.close, bar.day, week_ending(bar.day) == week)
        closes = self.weekly_series.get(name, {})
        day = week
        for _ in range(520):  # carry an earlier week forward, as far back as ten years
            if day in closes:
                return Quote(closes[day], closes[day], day, day == week)
            day -= timedelta(days=7)
        return None

    def next_open(self, asset: dict, week: date) -> Quote | None:
        """The first open after `week`'s Friday, if it comes within the following week:
        the earliest an order decided on Friday's close can trade."""
        if asset["kind"] == "stock":
            history, _start, until = self._stock(asset)
        else:
            history, until = self.daily_series.get(asset["instrument"]), None
        bar = history.first_after(week, until) if history else None
        if bar is None or bar.day > week + timedelta(days=7):
            return None
        return Quote(
            price=bar.open / history.adjustment(bar.day),
            raw=bar.open,
            day=bar.day,
            fresh=True,
            synthetic=bar.synthetic,
        )

    def traded_again(self, asset: dict, after: date) -> Quote | None:
        """The next real close after `after`: how wrong a carried-forward price turned out."""
        if asset["kind"] != "stock":
            return None
        history, _start, _until = self._stock(asset)
        bar = history.first_after(after) if history else None
        if bar is None:
            return None
        return Quote(bar.close / history.adjustment(bar.day), bar.close, bar.day, True)

    def series_disagreements(self, name: str, weeks: list[date]) -> list[tuple[date, float]]:
        """Weeks where a series' stored weekly close is not its last daily close of that week,
        with the ratio weekly / daily."""
        out = []
        history = self.daily_series.get(name)
        for week in weeks:
            weekly_close = self.weekly_series.get(name, {}).get(week)
            bar = history.last_on_or_before(week, None, None) if history else None
            if weekly_close is None or bar is None or week_ending(bar.day) != week:
                continue
            if abs(weekly_close / bar.close - 1) > 1e-9:
                out.append((week, weekly_close / bar.close))
        return out


# --- costs and tax ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Costs:
    model: str  # "itemised" | "flat"
    capital_rs: float  # what 1.0 of portfolio is in rupees: sizes the flat depository charge
    slippage: float  # fraction of value, each side
    flat_rate: float  # each side, "flat" model only

    @classmethod
    def from_settings(cls, settings: dict) -> Costs:
        return cls(
            model=settings["cost_model"],
            capital_rs=float(settings["capital"]),
            slippage=float(settings["slippage_bps"]) / 10_000,
            flat_rate=float(settings["cost_pct"]) / 100,
        )

    def on_buy(self, amount: float, liquid_fund: bool) -> float:
        if self.model == "flat":
            return amount * self.flat_rate
        if liquid_fund:
            return amount * LIQUID_FUND_STAMP_DUTY
        return amount * (STT + STAMP_DUTY_ON_BUY + EXCHANGE_SEBI_GST + self.slippage)

    def on_sell(self, gross: float, liquid_fund: bool) -> float:
        if self.model == "flat":
            return gross * self.flat_rate
        if liquid_fund or gross <= 0:
            return 0.0
        rupees = gross * self.capital_rs
        depository = min(DEPOSITORY_CHARGE_RS, DEPOSITORY_CHARGE_CAP * rupees)
        return (rupees * (STT + EXCHANGE_SEBI_GST + self.slippage) + depository) / self.capital_rs


@dataclass
class TaxBook:
    """Capital-gains tax on each sale, by the rules the run was given.

    A holding is long-term after `long_term_days` (debt never is). A loss is banked: a
    short-term loss later offsets any gain, a long-term loss only long-term gains. What is
    left of a gain is taxed at the long-term rate, the equity short-term rate, or the income
    slab rate, plus cess."""

    rules: dict
    short_losses: float = 0.0
    long_losses: float = 0.0
    paid: float = 0.0

    def on_sale(self, tax_class: str, gain: float, held_days: int) -> float:
        long_term = tax_class != "debt" and held_days > self.rules["long_term_days"]
        if gain <= 0:
            if long_term:
                self.long_losses += -gain
            else:
                self.short_losses += -gain
            return 0.0
        if long_term:
            used = min(gain, self.long_losses)
            self.long_losses -= used
            gain -= used
        used = min(gain, self.short_losses)
        self.short_losses -= used
        gain -= used
        if long_term:
            rate = self.rules["ltcg"]
        elif tax_class == "equity":
            rate = self.rules["equity_stcg"]
        else:
            rate = self.rules["slab_rate"]
        tax = gain * rate * (1 + self.rules["cess"])
        self.paid += tax
        return tax


def _tax_class(asset: dict) -> str:
    if asset["kind"] == "stock":
        return "equity"
    if asset["kind"] == "liquid_fund":
        return "debt"
    return SERIES_TAX_CLASS[asset["instrument"]]


# --- the replay -------------------------------------------------------------------------------


@dataclass
class _Lot:
    units: float
    since: date
    basis: float  # what it cost, after buying costs


@dataclass
class Fill:
    """One order as the replay worked it out."""

    index: int
    week: date
    action: str
    asset: str
    amount: float  # a buy's money, or the value sold
    price: float
    raw_price: float
    price_day: date
    fresh: bool
    synthetic: bool
    units: float
    held_before: float
    cost: float
    tax: float
    cash_before: float  # uninvested money just before this order
    participation: float | None = None  # rupees traded / the stock's median daily turnover


@dataclass
class Replayed:
    equity: dict[date, float]
    fills: list[Fill]
    marks: dict[date, dict[str, Quote]]  # every held instrument's price, each week
    positions: dict[str, float]  # value of what is still held at the end
    cash: dict[date, float]  # money left uninvested after each week's orders
    problems: list[str]  # things that stop the replay being trusted at all
    tax_paid: float = 0.0
    #: week -> instrument -> profit over the week ending then, after the costs and tax of the
    #: orders that opened it. Each week's entries add up to that week's change in equity.
    pnl: dict[date, dict[str, float]] = field(default_factory=dict)


@dataclass(frozen=True)
class Sizing:
    """How big each order is, and where it fills.

    The default reads each order's amount from the bundle and fills at the week's close: the
    reconciliation. A what-if keeps the *decisions* (the same names, the same share of the
    money on hand, the same fraction of a holding sold) and changes how they fill."""

    #: order index -> share of the cash on hand (a buy) or of the holding (a part sale), taken
    #: from a reconciling replay by `decisions`. None = use the bundle's amounts.
    shares: dict[int, float] | None = None
    fill_at: str = "close"  # "close" | "next_open"
    whole_shares: bool = False  # buy only whole shares at the raw price; the rest stays in cash
    #: Largest share of a stock's 60-session median daily turnover one buy may take (None = any).
    participation_cap: float | None = None
    #: symbol -> [(day, that day's return)]: days whose price move is taken out of the stock's
    #: series, to see how much of the result rests on them.
    zeroed: dict[str, list[tuple[date, float]]] | None = None

    @property
    def leaves_money_unspent(self) -> bool:
        return self.whole_shares or self.participation_cap is not None


def decisions(reconciled: Replayed) -> dict[int, float]:
    """Each order as a decision that survives a change of price: a buy as its share of the
    money that run of buys spent, a part sale as the fraction of the holding sold."""
    shares: dict[int, float] = {}
    run: list[Fill] = []

    def close_run() -> None:
        total = sum(f.amount for f in run)
        for f in run:
            shares[f.index] = f.amount / total if total > 0 else 0.0
        run.clear()

    for fill in reconciled.fills:
        if fill.action in BUYS:
            if run and fill.week != run[-1].week:
                close_run()
            run.append(fill)
            continue
        close_run()
        if fill.action in PART_SELLS:
            shares[fill.index] = fill.units / fill.held_before if fill.held_before else 0.0
    close_run()
    return shares


def replay(bundle: dict, market: Market, sizing: Sizing | None = None) -> Replayed:
    """Work the bundle's orders through, week by week."""
    sizing = sizing or Sizing()
    settings = bundle["settings"]
    if settings.get("portfolio", "buffer") != "buffer":
        raise ValueError("only the buffer portfolio rule can be replayed")
    costs = Costs.from_settings(settings)
    book = TaxBook(settings["tax"]) if settings.get("tax") else None
    assets = bundle["assets"]
    weeks = [date.fromisoformat(w) for w in bundle["weeks"]]
    what_if = sizing.shares is not None
    orders: dict[date, list[tuple[int, dict]]] = {}
    for index, order in enumerate(bundle["orders"]):
        orders.setdefault(date.fromisoformat(order["week"]), []).append((index, order))

    lots: dict[str, list[_Lot]] = {}
    cash = 1.0
    out = Replayed(equity={weeks[0]: 1.0}, fills=[], marks={}, positions={}, cash={}, problems=[])

    def without_zeroed_days(name: str, q: Quote | None) -> Quote | None:
        days = (sizing.zeroed or {}).get(assets[name].get("symbol"))
        if q is None or not days:
            return q
        keep = 1.0
        for day, move in days:
            if day <= q.day:
                keep /= 1 + move
        return dataclasses.replace(q, price=q.price * keep)

    def mark(name: str, week: date) -> Quote | None:
        q = market.close(assets[name], week, daily_basis=what_if)
        return without_zeroed_days(name, q)

    def fill_quote(name: str, week: date) -> Quote | None:
        if sizing.fill_at == "next_open":
            q = without_zeroed_days(name, market.next_open(assets[name], week))
            return q or mark(name, week)
        return mark(name, week)

    def units_held(name: str) -> float:
        return sum(lot.units for lot in lots.get(name, []))

    simulated = set(weeks[:-1])
    for week in sorted(orders):
        if week not in simulated:
            out.problems.append(f"{week}: orders on a week the run does not simulate")

    fund = {"kind": "liquid_fund", "instrument": LIQUID_FUND}
    values: dict[str, float] = {}  # what each holding was worth at the last week's close
    for i, week in enumerate(weeks[:-1]):
        run_cash = None  # the money a run of buys shares out, fixed when the run starts
        put_in: dict[str, float] = {}  # net money each instrument took from cash this week
        for index, order in orders.get(week, []):
            name, action = order["asset"], order["action"]
            asset = assets[name]
            liquid = asset["kind"] == "liquid_fund"
            q = fill_quote(name, week)
            if q is None:
                out.problems.append(f"{week} {action} {name}: no price in the raw data")
                continue
            held, cash_before, participation = units_held(name), cash, None
            if action in BUYS:
                if what_if:
                    run_cash = cash if run_cash is None else run_cash
                    amount = run_cash * sizing.shares[index]
                else:
                    amount = float(order["value"])
                if asset["kind"] == "stock" and (
                    sizing.whole_shares or sizing.participation_cap is not None
                ):
                    amount, participation = _realistic_buy(amount, q, market, asset, costs, sizing)
                cost = costs.on_buy(amount, liquid)
                units = (amount - cost) / q.price
                if amount > 0:
                    lots.setdefault(name, []).append(_Lot(units, week, amount - cost))
                cash -= amount
                put_in[name] = put_in.get(name, 0.0) + amount
                tax = 0.0
            elif action == FULL_SELL or action in PART_SELLS:
                run_cash = None
                if held <= 0:
                    if not what_if:
                        out.problems.append(f"{week} {action} {name}: nothing held to sell")
                    continue
                if action == FULL_SELL:
                    fraction = 1.0
                elif what_if:
                    fraction = sizing.shares[index]
                else:
                    fraction = min(float(order["value"]) / (held * q.price), 1.0)
                amount = held * fraction * q.price
                cost = costs.on_sell(amount, liquid)
                kept = 1 - cost / amount if amount > 0 else 1.0
                tax = 0.0
                for lot in lots[name]:
                    sold_units, sold_basis = lot.units * fraction, lot.basis * fraction
                    if book is not None:
                        gain = sold_units * q.price * kept - sold_basis
                        held_days = (week - lot.since).days
                        tax += book.on_sale(_tax_class(asset), gain, held_days)
                    lot.units -= sold_units
                    lot.basis -= sold_basis
                if fraction >= 1 - 1e-12:
                    del lots[name]
                units = amount / q.price
                cash += amount - cost - tax
                put_in[name] = put_in.get(name, 0.0) - (amount - cost - tax)
            else:
                out.problems.append(f"{week} {name}: unknown action {action!r}")
                continue
            out.fills.append(
                Fill(
                    index=index,
                    week=week,
                    action=action,
                    asset=name,
                    amount=amount,
                    price=q.price,
                    raw_price=q.raw,
                    price_day=q.day,
                    fresh=q.fresh,
                    synthetic=q.synthetic,
                    units=units,
                    held_before=held,
                    cost=cost,
                    tax=tax,
                    cash_before=cash_before,
                    participation=participation,
                )
            )
        out.cash[week] = cash

        nxt = weeks[i + 1]
        pnl: dict[str, float] = {}
        if sizing.leaves_money_unspent and cash > 0:
            # Money a real account could not place waits in the liquid fund, not under a mattress.
            now, then = market.close(fund, week, True), market.close(fund, nxt, True)
            if now is not None and then is not None:
                pnl["(unspent cash)"] = cash * (then.price / now.price - 1)
                cash += pnl["(unspent cash)"]
        total, marks, worth = cash, {}, {}
        for name in lots:
            q = mark(name, nxt)
            if q is None:
                out.problems.append(f"{nxt}: {name} is held but has no price in the raw data")
                continue
            marks[name] = q
            worth[name] = units_held(name) * q.price
            total += worth[name]
        for name in set(values) | set(worth) | set(put_in):
            pnl[name] = worth.get(name, 0.0) - values.get(name, 0.0) - put_in.get(name, 0.0)
        values = worth
        out.pnl[nxt] = pnl
        out.marks[nxt] = marks
        out.equity[nxt] = total

    last = weeks[-1]
    for name in lots:
        q = out.marks.get(last, {}).get(name)
        if q is not None:
            out.positions[name] = units_held(name) * q.price

    if book is not None:
        # A taxed run ends by selling everything, so unrealised gains do not escape tax.
        total = cash
        for name, position in lots.items():
            q = out.marks.get(last, {}).get(name)
            if q is None:
                continue
            liquid = assets[name]["kind"] == "liquid_fund"
            gross = units_held(name) * q.price
            kept = 1 - costs.on_sell(gross, liquid) / gross if gross > 0 else 1.0
            after = 0.0
            for lot in position:
                net = lot.units * q.price * kept
                held_days = (last - lot.since).days
                after += net - book.on_sale(_tax_class(assets[name]), net - lot.basis, held_days)
            out.pnl[last][name] = out.pnl[last].get(name, 0.0) + after - gross
            total += after
        out.equity[last] = total
        out.tax_paid = book.paid
    return out


def _realistic_buy(
    amount: float, q: Quote, market: Market, asset: dict, costs: Costs, sizing: Sizing
) -> tuple[float, float | None]:
    """A buy as a real account could place it: no more than the participation cap allows, and
    in whole shares. Returns (amount actually spent, share of median daily turnover taken)."""
    rupees = amount * costs.capital_rs
    history, _start, _until = market._stock(asset)
    typical = history.median_turnover(q.day) if history else None
    if sizing.participation_cap is not None and typical:
        rupees = min(rupees, sizing.participation_cap * typical)
    if sizing.whole_shares:
        rate = costs.on_buy(1.0, liquid_fund=False)
        shares = math.floor(rupees * (1 - rate) / q.raw)
        rupees = shares * q.raw / (1 - rate)
    return rupees / costs.capital_rs, (rupees / typical if typical else None)


# --- comparing with the backtest's claims --------------------------------------------------------


def cagr(equity: dict[date, float]) -> float:
    days = sorted(equity)
    years = (days[-1] - days[0]).days / 365.25
    return (equity[days[-1]] / equity[days[0]]) ** (1 / years) - 1


def max_drawdown(equity: dict[date, float]) -> float:
    peak, worst = -math.inf, 0.0
    for day in sorted(equity):
        peak = max(peak, equity[day])
        worst = min(worst, equity[day] / peak - 1)
    return worst


def _gap(mine: float, theirs: float) -> float:
    scale = max(abs(mine), abs(theirs))
    return abs(mine - theirs) / scale if scale > 1e-15 else 0.0


@dataclass
class Check:
    name: str
    passed: bool
    detail: str
    worst: list[str] = field(default_factory=list)  # the largest gaps, for a human to read


def compare(bundle: dict, mine: Replayed) -> list[Check]:
    """Each claim of the backtest against the replay's own figure."""
    claims = bundle["claims"]
    orders = bundle["orders"]
    by_index = {f.index: f for f in mine.fills}
    checks = [
        Check(
            "every order replayed",
            not mine.problems and len(mine.fills) == len(orders),
            f"{len(mine.fills)} of {len(orders)} orders",
            mine.problems[:10],
        )
    ]

    def per_fill(name: str, mine_of, theirs_of, limit: float, show) -> None:
        rows = []
        for index, claim in enumerate(claims["fills"]):
            fill, theirs = by_index.get(index), theirs_of(index, claim)
            if fill is not None and theirs is not None:
                rows.append((_gap(mine_of(fill), theirs), fill, theirs))
        rows.sort(key=lambda r: -r[0])
        off = [r for r in rows if r[0] > limit]
        detail = f"{len(rows) - len(off)} of {len(rows)} within {limit:.2%}"
        if rows:
            detail += f"; largest gap {rows[0][0]:.2e}"
        checks.append(Check(name, not off, detail, [show(*r) for r in off[:15]]))

    # 1. Fill prices: the exchange's close for that week against what the backtest filled at.
    per_fill(
        "fill prices",
        lambda f: f.price,
        lambda _i, c: c.get("fill_price"),
        FILL_PRICE_TOL,
        lambda gap, f, theirs: (
            f"{f.week} {f.action} {f.asset}: replay {f.price:.4f} (raw {f.raw_price:.2f} on "
            f"{f.price_day}{'' if f.fresh else ', carried forward'}), backtest {theirs:.4f}, "
            f"gap {gap:.3%}"
        ),
    )

    # 2. What follows from price and amount: shares, the value of an exit, costs, tax.
    per_fill(
        "shares traded",
        lambda f: f.units,
        lambda _i, c: c.get("units"),
        FILL_PRICE_TOL,
        lambda gap, f, theirs: (
            f"{f.week} {f.action} {f.asset}: replay {f.units:.6g}, backtest {theirs:.6g}"
        ),
    )
    per_fill(
        "shares held before each order",
        lambda f: f.held_before,
        lambda _i, c: c.get("prev_units"),
        FILL_PRICE_TOL,
        lambda gap, f, theirs: (
            f"{f.week} {f.action} {f.asset}: replay {f.held_before:.6g}, backtest {theirs:.6g}"
        ),
    )
    per_fill(
        "value of each full exit",
        lambda f: f.amount,
        lambda i, _c: float(orders[i]["value"]) if orders[i]["action"] == FULL_SELL else None,
        FILL_PRICE_TOL,
        lambda gap, f, theirs: f"{f.week} {f.asset}: replay {f.amount:.6g}, backtest {theirs:.6g}",
    )
    per_fill(
        "costs",
        lambda f: f.cost,
        lambda _i, c: c.get("cost"),
        FILL_PRICE_TOL,
        lambda gap, f, theirs: (
            f"{f.week} {f.action} {f.asset}: replay {f.cost:.6g}, backtest {theirs:.6g}"
        ),
    )
    per_fill(
        "tax",
        lambda f: f.tax,
        lambda _i, c: c.get("tax"),
        FILL_PRICE_TOL,
        lambda gap, f, theirs: (
            f"{f.week} {f.action} {f.asset}: replay {f.tax:.6g}, backtest {theirs:.6g}"
        ),
    )

    # 3. Money in equals money out: after a week that bought anything, nothing is left over.
    bought = sorted({f.week for f in mine.fills if f.action in BUYS})
    leftovers = sorted(((abs(mine.cash[w]) / mine.equity[w], w) for w in bought), reverse=True)
    off = [x for x in leftovers if x[0] > FILL_PRICE_TOL]
    detail = f"{len(leftovers) - len(off)} of {len(leftovers)} buying weeks"
    if leftovers:
        detail += f"; largest leftover {leftovers[0][0]:.2e} of the portfolio"
    checks.append(
        Check(
            "cash is fully used after buying",
            not off,
            detail,
            [
                f"{w}: {mine.cash[w]:+.6g} left ({share:.3%} of the portfolio)"
                for share, w in off[:10]
            ],
        )
    )

    # 4. Weekly marks: every held instrument's price, every week.
    rows = []
    for week_text, marks in claims.get("marks", {}).items():
        week = date.fromisoformat(week_text)
        for name, theirs in marks.items():
            q = mine.marks.get(week, {}).get(name)
            if q is not None and theirs is not None:
                rows.append((_gap(q.price, theirs), week, name, q, theirs))
    rows.sort(key=lambda r: -r[0])
    off = [r for r in rows if r[0] > FILL_PRICE_TOL]
    checks.append(
        Check(
            "weekly price of everything held",
            not off,
            f"{len(rows) - len(off)} of {len(rows)} within {FILL_PRICE_TOL:.2%}",
            [
                f"{week} {name}: replay {q.price:.4f} (raw {q.raw:.2f} on {q.day}), backtest "
                f"{theirs:.4f}, gap {gap:.3%}"
                for gap, week, name, q, theirs in off[:15]
            ],
        )
    )

    # 5. The equity curve, week by week.
    weeks = [date.fromisoformat(w) for w in bundle["weeks"]]
    gaps = [(_gap(mine.equity[w], e), w, e) for w, e in zip(weeks, claims["equity"], strict=True)]
    first_off = next((g for g in gaps if g[0] > WEEKLY_EQUITY_TOL), None)
    worst = max(gaps)
    checks.append(
        Check(
            "weekly equity",
            first_off is None,
            f"largest gap {worst[0]:.2e} on {worst[1]}; limit {WEEKLY_EQUITY_TOL:.1%}",
            []
            if first_off is None
            else [
                f"first week over the limit: {first_off[1]} (replay "
                f"{mine.equity[first_off[1]]:.6f}, backtest {first_off[2]:.6f})"
            ],
        )
    )

    # 6. The two headline figures.
    my_cagr, my_dd = cagr(mine.equity), max_drawdown(mine.equity)
    checks.append(
        Check(
            "CAGR",
            abs(my_cagr - claims["kpis"]["cagr"]) <= CAGR_TOL,
            f"replay {my_cagr:.4%}, backtest {claims['kpis']['cagr']:.4%}",
        )
    )
    checks.append(
        Check(
            "max drawdown",
            abs(my_dd - claims["kpis"]["mdd"]) <= MAX_DD_TOL,
            f"replay {my_dd:.4%}, backtest {claims['kpis']['mdd']:.4%}",
        )
    )

    # 7. What is still held at the end.
    theirs_open = {p["asset"]: p["value"] for p in claims.get("open_positions", [])}
    if claims.get("idle_value"):
        theirs_open[LIQUID_FUND] = claims["idle_value"]
    names = sorted(set(theirs_open) | set(mine.positions))
    off_names = [
        n
        for n in names
        if _gap(mine.positions.get(n, 0.0), theirs_open.get(n, 0.0)) > WEEKLY_EQUITY_TOL
    ]
    checks.append(
        Check(
            "holdings at the end",
            not off_names,
            f"{len(names) - len(off_names)} of {len(names)} positions agree",
            [
                f"{n}: replay {mine.positions.get(n, 0.0):.6g}, "
                f"backtest {theirs_open.get(n, 0.0):.6g}"
                for n in off_names[:10]
            ],
        )
    )
    return checks


def data_notes(bundle: dict, mine: Replayed, market: Market) -> dict:
    """Where the prices themselves are weaker than "the exchange's close that week". None of
    this is an arithmetic failure; each item is a place the result leans on thinner data."""
    assets = bundle["assets"]
    carried = []
    for fill in mine.fills:
        if fill.fresh:
            continue
        later = market.traded_again(assets[fill.asset], fill.price_day)
        row = {
            "week": str(fill.week),
            "action": fill.action,
            "asset": fill.asset,
            "price_from": str(fill.price_day),
            "days_stale": (fill.week - fill.price_day).days,
            "share_of_portfolio": fill.amount / mine.equity[fill.week],
        }
        if later is not None:
            row["next_traded"] = str(later.day)
            row["next_price_vs_used"] = later.price / fill.price - 1
        carried.append(row)
    stale_marks = [
        (week, name, q)
        for week, marks in mine.marks.items()
        for name, q in marks.items()
        if not q.fresh
    ]
    weeks = [date.fromisoformat(w) for w in bundle["weeks"]]
    series = {}
    for name, asset in assets.items():
        if asset["kind"] == "stock":
            continue
        used = {f.week for f in mine.fills if f.asset == name}
        used |= {week for week, marks in mine.marks.items() if name in marks}
        off = market.series_disagreements(asset["instrument"], sorted(used & set(weeks)))
        if off:
            ratios = sorted(r for _w, r in off)
            series[name] = {
                "weeks": len(off),
                "first": str(off[0][0]),
                "last": str(off[-1][0]),
                "weekly_over_daily_min": ratios[0],
                "weekly_over_daily_max": ratios[-1],
            }
    return {
        "fills_at_a_carried_forward_price": carried,
        "weekly_marks_carried_forward": len(stale_marks),
        "weekly_marks": sum(len(marks) for marks in mine.marks.values()),
        "longest_carried_mark_days": max(((w - q.day).days for w, _n, q in stale_marks), default=0),
        "stand_in_closes": {
            "fills": sum(f.synthetic for f in mine.fills),
            "weekly_marks": sum(
                q.synthetic for marks in mine.marks.values() for q in marks.values()
            ),
        },
        "series_whose_weekly_and_daily_tables_disagree": series,
    }


def summary(bundle: dict, mine: Replayed, checks: list[Check], market: Market) -> dict:
    """Everything worth keeping from one replay, as plain JSON."""
    return {
        "label": bundle.get("label"),
        "run_id": bundle.get("run_id"),
        "variant": bundle.get("variant"),
        "passed": all(c.passed for c in checks),
        "checks": [
            {"name": c.name, "passed": c.passed, "detail": c.detail, "worst": c.worst}
            for c in checks
        ],
        "replay": {
            "cagr": cagr(mine.equity),
            "max_drawdown": max_drawdown(mine.equity),
            "final_equity": mine.equity[max(mine.equity)],
            "tax_paid": mine.tax_paid,
            "costs_paid": sum(f.cost for f in mine.fills),
            "orders": len(mine.fills),
        },
        "backtest": bundle["claims"]["kpis"],
        "data_notes": data_notes(bundle, mine, market),
        "data": market.fingerprint,
        "bundle_code": bundle.get("code"),
    }


def render(report: dict) -> str:
    lines = [
        f"{report['label']} ({report['run_id']}, {report['variant']}): "
        f"{'PASS' if report['passed'] else 'FAIL'}"
    ]
    for check in report["checks"]:
        lines.append(f"  [{'ok' if check['passed'] else 'XX'}] {check['name']}: {check['detail']}")
        lines.extend(f"         {row}" for row in check["worst"])
    notes = report["data_notes"]
    lines.append(
        f"  data notes: {len(notes['fills_at_a_carried_forward_price'])} fills and "
        f"{notes['weekly_marks_carried_forward']} of {notes['weekly_marks']} weekly marks at a "
        f"carried-forward price (longest {notes['longest_carried_mark_days']} days)"
    )
    for row in notes["fills_at_a_carried_forward_price"]:
        later = (
            f"; next traded {row['next_traded']} at {row['next_price_vs_used']:+.1%}"
            if "next_traded" in row
            else "; never traded again"
        )
        lines.append(
            f"         {row['week']} {row['action']} {row['asset']}: price from "
            f"{row['price_from']} ({row['days_stale']} days old), "
            f"{row['share_of_portfolio']:.1%} of the portfolio{later}"
        )
    stand_in = notes["stand_in_closes"]
    lines.append(
        f"  stand-in closes: {stand_in['fills']} fills, {stand_in['weekly_marks']} weekly marks"
    )
    for name, off in notes["series_whose_weekly_and_daily_tables_disagree"].items():
        lines.append(
            f"  {name}: weekly table is {off['weekly_over_daily_min']:.4f} to "
            f"{off['weekly_over_daily_max']:.4f} x the daily table in {off['weeks']} weeks used "
            f"({off['first']} to {off['last']})"
        )
    return "\n".join(lines)


def data_root(root: Path | None = None) -> Path:
    if root is not None:
        return root.expanduser()
    override = os.environ.get("TRADING_DATA_ROOT", "").strip()
    return Path(override).expanduser() if override else Path.home() / "TradingData"


def market_for(bundle: dict, root: Path | None = None) -> Market:
    assets = bundle["assets"].values()
    return Market.load(
        data_root(root),
        {a["symbol"] for a in assets if a["kind"] == "stock"},
        {a["instrument"] for a in assets if a["kind"] != "stock"} | {LIQUID_FUND},
    )


def run(bundle_path: Path, root: Path | None = None) -> dict:
    bundle = json.loads(Path(bundle_path).read_text())
    market = market_for(bundle, root)
    mine = replay(bundle, market)
    return summary(bundle, mine, compare(bundle, mine), market)


if __name__ == "__main__":
    reports = [run(Path(arg)) for arg in sys.argv[1:]]
    print("\n\n".join(render(r) for r in reports))
    sys.exit(0 if reports and all(r["passed"] for r in reports) else 1)
