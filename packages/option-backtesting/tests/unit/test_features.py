"""
Feature registry tests. The central non-negotiable: a rolling/cross-day
feature (rolling_mean, ewma, rolling_pctile) with no `lag` must fail
validation — this is the M-2 exit criterion.
"""

import pydantic
import pytest

from option_backtesting.features.registry import (
    load_features,
    parse_feature,
    parse_leg_ref,
)


class TestLegRef:
    def test_valid_ref(self) -> None:
        assert parse_leg_ref("ATM.CE") == ("ATM", "CE")
        assert parse_leg_ref("OTM1.PE") == ("OTM1", "PE")

    def test_invalid_ref_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid leg reference"):
            parse_leg_ref("BOGUS.CE")

    def test_invalid_leg_side_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid leg reference"):
            parse_leg_ref("ATM.XX")


class TestLagRequirement:
    """The exact M-2 exit criterion case."""

    def test_rolling_mean_without_lag_fails(self) -> None:
        with pytest.raises(pydantic.ValidationError, match="lag"):
            parse_feature({"type": "rolling_mean", "source": "straddle_runup", "days": 5})

    def test_rolling_mean_with_lag_succeeds(self) -> None:
        f = parse_feature(
            {"type": "rolling_mean", "source": "straddle_runup", "days": 5, "lag": 1}
        )
        assert f.lag == 1

    def test_ewma_without_lag_fails(self) -> None:
        with pytest.raises(pydantic.ValidationError, match="lag"):
            parse_feature({"type": "ewma", "source": "straddle_runup", "halflife_days": 3})

    def test_rolling_pctile_without_lag_fails(self) -> None:
        with pytest.raises(pydantic.ValidationError, match="lag"):
            parse_feature({"type": "rolling_pctile", "source": "open_iv", "days": 60})

    def test_lag_zero_is_rejected(self) -> None:
        """lag=0 would still include today — only lag>=1 is safe."""
        with pytest.raises(pydantic.ValidationError):
            parse_feature({"type": "rolling_mean", "source": "x", "days": 5, "lag": 0})

    def test_same_day_features_do_not_require_lag(self) -> None:
        # leg_sum, max_runup, session_high, gap — all same-day-safe by
        # construction, no lag field exists on their schema at all.
        parse_feature({"type": "leg_sum", "legs": ["ATM.CE", "ATM.PE"]})
        parse_feature({"type": "max_runup", "source": "atm_straddle"})
        parse_feature({"type": "session_high", "source": "cash", "until": "09:45"})
        parse_feature({"type": "gap", "source": "fut", "vs": "prev_close"})


class TestLoadFeatures:
    def test_loads_the_design_handoff_example_block(self) -> None:
        raw = {
            "atm_straddle": {"type": "leg_sum", "legs": ["ATM.CE", "ATM.PE"], "fix_time": "09:17"},
            "otm1_strangle": {"type": "leg_sum", "legs": ["OTM1.CE", "OTM1.PE"], "fix_time": "09:17"},
            "straddle_runup": {"type": "max_runup", "source": "atm_straddle"},
            "spike_thr_5d": {
                "type": "rolling_mean",
                "source": "straddle_runup",
                "days": 5,
                "lag": 1,
            },
            "or_high": {"type": "session_high", "source": "cash", "until": "09:45"},
            "dte": {"type": "days_to_expiry", "expiry": "weekly"},
            "open_iv": {"type": "greek", "field": "iv", "at": "09:17", "leg": "ATM.CE"},
            "fut_gap_pct": {"type": "gap", "source": "fut", "vs": "prev_close"},
            "iv_pctile_60d": {
                "type": "rolling_pctile",
                "source": "open_iv",
                "days": 60,
                "lag": 1,
            },
        }
        features = load_features(raw)
        assert len(features) == 9
        assert features["dte"].expiry == "weekly"

    def test_unknown_source_reference_raises(self) -> None:
        with pytest.raises(ValueError, match="neither a built-in"):
            load_features(
                {
                    "spike_thr_5d": {
                        "type": "rolling_mean",
                        "source": "does_not_exist",
                        "days": 5,
                        "lag": 1,
                    }
                }
            )

    def test_forward_reference_is_rejected(self) -> None:
        """source must be declared EARLIER in the dict — this one references
        a feature defined after it."""
        with pytest.raises(ValueError, match="neither a built-in"):
            load_features(
                {
                    "spike_thr_5d": {
                        "type": "rolling_mean",
                        "source": "straddle_runup",
                        "days": 5,
                        "lag": 1,
                    },
                    "straddle_runup": {"type": "max_runup", "source": "atm_straddle"},
                }
            )

    def test_builtin_source_needs_no_prior_declaration(self) -> None:
        features = load_features(
            {"or_high": {"type": "session_high", "source": "cash", "until": "09:45"}}
        )
        assert features["or_high"].source == "cash"

    def test_extra_field_is_rejected(self) -> None:
        with pytest.raises(pydantic.ValidationError):
            parse_feature({"type": "gap", "source": "fut", "vs": "prev_close", "bogus": 1})

    def test_unknown_type_is_rejected(self) -> None:
        with pytest.raises(pydantic.ValidationError):
            parse_feature({"type": "not_a_real_type", "source": "cash"})
