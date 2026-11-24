"""The journal score computes each ranking once: favourites that share one are visited together."""

from __future__ import annotations

import json
from types import SimpleNamespace

from momentum_backtesting import forward_journal as journal
from momentum_backtesting import forward_run


def _request(settings: dict) -> SimpleNamespace:
    return SimpleNamespace(
        lookbacks=settings["lookbacks"],
        weights=None,
        score="momentum",
        voladj_skip_recent_month=False,
        broad_pool_top_n=100,
        broad_pool_exit_rank=150,
        broad_universe="turnover_rank",
        broad_series_breaks=False,
        voladj_lookbacks=None,
        voladj_skip=None,
        broad_liq_circuit=False,
        broad_liq_circuit_run=3,
        broad_liq_max_circuit_days=10,
    )


def _row(config_id: str, week: str, settings: dict) -> dict:
    return {
        "config_id": config_id,
        "run_kind": "final",
        "week": week,
        "source": "run",
        "rows": [{"week": week, "run_kind": "final", "config_id": config_id}],
        "scored": {"settings": json.dumps(settings)},
    }


def test_warm_visits_each_distinct_settings_once_and_one_ranking_at_a_time(monkeypatch):
    a1 = {"dataset": "broad", "lookbacks": [3, 6], "top": 1}
    a2 = {"dataset": "broad", "lookbacks": [3, 6], "top": 2}
    b1 = {"dataset": "broad", "lookbacks": [1, 12], "top": 1}
    # One week at a time, as `score` walks them: a1, b1, a2 each week.
    slots = {}
    for week in ("2026-10-16", "2026-10-23", "2026-10-30"):
        for cid, settings in (("a1", a1), ("b1", b1), ("a2", a2)):
            slots[(cid, "final", week)] = _row(cid, week, settings)
    monkeypatch.setattr(forward_run.fs, "select", lambda _rows: slots)

    visited: list[str] = []
    forward_run._warm(
        [],
        None,
        _request,
        lambda s: visited.append(f"prices {s['lookbacks']} {s['top']}"),
        lambda s: visited.append(f"run {s['lookbacks']} {s['top']}"),
    )

    assert len(visited) == 6  # three distinct settings, each priced and run once
    rankings = [v.split(" ", 1)[1].rsplit(" ", 1)[0] for v in visited]
    # [1, 12] and [3, 6] each appear as one contiguous block, never interleaved
    assert rankings == sorted(rankings, key=lambda r: rankings.index(r))
    assert journal.canonical(a1) != journal.canonical(a2)


def test_warm_skips_other_datasets_unscored_slots_and_unfollowed_configs(monkeypatch):
    broad = {"dataset": "broad", "lookbacks": [3, 6]}
    slots = {
        ("keep", "final", "2026-10-16"): _row("keep", "2026-10-16", broad),
        ("other", "final", "2026-10-16"): _row("other", "2026-10-16", broad),
        ("etf", "final", "2026-10-16"): _row("etf", "2026-10-16", {"dataset": "etf"}),
        ("open", "final", "2026-10-23"): {**_row("open", "2026-10-23", broad), "scored": None},
    }
    monkeypatch.setattr(forward_run.fs, "select", lambda _rows: slots)
    seen: list[str] = []
    forward_run._warm([], {"keep", "etf", "open"}, _request, seen.append, seen.append)
    assert len(seen) == 2  # "keep" only: priced and run once; "etf", "open", "other" skipped
