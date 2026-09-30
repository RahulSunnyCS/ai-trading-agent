from datetime import date

from trading_data.db import connect
from trading_data.instruments import InstrumentSpec, instrument_key, register

from option_backtesting.legwise import store
from option_backtesting.legwise.daily import StrategyFile, summary
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.schema import LegwiseStrategy

from .test_legwise_engine import DAY, EXP, bars, day, sell_leg, strategy


def _setup(root):
    with connect(root) as con:
        register(
            con,
            [
                InstrumentSpec(
                    "option",
                    "NSE",
                    "NIFTY",
                    expiry=EXP,
                    strike=22000.0,
                    option_type="CE",
                    underlying_key=instrument_key("NSE", "index", "NIFTY"),
                )
            ],
        )
    s = strategy([sell_leg(stop_loss={"percent": 50})])
    data = day({(22000.0, "CE"): bars(100, {"10:00": (120, 160, 118, 150)})})
    return s, simulate_day(s, data)


def test_daily_result_round_trips_exactly(tmp_path):
    s, result = _setup(tmp_path)
    with connect(tmp_path) as con:
        store.save_daily(con, s, result)
        [saved] = store.load_daily(con)
    assert saved == store.record(result, s)
    assert saved["trades"][0]["contract"] == "SELL 22000CE 29Sep"


def test_rerunning_a_day_replaces_its_result(tmp_path):
    s, result = _setup(tmp_path)
    with connect(tmp_path) as con:
        store.save_daily(con, s, result)
        store.save_daily(con, s, result)
        assert len(store.load_daily(con)) == 1
        assert con.execute("SELECT count(*) FROM backtest_trades").fetchone()[0] == 1


def test_version_ignores_formatting_but_not_settings():
    s = strategy([sell_leg()])
    same = LegwiseStrategy.model_validate(s.model_dump())  # e.g. re-saved or re-commented file
    changed = strategy([sell_leg(stop_loss={"percent": 60})])
    assert store.spec_hash(s) == store.spec_hash(same)
    assert store.spec_hash(s) != store.spec_hash(changed)


def test_results_of_an_older_version_are_reported_stale(tmp_path):
    s, result = _setup(tmp_path)
    with connect(tmp_path) as con:
        store.save_daily(con, s, result)
        history = store.load_daily(con)
    edited = strategy([sell_leg(stop_loss={"percent": 60})])
    text = summary(
        DAY, [], history, [StrategyFile(tmp_path / "t.yaml", edited, store.spec_hash(edited))]
    )
    assert "so far: +0 over 0 days" in text and "1 older day(s)" in text


def test_adhoc_runs_are_kept_separately(tmp_path):
    s, result = _setup(tmp_path)
    with connect(tmp_path) as con:
        store.save_adhoc(con, s, [result], {"from": None})
        store.save_adhoc(con, s, [result], {"from": None})
        kinds = con.execute("SELECT kind, count(*) FROM backtest_runs GROUP BY 1").fetchall()
        assert kinds == [("adhoc", 2)]
        assert store.load_daily(con) == []  # adhoc experiments never mix into daily totals
    assert date.fromisoformat(store.record(result, s)["day"]) == DAY
