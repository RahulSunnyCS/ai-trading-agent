"""BL-185: the registered grid is what Phase 0 says, and the overlay / selection / charge helpers
behave (pure functions of arrays; the engine-level parity runs are research/common/two_session/parity*.py)."""

from __future__ import annotations

import importlib.util
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[2] / "research" / "common" / "two_session"
REGISTERED_SHA = "675f5b0b6b174478"  # recorded in backlog/BL-185 Phase 0


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"two_session_{name}", HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


grid = _load("grid")
overlay = _load("overlay")
select_ = _load("select")  # not `select`: that is the stdlib module's name


def test_registered_grid_counts_and_sha():
    assert [len(grid.cells(c)) for c in ("W", "D")] == [360, 360]
    assert len(grid.SLOTS) == 20 and len(grid.SLOTS_AM) == 11 and len(grid.SLOTS_PM) == 9
    assert len(grid.parts()) == 80
    assert sum(len(grid.cells(c)) for c in grid.AXES) * len(grid.SLOTS) == 14_400
    assert grid.sha() == REGISTERED_SHA


def test_every_cell_validates_through_the_legwise_schema():
    from option_backtesting.legwise.schema import LegwiseStrategy

    for u in grid.UNDERLYINGS:
        for co in grid.AXES:
            for c in grid.cells(co):
                for slot in ("0917", "1302"):
                    LegwiseStrategy.model_validate(c.strategy(u, slot))


def _path(values: dict[int, float], last: float = 0.0) -> np.ndarray:
    p = np.full(375, last, dtype=float)
    for m, v in values.items():
        p[m:] = v
    return p


def test_first_trigger_stop_target_and_exit_minute():
    # entry 09:17 = minute 2; exit 15:28 = minute 373, so rules run over minutes 2..372
    p = _path({10: -300.0, 20: -700.0, 30: 900.0})
    assert overlay.first_trigger(p, 2, 372, stop=500.0) == 20
    assert overlay.first_trigger(p, 2, 372, target=800.0) == 30
    assert overlay.first_trigger(p, 2, 372, stop=500.0, target=800.0) == 20
    assert overlay.first_trigger(p, 2, 372) == overlay.NO_TRIGGER
    g, end, fired = overlay.apply(p, "09:17", "15:28", stop=500.0)
    assert (g, end, fired) == (-700.0, 20, True)
    g, end, fired = overlay.apply(p, "09:17", "12:00")  # no rule: the value at exit - 1
    assert (g, end, fired) == (900.0, 12 * 60 - (9 * 60 + 15) - 1, False)


def test_lock_and_lock_trail_follow_the_portfolio_rule():
    from option_backtesting.rotation.portfolio import apply_book, member_from_curve, parse_trail

    rng = np.random.default_rng(7)
    for _ in range(30):
        p = np.cumsum(rng.normal(0, 150, 375))
        p[373:] = p[372]  # nothing happens after the exit bar
        m = member_from_curve("x", 1, [(i, float(v)) for i, v in enumerate(p)], float(p[372]))
        for kind, rules, text in (
            ("lock", {"lock": (2000.0, 1000.0)}, "lock:2000,1000"),
            ("trail", {"locktrail": (3000.0, 1.0, 100.0)}, "locktrail:3000,1,100,100"),
        ):
            want = apply_book([m], None, parse_trail(text)).gross_with
            got, _, _ = overlay.apply(p, "09:17", "15:28", **rules)
            assert abs(got - want) < 1e-6, (kind, got, want)


def test_adjacency_keeps_chains_apart():
    lo, hi = select_.adjacency(5, ((0, 1, 2), (3, 4)))
    assert lo.tolist() == [-1, 0, 1, -1, 3]
    assert hi.tolist() == [1, 2, -1, 4, -1]


def test_strike_chain_separates_the_ladder_from_the_premiums():
    chains = tuple(tuple(grid.STRIKES.index(x) for x in ch) for ch in grid.CHAINS["strike"])
    lo, hi = select_.adjacency(len(grid.STRIKES), chains)
    assert hi[grid.STRIKES.index("OTM3")] == -1  # OTM3 is not next to the first premium level
    assert lo[grid.STRIKES.index("PLOW")] == -1


def test_charge_vec_equals_day_charges_on_a_closed_day():
    from option_backtesting.ruletest.charges import day_charges

    sb = sys.modules["two_session_select"].sb
    ev = np.full((1, 8, 6), np.nan, dtype=np.float32)
    # entry_min, exit_min, side (+1 sold), qty, entry price, exit price
    ev[0, 0] = [2, 100, 1, 75, 100.0, 150.0]
    ev[0, 1] = [2, 373, 1, 75, 90.0, 60.0]
    end = np.array([373])
    charges, orders = sb.charge_vec(ev, end, end, "NIFTY", np.array([0.0015]))
    sell = 75 * (100.0 + 90.0)
    buy = 75 * (150.0 + 60.0)
    want = day_charges("NIFTY", date(2026, 5, 4).isoformat(), 4, buy, sell).total
    assert orders[0] == 4
    assert abs(float(charges[0]) - want) < 0.05
