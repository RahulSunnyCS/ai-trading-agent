"""The fixed base reference and the 60-day read-out numbers (BL-058 amendment 2026-10-10).
Synthetic results under tmp_path: no lake, no engine."""

from __future__ import annotations

import csv
from datetime import date, timedelta

import numpy as np
import pytest

from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import base, journal, readout, store
from option_backtesting.rotation.variants import STRATEGIES_DIR, variant_names

NAMES = variant_names()
DAYS = [date(2026, 10, 12) + timedelta(days=i) for i in range(5)]  # Mon..Fri


def _write(root, name: str, series: dict[date, float], where: str = "results") -> None:
    directory = store.rotation_dir(root) / where
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(store.RESULT_COLUMNS)
        for d, v in series.items():
            w.writerow([d.isoformat(), v, v, 0.0, v, "", 2])


def _seed(root, value=lambda name, d: 100.0, days=DAYS) -> None:
    for n in NAMES:
        _write(root, n, {d: value(n, d) for d in days})


def _entry(
    root,
    day: date,
    picks: dict[str, list[str]],
    buy: dict[str, list[str]] | None = None,
    late=False,
):
    buy = buy or {}
    journal.append(
        store.journal_path(root),
        {
            "v": 3,
            "day": day.isoformat(),
            "weekday": day.strftime("%a"),
            "before_first_entry": not late,
            "lists": {
                k: {"core": picks[k], "buy": buy.get(k, []), "overridden": False, "composite": {}}
                for k in picks
            },
        },
    )


def _all_lists(core: list[str]) -> dict[str, list[str]]:
    return {k: list(core) for k in ("A", "B", "C", "REF")}


# --- the base's definition ---------------------------------------------------------------------


def test_the_base_dir_file_is_the_live_file_with_atm_and_nothing_else():
    live = load_legwise(STRATEGIES_DIR.parent / "legwise" / "nifty_dir_924_itm1_sl21_recost.yaml")
    mine = load_legwise(base.BASE_DIR / f"{base.DIR_NAME}.yaml")
    assert mine.entry_time == live.entry_time == "09:24"
    assert [leg.strike.strike_type for leg in mine.legs] == ["ATM", "ATM"]
    assert [leg.strike.strike_type for leg in live.legs] == ["ITM1", "ITM1"]
    for a, b in zip(mine.legs, live.legs, strict=True):
        assert a.stop_loss == b.stop_loss
        assert a.reentry_on_sl == b.reentry_on_sl
        assert a.lots == b.lots == 1
    assert mine.overall.stop_loss_inr == live.overall.stop_loss_inr == 3000
    assert mine.exit_time == live.exit_time
    assert mine.underlying == live.underlying == "NIFTY"


def test_the_base_is_outside_the_universe_so_the_pick_never_sees_it():
    assert len(NAMES) == 298
    assert base.DIR_NAME not in NAMES
    assert base.BASE_DIR != STRATEGIES_DIR
    assert (base.BASE_DIR / f"{base.DIR_NAME}.yaml").exists()
    # the leg it shares with the rotation is the registered Widesl OTM1 09:17 variant
    assert base.WIDE_NAME in NAMES


def test_base_per_lot_is_two_widesl_and_one_dir_over_three(tmp_path):
    d = DAYS[0]
    _write(tmp_path, base.WIDE_NAME, {d: 600.0, DAYS[1]: -300.0})
    _write(tmp_path, base.DIR_NAME, {d: 300.0}, where="base")
    s = base.base_per_lot(tmp_path)
    assert s == {d: (2 * 600.0 + 300.0) / 3}  # a day with only one leg is not a base day
    assert base.pending_days(tmp_path) == [DAYS[1]]


def test_a_stored_dir_day_is_never_rewritten(tmp_path):
    row = {
        "day": DAYS[0].isoformat(),
        "net": 1,
        "gross": 1,
        "costs": 0,
        "worst_mtm": 0,
        "stopped_by": "",
        "n_trades": 2,
    }
    assert base.append_dir_result(row, tmp_path) is True
    assert base.append_dir_result({**row, "gross": 999}, tmp_path) is False
    assert base.read_column(base.base_dir(tmp_path) / f"{base.DIR_NAME}.csv", "gross") == {
        DAYS[0]: 1.0
    }


# --- the numbers -------------------------------------------------------------------------------


def test_max_drawdown_starts_the_peak_at_zero_like_the_research():
    assert readout.max_drawdown(np.array([-5.0, -3.0, 4.0])) == -8.0
    assert readout.max_drawdown(np.array([10.0, -4.0, -3.0, 20.0])) == -7.0
    assert readout.max_drawdown(np.array([])) == 0.0


def test_the_bootstrap_is_deterministic_and_brackets_a_clear_edge():
    x = np.array([50.0, 40.0, 60.0, 55.0, 45.0, 52.0, 48.0, 58.0, 44.0, 51.0, 47.0, 53.0])
    a = readout.block_bootstrap_mean(x)
    assert a == readout.block_bootstrap_mean(x)  # same seed, same interval
    assert a[1] > 0 and a[1] <= a[0] <= a[2]
    z = readout.block_bootstrap_mean(np.zeros(12))
    assert z == (0.0, 0.0, 0.0)
    assert all(np.isnan(v) for v in readout.block_bootstrap_mean(np.array([])))


def test_a_day_of_random_baskets_does_not_depend_on_other_days_and_keeps_two_widesl():
    pool = np.array([1000.0] * 3 + [1.0] * 12)  # 3 Widesl-like at 1000, 12 other at 1
    wide = np.array([True] * 3 + [False] * 12)
    buy = np.array([7.0, 8.0])
    c1, b1 = readout.random_day(DAYS[0], pool, wide, buy, runs=500)
    c2, _ = readout.random_day(DAYS[1], pool, wide, buy, runs=500)
    c1b, b1b = readout.random_day(DAYS[0], pool, wide, buy, runs=500)
    assert np.array_equal(c1, c1b) and np.array_equal(b1, b1b)
    assert not np.array_equal(c1, c2)
    assert (c1 >= 2001).all()  # two Widesl-like + one other at least; one Widesl would be 1002
    assert set(b1.tolist()) <= {7.0, 8.0}


def test_readout_per_lot_day_vs_base_and_the_pass_rule(tmp_path):
    # 12 forward days; Widesl OTM1 09:17 is the base's leg. Picks earn more than the base every day.
    days = [
        d for d in (date(2026, 10, 12) + timedelta(days=i) for i in range(30)) if d.weekday() < 5
    ][:12]
    _seed(tmp_path, lambda n, d: 100.0, days=days)
    _write(tmp_path, "N_dir_0932", {d: 400.0 + i * 5 for i, d in enumerate(days)})
    _write(tmp_path, base.DIR_NAME, {d: 100.0 for d in days}, where="base")
    for d in days:
        _entry(
            tmp_path,
            d,
            {
                "A": ["N_dir_0932", "N_wide_0932", "N_wide_1017"],
                "B": ["N_wide_0932", "N_wide_1017", "N_dir_0947"],
                "C": ["N_wide_0932", "N_wide_1017", "N_dir_0947"],
                "REF": ["N_wide_0932", "N_wide_1017", "N_dir_0947"],
            },
        )
    r = readout.build(tmp_path, runs=200)
    assert r["n_days"] == 12 and not r["short"] and r["pending_days"] == []
    # base = (2*100 + 100)/3 = 100 per lot-day; A = (400+5i + 100 + 100)/3
    assert r["base"]["per_lot_day"] == pytest.approx(100.0)
    a = r["lists"]["A"]
    expected = np.mean([(400 + 5 * i + 200) / 3 for i in range(12)])
    assert a["per_lot_day"] == pytest.approx(expected)
    assert a["total"] == pytest.approx(2 * sum(400 + 5 * i + 200 for i in range(12)))  # 2 lots each
    assert a["lots_per_day"] == 6
    assert a["vs_base"]["mean"] == pytest.approx(expected - 100.0)
    assert a["vs_base"]["lower"] > 0 and a["vs_base"]["beats_base"] is True
    # B / C / REF earn exactly the base's 100 per lot: not ahead
    for k in ("B", "C", "REF"):
        assert r["lists"][k]["vs_base"]["mean"] == pytest.approx(0.0)
        assert r["lists"][k]["vs_base"]["beats_base"] is False
    assert r["lists"]["REF"]["vs_ref"] is None
    assert r["lists"]["A"]["vs_ref"]["mean"] == pytest.approx(expected - 100.0)


def test_a_late_entry_and_an_unscored_day_are_left_out_and_named(tmp_path):
    days = DAYS[:3]
    _seed(tmp_path, days=days[:2])  # the third day has no results yet
    _write(tmp_path, base.DIR_NAME, {d: 100.0 for d in days}, where="base")
    core = ["N_wide_0932", "N_wide_1017", "N_dir_0947"]
    _entry(tmp_path, days[0], _all_lists(core))
    _entry(tmp_path, days[1], _all_lists(core), late=True)
    _entry(tmp_path, days[2], _all_lists(core))
    r = readout.build(tmp_path, runs=50)
    assert r["n_days"] == 1 and r["short"]
    assert r["late_entries"] == [days[1].isoformat()]
    assert r["pending_days"] == [days[2].isoformat()]


def test_a_buy_day_counts_its_two_lots_and_four_strategies(tmp_path):
    d = DAYS[0]
    _seed(tmp_path, lambda n, day: 100.0 if "buy" not in n else 700.0, days=[d])
    _write(tmp_path, base.DIR_NAME, {d: 100.0}, where="base")
    core = ["N_wide_0932", "N_wide_1017", "N_dir_0947"]
    _entry(tmp_path, d, _all_lists(core), buy={"A": ["N_buy_0932"]})
    a = readout.build(tmp_path, runs=50)["lists"]["A"]
    assert a["lots_per_day"] == 8
    assert a["total"] == pytest.approx(2 * (300 + 700))
    assert a["per_lot_day"] == pytest.approx((300 + 700) / 4)


def test_an_unscored_day_says_why_it_is_waiting(tmp_path):
    d1, d2 = DAYS[0], DAYS[1]
    _seed(tmp_path, days=[d1])  # d1 has every variant; d2 has none
    _write(tmp_path, base.DIR_NAME, {}, where="base")  # the Dir leg has no days at all
    core = ["N_wide_0932", "N_wide_1017", "N_dir_0947"]
    _entry(tmp_path, d1, _all_lists(core))
    _entry(tmp_path, d2, _all_lists(core))
    r = readout.build(tmp_path, runs=20)
    assert r["n_days"] == 0
    assert "Dir ATM 09:24" in r["pending_reasons"][d1.isoformat()]
    assert "no result yet for" in r["pending_reasons"][d2.isoformat()]
    assert "waiting:" in readout.render(r)


def test_base_scoring_reports_the_first_error_instead_of_a_bare_count(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("lake unreadable")

    monkeypatch.setattr(base, "load_day", boom)
    lines: list[str] = []
    out = base.score_days([DAYS[0]], root=tmp_path, log=lines.append)
    assert out["written"] == 0 and len(out["skipped"]) == 1
    assert "lake unreadable" in lines[0] and "1 skipped" in lines[0]


def test_a_base_failure_never_fails_the_nightly_update(monkeypatch):
    from typer.testing import CliRunner

    from option_backtesting.rotation import cli, triggers, update

    monkeypatch.setattr(update, "default_day", lambda *a, **k: DAYS[0])
    monkeypatch.setattr(
        update,
        "update_day",
        lambda *a, **k: {"written": 1, "already": 0, "skipped": None, "errors": []},
    )
    monkeypatch.setattr(triggers, "score_pending", lambda *a, **k: None)

    def boom(*a, **k):
        raise RuntimeError("base broke")

    monkeypatch.setattr(base, "pending_days", boom)
    result = CliRunner().invoke(cli.rotation_app, ["update"])
    assert result.exit_code == 0
    assert "base scoring skipped" in (result.output + (result.stderr or ""))


def test_the_readout_carries_daily_totals_the_base_total_and_the_random_band(tmp_path):
    days = [
        d for d in (date(2026, 10, 12) + timedelta(days=i) for i in range(10)) if d.weekday() < 5
    ][:5]
    _seed(tmp_path, lambda n, d: 100.0, days=days)
    _write(tmp_path, base.DIR_NAME, {d: 100.0 for d in days}, where="base")
    core = ["N_wide_0932", "N_wide_1017", "N_dir_0947"]
    for d in days:
        _entry(tmp_path, d, _all_lists(core))
    r = readout.build(tmp_path, runs=100)
    assert r["base"]["total"] == pytest.approx(2 * 3 * 100.0 * 5)  # 6 lots, 5 days
    a = r["lists"]["A"]["random_path"]
    assert len(a["p50"]) == 5 and a["p10"][-1] <= a["p50"][-1] <= a["p90"][-1]
    assert r["days"][0]["A_total"] == pytest.approx(2 * 300.0)
    assert r["days"][-1]["base_total"] == pytest.approx(2 * 3 * 100.0)
