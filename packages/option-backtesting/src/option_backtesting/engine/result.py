"""
Per-session result computation. `SessionResult` is the atomic unit the
aggregate report (added on top of this module once every session in a run
has been simulated) is built from.

All formulas here are pinned against `golden_15_sessions.py` /
`pyramid_backtest.py`'s reference implementation — read engine/loop.py's
module docstring before touching this file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Literal

import numpy as np

from .costs import flat_cost
from .ledger import Fill, SessionLedger


@dataclass
class SessionResult:
    date: date
    dte: int
    net: float
    gross: float
    cost: float
    lot_days: float
    peak_loss: float
    total_lots: int
    exit_bar: int
    fills: list[Fill] = field(default_factory=list)


def compute_session_result(
    d: date,
    dte: int,
    traded_closes: list[float],
    ledger: SessionLedger,
    exit_bar: int,
    lot_size: int,
    per_leg_rt: float,
    side: Literal["BUY", "SELL"],
) -> SessionResult:
    """`side` is the strategy's uniform leg side — SELL means the combined
    premium series is a short position (profit as price falls, matching the
    reference's short-strangle model exactly); BUY generalizes to a long
    position (profit as price rises). Mixed BUY/SELL legs within one
    strategy are rejected upstream (engine/loop.py's `_uniform_side`) — this
    function assumes a single sign for the whole session."""
    sign = 1 if side == "SELL" else -1
    n = len(traded_closes)
    exit_price = traded_closes[exit_bar]
    total_lots = ledger.total_lots()

    gross = sum(f.lots * sign * (f.price - exit_price) for f in ledger.fills) * lot_size
    cost = flat_cost(total_lots, per_leg_rt)
    net = gross - cost

    lot_days = sum(f.lots * (n - f.bar) / n for f in ledger.fills)

    mtm_values = [
        sum(f.lots * sign * (f.price - traded_closes[i]) for f in ledger.fills if f.bar <= i)
        * lot_size
        for i in range(n)
    ]
    peak_loss = min([0.0, *mtm_values])

    return SessionResult(
        date=d,
        dte=dte,
        net=net,
        gross=gross,
        cost=cost,
        lot_days=lot_days,
        peak_loss=peak_loss,
        total_lots=total_lots,
        exit_bar=exit_bar,
        fills=list(ledger.fills),
    )


def position_mtm(
    traded_closes: list[float],
    ledger: SessionLedger,
    side: Literal["BUY", "SELL"],
    lot_size: int,
    bar: int,
) -> float:
    """Running mark-to-market P&L using only fills entered by `bar`
    (inclusive) — the same formula `compute_session_result` uses per-bar for
    `peak_loss`, exposed separately so engine/loop.py's stop_loss/
    profit_target/trailing exit checks can reuse it live, bar by bar."""
    sign = 1 if side == "SELL" else -1
    return (
        sum(f.lots * sign * (f.price - traded_closes[bar]) for f in ledger.fills if f.bar <= bar)
        * lot_size
    )


@dataclass
class AggregateResult:
    net_inr: float
    gross_inr: float
    win_days: int
    worst_day: float
    sum_peak_loss: float
    # Distinctly named from `sum_peak_loss` on purpose: the reference's own
    # more general `summarise()` computes `worst_intraday_mtm = min(peak_loss
    # across sessions)`, NOT the sum the golden fixture's "sum pkLoss"
    # reports — conflating the two would silently corrupt whichever one a
    # caller actually wanted. Never merge these fields.
    worst_intraday_mtm: float
    lot_days: float
    inr_per_lot_day: float
    dte_buckets: dict[int, float]
    sessions: list[SessionResult] = field(default_factory=list)


def aggregate(sessions: list[SessionResult]) -> AggregateResult:
    net_inr = sum(s.net for s in sessions)
    gross_inr = sum(s.gross for s in sessions)
    win_days = sum(1 for s in sessions if s.net > 0)
    worst_day = min([0.0, *(s.net for s in sessions)])
    sum_peak_loss = sum(s.peak_loss for s in sessions)
    worst_intraday_mtm = min(s.peak_loss for s in sessions) if sessions else 0.0
    lot_days = sum(s.lot_days for s in sessions)
    inr_per_lot_day = net_inr / lot_days if lot_days else 0.0
    dte_buckets: dict[int, float] = {}
    for s in sessions:
        dte_buckets[s.dte] = dte_buckets.get(s.dte, 0.0) + s.net
    return AggregateResult(
        net_inr=net_inr,
        gross_inr=gross_inr,
        win_days=win_days,
        worst_day=worst_day,
        sum_peak_loss=sum_peak_loss,
        worst_intraday_mtm=worst_intraday_mtm,
        lot_days=lot_days,
        inr_per_lot_day=inr_per_lot_day,
        dte_buckets=dte_buckets,
        sessions=list(sessions),
    )


@dataclass
class BootstrapCI:
    net_lo: float
    net_hi: float
    inr_per_lot_day_lo: float
    inr_per_lot_day_hi: float
    n_resamples: int
    seed: int


def bootstrap_ci(
    session_nets: list[float],
    session_lot_days: list[float],
    *,
    n_resamples: int = 2000,
    seed: int = 0,
    confidence: float = 0.90,
) -> BootstrapCI:
    """Session-level IID resample (R1a) for a net-INR and INR/lot-day
    confidence interval — deliberately does NOT bootstrap `worst_day` or
    `sum_peak_loss`, which are path/order-dependent statistics not
    well-posed under IID resampling of session order. Deterministic given a
    fixed `seed` (numpy's `default_rng`)."""
    n = len(session_nets)
    if n == 0:
        return BootstrapCI(0.0, 0.0, 0.0, 0.0, n_resamples, seed)
    rng = np.random.default_rng(seed)
    nets = np.array(session_nets)
    lot_days = np.array(session_lot_days)
    resampled_nets = np.empty(n_resamples)
    resampled_ratios = np.empty(n_resamples)
    for i in range(n_resamples):
        idx = rng.integers(0, n, size=n)
        resampled_nets[i] = nets[idx].sum()
        total_lot_days = lot_days[idx].sum()
        resampled_ratios[i] = resampled_nets[i] / total_lot_days if total_lot_days else 0.0
    alpha = (1 - confidence) / 2
    net_lo, net_hi = np.quantile(resampled_nets, [alpha, 1 - alpha])
    ratio_lo, ratio_hi = np.quantile(resampled_ratios, [alpha, 1 - alpha])
    return BootstrapCI(
        net_lo=float(net_lo),
        net_hi=float(net_hi),
        inr_per_lot_day_lo=float(ratio_lo),
        inr_per_lot_day_hi=float(ratio_hi),
        n_resamples=n_resamples,
        seed=seed,
    )


def render_report(result: AggregateResult) -> str:
    lines = [
        f"gross INR: {result.gross_inr:.0f}",
        f"net INR: {result.net_inr:.0f}",
        f"win days: {result.win_days}",
        f"worst day: {result.worst_day:.0f}",
        f"sum pkLoss: {result.sum_peak_loss:.0f}",
        f"worst intraday mtm: {result.worst_intraday_mtm:.0f}",
        f"lot-days: {result.lot_days:.2f}",
        f"INR/lot-day: {result.inr_per_lot_day:.0f}",
        "",
        "DTE breakdown:",
    ]
    for dte in sorted(result.dte_buckets):
        lines.append(f"  {dte}: {result.dte_buckets[dte]:.0f}")
    return "\n".join(lines)


def render_bootstrap(ci: BootstrapCI) -> str:
    return (
        f"--- Bootstrap CI (n={ci.n_resamples}, seed={ci.seed}) ---\n"
        f"net INR: [{ci.net_lo:.0f}, {ci.net_hi:.0f}]\n"
        f"INR/lot-day: [{ci.inr_per_lot_day_lo:.0f}, {ci.inr_per_lot_day_hi:.0f}]"
    )


def position_profit_pct(
    traded_closes: list[float], ledger: SessionLedger, side: Literal["BUY", "SELL"], bar: int
) -> float:
    """% move of the combined premium in the position's favor since its
    lot-weighted average entry price, as of `bar`. Not golden-verified (no
    committed strategy uses a `premium_pct`-basis exit)."""
    sign = 1 if side == "SELL" else -1
    fills_so_far = [f for f in ledger.fills if f.bar <= bar]
    total_lots = sum(f.lots for f in fills_so_far)
    avg_price = sum(f.lots * f.price for f in fills_so_far) / total_lots
    close = traded_closes[bar]
    return -sign * (close - avg_price) / avg_price * 100
