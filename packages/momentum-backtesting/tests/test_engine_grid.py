"""engine._Grid and the position-based lookups in `_Sim` (BL-005 Phase 3).

The engine reads one cell at a time from week x instrument tables. Those reads now go through
`_Grid` (an array and two dicts) instead of `DataFrame.at`, and `top_names` finds the end of the
top-N prefix of a sorted list instead of looking every name up. Neither may move a result, so
these pin them against the original implementation on random tables full of ties, missing
values and every gate."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import CASH, Config, _Grid, _Sim

NAMES = [f"S{i}" for i in range(14)]
WEEKS = pd.date_range("2024-01-05", periods=6, freq="W-FRI")


def reference_top_names(sim: _Sim, week, held) -> list[str]:
    """`_Sim.top_names` exactly as it was before BL-005 Phase 3, on the DataFrames."""
    ranks = sim.ranks.loc[week].dropna().sort_values()
    names = [n for n in ranks.index if ranks[n] <= sim.config.top_n and sim.passes_filter(n, week)]
    if sim.membership is not None:
        names = [
            n for n in names if n not in sim.membership.columns or bool(sim.membership.at[week, n])
        ]
    gates = [g for g in (sim.no_buy, sim.uc_locked) if g is not None]
    if not gates:
        return names

    def blocked(n):
        return any(n in g.columns and bool(g.at[week, n]) for g in gates)

    def unbuyable(n):
        locked = sim.uc_locked
        return locked is not None and n in locked.columns and bool(locked.at[week, n])

    out = [n for n in names if n in held or not blocked(n)]
    if len(out) >= sim.config.top_n:
        return [n for n in out if not unbuyable(n)]
    for n in ranks.index:
        if len(out) >= sim.config.top_n:
            break
        if n in out or blocked(n) or not sim.passes_filter(n, week):
            continue
        if (
            sim.membership is not None
            and n in sim.membership.columns
            and not bool(sim.membership.at[week, n])
        ):
            continue
        if ranks[n] > sim.config.exit_rank:
            break
        out.append(n)
    return [n for n in out if not unbuyable(n)]


def random_sim(seed: int, *, defensive: str, gates: bool) -> _Sim:
    rng = np.random.default_rng(seed)
    columns = [*NAMES, CASH]
    # integer ranks with plenty of ties, and some missing
    ranks = pd.DataFrame(
        rng.integers(1, 12, size=(len(WEEKS), len(NAMES))).astype(float), WEEKS, NAMES
    )
    ranks = ranks.mask(rng.random(ranks.shape) < 0.2)

    def flags(p: float) -> pd.DataFrame:
        """Boolean table over most (not all) of the names: the rest are 'absent from the gate'."""
        return pd.DataFrame(
            rng.random((len(WEEKS), len(NAMES) - 3)) < p, WEEKS, NAMES[: len(NAMES) - 3]
        )

    returns = pd.DataFrame(rng.normal(0, 0.1, (len(WEEKS), len(columns))), WEEKS, columns)
    returns = returns.mask(rng.random(returns.shape) < 0.1)
    return _Sim(
        prices=pd.DataFrame(100 + rng.random((len(WEEKS), len(columns))), WEEKS, columns),
        ranks=ranks,
        filter_ret=returns,
        config=Config(top_n=3, exit_rank=6, defensive=defensive),
        ledger=None,
        tax_classes={},
        membership=flags(0.7) if gates else None,
        no_buy=flags(0.3) if gates else None,
        uc_locked=flags(0.2) if gates else None,
        lc_locked=flags(0.2) if gates else None,
    )


@pytest.mark.parametrize("defensive", ["filter", "ranked"])
@pytest.mark.parametrize("gates", [False, True])
def test_top_names_is_what_it_always_was_on_random_tables(defensive, gates):
    rng = np.random.default_rng(1)
    checked = 0
    for seed in range(60):
        sim = random_sim(seed, defensive=defensive, gates=gates)
        for week in WEEKS:
            for _ in range(3):
                held = {n for n in NAMES if rng.random() < 0.25}
                assert sim.top_names(week, held) == reference_top_names(sim, week, held), (
                    seed,
                    week,
                    held,
                )
                checked += 1
    assert checked == 60 * len(WEEKS) * 3


def test_every_cell_reads_the_same_as_at():
    sim = random_sim(7, defensive="filter", gates=True)
    for week in WEEKS:
        for name in NAMES:
            assert sim.rank(week, name) is not None
            same = sim.ranks.at[week, name]
            got = sim.rank(week, name)
            assert (np.isnan(same) and np.isnan(got)) or same == got
            assert type(got) is type(same)  # the array's scalar, as `.at` gives
            assert sim.price(name, week) == sim.prices.at[week, name]
        for name in NAMES[: len(NAMES) - 3]:
            assert sim.sell_blocked(name, week) == bool(sim.lc_locked.at[week, name])
    assert np.isnan(sim.rank(WEEKS[0], "not-a-column"))  # absent: NaN, as before
    assert not sim.sell_blocked("not-a-column", WEEKS[0])


def test_a_missing_week_or_column_raises_keyerror_like_at():
    grid = _Grid(pd.DataFrame([[1.0]], index=WEEKS[:1], columns=["A"]))
    assert grid.at(WEEKS[0], "A") == 1.0
    with pytest.raises(KeyError):
        grid.at(WEEKS[1], "A")
    with pytest.raises(KeyError):
        grid.at(WEEKS[0], "B")


def test_duplicate_labels_are_refused_rather_than_read_wrongly():
    twice = pd.DataFrame([[1.0, 2.0]], index=WEEKS[:1], columns=["A", "A"])
    with pytest.raises(ValueError):
        _Grid(twice)
