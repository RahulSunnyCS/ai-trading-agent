"""The 5-minute chain snapshots (BL-034 Phase 3) driving the unchanged legwise engine, checked
against the 1-minute engine on the frozen real NIFTY days of the golden fixture."""

import shutil
from pathlib import Path

import pytest
from trading_data import derived

from option_backtesting.legwise.engine import run_legwise
from option_backtesting.legwise.schema import LegwiseStrategy

FIXTURE = Path(__file__).resolve().parents[1] / "golden" / "legwise_fixture"


@pytest.fixture(scope="module")
def root(tmp_path_factory):
    root = tmp_path_factory.mktemp("lake")
    shutil.copytree(FIXTURE / "lake", root / "lake")
    derived.rebuild(root, ("NIFTY",), log=lambda _: None)
    return root


def straddle(**extra) -> LegwiseStrategy:
    legs = [
        {"id": kind.lower(), "lots": 1, "position": "sell", "option_type": kind,
         "strike": {"strike_type": "ATM"}, **extra.pop("leg", {})}
        for kind in ("CE", "PE")
    ]  # fmt: skip
    return LegwiseStrategy.model_validate(
        {"id": "s", "underlying": "NIFTY", "entry_time": "09:20", "exit_time": "15:15",
         "legs": legs, **extra}
    )  # fmt: skip


def trades(results) -> dict:
    return {
        r.day: [
            (t.leg_id, t.contract, t.qty, t.entry_min, t.entry_price, t.exit_min, t.exit_price,
             t.exit_reason)
            for t in r.trades
        ]
        for r in results
    }  # fmt: skip


def test_time_based_straddle_is_identical_on_5_minute_bars(root):
    """Entry and exit on 5-minute marks: same strikes, minutes, prices and P&L."""
    one = run_legwise(straddle(), root, bars="1m")
    five = run_legwise(straddle(), root, bars="5m")
    assert len(one) == len(five) == 6
    assert trades(five) == trades(one)
    assert [r.gross for r in five] == pytest.approx([r.gross for r in one])


def test_stops_and_adjustments_run_on_5_minute_bars(root):
    """A stop is checked per window, so its fill can differ from the 1-minute engine where a
    minute inside the window gapped through it; the days and entries are the same."""
    spec = straddle(
        leg={"stop_loss": {"percent": 30}, "reentry_on_sl": {"mode": "asap", "count": 1}},
        overall={"stop_loss_inr": 4000},
    )
    one = run_legwise(spec, root, bars="1m")
    five = run_legwise(spec, root, bars="5m")
    assert [r.day for r in five] == [r.day for r in one]
    for a, b in zip(one, five, strict=True):
        assert [t.contract for t in a.trades[:2]] == [t.contract for t in b.trades[:2]]
        assert [t.entry_price for t in a.trades[:2]] == [t.entry_price for t in b.trades[:2]]


def test_5_minute_bars_need_times_on_5_minute_marks(root):
    spec = straddle().model_copy(update={"entry_time": "09:17"})
    with pytest.raises(ValueError, match="09:17 is not on a 5-minute mark"):
        run_legwise(spec, root, bars="5m")


def test_a_day_without_snapshots_is_skipped_with_the_reason(root, tmp_path):
    shutil.copytree(FIXTURE / "lake", tmp_path / "lake")
    skipped: dict = {}
    assert run_legwise(straddle(), tmp_path, bars="5m", skipped=skipped) == []
    assert set(skipped.values()) == {"no 5-minute snapshot (tdata derived rebuild)"}
