"""
Walk-forward analysis (M-5). Our strategies are hand-authored YAML, not
parameters a fitting procedure tunes, so there is nothing to "re-optimize"
between windows — this is walk-forward in the narrower, honest sense the
design calls for: run the same strategy, unchanged, over a chronologically
earlier in-sample window and a strictly later out-of-sample window, and
report both — with the out-of-sample figure headlined, since an in-sample
number for a strategy whose rules were themselves eyeballed against that
same window is the number most likely to overstate real edge.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ..data.cache import Cache
from ..data.reference.loader import ReferenceData
from ..engine.loop import run_backtest
from ..engine.result import AggregateResult, aggregate, render_report
from ..strategy.loader import LoadedStrategy


@dataclass(frozen=True)
class WalkForwardResult:
    in_sample_from: date
    in_sample_to: date
    out_of_sample_from: date
    out_of_sample_to: date
    in_sample: AggregateResult
    out_of_sample: AggregateResult


def run_walkforward(
    loaded: LoadedStrategy,
    cache: Cache,
    reference: ReferenceData,
    in_sample_from: date,
    in_sample_to: date,
    out_of_sample_from: date,
    out_of_sample_to: date,
) -> WalkForwardResult:
    """Raises ValueError if the out-of-sample window doesn't strictly
    follow the in-sample window — a walk-forward comparison where the
    windows overlap or run backwards isn't testing anything, and silently
    computing one anyway would produce a number that looks like OOS
    validation but isn't."""
    if out_of_sample_from <= in_sample_to:
        raise ValueError(
            f"out-of-sample window (from {out_of_sample_from}) must start strictly after "
            f"the in-sample window ends ({in_sample_to}) — got an overlapping or "
            f"backwards window pair."
        )

    is_sessions = run_backtest(loaded, cache, reference, in_sample_from, in_sample_to)
    if not is_sessions:
        raise ValueError(
            f"No cached sessions for the in-sample window [{in_sample_from}, {in_sample_to}]."
        )
    oos_sessions = run_backtest(loaded, cache, reference, out_of_sample_from, out_of_sample_to)
    if not oos_sessions:
        raise ValueError(
            f"No cached sessions for the out-of-sample window "
            f"[{out_of_sample_from}, {out_of_sample_to}]."
        )

    return WalkForwardResult(
        in_sample_from=in_sample_from,
        in_sample_to=in_sample_to,
        out_of_sample_from=out_of_sample_from,
        out_of_sample_to=out_of_sample_to,
        in_sample=aggregate(is_sessions),
        out_of_sample=aggregate(oos_sessions),
    )


def render_walkforward(result: WalkForwardResult) -> str:
    lines = [
        f"=== OUT-OF-SAMPLE (headline) [{result.out_of_sample_from} .. "
        f"{result.out_of_sample_to}] ===",
        render_report(result.out_of_sample),
        "",
        f"--- in-sample (reference only) [{result.in_sample_from} .. "
        f"{result.in_sample_to}] ---",
        render_report(result.in_sample),
    ]
    return "\n".join(lines)
