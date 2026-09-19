"""
YAML loader tests — the M-2 exit criterion: a lagless rolling_mean feature
fails validation with a line number attached to the error.
"""

from pathlib import Path

import pytest

from option_backtesting.strategy.loader import (
    StrategyValidationError,
    load_strategy,
    load_strategy_from_source,
)

FIXTURES = Path(__file__).parent / "fixtures"


class TestLoadStrategy:
    def test_valid_minimal_strategy_loads(self) -> None:
        loaded = load_strategy(FIXTURES / "valid_minimal.yaml")
        assert loaded.strategy is not None
        assert loaded.strategy.id == "test"
        assert "atm_straddle" in loaded.features

    def test_lagless_rolling_mean_fails_with_line_number(self) -> None:
        """The exact M-2 exit criterion case."""
        with pytest.raises(StrategyValidationError) as exc_info:
            load_strategy(FIXTURES / "bad_lagless_feature.yaml")

        errors = exc_info.value.errors
        assert len(errors) == 1
        assert errors[0].startswith("line ")
        assert "lag" in errors[0]
        assert "Field required" in errors[0]
        # Points at (or very near) the actual `type: rolling_mean` block,
        # not e.g. line 1 or some other unrelated location.
        line_no = int(errors[0].split(":")[0].removeprefix("line "))
        assert 9 <= line_no <= 12

    def test_missing_strategy_key_reported(self, tmp_path: Path) -> None:
        p = tmp_path / "no_strategy.yaml"
        p.write_text("features:\n  x:\n    type: gap\n    source: fut\n")
        with pytest.raises(StrategyValidationError, match="Missing required top-level 'strategy'"):
            load_strategy(p)

    def test_non_mapping_document_reported(self, tmp_path: Path) -> None:
        p = tmp_path / "list.yaml"
        p.write_text("- just\n- a\n- list\n")
        with pytest.raises(StrategyValidationError, match="must be a mapping"):
            load_strategy(p)

    def test_malformed_yaml_is_a_validation_error_not_a_crash(self, tmp_path: Path) -> None:
        # A real gap this test closes: yaml.safe_load can raise yaml.YAMLError
        # (e.g. an unclosed flow mapping) — this must surface as a normal
        # StrategyValidationError, never propagate as an uncaught YAMLError
        # (the FastAPI service's /validate route depends on this: a bad
        # request body must never turn into an unhandled 500).
        p = tmp_path / "malformed.yaml"
        p.write_text("{{{not yaml")
        with pytest.raises(StrategyValidationError, match="could not parse YAML"):
            load_strategy(p)


class TestLoadStrategyFromSource:
    def test_validates_an_in_memory_yaml_string(self) -> None:
        source = (FIXTURES / "valid_minimal.yaml").read_text()
        loaded = load_strategy_from_source(source)
        assert loaded.strategy is not None
        assert loaded.strategy.id == "test"

    def test_errors_use_the_given_label(self) -> None:
        with pytest.raises(StrategyValidationError) as exc_info:
            load_strategy_from_source("- a\n- list\n", label="request body")
        assert "request body" in exc_info.value.errors[0]

    def test_multiple_errors_all_reported_at_once(self, tmp_path: Path) -> None:
        p = tmp_path / "multi_bad.yaml"
        p.write_text(
            "features:\n"
            "  bad1:\n"
            "    type: rolling_mean\n"
            "    source: cash\n"
            "    days: 5\n"
            "  bad2:\n"
            "    type: ewma\n"
            "    source: cash\n"
            "    halflife_days: 3\n"
            "strategy:\n"
            "  id: test\n"
            "  universe: { underlying: NIFTY }\n"
            "  legs:\n"
            "    - { id: ce, kind: OPT, strike: ATM, option: CE, side: SELL }\n"
            "  entry: { time: \"09:17\", lots: 1 }\n"
            "  caps: { max_lots: 1 }\n"
            "  exits:\n"
            "    - { type: time, at: \"15:15\" }\n"
            "  fills: { model: trigger_level }\n"
            "  costs: { per_leg_rt: 60 }\n"
        )
        with pytest.raises(StrategyValidationError) as exc_info:
            load_strategy(p)
        # Both lagless features are reported in one pass, not just the first.
        assert len(exc_info.value.errors) == 2
        assert all(e.startswith("line ") for e in exc_info.value.errors)

    def test_strategy_schema_error_also_gets_a_line_number(self, tmp_path: Path) -> None:
        p = tmp_path / "bad_strategy.yaml"
        p.write_text(
            "strategy:\n"
            "  id: test\n"
            "  universe: { underlying: NIFTY }\n"
            "  legs:\n"
            "    - { id: ce, kind: OPT, strike: BOGUS_RULE, option: CE, side: SELL }\n"
            "  entry: { time: \"09:17\", lots: 1 }\n"
            "  caps: { max_lots: 1 }\n"
            "  exits:\n"
            "    - { type: time, at: \"15:15\" }\n"
            "  fills: { model: trigger_level }\n"
            "  costs: { per_leg_rt: 60 }\n"
        )
        with pytest.raises(StrategyValidationError) as exc_info:
            load_strategy(p)
        assert any("Unknown strike rule" in e and e.startswith("line ") for e in exc_info.value.errors)
