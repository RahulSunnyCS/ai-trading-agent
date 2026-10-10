"""Strategy correlation (BL-090): the measures, the basket builder, the dynamic series loader and
the CLI. Hand-built series and tmp roots: no lake, no Fyers."""

from __future__ import annotations

import json
import math
from datetime import date, timedelta

import numpy as np
import pytest
import yaml
from trading_data.db import connect
from typer.testing import CliRunner

from option_backtesting import cli
from option_backtesting.analytics import correlation as c
from option_backtesting.legwise import store as legwise_store
from option_backtesting.legwise.engine import DayResult
from option_backtesting.legwise.schema import LegwiseStrategy
from option_backtesting.rotation import series as rseries
from option_backtesting.rotation import store

from .test_legwise_engine import sell_leg, strategy


def weekdays(n: int, start: date = date(2025, 1, 6)) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def ser(name: str, x, days: list[date] | None = None, kind: str = "variant") -> c.Series:
    days = days or weekdays(len(x))
    return c.Series(name, kind, dict(zip(days, map(float, x), strict=True)))


def noise(seed: int, n: int = 200) -> np.ndarray:
    return np.random.default_rng(seed).normal(0, 1000, n)


# --- the measures -----------------------------------------------------------------------------


def test_identical_series_are_one_and_negated_series_minus_one():
    x = noise(1)
    r = c.analyse([ser("a", x), ser("b", x), ser("neg", -x)])
    assert r.pearson[0, 1] == pytest.approx(1.0)
    assert r.spearman[0, 1] == pytest.approx(1.0)
    assert r.pearson[0, 2] == pytest.approx(-1.0)
    assert r.loss_overlap[0, 1] == pytest.approx(1.0)
    assert r.loss_overlap[0, 2] == pytest.approx(0.0)  # never lose on the same day
    assert r.loss_corr[0, 1] == pytest.approx(1.0)


def test_independent_series_are_uncorrelated_and_the_basket_draws_down_less_than_its_parts():
    r = c.analyse([ser("a", noise(2)), ser("b", noise(3)), ser("c", noise(4))])
    off_diagonal = r.pearson[np.triu_indices(3, 1)]
    assert np.all(np.abs(off_diagonal) < 0.2)
    assert r.basket.dd_ratio < 1.0
    assert r.basket.sum_of_part_dds == pytest.approx(sum(p.max_dd for p in r.parts.values()))


def test_spearman_ignores_a_monotone_transform_but_pearson_does_not():
    x = noise(5)
    y = x + noise(6, len(x)) * 0.8
    base = c.analyse([ser("x", x), ser("y", y)])
    cubed = c.analyse([ser("x", x**3), ser("y", y)])
    assert cubed.spearman[0, 1] == pytest.approx(base.spearman[0, 1])
    assert cubed.pearson[0, 1] != pytest.approx(base.pearson[0, 1], abs=1e-3)


def test_loss_correlation_matches_a_brute_force_pairwise_computation():
    rng = np.random.default_rng(7)
    x = rng.normal(0, 1, (150, 4))
    x[:, 1] += 0.6 * x[:, 0]
    got = c._loss_corr(x)
    for i in range(4):
        for j in range(4):
            if i == j:
                continue
            keep = (x[:, i] < 0) | (x[:, j] < 0)
            want = np.corrcoef(x[keep, i], x[keep, j])[0, 1]
            assert got[i, j] == pytest.approx(want, abs=1e-9)


def test_max_drawdown_is_measured_from_a_start_of_zero():
    daily = np.array([100, -50, -80, 30, 200, -300], dtype=float)
    assert c._max_drawdown(daily) == -300.0
    assert c._max_drawdown(np.array([-10.0, -20.0])) == -30.0  # a loss from day one counts
    assert c._max_drawdown(np.array([5.0, 6.0])) == 0.0


def test_a_strategy_that_never_varies_has_no_correlation_not_a_crash():
    r = c.analyse([ser("flat", np.zeros(60)), ser("b", noise(8, 60))])
    assert math.isnan(r.pearson[0, 1])
    assert json.loads(json.dumps(c.to_json(r)))["pearson"][0][1] is None


def test_align_keeps_common_weekdays_only_and_names_the_shortest_history():
    days = weekdays(60)
    sat = date(2025, 1, 11)
    a = ser("a", noise(9, 60), days)
    a.values[sat] = 1.0  # a Saturday session is dropped
    b = ser("b", noise(10, 59), days[:-1])  # one day short
    got_days, names, values = c.align([a, b])
    assert sat not in got_days and days[-1] not in got_days and len(got_days) == 59
    assert names == ["a", "b"] and values.shape == (59, 2)
    with pytest.raises(ValueError, match=r"only 10 days in common .*shortest history: short"):
        c.align([a, ser("short", noise(11, 10), days[:10])])


def test_rolling_blocks_show_a_pair_that_flips_from_alike_to_opposite():
    x = noise(12, 126)
    y = np.concatenate([x[:63], -x[63:]])
    r = c.analyse([ser("x", x), ser("y", y)], window=63)
    assert [round(row.mean) for row in r.rolling] == [1, -1]
    assert r.rolling[0].top_pair[:2] == ("x", "y")


def test_end_date_cuts_the_window_for_a_trailing_matrix():
    s = [ser("a", noise(13, 200)), ser("b", noise(14, 200))]
    cut = weekdays(200)[99]
    assert c.analyse(s, end=cut).days[-1] == cut


# --- the basket builder -----------------------------------------------------------------------


def _clones():
    base = noise(20)
    near = lambda seed: base + noise(seed) * 0.05  # noqa: E731
    return [
        ser("clone1", near(21)),
        ser("clone2", near(22)),
        ser("clone3", near(23)),
        ser("other", noise(24) + 40),
    ]


def test_pick_diverse_takes_one_of_each_look_alike_group():
    r = c.analyse(_clones())
    rank = {"clone1": 3.0, "clone2": 2.0, "clone3": 1.0, "other": 0.5}
    b = c.pick_diverse(r, 2, 0.9, rank=rank)
    assert b.names == ["clone1", "other"]
    assert [s[0] for s in b.skipped] == ["clone2", "clone3"]
    assert b.uncapped.names == ["clone1", "clone2"]
    assert b.stats.max_dd >= b.uncapped.max_dd  # less negative: the cap cut the drawdown


def test_pick_diverse_honours_require_and_comes_up_short_instead_of_padding():
    r = c.analyse(_clones())
    rank = {"clone1": 3.0, "clone2": 2.0, "clone3": 1.0, "other": 0.5}
    b = c.pick_diverse(r, 3, 0.9, rank=rank, require=["clone3"])
    assert b.names[0] == "clone3" and "clone1" not in b.names
    assert b.short and len(b.names) == 2 and b.in_sample
    with pytest.raises(ValueError, match="not in the report"):
        c.pick_diverse(r, 2, 0.9, require=["nope"])
    with pytest.raises(ValueError, match="do not fit"):
        c.pick_diverse(r, 1, 0.9, require=["clone1", "other"])


def test_pick_diverse_treats_an_incomputable_correlation_as_not_independent():
    r = c.analyse([ser("flat", np.zeros(60)), ser("b", noise(30, 60))])
    b = c.pick_diverse(r, 2, 0.9, rank={"b": 2.0, "flat": 1.0})
    assert b.names == ["b"] and b.short


def test_render_text_handles_small_and_large_sets():
    small = c.render_text(c.analyse([ser("a", noise(40)), ser("b", noise(41))]))
    assert "Pearson" in small and "Loss overlap" in small and "Basket of all 2" in small
    many = [ser(f"s{i:02d}", noise(100 + i, 80)) for i in range(c.FULL_MATRIX_MAX + 3)]
    big = c.render_text(c.analyse(many))
    assert "most alike" in big and "least alike" in big and "Loss overlap" not in big


def test_csv_rows_are_a_labelled_square_matrix():
    rows = c.to_csv_rows(c.analyse([ser("a", noise(50)), ser("b", noise(51))]), "spearman")
    assert rows[0] == ["", "a", "b"] and rows[1][0] == "a" and rows[1][1] == "1.0000"


# --- finding strategies: nothing is a fixed list ----------------------------------------------


def _variant(root, name: str, x, days: list[date] | None = None):
    for d, v in zip(days or weekdays(len(x)), x, strict=True):
        store.append_result(name, {"day": d.isoformat(), "net": float(v)}, root)


def _live(strategy_id: str, stop: int = 50) -> LegwiseStrategy:
    base = strategy([sell_leg(stop_loss={"percent": stop})])
    return LegwiseStrategy.model_validate({**base.model_dump(), "id": strategy_id})


def _save_live(root, s: LegwiseStrategy, x, days: list[date] | None = None):
    with connect(root) as con:
        for d, v in zip(days or weekdays(len(x)), x, strict=True):
            r = DayResult(d, [], float(v), 0.0, 0.0, 0.0, None)
            legwise_store.save_daily(con, s, r)


def _write_yaml(folder, s: LegwiseStrategy):
    folder.mkdir(exist_ok=True)
    (folder / f"{s.id}.yaml").write_text(yaml.safe_dump({"strategy": s.model_dump(mode="json")}))


def test_a_variant_added_later_is_found_with_no_code_change(tmp_path):
    _variant(tmp_path, "N_wide_0917", noise(60, 50))
    assert [a.name for a in rseries.available(tmp_path, tmp_path / "none")] == ["N_wide_0917"]
    _variant(tmp_path, "N_idea_0917", noise(61, 50))  # a strategy created tomorrow
    names = [a.name for a in rseries.available(tmp_path, tmp_path / "none")]
    assert names == ["N_idea_0917", "N_wide_0917"]
    assert [s.name for s in rseries.load(["family:idea"], tmp_path, strategies_dir=tmp_path)] == [
        "N_idea_0917"
    ]


def test_selectors_pick_by_name_glob_slot_family_index_and_kind(tmp_path):
    for n in ("N_wide_0917", "N_p80_0917", "N_dir_0932", "S_wide_0917", "S_buy_0917"):
        _variant(tmp_path, n, noise(70, 45))
    live = _live("nifty_live")
    _save_live(tmp_path, live, noise(71, 45))
    _write_yaml(tmp_path / "strategies", live)
    av = rseries.available(tmp_path, tmp_path / "strategies")

    def names(*sel: str) -> list[str]:
        return [a.name for a in rseries.resolve(list(sel), av)]

    assert names("N_*_0917") == ["N_p80_0917", "N_wide_0917"]
    assert names("slot:09:17") == names("slot:0917") == [
        "N_p80_0917", "N_wide_0917", "S_buy_0917", "S_wide_0917",
    ]  # fmt: skip
    assert names("family:wide") == ["N_p80_0917", "N_wide_0917", "S_wide_0917"]  # p80 is Widesl
    assert names("family:p80") == ["N_p80_0917"]
    assert names("index:S", "N_dir_0932") == ["S_buy_0917", "S_wide_0917", "N_dir_0932"]
    assert names("kind:legwise") == ["nifty_live"] and len(names("all")) == 6
    assert names("N_wide_0917", "N_*_0917") == ["N_wide_0917", "N_p80_0917"]  # once, in order
    with pytest.raises(rseries.SelectorError, match="matches nothing"):
        names("slot:1500")
    with pytest.raises(rseries.SelectorError):
        names("../../etc/passwd")  # only ever matched against enumerated names


def test_legwise_results_of_an_edited_strategy_are_stale_until_asked_for(tmp_path):
    old = _live("live_a", stop=50)
    _save_live(tmp_path, old, noise(80, 45))
    edited = _live("live_a", stop=60)  # the file now says something else
    _write_yaml(tmp_path / "strategies", edited)
    av = rseries.available(tmp_path, tmp_path / "strategies")
    assert [(a.name, a.stale) for a in av] == [("live_a", True)]
    with pytest.raises(rseries.SelectorError, match="stale"):
        rseries.resolve(["live_a"], av)
    assert [a.name for a in rseries.resolve(["live_a"], av, include_stale=True)] == ["live_a"]
    _save_live(tmp_path, edited, noise(81, 45))  # re-run at the new settings
    fresh = rseries.available(tmp_path, tmp_path / "strategies")
    assert [(a.name, a.stale, a.n_days) for a in fresh] == [("live_a", False, 45)]


def test_a_live_strategy_correlates_with_a_variant_that_reproduces_it(tmp_path):
    x = noise(90, 45)
    _variant(tmp_path, "N_wide_0917", x)
    live = _live("nifty_copy")
    _save_live(tmp_path, live, x)
    _write_yaml(tmp_path / "strategies", live)
    series = rseries.load(
        ["N_wide_0917", "kind:legwise"], tmp_path, strategies_dir=tmp_path / "strategies"
    )
    r = c.analyse(series, min_days=40)
    assert r.pearson[0, 1] == pytest.approx(1.0) and r.kinds == ["variant", "legwise"]


def test_no_results_at_all_says_what_to_run(tmp_path):
    with pytest.raises(rseries.SelectorError, match="obt rotation update"):
        rseries.resolve(["all"], rseries.available(tmp_path, tmp_path / "none"))


# --- the commands -----------------------------------------------------------------------------


@pytest.fixture
def populated(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(rseries, "LEGWISE_DIR", tmp_path / "none")
    base = noise(95, 60)
    _variant(tmp_path, "N_wide_0917", base)
    _variant(tmp_path, "N_p80_0917", base + noise(96, 60) * 0.1)
    _variant(tmp_path, "N_buy_0917", -base + noise(97, 60) * 0.5)
    _variant(tmp_path, "S_dir_0917", noise(98, 60))
    return tmp_path


def run(*args: str):
    return CliRunner().invoke(cli.app, ["rotation", *args])


def test_corr_defaults_to_the_0917_slot_and_writes_json_and_csv(populated):
    j, s = populated / "c.json", populated / "c.csv"
    out = run("corr", "--json", str(j), "--csv", str(s), "--matrix", "spearman")
    assert out.exit_code == 0, out.output
    for name in ("N_wide_0917", "N_p80_0917", "N_buy_0917", "S_dir_0917"):
        assert name in out.output
    data = json.loads(j.read_text())
    assert data["names"] == ["N_buy_0917", "N_p80_0917", "N_wide_0917", "S_dir_0917"]
    assert data["n_days"] == 60 and data["pearson"][1][2] > 0.9 and data["pearson"][0][2] < -0.5
    assert s.read_text().splitlines()[0] == ",N_buy_0917,N_p80_0917,N_wide_0917,S_dir_0917"


def test_corr_refuses_politely(populated):
    assert run("corr", "N_wide_0917").exit_code == 2  # one strategy
    bad = run("corr", "slot:1500")
    assert bad.exit_code == 2 and "matches nothing" in bad.output
    few = run("corr", "all", "--from", "2025-03-01")
    assert few.exit_code == 2 and "days in common" in few.output
    assert run("corr", "--matrix", "bogus").exit_code != 0


def test_corr_list_prints_everything_stored(populated):
    out = run("corr-list")
    assert out.exit_code == 0 and "4 strategies" in out.output and "60 days" in out.output


def test_corr_pick_prints_a_basket_and_what_the_cap_cost(populated):
    j = populated / "p.json"
    out = run(
        "corr-pick", "--k", "2", "--max-corr", "0.5", "--require", "N_wide_0917", "--json", str(j)
    )
    assert out.exit_code == 0, out.output
    assert "In-sample" in out.output and "no cap" in out.output
    picked = json.loads(j.read_text())
    assert picked["names"][0] == "N_wide_0917" and "N_p80_0917" not in picked["names"]
    assert run("corr-pick", "--require", "S_wide_1017").exit_code == 2
