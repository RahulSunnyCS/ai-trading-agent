"""Which days a leg-wise backtest runs on, and how the left-out ones are reported."""

from datetime import date

from option_backtesting.data.reference.loader import MissingReferenceData
from option_backtesting.legwise import engine, market
from option_backtesting.legwise.schema import LegwiseStrategy

D1, D2, D3 = date(2025, 1, 1), date(2025, 1, 2), date(2025, 1, 3)


def test_excluded_days_are_left_out_with_the_reason(monkeypatch, tmp_path):
    monkeypatch.setattr(market, "available_days", lambda root, u: [D1, D2, D3])
    monkeypatch.setattr(
        market.quality, "excluded_days", lambda root, a, n: {D2: "short_session:120"}
    )
    days, skipped = market.backtest_days(tmp_path, "NIFTY")
    assert days == [D1, D3]
    assert skipped == {D2: "excluded: short_session:120"}
    days, skipped = market.backtest_days(tmp_path, "NIFTY", include_excluded=True)
    assert (days, skipped) == ([D1, D2, D3], {})
    days, _ = market.backtest_days(tmp_path, "NIFTY", start=D2, end=D3)
    assert days == [D3]


def test_no_verdict_file_runs_every_day(monkeypatch, tmp_path):
    monkeypatch.setattr(market, "available_days", lambda root, u: [D1, D2])
    monkeypatch.setattr(market.quality, "excluded_days", lambda root, a, n: None)
    assert market.backtest_days(tmp_path, "NIFTY") == ([D1, D2], {})


def test_unrunnable_days_are_skipped_not_fatal(monkeypatch, tmp_path):
    strategy = LegwiseStrategy.model_validate(
        {
            "id": "t",
            "underlying": "NIFTY",
            "entry_time": "09:20",
            "exit_time": "15:00",
            "legs": [
                {"id": "ce", "lots": 1, "position": "sell", "option_type": "CE",
                 "strike": {"strike_type": "ATM"}}
            ],
        }
    )  # fmt: skip
    monkeypatch.setattr(
        engine, "backtest_days", lambda *a, **k: ([D1, D2], {D3: "excluded: thin_chain:4"})
    )

    def load_day(root, underlying, day):
        if day == D2:
            raise FileNotFoundError("no index file")
        return day

    def simulate_day(strategy, data, reference):
        if data == D1:
            raise MissingReferenceData("No lot_sizes row for NIFTY effective on or before …")
        return "ok"

    monkeypatch.setattr(engine, "load_day", load_day)
    monkeypatch.setattr(engine, "simulate_day", simulate_day)
    skipped: dict[date, str] = {}
    assert engine.run_legwise(strategy, tmp_path, skipped=skipped) == []
    assert skipped[D1].startswith("reference: No lot_sizes row")
    assert skipped[D2] == "no index or option file"
    assert skipped[D3] == "excluded: thin_chain:4"
    assert engine.skipped_summary(skipped) == (
        "3 days skipped: excluded thin_chain 1, no index or option file 1, reference 1"
    )
