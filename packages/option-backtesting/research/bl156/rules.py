"""BL-156: the overall MTM stop checked at the 1-minute candle close (the engine as it is) or on every
tick (modelled from each minute's high / low). Rules: backlog/BL-156-mtm-stop-tick-vs-candle-close.md,
Phase 0 (2026-10-23).

`RuleSim` is the engine's own day simulator with one change: where the overall stop is checked. Leg
stops, trails, re-entries, fills and the exit time are the engine's. The engine itself is not edited.

Rules:
- "close"  : the engine as it is (combined MTM at each bar's close; exit at that close).
- "close5" : the same, but only at the close of each 5-minute candle (09:19, 09:24, ...).
- "tick"   : each minute, two index-driven scenarios (calls at the minute's high and puts at its
             low; calls at the low and puts at the high). If the worse one is at or below -stop, the
             stop fires that minute and the day ends at -stop x (1 + overshoot), or at the minute's
             open MTM if that is already through (a gap).
- "tick_pess": as "tick", but every leg at its own adverse extreme at once (sells at the high, buys at
             the low): an upper bound on how often a tick stop fires.
A leg that entered intrabar in the minute counts at that minute's close.

Leg stop (Amendment 1), `leg_rule`:
- "tick"  : the engine as it is (the bar's high/low; fill at the stop, or the open on a gap).
- "close" : the stop is checked against the 1-minute close and the leg exits at that close; the trail
            moves on closes. The tick MTM check then runs before the legs' close checks in a minute.
"""

from __future__ import annotations

import math

from option_backtesting.legwise.engine import _EPS, DayResult, _DaySim, to_tick  # noqa: PLC2701
from option_backtesting.legwise.market import N_MINUTES, minute_index, minute_label

RULES = ("close", "close5", "tick", "tick_pess")


class RuleSim(_DaySim):
    def __init__(
        self, *args, rule: str = "close", overshoot: float = 0.02, leg_rule: str = "tick", **kwargs
    ) -> None:
        if rule not in RULES or leg_rule not in ("tick", "close"):
            raise ValueError((rule, leg_rule))
        super().__init__(*args, **kwargs)
        self.rule = rule
        self.leg_rule = leg_rule
        self.overshoot = overshoot
        self.adjust = (
            0.0  # tick rules: the day's total set to the stop level, minus the trades' P&L
        )

    # -- the tick model -------------------------------------------------------------------------

    def _leg_prices(self, minute: int, start: int, scenario: str) -> list[tuple[object, float]]:
        out = []
        for run in self.legs:
            if run.state != "open" or run.series is None:
                continue
            s = run.series
            o, h, lo, c = s.open[minute], s.high[minute], s.low[minute], s.close[minute]
            if c is None:
                continue
            fresh = run.trade is not None and run.trade.entry_min == minute and minute != start
            if fresh or h is None or lo is None or o is None:
                price = c
            elif scenario == "open":
                price = o
            elif scenario == "pess":
                price = h if run.spec.position == "sell" else lo
            else:
                call = run.contract is not None and run.contract[2] == "CE"
                up = scenario == "up"
                price = h if (call == up) else lo
            out.append((run, price))
        return out

    def _mtm_at(self, prices: list[tuple[object, float]]) -> float:
        return self.realised + sum(r.sign * (p - r.entry_price) * r.qty for r, p in prices)  # type: ignore[attr-defined]

    def _tick_fire(self, minute: int, start: int, stop: float) -> float | None:
        """The day's total if the tick stop fires in this minute, else None. With no leg open the
        realised P&L is final: nothing is left for a tick stop to close (the close rule keeps it too)."""
        if not self._leg_prices(minute, start, "open"):
            return None
        if self.rule == "tick_pess":
            worst = self._mtm_at(self._leg_prices(minute, start, "pess"))
        else:
            worst = min(
                self._mtm_at(self._leg_prices(minute, start, "up")),
                self._mtm_at(self._leg_prices(minute, start, "down")),
            )
        if worst > -stop:
            return None
        at_open = self._mtm_at(self._leg_prices(minute, start, "open"))
        if at_open <= -stop:
            return at_open
        return -stop * (1 + self.overshoot)

    # -- the leg stop at the candle close (Amendment 1) -----------------------------------------

    def _step_open_close(self, run, minute: int) -> str | None:
        """The engine's `_step_open`, with the stop, target and trail read at the bar's close."""
        assert run.series is not None
        if run.fresh_intrabar:
            run.fresh_intrabar = False
            return None
        c = run.series.close[minute]
        if c is None:
            return None
        buy = run.spec.position == "buy"
        sl, tgt = run.sl, run.target
        if sl is not None and (c <= sl if buy else c >= sl):
            self._exit(run, minute, c, "SL")
            return "sl"
        if tgt is not None and (c >= tgt if buy else c <= tgt):
            self._exit(run, minute, c, "TARGET")
            return "target"
        if run.spec.trail_sl is not None:
            run.best = max(run.best, c) if buy else min(run.best, c)
            x, y = run.spec.trail_sl.step(run.entry_price)
            moved = run.sign * (run.best - run.entry_price)
            steps = math.floor(moved / x + _EPS) if moved > 0 else 0
            trailed = to_tick(run.initial_sl + run.sign * steps * y)
            run.sl = max(run.sl, trailed) if buy else min(run.sl, trailed)
        return None

    def _after_hit(self, run, minute: int, hit: str | None) -> None:
        if hit and self.s.square_off == "complete":
            self._close_all(minute, "close", "SQUARE_OFF")
        elif hit:
            self._arm_reentry(run, minute, hit)

    # -- the engine's loop, with the stop checks switched ---------------------------------------

    def run(self) -> DayResult:
        start = minute_index(self.s.entry_time)
        end = minute_index(self.s.exit_time)
        worst = best = 0.0
        curve: list[tuple[int, float]] = []
        overall = self.s.overall
        stop = overall.stop_loss_inr
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
                if run.state == "open" and self.leg_rule == "tick":
                    self._after_hit(run, minute, self._step_open(run, minute))
            if self.leg_rule == "tick":
                self._roll_exhausted_legs(minute)
            if stop is not None and self.rule in ("tick", "tick_pess"):
                total = self._tick_fire(minute, start, stop)
                if total is not None:
                    self._close_all(minute, "close", "OVERALL_SL")
                    self.adjust = total - sum(t.pnl for t in self.trades)
                    self.stopped_by = f"overall SL (tick) at {minute_label(minute)}"
                    worst = min(worst, total)
                    break
            if self.leg_rule == "close":
                for run in self.legs:
                    if run.state == "open":
                        self._after_hit(run, minute, self._step_open_close(run, minute))
                self._roll_exhausted_legs(minute)
            mtm = self._mtm(minute)
            curve.append((minute, mtm))
            worst, best = min(worst, mtm), max(best, mtm)
            check = self.rule != "close5" or (minute + 1) % 5 == 0
            if stop is not None and self.rule in ("close", "close5") and check and mtm <= -stop:
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
        gross = sum(t.pnl for t in self.trades) + self.adjust
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


def simulate(
    strategy,
    data,
    reference,
    sizing_date,
    rule: str,
    overshoot: float = 0.02,
    leg_rule: str = "tick",
) -> DayResult:
    return RuleSim(
        strategy, data, reference, sizing_date, rule=rule, overshoot=overshoot, leg_rule=leg_rule
    ).run()
