"""
Unit tests for analytics/overfit.py (CSCV/PBO + simplified Deflated Sharpe
Ratio). Structural/validation behaviour is tested against hand-built
`SweepReport`s; PBO/DSR's actual statistical behaviour is validated the way
the literature itself validates it — via Monte Carlo scenarios with a fixed
seed: pure noise (no real skill among configs) should show a HIGH PBO and a
LOW deflated Sharpe for the apparent best config, while one genuinely
skilled config planted among noise configs should show a LOW PBO and a HIGH
deflated Sharpe.
"""

import random
from datetime import date, timedelta

import pytest

from option_backtesting.analytics.overfit import (
    render_overfit,
    run_cscv,
    run_deflated_sharpe,
)
from option_backtesting.analytics.sweep import SweepConfigResult, SweepReport
from option_backtesting.engine.result import AggregateResult, SessionResult


def _session(i: int, net: float) -> SessionResult:
    return SessionResult(
        date=date(2026, 1, 1) + timedelta(days=i),
        dte=1,
        net=net,
        gross=net,
        cost=0.0,
        lot_days=1.0,
        peak_loss=0.0,
        total_lots=1,
        exit_bar=0,
        fills=[],
    )


def _config(label: str, nets: list[float], error: str | None = None) -> SweepConfigResult:
    result = None
    if error is None:
        sessions = [_session(i, n) for i, n in enumerate(nets)]
        result = AggregateResult(
            net_inr=sum(nets),
            gross_inr=sum(nets),
            win_days=sum(1 for n in nets if n > 0),
            worst_day=min([0.0, *nets]),
            sum_peak_loss=0.0,
            worst_intraday_mtm=0.0,
            lot_days=float(len(nets)),
            inr_per_lot_day=sum(nets) / len(nets) if nets else 0.0,
            dte_buckets={},
            sessions=sessions,
        )
    return SweepConfigResult(label=label, changes={}, yaml_text="", result=result, error=error)


def _report(configs: list[SweepConfigResult]) -> SweepReport:
    return SweepReport(date_from=date(2026, 1, 1), date_to=date(2026, 3, 1), configs=configs)


class TestRunCscvValidation:
    def test_needs_at_least_two_successful_configs(self) -> None:
        report = _report([_config("a", [1.0] * 20)])
        with pytest.raises(ValueError, match="at least 2 successful configs"):
            run_cscv(report)

    def test_n_blocks_must_be_even(self) -> None:
        report = _report([_config("a", [1.0] * 20), _config("b", [2.0] * 20)])
        with pytest.raises(ValueError, match="even number"):
            run_cscv(report, n_blocks=3)

    def test_mismatched_session_counts_rejected(self) -> None:
        report = _report([_config("a", [1.0] * 20), _config("b", [2.0] * 10)])
        with pytest.raises(ValueError, match="same session count"):
            run_cscv(report)

    def test_too_few_sessions_for_n_blocks_rejected(self) -> None:
        report = _report([_config("a", [1.0] * 4), _config("b", [2.0] * 4)])
        with pytest.raises(ValueError, match="Need at least"):
            run_cscv(report, n_blocks=4)

    def test_failed_configs_are_excluded_from_comparison(self) -> None:
        report = _report(
            [
                _config("a", [1.0] * 20),
                _config("b", [2.0] * 20),
                _config("bad", [], error="no data"),
            ]
        )
        result = run_cscv(report)
        assert result.n_configs == 2

    def test_n_combinations_matches_binomial_coefficient(self) -> None:
        report = _report([_config("a", [1.0] * 20), _config("b", [2.0] * 20)])
        result = run_cscv(report, n_blocks=4)
        # C(4, 2) = 6
        assert result.n_combinations == 6
        assert 0.0 <= result.pbo <= 1.0


class TestRunDeflatedSharpeValidation:
    def test_needs_at_least_two_successful_configs(self) -> None:
        report = _report([_config("a", [1.0] * 20)])
        with pytest.raises(ValueError, match="at least 2 successful configs"):
            run_deflated_sharpe(report)

    def test_mismatched_session_counts_rejected(self) -> None:
        report = _report([_config("a", [1.0] * 20), _config("b", [2.0] * 10)])
        with pytest.raises(ValueError, match="same session count"):
            run_deflated_sharpe(report)

    def test_best_config_label_matches_max_sharpe(self) -> None:
        report = _report(
            [
                _config("flat", [1.0] * 20),  # zero variance -> sharpe 0.0
                _config("winner", [10.0, 12.0, 9.0, 11.0] * 5),  # positive, low-vol
            ]
        )
        result = run_deflated_sharpe(report)
        assert result.best_config_label == "winner"
        assert result.n_trials == 2
        assert result.n_sessions == 20


class TestMonteCarloBehaviour:
    """Not hand-computable in closed form — validated the way the
    literature validates PBO/DSR: Monte Carlo. A SINGLE noise realization's
    PBO is itself a noisy statistic (only n_blocks-choose-n_blocks/2
    discrete combinations feed it), so these average over many independent
    repetitions — the law-of-large-numbers behaviour is what's actually
    being asserted, not any one draw."""

    N_REPS = 30

    def test_pure_noise_configs_average_pbo_near_no_signal_floor(self) -> None:
        pbos = []
        for seed in range(self.N_REPS):
            rng = random.Random(seed)
            configs = [
                _config(f"noise_{i}", [rng.gauss(0, 10) for _ in range(40)]) for i in range(8)
            ]
            pbos.append(run_cscv(_report(configs), n_blocks=4).pbo)
        # With no real skill differentiating any config, the best-in-sample
        # config should do no better than a coin flip out-of-sample on
        # average — mean PBO should sit close to the "no signal" ~0.5
        # floor, not collapse toward 0.
        avg_pbo = sum(pbos) / len(pbos)
        assert 0.35 < avg_pbo < 0.65

    def test_pure_noise_configs_average_deflated_sharpe_is_moderate(self) -> None:
        dsrs = []
        for seed in range(self.N_REPS):
            rng = random.Random(seed)
            configs = [
                _config(f"noise_{i}", [rng.gauss(0, 10) for _ in range(60)]) for i in range(15)
            ]
            dsrs.append(run_deflated_sharpe(_report(configs)).deflated_sharpe)
        # The best-of-15 pure-noise Sharpe ratio is inflated by trial count
        # alone; after deflating for N trials it should NOT look like real
        # skill on average (P[true Sharpe > 0] should not be near-certain).
        avg_dsr = sum(dsrs) / len(dsrs)
        assert avg_dsr < 0.75

    def test_one_genuinely_skilled_config_gives_consistently_low_pbo(self) -> None:
        pbos = []
        for seed in range(self.N_REPS):
            rng = random.Random(seed)
            configs = [
                _config(f"noise_{i}", [rng.gauss(0, 10) for _ in range(40)]) for i in range(7)
            ]
            configs.append(_config("skilled", [rng.gauss(20, 5) for _ in range(40)]))
            pbos.append(run_cscv(_report(configs), n_blocks=4).pbo)
        # A config with a real, consistent edge should keep winning
        # out-of-sample too, in almost every repetition — average PBO
        # should be low, well under the "no signal" ~0.5 floor.
        avg_pbo = sum(pbos) / len(pbos)
        assert avg_pbo < 0.15

    def test_one_genuinely_skilled_config_gives_consistently_high_deflated_sharpe(self) -> None:
        dsrs = []
        winners = []
        for seed in range(self.N_REPS):
            rng = random.Random(seed)
            configs = [
                _config(f"noise_{i}", [rng.gauss(0, 10) for _ in range(60)]) for i in range(7)
            ]
            configs.append(_config("skilled", [rng.gauss(25, 5) for _ in range(60)]))
            result = run_deflated_sharpe(_report(configs))
            dsrs.append(result.deflated_sharpe)
            winners.append(result.best_config_label)
        assert all(w == "skilled" for w in winners)
        avg_dsr = sum(dsrs) / len(dsrs)
        assert avg_dsr > 0.9


def test_render_overfit_includes_both_headline_figures() -> None:
    rng = random.Random(3)
    configs = [_config(f"c{i}", [rng.gauss(0, 10) for _ in range(20)]) for i in range(4)]
    report = _report(configs)
    cscv = run_cscv(report)
    dsr = run_deflated_sharpe(report)
    text = render_overfit(cscv, dsr)
    assert "PBO" in text
    assert "Deflated Sharpe" in text
    assert dsr.best_config_label in text
