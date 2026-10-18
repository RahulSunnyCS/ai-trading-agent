"""Strategy labels for the Telegram messages (BL-125): read from each strategy's own YAML."""

from __future__ import annotations

import pytest

from option_backtesting.rotation import labels
from option_backtesting.rotation.variants import TRACK_DIRS, variant_names

KNOWN = [
    ("N_ditm1_0917", "N_dir_ITM1", "SL21% · TSLnone · RECOST1 · MTMSL3000"),
    ("N_wide_1117", "N_widesl_OTM1", "SL115% · TSL15%/10% · REnone · MTMSL2500"),
    ("N_p100_1202", "N_widesl_p100", "SL115% · TSL15%/10% · REnone · MTMSL2500"),
    ("N_ditm1-t1s36_0947", "N_dir_ITM1", "SL20% · TSL10%/5% · RECOST2 · MTMSL4000"),
    ("N_p150-t1s11_0917", "N_widesl_p150", "SL60% · TSL15%/10% · REnone · MTMSL4000"),
    ("S_p320_1132", "S_widesl_p320", "SL114%/115% · TSL15%/10% · REnone · MTMSL2500"),
    ("N_buy_0917", "N_buy_p50", "SL25% · TSL1pt/1pt · RB09:17-09:27-high · MTMSL2000"),
]


@pytest.mark.parametrize(("name", "head", "params"), KNOWN)
def test_known_labels(name, head, params):
    assert labels.label(name) == (head, params)


def test_every_core_and_t1_strategy_has_a_label():
    """All 521 files load and say what they do: a head `{N|S}_{dir|widesl|buy}_{strike}` and a
    params line that always carries the stop loss, the trail and the overall stop."""
    names = [*variant_names(), *variant_names(TRACK_DIRS["t1"])]
    assert len(names) == 298 + 223
    for name in names:
        head, params = labels.label(name)
        assert head != name, f"{name}: no label (file unreadable or an unknown kind)"
        index, kind, strike = head.split("_")
        assert index == name[0] and kind in ("dir", "widesl", "buy") and strike
        assert params.startswith("SL") and " · TSL" in params and " · MTMSL" in params
        assert labels.slot(name) == f"{name[-4:-2]}:{name[-2:]}"


def test_a_range_breakout_says_how_it_triggers():
    assert labels.breakout_note("N_buy_0917") == "buys only if the premium breaks the range high"
    assert labels.breakout_note("N_wide_1117") is None
    assert labels.breakout_note("no_such_strategy") is None


def test_names_with_no_file_fall_back_to_the_raw_id_and_never_raise():
    for name in ("N_wide_9999", "X_wide_0917", "not-a-variant", "", "N_p150-t9s1_0917"):
        assert labels.label(name) == (name, "")
    assert labels.slot("not-a-variant") == ""
    assert not labels.buy_strategy("not-a-variant")


def test_legs_that_differ_are_joined_and_optional_settings_appear(tmp_path, monkeypatch):
    """CE/PE differences join with `/`; a target, a roll and an underlying-based breakout with a
    gap and a validity window are spelled out (no Core or T1 file uses them today)."""
    (tmp_path / "N_wide_0917.yaml").write_text(
        """
strategy:
  id: x
  underlying: NIFTY
  entry_time: "09:17"
  exit_time: "15:28"
  legs:
    - id: ce
      lots: 1
      position: sell
      option_type: CE
      strike: { strike_type: OTM2 }
      stop_loss: { points: 30 }
      target: { percent: 50 }
      trail_sl: { points: [5, 2] }
      reentry_on_sl: { mode: asap, count: 2 }
      roll: { decay: 0.25 }
    - id: pe
      lots: 1
      position: sell
      option_type: PE
      strike: { strike_type: OTM2 }
      stop_loss: { points: 40 }
      target: { percent: 50 }
      trail_sl: { points: [5, 2] }
      reentry_on_sl: { mode: asap, count: 2 }
      roll: { decay: 0.25 }
  overall: { stop_loss_inr: 1500.5, target_inr: 4000 }
"""
    )
    (tmp_path / "N_buy_0932.yaml").write_text(
        """
strategy:
  id: y
  underlying: NIFTY
  entry_time: "09:32"
  exit_time: "15:14"
  legs:
    - id: ce
      lots: 1
      position: buy
      option_type: CE
      strike: { closest_premium: 52.5 }
      stop_loss: { percent: 25 }
      range_breakout: { until: "09:42", side: low, source: underlying, gap_percent: 0.5, valid_until: "10:30" }
    - id: pe
      lots: 1
      position: buy
      option_type: PE
      strike: { closest_premium: 52.5 }
      stop_loss: { percent: 25 }
      range_breakout: { until: "09:42", side: low, source: underlying, gap_percent: 0.5, valid_until: "10:30" }
"""
    )
    monkeypatch.setattr(labels, "strategy_path", lambda name: tmp_path / f"{name}.yaml")
    labels._load.cache_clear()
    try:
        assert labels.label("N_wide_0917") == (
            "N_widesl_OTM2",
            "SL30pt/40pt · TSL5pt/2pt · REASAP2 · TP50% · ROLL0.25 · MTMSL1500.5 · MTMTP4000",
        )
        assert labels.label("N_buy_0932") == (
            "N_buy_p52.5",
            "SL25% · TSLnone · RB09:32-09:42-low-underlying+0.5%->10:30 · MTMSLnone",
        )
        assert labels.breakout_note("N_buy_0932") == "buys only if the index breaks the range low"
    finally:
        labels._load.cache_clear()
