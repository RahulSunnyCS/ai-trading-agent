"""
Minute-by-minute simulation of one leg-wise strategy over one day.

Conventions forced by 1-minute bars — each is a guess at what AlgoTest does
and is the first thing to check when a day disagrees with AlgoTest's own
backtest (TODO.md 3.10.7):

- **The price at time T is the CLOSE of the bar that ends at T** (the T-1
  bar, `Series.price_at`). A fixed-time entry fills there; strikes are chosen
  from the index's price at T (Strike Type) or each option's (Closest
  Premium); exit time T fills there too. Verified against AlgoTest (BL-009
  Phase 1): its candle stamped T is our bar starting T-1, and its 09:17 entry
  and 15:28 exit prices are that candle's close. (Until 2026-10-07 the engine
  used the OPEN of the T bar.) AlgoTest stamps a stop exit at the END of the
  minute that triggered it, so its stop times read one minute later than ours.
- **Closest premium** — nearest to the target among the collected strikes of
  that expiry, by each option's price at the entry time (`price_at`); an exact tie picks
  the LOWER premium (AlgoTest docs' example: premiums 49 and 52 for a 50
  target -> 49).
- **SL / target** are checked against each bar's high/low, from the entry bar
  itself (everything in the entry bar happens after its open). They fill at
  the trigger price, or at the bar's open if it gapped through. If a bar
  touches both, the SL wins (conservative).
- **Trail SL [X, Y]** — every full X of favourable move from the entry price
  (sell: the lowest low since entry; buy: the highest high) moves the SL Y
  in the same direction; it never loosens. Updated AFTER the bar's SL check,
  so a bar that sets a new extreme cannot also hit the SL it just tightened.
- **Range breakout** — the range is the high/low of the leg's option (or the
  index, `source: underlying`) over [entry_time, until); the strike is chosen at
  entry_time. From `until` on, the first bar whose high exceeds the range high
  (side high) or whose low undercuts the range low (side low) enters, at the
  range level (or the bar's open if it gapped through). `source: underlying`
  fills at the option's CLOSE of the breakout minute. Triggers at most once.
- **Intrabar entries** (breakout, RE COST) skip SL/target/trail on their own
  bar — the bar's high/low may have happened before the fill.
- **RE COST** — after an SL, the same contract re-enters when its price comes
  back to the original entry price (from the next bar). **RE ASAP** — the
  strike is re-selected by the leg's own criteria and entered at the next
  bar's open. Both respect `no_reentry_after` and the leg's count.
- **Overall stop/target** — combined MTM (realised + open legs at each bar's
  CLOSE); when hit, every open leg exits at that close and nothing else
  happens that day.
- **Square off complete** — any leg's SL/target exits every other open leg at
  that bar's close and cancels pending entries.
- Slippage (% of price) is applied adversely to every fill; a flat cost is
  charged per order (entry and exit are one order each).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ..data.providers.base import Right
from ..data.reference.loader import (
    MissingReferenceData,
    ReferenceData,
    default_reference_data,
)
from ..data.resolver import resolve_strike
from .market import (
    BAR_SIZES,
    N_MINUTES,
    ContractKey,
    DayData,
    Series,
    backtest_days,
    check_on_5m_marks,
    check_strikes_on_5m,
    load_day,
    load_day_5m,
    minute_index,
    minute_label,
    pick_expiry,
    snapshot_days,
    window_close_minute,
)
from .schema import Leg, LegwiseStrategy, ReEntry

_EPS = 1e-9


@dataclass
class Trade:
    leg_id: str
    contract: ContractKey
    position: str
    qty: int
    entry_min: int
    entry_price: float
    exit_min: int | None = None
    exit_price: float | None = None
    exit_reason: str = ""

    @property
    def pnl(self) -> float:
        if self.exit_price is None:
            return 0.0
        sign = 1 if self.position == "buy" else -1
        return sign * (self.exit_price - self.entry_price) * self.qty

    def describe(self) -> str:
        expiry, strike, option_type = self.contract
        return f"{self.position.upper()} {strike:g}{option_type} {expiry:%d%b}"


@dataclass
class DayResult:
    day: date
    trades: list[Trade]
    gross: float
    costs: float
    worst_mtm: float
    best_mtm: float
    stopped_by: str | None
    notes: list[str] = field(default_factory=list)
    #: (minute index, MTM in INR) at each simulated minute — the curve behind
    #: worst/best_mtm. Not persisted (store.py ignores it): the engine is
    #: deterministic, so the dashboard re-simulates a day to get it back.
    mtm: list[tuple[int, float]] = field(default_factory=list)

    @property
    def net(self) -> float:
        return self.gross - self.costs


@dataclass
class _LegRun:
    spec: Leg
    qty: int
    state: str = "idle"  # idle | range | armed | open | reentry | done
    contract: ContractKey | None = None
    series: Series | None = None
    trade: Trade | None = None
    entry_price: float = 0.0
    initial_sl: float | None = None
    sl: float | None = None
    target: float | None = None
    best: float = 0.0
    range_end: int = 0
    range_hi: float | None = None
    range_lo: float | None = None
    fresh_intrabar: bool = False
    reentries_sl: int = 0
    reentries_target: int = 0
    reentry_mode: str | None = None
    reentry_price: float = 0.0

    @property
    def sign(self) -> int:
        return 1 if self.spec.position == "buy" else -1


class _DaySim:
    def __init__(
        self,
        strategy: LegwiseStrategy,
        data: DayData,
        reference: ReferenceData,
        sizing_date: date | None = None,
    ) -> None:
        self.s = strategy
        self.data = data
        self.reference = reference
        #: the date whose lot size "current" sizing uses (today unless a test pins it)
        self.sizing_date = sizing_date or date.today()
        self.notes: list[str] = []
        # Quantity is set per leg in _select, once the leg's contract is known.
        self.legs = [_LegRun(leg, 0) for leg in strategy.legs]
        for run in self.legs:
            run.reentries_sl = leg_count(run.spec.reentry_on_sl)
            run.reentries_target = leg_count(run.spec.reentry_on_target)
        self.trades: list[Trade] = []
        self.realised = 0.0
        self.orders = 0
        self.stopped_by: str | None = None
        self.last_reentry_min = (
            minute_index(strategy.no_reentry_after) if strategy.no_reentry_after else N_MINUTES
        )

    # -- fills -------------------------------------------------------------

    def _slip(self, price: float, buying: bool) -> float:
        pct = self.s.execution.slippage_pct / 100
        return price * (1 + pct) if buying else price * (1 - pct)

    def _enter(self, run: _LegRun, minute: int, raw: float, intrabar: bool) -> None:
        assert run.contract is not None
        price = self._slip(raw, buying=run.spec.position == "buy")
        run.trade = Trade(run.spec.id, run.contract, run.spec.position, run.qty, minute, price)
        self.trades.append(run.trade)
        self.orders += 1
        run.entry_price = price
        run.best = price
        spec = run.spec
        run.initial_sl = run.sl = (
            price - run.sign * spec.stop_loss.distance(price) if spec.stop_loss else None
        )
        run.target = price + run.sign * spec.target.distance(price) if spec.target else None
        run.fresh_intrabar = intrabar
        run.state = "open"

    def _exit(self, run: _LegRun, minute: int, raw: float, reason: str) -> None:
        assert run.trade is not None
        run.trade.exit_price = self._slip(raw, buying=run.spec.position == "sell")
        run.trade.exit_min = minute
        run.trade.exit_reason = reason
        self.realised += run.trade.pnl
        self.orders += 1
        run.state = "done"

    # -- strike selection --------------------------------------------------

    def _select(self, run: _LegRun, minute: int) -> bool:
        spec = run.spec
        expiry = pick_expiry(self.data, spec.expiry)
        if expiry is None:
            self.notes.append(f"{spec.id}: no {spec.expiry} expiry listed")
            return False
        if spec.strike.strike_type is not None:
            spot = self.data.spot.price_at(minute)
            if spot is None:
                self.notes.append(f"{spec.id}: no index price at {minute_label(minute)}")
                return False
            strike = resolve_strike(
                self.s.underlying,
                spec.strike.strike_type,
                Right(spec.option_type),
                spot,
                as_of=self.data.day,
                reference=self.reference,
            ).strike
            key = (expiry, float(strike), spec.option_type)
            if key not in self.data.chain:
                self.notes.append(f"{spec.id}: {strike:g}{spec.option_type} {expiry} not collected")
                return False
        else:
            target = spec.strike.closest_premium
            priced = [
                (abs(p - target), p, k)
                for k, series in self.data.chain.items()
                if k[0] == expiry
                and k[2] == spec.option_type
                and (p := series.price_at(minute)) is not None
            ]
            if not priced:
                self.notes.append(f"{spec.id}: no priced {spec.option_type} strikes for {expiry}")
                return False
            key = min(priced)[2]
        series = self.data.chain[key]
        if series.price_at(minute) is None:
            self.notes.append(f"{spec.id}: {key} has not traded by {minute_label(minute)}")
            return False
        contract_lot = self.reference.lot_size(self.s.underlying, key[0])
        historical = self.s.execution.lot_sizing == "historical"
        lot = (
            contract_lot
            if historical
            else self.reference.lot_size(self.s.underlying, self.sizing_date)
        )
        # in either mode: a symbol master that disagrees with the table means the table is stale
        if self.data.master_lot_size is not None and self.data.master_lot_size != contract_lot:
            self.notes.append(
                f"lot size: reference CSV says {contract_lot} for the {key[0]} expiry, Fyers "
                f"symbol master says {self.data.master_lot_size} — using the CSV; update "
                "lot_sizes.csv if it is stale"
            )
        run.qty = run.spec.lots * lot
        run.contract, run.series = key, series
        return True

    # -- per-minute steps --------------------------------------------------

    def _start(self, run: _LegRun, minute: int) -> None:
        if not self._select(run, minute):
            run.state = "done"
            return
        if run.spec.range_breakout is not None:
            run.state = "range"
            run.range_end = minute_index(run.spec.range_breakout.until)
            return
        assert run.series is not None
        self._enter(run, minute, run.series.price_at(minute), intrabar=False)  # type: ignore[arg-type]

    def _range_source(self, run: _LegRun) -> Series:
        assert run.series is not None and run.spec.range_breakout is not None
        return self.data.spot if run.spec.range_breakout.source == "underlying" else run.series

    def _step_range(self, run: _LegRun, minute: int) -> None:
        source = self._range_source(run)
        if minute < run.range_end:
            high, low = source.high[minute], source.low[minute]
            if high is not None:
                run.range_hi = high if run.range_hi is None else max(run.range_hi, high)
            if low is not None:
                run.range_lo = low if run.range_lo is None else min(run.range_lo, low)
            return
        if run.range_hi is None or run.range_lo is None:
            self.notes.append(f"{run.spec.id}: no prices during the range — no entry")
            run.state = "done"
            return
        run.state = "armed"

    def _step_armed(self, run: _LegRun, minute: int) -> None:
        rb = run.spec.range_breakout
        assert rb is not None and run.series is not None
        source = self._range_source(run)
        o, h, lo = source.open[minute], source.high[minute], source.low[minute]
        if o is None or h is None or lo is None:
            return
        if rb.side == "high" and h > run.range_hi + _EPS:  # type: ignore[operator]
            level = max(o, run.range_hi)  # type: ignore[type-var]
        elif rb.side == "low" and lo < run.range_lo - _EPS:  # type: ignore[operator]
            level = min(o, run.range_lo)  # type: ignore[type-var]
        else:
            return
        price = level if rb.source == "instrument" else run.series.close[minute]
        self._enter(run, minute, price, intrabar=True)  # type: ignore[arg-type]

    def _step_open(self, run: _LegRun, minute: int) -> str | None:
        """Returns "sl"/"target" if the leg exited on this bar."""
        assert run.series is not None
        if run.fresh_intrabar:
            run.fresh_intrabar = False
            return None
        o, h, lo = run.series.open[minute], run.series.high[minute], run.series.low[minute]
        if o is None or h is None or lo is None:
            return None
        buy = run.spec.position == "buy"
        sl, tgt = run.sl, run.target
        sl_hit = sl is not None and (lo <= sl if buy else h >= sl)
        tgt_hit = tgt is not None and (h >= tgt if buy else lo <= tgt)
        if sl_hit:
            gapped = o <= sl if buy else o >= sl  # type: ignore[operator]
            self._exit(run, minute, o if gapped else sl, "SL")  # type: ignore[arg-type]
            return "sl"
        if tgt_hit:
            gapped = o >= tgt if buy else o <= tgt  # type: ignore[operator]
            self._exit(run, minute, o if gapped else tgt, "TARGET")  # type: ignore[arg-type]
            return "target"
        if run.spec.trail_sl is not None:
            run.best = max(run.best, h) if buy else min(run.best, lo)
            x, y = run.spec.trail_sl.step(run.entry_price)
            moved = run.sign * (run.best - run.entry_price)
            steps = math.floor(moved / x + _EPS) if moved > 0 else 0
            trailed = run.initial_sl + run.sign * steps * y  # type: ignore[operator]
            run.sl = max(run.sl, trailed) if buy else min(run.sl, trailed)  # type: ignore[type-var]
        return None

    def _arm_reentry(self, run: _LegRun, minute: int, why: str) -> None:
        spec = run.spec.reentry_on_sl if why == "sl" else run.spec.reentry_on_target
        left = run.reentries_sl if why == "sl" else run.reentries_target
        if spec is None or left <= 0 or minute + 1 > self.last_reentry_min:
            return
        if why == "sl":
            run.reentries_sl -= 1
        else:
            run.reentries_target -= 1
        run.reentry_mode = spec.mode
        run.reentry_price = run.trade.entry_price if run.trade else run.entry_price
        run.state = "reentry"

    def _step_reentry(self, run: _LegRun, minute: int) -> None:
        if minute > self.last_reentry_min:
            run.state = "done"
            return
        if run.reentry_mode == "asap":
            if self._select(run, minute):
                self._enter(run, minute, run.series.open[minute], intrabar=False)  # type: ignore[union-attr,arg-type]
            else:
                run.state = "done"
            return
        assert run.series is not None
        o, h, lo = run.series.open[minute], run.series.high[minute], run.series.low[minute]
        if o is None or h is None or lo is None:
            return
        p = run.reentry_price
        if run.spec.position == "sell":
            fill = o if o <= p else (p if lo <= p else None)
        else:
            fill = o if o >= p else (p if h >= p else None)
        if fill is not None:
            self._enter(run, minute, fill, intrabar=fill != o)

    def _close_all(self, minute: int, price_of: str, reason: str) -> None:
        for run in self.legs:
            if run.state == "open":
                series = run.series
                assert series is not None
                if price_of == "at":
                    price = series.price_at(minute)
                else:
                    price = getattr(series, price_of)[minute]
                self._exit(run, minute, price, reason)  # type: ignore[arg-type]
            elif run.state != "done":
                run.state = "done"

    def _mtm(self, minute: int) -> float:
        total = self.realised
        for run in self.legs:
            if run.state == "open" and run.series is not None:
                close = run.series.close[minute]
                if close is not None:
                    total += run.sign * (close - run.entry_price) * run.qty
        return total

    def run(self) -> DayResult:
        start = minute_index(self.s.entry_time)
        end = minute_index(self.s.exit_time)
        worst = best = 0.0
        curve: list[tuple[int, float]] = []
        for minute in range(start, end):
            for run in self.legs:
                if minute == start:
                    self._start(run, minute)
                if run.state == "range":
                    self._step_range(run, minute)
                if run.state == "armed":
                    self._step_armed(run, minute)
                if run.state == "reentry" and minute > run.trade.exit_min:  # type: ignore[union-attr,operator]
                    self._step_reentry(run, minute)
                # A leg that entered intrabar this minute (breakout, RE COST)
                # is skipped inside _step_open via fresh_intrabar.
                if run.state == "open":
                    hit = self._step_open(run, minute)
                    if hit and self.s.square_off == "complete":
                        self._close_all(minute, "close", "SQUARE_OFF")
                    elif hit:
                        self._arm_reentry(run, minute, hit)
            mtm = self._mtm(minute)
            curve.append((minute, mtm))
            worst, best = min(worst, mtm), max(best, mtm)
            overall = self.s.overall
            if overall.stop_loss_inr is not None and mtm <= -overall.stop_loss_inr:
                self._close_all(minute, "close", "OVERALL_SL")
                self.stopped_by = f"overall SL at {minute_label(minute)}"
                break
            if overall.target_inr is not None and mtm >= overall.target_inr:
                self._close_all(minute, "close", "OVERALL_TARGET")
                self.stopped_by = f"overall target at {minute_label(minute)}"
                break
        else:
            if end < N_MINUTES:
                self._close_all(end, "at", "EXIT_TIME")
            else:
                self._close_all(N_MINUTES - 1, "close", "EXIT_TIME")
        gross = sum(t.pnl for t in self.trades)
        return DayResult(
            day=self.data.day,
            trades=self.trades,
            gross=gross,
            costs=self.orders * self.s.execution.cost_per_order_inr,
            worst_mtm=min(worst, gross),
            best_mtm=max(best, gross),
            stopped_by=self.stopped_by,
            notes=self.data.notes + self.notes,
            mtm=curve,
        )


def leg_count(reentry: ReEntry | None) -> int:
    return reentry.count if reentry is not None else 0


def simulate_day(
    strategy: LegwiseStrategy,
    data: DayData,
    reference: ReferenceData | None = None,
    sizing_date: date | None = None,
) -> DayResult:
    return _DaySim(strategy, data, reference or default_reference_data(), sizing_date).run()


def run_legwise(
    strategy: LegwiseStrategy,
    root: Path,
    start: date | None = None,
    end: date | None = None,
    reference: ReferenceData | None = None,
    *,
    include_excluded: bool = False,
    skipped: dict[date, str] | None = None,
    bars: str = "1m",
    only_days: set[date] | None = None,
    sizing_date: date | None = None,
) -> list[DayResult]:
    """Simulate every backtest day (market.backtest_days) in [start, end]. A day that cannot
    be run — excluded by data_quality, no index file, or no reference row (a lot size before
    the table starts) — is left out, never zero-filled; pass `skipped` to receive
    {day: reason} for each. `bars="5m"` runs the same engine on the 5-minute chain snapshots
    (market.load_day_5m); every strategy time must then be on a 5-minute mark. `only_days`
    restricts the run to those days (e.g. an AlgoTest export's); `sizing_date` pins the date
    whose lot `lot_sizing: current` uses (default: today)."""
    if bars not in BAR_SIZES:
        raise ValueError(f"bars must be one of {BAR_SIZES}, got {bars!r}")
    reference = reference or default_reference_data()
    days, left_out = backtest_days(root, strategy.underlying, start, end, include_excluded)
    if only_days is not None:
        days = [d for d in days if d in only_days]
        left_out = {d: r for d, r in left_out.items() if d in only_days}
    loader = load_day
    if bars == "5m":
        check_on_5m_marks(
            strategy.entry_time,
            strategy.exit_time,
            strategy.no_reentry_after,
            *(leg.range_breakout.until for leg in strategy.legs if leg.range_breakout),
        )
        check_strikes_on_5m(strategy.legs)
        built = snapshot_days(root, strategy.underlying)
        for day in [d for d in days if d not in built]:
            left_out[day] = "no 5-minute snapshot (tdata derived rebuild)"
        days = [d for d in days if d in built]
        loader = load_day_5m
    results = []
    for day in days:
        try:
            data = loader(root, strategy.underlying, day)
            results.append(simulate_day(strategy, data, reference, sizing_date))
        except FileNotFoundError:
            left_out[day] = "no index or option file"
        except MissingReferenceData as error:
            left_out[day] = f"reference: {error}"
    if bars == "5m":
        for result in results:
            _report_at_window_close(result)
    if skipped is not None:
        skipped.update(left_out)
    return results


def _report_at_window_close(result: DayResult) -> None:
    """5-minute bars: an entry or exit the engine made at a filler minute happened at the
    window's close — report it there (stopped_by's HH:MM too), not up to 4 minutes early."""
    for t in result.trades:
        t.entry_min = window_close_minute(t.entry_min)
        if t.exit_min is not None:
            t.exit_min = window_close_minute(t.exit_min)
    if result.stopped_by:
        result.stopped_by = re.sub(
            r"\b\d\d:\d\d\b",
            lambda m: minute_label(window_close_minute(minute_index(m.group(0)))),
            result.stopped_by,
        )


def skipped_summary(skipped: dict[date, str]) -> str:
    """'3 days skipped: excluded short_session 2, reference 1' — reasons grouped by kind."""
    if not skipped:
        return ""
    kinds: dict[str, int] = {}
    for reason in skipped.values():
        head, _, rest = reason.partition(": ")
        kind = f"{head} {rest.split(':')[0]}" if head == "excluded" else head
        kinds[kind] = kinds.get(kind, 0) + 1
    parts = ", ".join(f"{k} {n}" for k, n in sorted(kinds.items()))
    return f"{len(skipped)} day{'' if len(skipped) == 1 else 's'} skipped: {parts}"
