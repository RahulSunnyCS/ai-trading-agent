"""
Overfitting guard (M-5, R1b): Combinatorially Symmetric Cross-Validation
(CSCV) / Probability of Backtest Overfitting (PBO), and a simplified
Deflated Sharpe Ratio (DSR) — both per Bailey & Lopez de Prado ("The
Probability of Backtest Overfitting", 2015; "The Deflated Sharpe Ratio",
2014). Both consume a `SweepReport`'s successful configs' SESSION-LEVEL net
P&L (`AggregateResult.sessions`), never a single run's headline number —
overfitting is a property of "how many configs were tried and how each one
did", which only a sweep (analytics/sweep.py) records; a lone backtest has
nothing to be overfit relative to.

Deflated Sharpe Ratio here uses the simplified (Gaussian-returns) form: it
adjusts for the number of trials (N) and the spread of Sharpe ratios across
them, but does NOT correct for the skewness/kurtosis of session-level P&L
the full PSR/DSR derivation calls for. That is a known, documented
simplification — flagged here rather than silently omitted — appropriate
given this milestone's scope; the full skew/kurtosis-adjusted estimator is
a natural follow-up, not required for a first, honest overfitting guard.

Both functions only use Python's stdlib `statistics.NormalDist` for the
standard normal CDF/inverse-CDF — deliberately not adding scipy as a new
dependency for two formulas that stdlib already covers exactly.
"""

from __future__ import annotations

import itertools
import math
import statistics
from dataclasses import dataclass

from .sweep import SweepReport

_EULER_MASCHERONI = 0.5772156649015329
_NORMAL = statistics.NormalDist()


@dataclass(frozen=True)
class CscvResult:
    n_configs: int
    n_blocks: int
    n_combinations: int
    # Fraction of IS/OOS combinations where the config that looked best
    # in-sample fell at or below the out-of-sample median — the paper's
    # headline overfitting-probability figure. Higher = more likely that
    # picking "the best backtest" was picking noise, not skill.
    pbo: float


@dataclass(frozen=True)
class DeflatedSharpeResult:
    best_config_label: str
    observed_sharpe: float
    expected_max_sharpe: float
    # P(true Sharpe > 0 | observed best-of-N), after deflating for N trials.
    deflated_sharpe: float
    n_trials: int
    n_sessions: int


def _sharpe(values: list[float]) -> float:
    """Sample-mean / sample-stdev of a session-net series. 0.0 for a
    degenerate series (fewer than 2 values, or zero variance) rather than
    raising or dividing by zero — a flat/tiny sample carries no Sharpe
    signal either way."""
    if len(values) < 2:
        return 0.0
    stdev = statistics.stdev(values)
    if stdev == 0:
        return 0.0
    return statistics.fmean(values) / stdev


def _block_bounds(n: int, n_blocks: int) -> list[tuple[int, int]]:
    """Contiguous, near-equal-sized (chronological) block boundaries over n
    sessions — CSCV's blocks are time-contiguous, not random."""
    base, extra = divmod(n, n_blocks)
    bounds = []
    start = 0
    for i in range(n_blocks):
        size = base + (1 if i < extra else 0)
        bounds.append((start, start + size))
        start += size
    return bounds


def _relative_rank(perf: dict[str, float], label: str) -> float:
    """Bailey & Lopez de Prado's omega_c: the rank of `label`'s performance
    among all configs (1=worst .. N=best), divided by (N+1) so it lies
    strictly in (0, 1) and the logit lambda_c = ln(omega/(1-omega)) is
    always defined."""
    target = perf[label]
    rank = sum(1 for v in perf.values() if v <= target)
    return rank / (len(perf) + 1)


def _session_counts(report: SweepReport) -> int:
    counts = {len(c.result.sessions) for c in report.successful}  # type: ignore[union-attr]
    if len(counts) != 1:
        raise ValueError(
            f"All successful configs must share the same session count (same shared "
            f"window) for this analysis; got {sorted(counts)}"
        )
    return counts.pop()


def run_cscv(report: SweepReport, n_blocks: int = 4) -> CscvResult:
    """CSCV/PBO over a sweep's successful configs. Every successful config
    must have the SAME number of sessions (the sweep ran them all over the
    same shared window). `n_blocks` must be an even number >= 2; there must
    be at least `2 * n_blocks` sessions so every IS/OOS half of every
    combination has at least 2 sessions to compute a Sharpe ratio from."""
    configs = report.successful
    if len(configs) < 2:
        raise ValueError("CSCV needs at least 2 successful configs to compare.")
    if n_blocks < 2 or n_blocks % 2 != 0:
        raise ValueError(f"n_blocks must be an even number >= 2, got {n_blocks}")

    n_sessions = _session_counts(report)
    if n_sessions < 2 * n_blocks:
        raise ValueError(
            f"Need at least {2 * n_blocks} sessions to run CSCV with n_blocks={n_blocks} "
            f"(so every IS/OOS half has >= 2 sessions), got {n_sessions}"
        )

    bounds = _block_bounds(n_sessions, n_blocks)
    blocks: dict[str, list[list[float]]] = {
        c.label: [[s.net for s in c.result.sessions[a:b]] for a, b in bounds]  # type: ignore[union-attr]
        for c in configs
    }
    labels = list(blocks.keys())
    block_indices = range(n_blocks)

    below_median = 0
    combos = list(itertools.combinations(block_indices, n_blocks // 2))
    for combo in combos:
        is_set = set(combo)
        is_perf = {}
        oos_perf = {}
        for label in labels:
            is_values = [v for i in is_set for v in blocks[label][i]]
            oos_values = [v for i in block_indices if i not in is_set for v in blocks[label][i]]
            is_perf[label] = _sharpe(is_values)
            oos_perf[label] = _sharpe(oos_values)

        best_is_label = max(labels, key=lambda label: is_perf[label])
        if _relative_rank(oos_perf, best_is_label) <= 0.5:
            below_median += 1

    return CscvResult(
        n_configs=len(configs),
        n_blocks=n_blocks,
        n_combinations=len(combos),
        pbo=below_median / len(combos),
    )


def run_deflated_sharpe(report: SweepReport) -> DeflatedSharpeResult:
    """Deflated Sharpe Ratio (simplified, Gaussian-returns form — see module
    docstring) over a sweep's successful configs. Needs >= 2 successful
    configs (N trials) all sharing the same session count, and >= 2
    sessions to compute a Sharpe ratio at all."""
    configs = report.successful
    if len(configs) < 2:
        raise ValueError("Deflated Sharpe needs at least 2 successful configs (N trials).")

    n_sessions = _session_counts(report)
    if n_sessions < 2:
        raise ValueError("Need at least 2 sessions to compute a Sharpe ratio.")

    sharpes = {c.label: _sharpe([s.net for s in c.result.sessions]) for c in configs}  # type: ignore[union-attr]
    n = len(sharpes)
    sigma_sr = statistics.pstdev(sharpes.values())

    if sigma_sr == 0:
        expected_max_sr = 0.0
    else:
        # E[max SR] under N independent trials with no true skill (Bailey &
        # Lopez de Prado's Gaussian approximation of the expected maximum
        # of N draws from a standard normal, scaled by the observed
        # cross-trial Sharpe spread).
        expected_max_sr = sigma_sr * (
            (1 - _EULER_MASCHERONI) * _NORMAL.inv_cdf(1 - 1 / n)
            + _EULER_MASCHERONI * _NORMAL.inv_cdf(1 - 1 / (n * math.e))
        )

    best_label = max(sharpes, key=lambda label: sharpes[label])
    sr_hat = sharpes[best_label]
    # Simplified standard error of the estimated Sharpe ratio, assuming
    # Gaussian returns (no skew/kurtosis correction — see module docstring).
    se_sr_hat = math.sqrt(1 / (n_sessions - 1))
    deflated = _NORMAL.cdf((sr_hat - expected_max_sr) / se_sr_hat)

    return DeflatedSharpeResult(
        best_config_label=best_label,
        observed_sharpe=sr_hat,
        expected_max_sharpe=expected_max_sr,
        deflated_sharpe=deflated,
        n_trials=n,
        n_sessions=n_sessions,
    )


def render_overfit(cscv: CscvResult, dsr: DeflatedSharpeResult) -> str:
    return (
        f"CSCV: {cscv.n_configs} config(s), {cscv.n_blocks} block(s), "
        f"{cscv.n_combinations} IS/OOS combination(s)\n"
        f"  PBO (probability of backtest overfitting): {cscv.pbo:.1%}\n"
        f"\n"
        f"Deflated Sharpe Ratio ({dsr.n_trials} trial(s), {dsr.n_sessions} session(s)):\n"
        f"  best config: {dsr.best_config_label}\n"
        f"  observed Sharpe: {dsr.observed_sharpe:.3f}\n"
        f"  expected max Sharpe under no skill: {dsr.expected_max_sharpe:.3f}\n"
        f"  deflated Sharpe (P[true Sharpe > 0]): {dsr.deflated_sharpe:.1%}"
    )
