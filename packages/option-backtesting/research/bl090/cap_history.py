"""BL-090 Phase 3 on the research history: does a trailing-correlation cap in `score.select` cut
the lists' drawdown by more than it cuts their P&L?

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl090/cap_history.py \
        [--research-dir DIR] [--check-only]

Registered in backlog/BL-090-strategy-correlation-and-diverse-baskets.md (Phase 3, Phase 0 block,
commit ed3616f3) with the red-team and mechanical clarifications logged on 2026-10-28 before this
ran. Caps 0.5 / 0.6 / 0.7 (trailing 63-day Pearson of daily net P&L) and off, x lists A / B / C /
REF, x BL-075's three periods. Read-only on TRADING_DATA_ROOT: every stored row after 2026-10-08 is
dropped while reading (the forward journal from 2026-10-12 is the hold-out).

The ranking is the journal's (`rotation/score.py`); the cap's correlation is
`analytics/correlation.analyse(start = day i-63, end = day i-1)`, with Phase 2's `pick_diverse` rule
(an equal or incomputable correlation blocks). Before any cap is scored, the uncapped replay must
reproduce rotate.py's recorded picks and BL-075's gross and drawdown; any difference exits 1.

`--research-dir` is where the git-ignored research outputs live (P3's per-variant results in
bl071/results, rotate.py's picks in bl057, BL-075's run reports in bl075/out/runs); default this
package's research/. The result is written once to phase3_history_2026-10-28.json beside this
script (refused if it exists); per-day rows go to out/ (git-ignored).
"""

from __future__ import annotations

import csv
import json
import math
import sys
from datetime import date
from pathlib import Path

import duckdb
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "common"))
import rotparse  # noqa: E402
import varlib  # noqa: E402

from option_backtesting.analytics.correlation import Series, analyse, matrix_of  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import (  # noqa: E402
    LISTS,
    LOTS_PER,
    MIN_WIDE_N,
    N_CORE,
    WARMUP,
)
from option_backtesting.rotation.score import (  # noqa: E402
    composite,
    dte_label,
    dte_matrix,
    family_index,
    select,
    vix_band,
)
from option_backtesting.rotation.variants import (  # noqa: E402
    is_buy,
    is_dir,
    is_wide,
    variant_names,
)

RESULT = HERE / "phase3_history_2026-10-28.json"
OUT = HERE / "out"
CUT = date(2026, 10, 8)  # BL-075's P1 end; nothing later is read
HOLDOUT_FROM = date(2026, 10, 12)
WINDOW = 63  # trailing trading days of the correlation (registered)
CAPS: tuple[float | None, ...] = (None, 0.5, 0.6, 0.7)
LIST_KEYS = ("A", "B", "C", "REF")
DD_CUT = 0.10  # max drawdown lower by at least 10% of the uncapped
NET_GIVE = 0.05  # net P&L no more than 5% lower
PERIODS_NEEDED = 2
PERIODS = {
    "P1": (date(2025, 9, 1), date(2026, 10, 8), False),
    "P2": (date(2024, 10, 9), date(2025, 8, 29), False),
    "P3": (date(2022, 1, 3), date(2024, 10, 8), True),  # NIFTY only (SENSEX options start 2024-10)
}
# rotate.py's picks files the BL-075 runs left (DRB-6W3L2, 248 variants), per period and list
_PICKS = "daily_picks_min3_core6_buy2L2_whole_day"
_FIT = "fitlb5x30_21x25_63x25_126x20_fband"
PICKS_FILES = {
    ("P1", "A"): f"{_PICKS}_w5_34_33_23_0_5_{_FIT}.csv",
    ("P1", "B"): f"{_PICKS}_w0_36_35_24_0_5_{_FIT}.csv",
    ("P1", "C"): f"{_PICKS}_w15_30_30_20_0_5_{_FIT}.csv",
    ("P1", "REF"): f"{_PICKS}.csv",
    ("P2", "REF"): f"{_PICKS}_w33_25_25_17_from2024-10-09_to2025-08-29.csv",
    ("P3", "REF"): f"{_PICKS}_w33_25_25_17_from2022-01-03_nifty_early_to2024-10-08.csv",
}
# BL-075 stage-1 cells that are lists A / B / C (their printed reports, gross and max drawdown)
BL075_CELLS = {"A": "o5_f5_baseline", "B": "o0_f5_baseline", "C": "o15_f5_baseline"}


def arg(name: str, default: str) -> str:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def read_net_until(path: Path, lo: date, hi: date) -> dict[date, float]:
    """A variant's net P&L for lo..hi; rows outside are skipped while reading, never kept."""
    out: dict[date, float] = {}
    with path.open() as f:
        for r in csv.DictReader(f):
            d = date.fromisoformat(r["day"])
            if d > CUT:
                continue
            if lo <= d <= hi:
                out[d] = float(r["net"])
    return out


def lake_attrs(root: Path, days: list[date]) -> dict[date, dict[str, str]]:
    """weekday / VIX band / NIFTY days to expiry for P3 days, as rotate.py's `lake_features`: the
    first INDIAVIX bar at or after 09:15, the nearest NIFTY expiry with bars that day, calendar days."""
    lake_root = root / "lake" / "bars_1m"
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    vix = dict(
        con.execute(
            f"""select date, arg_min(open, ts) filter (where hour(ts) * 60 + minute(ts) >= 555)
                from read_parquet('{lake_root}/asset=index/symbol=INDIAVIX/**/*.parquet',
                                  hive_partitioning=true)
                where date between '{days[0]}' and '{days[-1]}' group by date"""
        ).fetchall()
    )
    exp = dict(
        con.execute(
            f"""select date, min(expiry) from (
                  select distinct date, expiry
                  from read_parquet('{lake_root}/asset=option/underlying=NIFTY/**/*.parquet',
                                    hive_partitioning=true)
                  where date between '{days[0]}' and '{days[-1]}') t
                where expiry >= date group by date"""
        ).fetchall()
    )
    out = {}
    for d in days:
        e = exp.get(d)
        v = vix.get(d)
        out[d] = {
            "weekday": d.strftime("%a"),
            "vix_band": vix_band(None if v is None else float(v)),
            "dte_n": dte_label(None if e is None else (e - d).days),
        }
        out[d]["dte_s"] = out[d]["dte_n"]  # unused: every P3 variant is NIFTY
    return out


def load_period(key: str, root: Path, research: Path) -> dict:
    lo, hi, nifty_only = PERIODS[key]
    assert hi <= CUT < HOLDOUT_FROM
    names = [n for n in variant_names() if "_ditm1_" not in n]
    assert len(names) == 248, len(names)
    if nifty_only:
        names = [n for n in names if n.startswith("N_")]
        early = research / "bl071" / "results"
        series = [
            read_net_until(early / f"{varlib.variant_file(n, 'variants').stem}.csv", lo, hi)
            for n in names
        ]
    else:
        series = [read_net_until(store.result_path(n, root), lo, hi) for n in names]
    common = set(series[0])
    for s in series[1:]:
        common &= set(s)
    days = sorted(d for d in common if d.weekday() < 5)
    if nifty_only:
        attrs = lake_attrs(root, days)
    else:
        stored = store.read_days(root, basis="calendar")  # rotate.py's calendar-day DTE labels
        attrs = {d: stored[d] for d in days if d in stored}
        days = [d for d in days if d in attrs]
    assert days and max(days) <= CUT, "a day after the cut was loaded"
    values = np.array([[s[d] for s in series] for d in days], dtype=float)
    return {
        "key": key,
        "names": names,
        "days": days,
        "P": values,
        "wd": np.array([attrs[d]["weekday"] for d in days]),
        "vb": np.array([attrs[d]["vix_band"] for d in days]),
        "dte": dte_matrix(
            np.array([attrs[d]["dte_n"] for d in days]),
            np.array([attrs[d]["dte_s"] for d in days]),
            names,
        ),
        "fam": family_index(names),
    }


def select_capped(
    comp: np.ndarray, names: list[str], corr: np.ndarray, ci: dict[str, int], cap: float
) -> tuple[list[int], list[int], dict]:
    """`score.select` with the cap: non-Buy variants in composite order, each kept only when its
    correlation with every kept pick is below `cap` (equal or NaN blocks: `pick_diverse`'s rule);
    then the Widesl minimum, the added Widesl also under the cap. Short, never padded. The Buy
    add-on is `select`'s, uncapped."""
    order = sorted(
        (v for v in range(len(names)) if not is_buy(names[v])), key=lambda v: (-comp[v], names[v])
    )
    info = {"nan_block": False, "short": False}

    def fits(v: int, kept: list[int]) -> bool:
        for o in kept:
            c = corr[ci[names[v]], ci[names[o]]]
            if math.isnan(c):
                info["nan_block"] = True
                return False
            if c >= cap:
                return False
        return True

    core: list[int] = []
    for v in order:
        if len(core) == N_CORE:
            break
        if fits(v, core):
            core.append(v)
    n_wide = sum(is_wide(names[v]) for v in core)
    while n_wide < MIN_WIDE_N:
        dirs = [v for v in core if is_dir(names[v])]
        if not dirs:
            break
        core.remove(min(dirs, key=lambda v: (comp[v], names[v])))
        add = next(
            (v for v in order if is_wide(names[v]) and v not in core and fits(v, core)), None
        )
        if add is None:
            break
        core.append(add)
        n_wide += 1
    info["short"] = len(core) < N_CORE or n_wide < MIN_WIDE_N
    buy = [names.index(n) for n in select(comp, names).buy]
    return core, buy, info


def max_dd(daily: list[float]) -> float:
    cum = np.cumsum(np.asarray(daily, dtype=float))
    return float(np.min(cum - np.maximum.accumulate(np.maximum(cum, 0.0))).clip(max=0.0))


def replay(p: dict) -> dict:
    """Every list x cap over the period's selection days. Returns per (list, cap) the daily rows."""
    names, days, P = p["names"], p["days"], p["P"]
    nonbuy = [n for n in names if not is_buy(n)]
    ci = {n: j for j, n in enumerate(nonbuy)}
    col = {n: j for j, n in enumerate(names)}
    series = [
        Series(n, "variant", {d: float(P[t, col[n]]) for t, d in enumerate(days)}) for n in nonbuy
    ]
    rows: dict[tuple[str, float | None], list[dict]] = {(k, c): [] for k in LIST_KEYS for c in CAPS}
    for i in range(WARMUP, len(days)):
        hist = P[: i + 1].copy()
        hist[i] = 0.0  # day i's own P&L is never visible to its ranking
        rep = analyse(
            series, start=days[i - WINDOW], end=days[i - 1], window=WINDOW, min_days=WINDOW
        )
        assert rep.n_days == WINDOW and rep.days[-1] < days[i]
        corr = matrix_of(rep, "pearson")
        for key in LIST_KEYS:
            comp = composite(
                hist,
                p["wd"][: i + 1],
                p["vb"][: i + 1],
                p["dte"][: i + 1],
                names,
                LISTS[key],
                p["fam"],
            )
            base = select(comp, names)
            base_core = [col[n] for n in base.core]
            base_buy = [col[n] for n in base.buy]
            # the capped code with no cap must be `select` itself
            same_core, same_buy, _ = select_capped(comp, names, corr, ci, math.inf)
            assert set(same_core) == set(base_core) and same_buy == base_buy, (key, days[i])
            for cap in CAPS:
                if cap is None:
                    core, buy, info = base_core, base_buy, {"nan_block": False, "short": False}
                else:
                    core, buy, info = select_capped(comp, names, corr, ci, cap)
                pairs = [
                    corr[ci[names[a]], ci[names[b]]]
                    for x, a in enumerate(core)
                    for b in core[x + 1 :]
                ]
                rows[(key, cap)].append(
                    {
                        "day": days[i].isoformat(),
                        "pnl": float(LOTS_PER * (P[i, core].sum() + P[i, buy].sum())),
                        "core": [names[v] for v in core],
                        "buy": [names[v] for v in buy],
                        "changed": set(core) != set(base_core),
                        "short": info["short"],
                        "nan_block": info["nan_block"],
                        "max_pair_corr": float(np.nanmax(pairs))
                        if pairs and not np.all(np.isnan(pairs))
                        else None,
                    }
                )
    return rows


def parity(key: str, rows: dict, research: Path) -> list[dict]:
    """The uncapped replay against rotate.py's recorded picks and BL-075's printed gross / drawdown."""
    checks = []
    for (period, lst), fname in PICKS_FILES.items():
        if period != key:
            continue
        path = research / "bl057" / fname
        if not path.exists():
            raise SystemExit(f"parity: {path} missing (pass --research-dir)")
        want = {}
        with path.open() as f:
            for r in csv.DictReader(f):
                want[r["day"][:10]] = (set(r["core_A"].split(",")), set(r["buy"].split(",")) - {""})
        got = {r["day"]: (set(r["core"]), set(r["buy"])) for r in rows[(lst, None)]}
        bad = [d for d in want if got.get(d) != want[d]]
        checks.append(
            {
                "check": "picks",
                "period": key,
                "list": lst,
                "file": fname,
                "days": len(want),
                "differing": len(bad),
                "first_differing": bad[:3],
                "days_match": set(want) == set(got),
            }
        )
    for lst, cell in BL075_CELLS.items():
        path = research / "bl075" / "out" / "runs" / f"{cell}_{key}.txt"
        if not path.exists():
            raise SystemExit(f"parity: {path} missing (pass --research-dir)")
        rep = rotparse.parse_case_a(path.read_text())
        daily = [r["pnl"] for r in rows[(lst, None)]]
        net, dd = round(sum(daily)), round(max_dd(daily))
        checks.append(
            {
                "check": "bl075_gross_dd",
                "period": key,
                "list": lst,
                "cell": cell,
                "bl075_gross": rep["gross"],
                "replay_gross": net,
                "bl075_max_dd": rep["max_dd"],
                "replay_max_dd": dd,
                "ok": abs(net - rep["gross"]) < 1 and abs(dd - rep["max_dd"]) < 1,
            }
        )
    return checks


def summarise(daily_rows: list[dict]) -> dict:
    pnl = [r["pnl"] for r in daily_rows]
    return {
        "days": len(pnl),
        "net": round(float(sum(pnl)), 2),
        "max_dd": round(max_dd(pnl), 2),
        "worst_day": round(float(min(pnl)), 2),
        "win_rate": round(float(np.mean([x > 0 for x in pnl])), 4),
        "days_changed": sum(r["changed"] for r in daily_rows),
        "short_days": sum(r["short"] for r in daily_rows),
        "nan_block_days": sum(r["nan_block"] for r in daily_rows),
    }


def judge(off: dict, capped: dict) -> dict:
    dd_ok = capped["max_dd"] >= (1 - DD_CUT) * off["max_dd"]  # drawdowns are <= 0
    net_ok = capped["net"] >= off["net"] - NET_GIVE * abs(off["net"])
    return {
        "dd_change": round(capped["max_dd"] / off["max_dd"] - 1, 4) if off["max_dd"] else None,
        "net_change": round(capped["net"] / off["net"] - 1, 4) if off["net"] else None,
        "dd_lower_by_10pct": bool(dd_ok),
        "net_within_5pct": bool(net_ok),
        "meets": bool(dd_ok and net_ok),
    }


def main() -> None:
    root = data_dir()
    research = Path(arg("--research-dir", str(HERE.parent))).resolve()
    if RESULT.exists() and "--check-only" not in sys.argv:
        raise SystemExit(f"{RESULT.name} exists: the result is written once")
    OUT.mkdir(exist_ok=True)
    periods, checks, stats = {}, [], {}
    for key in PERIODS:
        p = load_period(key, root, research)
        rows = replay(p)
        c = parity(key, rows, research)
        checks += c
        lo, hi, nifty_only = PERIODS[key]
        periods[key] = {
            "history_from": lo.isoformat(),
            "history_to": hi.isoformat(),
            "nifty_only": nifty_only,
            "variants": len(p["names"]),
            "rows": len(p["days"]),
            "first_selection": p["days"][WARMUP].isoformat(),
            "selection_days": len(p["days"]) - WARMUP,
        }
        print(f"{key}: {periods[key]}")
        for x in c:
            print("  parity", x)
        if not all(x.get("ok", x.get("differing") == 0 and x.get("days_match")) for x in c):
            raise SystemExit(f"PARITY FAILED in {key}: no cap is scored")
        if "--check-only" in sys.argv:
            continue
        for (lst, cap), daily_rows in rows.items():
            stats[(key, lst, cap)] = summarise(daily_rows)
            (OUT / f"{key}_{lst}_{'off' if cap is None else cap}.json").write_text(
                json.dumps(daily_rows)
            )
    if "--check-only" in sys.argv:
        print("PARITY OK (check only; nothing scored)")
        return
    table, verdicts = [], {}
    for lst in LIST_KEYS:
        for cap in CAPS[1:]:
            met = 0
            for key in PERIODS:
                off, capped = stats[(key, lst, None)], stats[(key, lst, cap)]
                j = judge(off, capped)
                met += j["meets"]
                table.append(
                    {"list": lst, "cap": cap, "period": key, "uncapped": off, "capped": capped, **j}
                )
            verdicts[f"{lst}@{cap}"] = {
                "periods_met": met,
                "verdict": "pass" if met >= PERIODS_NEEDED else "killed",
            }
    passed = [k for k, v in verdicts.items() if v["verdict"] == "pass"]
    result = {
        "item": "BL-090 Phase 3, research history",
        "pre_registration_commit": "ed3616f3",
        "run_on": "2026-10-28",
        "rule": {
            "caps": [c for c in CAPS if c is not None],
            "window_days": WINDOW,
            "measure": "pearson of daily net P&L",
            "pass": "max DD no deeper than 0.9 x uncapped AND net >= uncapped - 5% of |uncapped|, in >= 2 of 3 periods",
            "comparator": "the same list, uncapped (rotation/score.py select)",
            "universe": "248 variants of strategies/rotation/ (no Dir ITM1, no BL-080 extensions); P3 NIFTY 124",
            "lots": f"{N_CORE} strategies x {LOTS_PER} lots + Buy add-on x {LOTS_PER} (uncapped)",
            "costs": "none: variants carry no costs, net = gross, both arms",
        },
        "data": {
            "trading_data_root": str(root),
            "cut": CUT.isoformat(),
            "holdout_from": HOLDOUT_FROM.isoformat(),
            "p1_p2_source": "TRADING_DATA_ROOT/rotation/results + days.csv (calendar-day DTE)",
            "p3_source": "research/bl071/results + lake attributes",
        },
        "periods": periods,
        "parity": checks,
        "table": table,
        "verdicts": verdicts,
        "passed": passed,
        "decision": (
            f"{len(passed)} of 12 cap x list cells pass on the research history: "
            + (
                ", ".join(passed) + "; only these go to the hold-out"
                if passed
                else "none goes to the hold-out"
            )
        ),
    }
    RESULT.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps(verdicts, indent=1))
    print(result["decision"])
    print(f"wrote {RESULT}")


if __name__ == "__main__":
    main()
