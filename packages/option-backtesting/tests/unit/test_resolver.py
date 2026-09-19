"""
Resolver tests, including the explicit M-1 exit-criterion case: the resolver
must never reproduce the 2026-09-03 AlgoTest collision (identical ATM PE /
OTM1 PE series caused by a vendor fix_time mismatch) — see resolver.py's
module docstring and DECISIONS.md.
"""

from datetime import date, datetime

import pytest

from option_backtesting.data.providers.base import InstrumentKey, Kind, Right
from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.data.resolver import resolve, resolve_strike


@pytest.fixture()
def rd() -> ReferenceData:
    return ReferenceData()


AS_OF = date(2026, 9, 3)  # the actual collision date


class TestRoundHalfUp:
    """Must match getAtmStrike()'s round-half-up in instrument-registry.ts —
    NOT Python's built-in round(), which is round-half-to-even (banker's
    rounding) and would silently disagree at exact half-step spots."""

    def test_ordinary_spot_rounds_to_nearest_strike(self, rd: ReferenceData) -> None:
        # 24538 / 50 = 490.76 -> rounds to 491 -> 24550
        r = resolve_strike("NIFTY", "ATM", Right.CE, 24538, as_of=AS_OF, reference=rd)
        assert r.strike == 24550

    def test_exact_half_step_rounds_up_not_to_even(self, rd: ReferenceData) -> None:
        # 24525 / 50 = 490.5 exactly. round-half-up -> 491 -> 24550.
        # Python's round(490.5) would give 490 (banker's rounding to even) —
        # this test fails if _round_half_up is ever replaced with round().
        r = resolve_strike("NIFTY", "ATM", Right.CE, 24525, as_of=AS_OF, reference=rd)
        assert r.strike == 24550

    def test_another_half_step_also_rounds_up(self, rd: ReferenceData) -> None:
        # 24475 / 50 = 489.5 exactly -> round-half-up -> 490 -> 24500.
        # (489 is odd, so banker's rounding would coincidentally also round
        # up here — the previous test is the one that actually discriminates.)
        r = resolve_strike("NIFTY", "ATM", Right.CE, 24475, as_of=AS_OF, reference=rd)
        assert r.strike == 24500


class TestOtmItmDirection:
    """OTM/ITM are option-type-relative: for a CALL, OTM is above spot; for
    a PUT, OTM is below spot (mirrored for ITM)."""

    def test_ce_otm_is_above_atm(self, rd: ReferenceData) -> None:
        atm = resolve_strike("NIFTY", "ATM", Right.CE, 24538, as_of=AS_OF, reference=rd).strike
        otm1 = resolve_strike("NIFTY", "OTM1", Right.CE, 24538, as_of=AS_OF, reference=rd).strike
        assert otm1 == atm + 50

    def test_pe_otm_is_below_atm(self, rd: ReferenceData) -> None:
        atm = resolve_strike("NIFTY", "ATM", Right.PE, 24538, as_of=AS_OF, reference=rd).strike
        otm1 = resolve_strike("NIFTY", "OTM1", Right.PE, 24538, as_of=AS_OF, reference=rd).strike
        assert otm1 == atm - 50

    def test_ce_itm_is_below_atm(self, rd: ReferenceData) -> None:
        atm = resolve_strike("NIFTY", "ATM", Right.CE, 24538, as_of=AS_OF, reference=rd).strike
        itm1 = resolve_strike("NIFTY", "ITM1", Right.CE, 24538, as_of=AS_OF, reference=rd).strike
        assert itm1 == atm - 50

    def test_pe_itm_is_above_atm(self, rd: ReferenceData) -> None:
        atm = resolve_strike("NIFTY", "ATM", Right.PE, 24538, as_of=AS_OF, reference=rd).strike
        itm1 = resolve_strike("NIFTY", "ITM1", Right.PE, 24538, as_of=AS_OF, reference=rd).strike
        assert itm1 == atm + 50

    def test_otm2_is_two_steps_out(self, rd: ReferenceData) -> None:
        atm = resolve_strike("NIFTY", "ATM", Right.CE, 24538, as_of=AS_OF, reference=rd).strike
        otm2 = resolve_strike("NIFTY", "OTM2", Right.CE, 24538, as_of=AS_OF, reference=rd).strike
        assert otm2 == atm + 100


class TestNoCollision:
    """The 2026-09-03 exit criterion: ATM and OTM1 (any leg) must never
    resolve to the same strike. AlgoTest's own resolver did exactly that on
    the real date, for the real PE leg, due to a fix_time mismatch between
    the two pulls. Ours can't: every rule is a distinct integer offset from
    one shared ATM anchor computed the same way every time."""

    @pytest.mark.parametrize("right", [Right.CE, Right.PE])
    @pytest.mark.parametrize("spot", [24538, 24525, 24475, 24500.0, 51234.5])
    def test_atm_and_otm1_never_collide(self, rd: ReferenceData, right: Right, spot: float) -> None:
        atm = resolve_strike("NIFTY", "ATM", right, spot, as_of=AS_OF, reference=rd).strike
        otm1 = resolve_strike("NIFTY", "OTM1", right, spot, as_of=AS_OF, reference=rd).strike
        assert atm != otm1

    @pytest.mark.parametrize("right", [Right.CE, Right.PE])
    def test_all_five_strike_rules_are_pairwise_distinct(
        self, rd: ReferenceData, right: Right
    ) -> None:
        rules = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"]
        strikes = [
            resolve_strike("NIFTY", r, right, 24538, as_of=AS_OF, reference=rd).strike
            for r in rules
        ]
        assert len(set(strikes)) == len(strikes)


class TestExactAndDelta:
    def test_exact_rule(self, rd: ReferenceData) -> None:
        r = resolve_strike("NIFTY", "EXACT:24600", Right.CE, 24538, as_of=AS_OF, reference=rd)
        assert r.strike == 24600

    def test_delta_rule_not_yet_implemented(self, rd: ReferenceData) -> None:
        with pytest.raises(NotImplementedError):
            resolve_strike("NIFTY", "DELTA:0.30", Right.CE, 24538, as_of=AS_OF, reference=rd)

    def test_unknown_rule_raises(self, rd: ReferenceData) -> None:
        with pytest.raises(ValueError, match="Unrecognised strike rule"):
            resolve_strike("NIFTY", "BOGUS", Right.CE, 24538, as_of=AS_OF, reference=rd)


class TestResolveToInstrumentKey:
    def test_returns_concrete_instrument_key(self, rd: ReferenceData) -> None:
        key = resolve(
            "NIFTY",
            date(2026, 9, 8),
            "ATM",
            Right.CE,
            24538,
            at=datetime(2026, 9, 3, 9, 17),
            reference=rd,
        )
        assert isinstance(key, InstrumentKey)
        assert key.kind is Kind.OPT
        assert key.strike == 24550
        assert key.expiry == date(2026, 9, 8)
        assert key.right is Right.CE
