"""The 60-day read-out numbers the forward journal registered (BL-058 Phase 0b and its fixed-base
amendment of 2026-10-10). Read-only: nothing here writes to the journal or the results.

For every list (A, B, C, REF), over the forward days whose picks are all scored:

* gross, max drawdown, and ₹ per lot-day (a list holds 2 lots per strategy: 6 lots, or 8 with the
  Buy add-on, so totals are reported beside but never compared across lists);
* the share of 1,000 random same-shape baskets it beats (3 non-Buy strategies with at least 2
  Widesl and the list's own Buy add-on lots, drawn from the 298 variants of that day);
* list minus REF and list minus the fixed base, in ₹ per lot-day, with a two-sided 90% interval
  from a circular 5-day block bootstrap (2,000 resamples, seed 20261012), and the registered pass
  rule against the base: the interval's lower bound above zero AND the max drawdown per lot no
  worse than the base's. No minimum size.

The settings below were fixed before the first entry and are not options.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from . import base as base_mod
from . import journal, store
from .lists import LISTS, LOTS_PER, MIN_WIDE_N
from .variants import is_buy, is_wide, variant_names

N_RUNS = 1000  # random same-shape baskets, as research/bl057/rotate.py
RANDOM_SEED = 57  # the research comparator's seed; combined with the day, see random_day
BOOT_RESAMPLES = 2000
BOOT_BLOCK = 5
BOOT_SEED = 20261012
BOOT_LEVEL = 0.90
MIN_DAYS_FOR_INTERVAL = 10  # below this the interval is shown but flagged as too short to read


def max_drawdown(daily: np.ndarray) -> float:
    """Largest fall of the cumulative series from its running peak, the peak starting at zero
    (the research's `mdd`). Non-positive."""
    eq = np.cumsum(np.asarray(daily, dtype=float))
    if eq.size == 0:
        return 0.0
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0.0))).min())


def block_bootstrap_mean(
    diff: np.ndarray,
    resamples: int = BOOT_RESAMPLES,
    block: int = BOOT_BLOCK,
    seed: int = BOOT_SEED,
    level: float = BOOT_LEVEL,
) -> tuple[float, float, float]:
    """(mean, lower, upper) of a daily difference series: circular moving blocks of `block` days,
    percentile interval. Deterministic for a seed; the same input always gives the same interval."""
    d = np.asarray(diff, dtype=float)
    n = d.size
    if n == 0:
        return (float("nan"),) * 3
    nb = -(-n // block)
    rng = np.random.default_rng(seed)
    starts = rng.integers(0, n, size=(resamples, nb))
    idx = ((starts[:, :, None] + np.arange(block)[None, None, :]) % n).reshape(resamples, -1)[:, :n]
    means = d[idx].mean(axis=1)
    lo, hi = np.percentile(means, [(1 - level) / 2 * 100, (1 + level) / 2 * 100])
    return float(d.mean()), float(lo), float(hi)


def random_day(
    day: date,
    pool: np.ndarray,
    pool_wide: np.ndarray,
    buy_pool: np.ndarray,
    runs: int = N_RUNS,
    min_wide: int = MIN_WIDE_N,
) -> tuple[np.ndarray, np.ndarray]:
    """One day's random same-shape baskets: (core, buy), each `runs` long, of one-lot gross.

    `core` is the sum of 3 distinct non-Buy variants with at least `min_wide` Widesl (redrawn, as
    the research did); `buy` is one random Buy variant, added by a list only on its Buy days. The
    generator is seeded by (RANDOM_SEED, day), so a day's draws do not depend on which other days
    are computed."""
    rng = np.random.default_rng([RANDOM_SEED, day.toordinal()])
    m = pool.size
    core = np.empty(runs)
    todo = np.arange(runs)
    while todo.size:
        keys = rng.random((todo.size, m))
        ix = np.argpartition(keys, 3, axis=1)[:, :3]
        ok = pool_wide[ix].sum(axis=1) >= min_wide
        core[todo[ok]] = pool[ix[ok]].sum(axis=1)
        todo = todo[~ok]
    buy = buy_pool[rng.integers(0, buy_pool.size, size=runs)]
    return core, buy


def _grosses(names: list[str], root: Path) -> dict[str, dict[date, float]]:
    return {n: base_mod.read_column(n, "gross", root) for n in names}


def build(
    root: Path | None = None,
    start: date | None = None,
    end: date | None = None,
    runs: int = N_RUNS,
) -> dict:
    """The read-out over the forward entries (never a late one), as a plain dict."""
    root = root or data_dir()
    names = variant_names()
    entries = [
        e
        for e in journal.read(store.journal_path(root))
        if e.get("before_first_entry", False)
        and (start is None or date.fromisoformat(e["day"]) >= start)
        and (end is None or date.fromisoformat(e["day"]) <= end)
    ]
    late = [
        e["day"]
        for e in journal.read(store.journal_path(root))
        if not e.get("before_first_entry", False)
    ]
    gross = _grosses(names, root)
    base_pl = base_mod.base_per_lot(root, "gross")

    scored: list[dict] = []
    pending: list[str] = []
    for e in entries:
        day = date.fromisoformat(e["day"])
        picks = {k: p["core"] + p["buy"] for k, p in e["lists"].items()}
        lacking = sorted({n for ps in picks.values() for n in ps if day not in gross[n]})
        if lacking:
            why = f"no result yet for {', '.join(lacking[:4])}" + (
                "..." if len(lacking) > 4 else ""
            )
        elif day not in base_pl:
            why = "the base's Dir ATM 09:24 leg is not scored yet (obt rotation base --backfill)"
        else:
            why = ""
        if why:
            pending.append({"day": day, "why": why})
        else:
            scored.append({"day": day, "entry": e, "picks": picks})

    keys = list(LISTS)
    days = [s["day"] for s in scored]
    out: dict = {
        "settings": {
            "lots_per_strategy": LOTS_PER,
            "random_runs": runs,
            "random_seed": RANDOM_SEED,
            "bootstrap_resamples": BOOT_RESAMPLES,
            "bootstrap_block_days": BOOT_BLOCK,
            "bootstrap_seed": BOOT_SEED,
            "interval": BOOT_LEVEL,
            "basis": "gross",
        },
        "n_days": len(days),
        "first_day": days[0].isoformat() if days else None,
        "last_day": days[-1].isoformat() if days else None,
        "pending_days": [p["day"].isoformat() for p in pending],
        "pending_reasons": {p["day"].isoformat(): p["why"] for p in pending},
        "late_entries": late,
        "short": len(days) < MIN_DAYS_FOR_INTERVAL,
        "lists": {},
        "base": None,
    }
    if not days:
        return out

    pool_ix = np.array([i for i, n in enumerate(names) if not is_buy(n)])
    buy_ix = np.array([i for i, n in enumerate(names) if is_buy(n)])
    wide_mask = np.array([is_wide(n) for n in names])

    per_lot: dict[str, np.ndarray] = {}
    total: dict[str, np.ndarray] = {}
    lots: dict[str, np.ndarray] = {}
    for k in keys:
        pl, tt, ll = [], [], []
        for s in scored:
            ps = s["picks"][k]
            g = sum(gross[n][s["day"]] for n in ps)
            pl.append(g / len(ps))
            tt.append(LOTS_PER * g)
            ll.append(LOTS_PER * len(ps))
        per_lot[k], total[k], lots[k] = np.array(pl), np.array(tt), np.array(ll, dtype=float)

    base_series = np.array([base_pl[d] for d in days])
    base_dd = max_drawdown(base_series)
    out["base"] = {
        "definition": "2 x NIFTY Widesl OTM1 09:17 + 1 x NIFTY Dir ATM 09:24, 2 lots each",
        "per_lot_day": float(base_series.mean()),
        "cumulative_per_lot": float(base_series.sum()),
        "max_drawdown_per_lot": base_dd,
        "lots_per_day": LOTS_PER * base_mod.BASE_LOTS,
        # the base at the same 2 lots per strategy, so its cumulative is comparable to a list's
        "total": float(LOTS_PER * base_mod.BASE_LOTS * base_series.sum()),
        "max_drawdown": max_drawdown(LOTS_PER * base_mod.BASE_LOTS * base_series),
    }

    # random same-shape baskets, one set of core draws per day shared by every list
    rand_total = {k: np.zeros(runs) for k in keys}
    rand_cum = {k: np.zeros((len(scored), runs)) for k in keys}  # cumulative per run, day by day
    rand_day_pct = {k: [] for k in keys}
    for j, s in enumerate(scored):
        day = s["day"]
        g_all = np.array([gross[n].get(day, np.nan) for n in names])
        pool = g_all[pool_ix]
        ok = ~np.isnan(pool)
        bpool = g_all[buy_ix]
        bpool = bpool[~np.isnan(bpool)]
        core, buy = random_day(day, pool[ok], wide_mask[pool_ix][ok], bpool, runs=runs)
        for k in keys:
            has_buy = bool(s["entry"]["lists"][k]["buy"])
            r = LOTS_PER * (core + (buy if has_buy else 0.0))
            rand_total[k] += r
            rand_cum[k][j] = rand_total[k]
            rand_day_pct[k].append(float((r < total[k][j]).mean()))

    ref = per_lot["REF"]
    for k in keys:
        t = float(total[k].sum())
        r = rand_total[k]
        vs_base = block_bootstrap_mean(per_lot[k] - base_series)
        vs_ref = block_bootstrap_mean(per_lot[k] - ref) if k != "REF" else None
        dd_lot = max_drawdown(per_lot[k])
        out["lists"][k] = {
            "total": t,
            "mean_day": float(total[k].mean()),
            "per_lot_day": float(per_lot[k].mean()),
            "lots_per_day": float(lots[k].mean()),
            "max_drawdown": max_drawdown(total[k]),
            "max_drawdown_per_lot": dd_lot,
            "beats_random_pct": float((r < t).mean() * 100),
            "random": {
                "p10": float(np.percentile(r, 10)),
                "p50": float(np.percentile(r, 50)),
                "p90": float(np.percentile(r, 90)),
                "max": float(r.max()),
            },
            "mean_daily_random_percentile": float(np.mean(rand_day_pct[k]) * 100),
            "random_path": {
                f"p{q}": np.percentile(rand_cum[k], q, axis=1).round(2).tolist()
                for q in (10, 50, 90)
            },
            "vs_base": {
                "mean": vs_base[0],
                "lower": vs_base[1],
                "upper": vs_base[2],
                "drawdown_no_worse": bool(dd_lot >= base_dd),
                "beats_base": bool(vs_base[1] > 0 and dd_lot >= base_dd),
            },
            "vs_ref": (
                None
                if vs_ref is None
                else {"mean": vs_ref[0], "lower": vs_ref[1], "upper": vs_ref[2]}
            ),
        }
    out["days"] = [
        {
            "day": d.isoformat(),
            "base": float(base_series[j]),
            "base_total": float(LOTS_PER * base_mod.BASE_LOTS * base_series[j]),
            **{k: float(per_lot[k][j]) for k in keys},
            **{f"{k}_total": float(total[k][j]) for k in keys},
            **{f"{k}_random_pct": rand_day_pct[k][j] * 100 for k in keys},
        }
        for j, d in enumerate(days)
    ]
    return out


def render(r: dict) -> str:
    """The read-out as text for `obt rotation readout`."""
    if not r["n_days"]:
        lines = ["no scored forward days yet"]
        for day, why in r["pending_reasons"].items():
            lines.append(f"waiting: {day}: {why}")
        return "\n".join(lines)
    s = r["settings"]
    lines = [
        f"Forward read-out, {r['n_days']} scored days {r['first_day']} .. {r['last_day']} "
        f"({s['basis']}, {s['lots_per_strategy']} lots per strategy)",
    ]
    if r["short"]:
        lines.append(
            f"  fewer than {MIN_DAYS_FOR_INTERVAL} days: intervals are shown but not readable yet"
        )
    b = r["base"]
    lines.append(
        f"  base ({b['definition']}): ₹{b['per_lot_day']:,.0f} per lot-day, "
        f"cumulative per lot ₹{b['cumulative_per_lot']:,.0f}, max DD per lot "
        f"₹{b['max_drawdown_per_lot']:,.0f}"
    )
    lines.append(
        f"  {'list':4s} {'total':>10s} {'₹/lot-day':>10s} {'maxDD':>9s} {'beats rand':>10s} "
        f"{'vs REF ₹/lot-day [90%]':>30s} {'vs base ₹/lot-day [90%]':>30s}  base?"
    )
    for k, v in r["lists"].items():
        if v["vs_ref"]:
            vr = v["vs_ref"]
            ref = f"{vr['mean']:+8,.0f} [{vr['lower']:+7,.0f}, {vr['upper']:+7,.0f}]"
        else:
            ref = "(comparator)"
        vb = v["vs_base"]
        lines.append(
            f"  {k:4s} {v['total']:>10,.0f} {v['per_lot_day']:>10,.0f} {v['max_drawdown']:>9,.0f} "
            f"{v['beats_random_pct']:>9.0f}% {ref:>30s} "
            f"{vb['mean']:+8,.0f} [{vb['lower']:+7,.0f}, {vb['upper']:+7,.0f}]  "
            f"{'YES' if vb['beats_base'] else 'no'}"
            f"{'' if vb['drawdown_no_worse'] else ' (drawdown worse)'}"
        )
    for day, why in r["pending_reasons"].items():
        lines.append(f"  waiting: {day}: {why}")
    if r["late_entries"]:
        lines.append(f"  late entries excluded: {', '.join(r['late_entries'])}")
    return "\n".join(lines)
