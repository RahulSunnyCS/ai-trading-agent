"""BL-010 Phase 6 step 2: the one-shot 2012-2016 backcast of the frozen ensemble, exactly as
criteria addendum 5 fixes it. Writes `backcast.json` / `backcast.md` once and refuses to run
again; a dry run on an already-seen window (`window=`) exercises the same code without
reading the hold-out.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd

from . import choose, criteria, metrics, reference_benchmarks
from .engine import CASH

HOLDOUT = ("2012-01-01", "2016-12-31")
MEASURED = ("2012-01-06", "2016-12-30")
BENCHMARKS = ("Nifty 500 TRI", "Nifty Midcap 150 TRI")
REPORTED = ("Nifty200 Momentum 30 TRI", "Nifty Smallcap 250 TRI")
OUTER_BENCHMARK = "Nifty 50"


def patched_outer_prices(
    outer: pd.DataFrame, cash: pd.Series, nifty50_tri: pd.Series
) -> pd.DataFrame:
    """Addendum 5's two data patches: the weekly table's cash column takes the stock layer's
    cash series before the table starts (2016), and its 'Nifty 50' column (the run's own
    benchmark line, never used for judging) takes Nifty 50 TRI for every week."""
    first = outer.index[0]
    earlier = cash.index[cash.index < first]
    out = outer.reindex(earlier.union(outer.index))
    out.loc[earlier, CASH] = cash.loc[earlier].to_numpy()
    out[OUTER_BENCHMARK] = nifty50_tri.reindex(out.index).ffill()
    return out


def _stats(curve: pd.Series) -> dict[str, float]:
    depth, _, _ = metrics.max_drawdown(curve)
    return {"cagr": float(metrics.cagr(curve)), "mdd": float(depth)}


def judge(ensemble: pd.Series, refs: pd.DataFrame) -> dict:
    """Addendum 5's pass rule against each benchmark, plus the reported-only lines."""
    spec = criteria.load()["phase_6_holdout"]["backcast"]
    mine = _stats(ensemble)
    out: dict = {"ensemble": mine, "benchmarks": {}, "reported": {}}
    for name in BENCHMARKS:
        line = reference_benchmarks.aligned(refs[name], ensemble.index)
        theirs = _stats(line)
        out["benchmarks"][name] = {
            **theirs,
            "excess_pts": (mine["cagr"] - theirs["cagr"]) * 100,
            "dd_multiple": mine["mdd"] / theirs["mdd"] if theirs["mdd"] else math.nan,
            "passes": bool(
                mine["cagr"] >= theirs["cagr"] + spec["pass_excess_pts"] / 100
                and mine["mdd"] >= spec["pass_dd_multiple_of_benchmark"] * theirs["mdd"]
            ),
        }
    for name in REPORTED:
        line = reference_benchmarks.aligned(refs[name], ensemble.index)
        out["reported"][name] = _stats(line) if line is not None else None
    out["passes"] = all(b["passes"] for b in out["benchmarks"].values())
    return out


def run(
    frozen_path: Path,
    space_path: Path,
    out: Path,
    *,
    window: tuple[str, str] | None = None,
    echo=print,
) -> dict:
    """Run the four frozen configs on the hold-out (or, for a dry run, on `window`), build the
    ensemble and judge it. The hold-out run writes its result once and never again."""
    from . import api, bias, search
    from .audit import bundle as bundle_mod
    from .audit import replay as rp
    from .audit import studies as st

    dry = window is not None
    start, end = window or HOLDOUT
    out.mkdir(parents=True, exist_ok=True)
    result_path = out / ("dry_run.json" if dry else "backcast.json")
    if not dry and result_path.exists():
        raise RuntimeError(f"{result_path} exists: the backcast runs once (criteria addendum 5)")

    frozen = json.loads(Path(frozen_path).read_text())
    space = search.load_space(space_path)
    runner = bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")
    refs = reference_benchmarks.load_references()
    cash = pd.read_csv(
        api.DATA_DIR / "stocks" / "cash_weekly.csv", index_col="date", parse_dates=True
    )
    runner.common["outer_prices"] = patched_outer_prices(
        runner.common["outer_prices"], cash["close"].dropna(), refs["Nifty 50 TRI"]
    )

    curves, replays, configs = {}, {}, []
    feed = st.load_action_feed(api.DATA_DIR / "stocks" / "raw" / "corporate_actions")
    for cfg in frozen["configs"]:
        heavy = cfg["heavy"]
        light = {**cfg["light"], "rebalance_offset": cfg["rebalance_offset"]}
        echo(f"{cfg['id']}: running {start}..{end} ...")
        base = runner.base(heavy)
        outcome, ranking = runner.run(base, heavy, light, start=start, end=end)
        result = outcome.result
        curves[cfg["id"]] = result.equity
        prices = ranking.prices.ffill()
        prices[CASH] = runner.common["outer_prices"].reindex(prices.index)[CASH]
        bundle = bundle_mod.build_bundle(
            result,
            prices=prices,
            column_to_base_symbol=ranking.column_to_base_symbol,
            events=ranking.events,
            label=cfg["id"],
            run_id=cfg["id"],
            variant="backcast" if not dry else "dry_run",
            params={"heavy": heavy, "light": light},
        )
        market = rp.market_for(bundle)
        # The replay's liquid fund comes from the weekly table (2016 on); give it the same
        # earlier weeks the backtest got (addendum 5's cash patch).
        fund = market.weekly_series.setdefault(rp.LIQUID_FUND, {})
        for day, value in cash["close"].dropna().items():
            fund.setdefault(day.date(), float(value))
        market.weekly_series[rp.LIQUID_FUND] = dict(sorted(fund.items()))
        mine = rp.replay(bundle, market)
        reconciles = all(check.passed for check in rp.compare(bundle, mine))
        scan = st.jump_scan(bundle, market, mine, feed)
        days = st.big_days(bundle, market, mine)
        zeroed: dict = {}
        for row in days:
            zeroed.setdefault(row["symbol"], []).append(
                (pd.Timestamp(row["day"]).date(), row["move"])
            )
        shares = rp.decisions(mine)
        base_replay = rp.replay(bundle, market, rp.Sizing(shares=shares))
        without = (
            rp.replay(bundle, market, rp.Sizing(shares=shares, zeroed=zeroed))
            if zeroed
            else base_replay
        )
        replays[cfg["id"]] = (base_replay.equity, without.equity)
        trades = result.trades
        configs.append(
            {
                "id": cfg["id"],
                **_stats(result.equity),
                "first_trade": str(trades["week"].min().date()) if len(trades) else None,
                "trades": len(trades),
                "replay_reconciles": reconciles,
                "big_days": len(days),
                "cagr_without_big_days": scan["cagr_without_big_days"],
            }
        )
        echo(f"  CAGR {configs[-1]['cagr']:.1%}, max drawdown {configs[-1]['mdd']:.1%}")

    frame = pd.DataFrame(curves).ffill()
    ensemble = choose.ensemble_curve(frame / frame.iloc[0], list(frame.columns))
    verdict = judge(ensemble, refs)

    def _replayed(which: int) -> pd.Series:
        parts = pd.DataFrame({k: pd.Series(v[which]) for k, v in replays.items()}).sort_index()
        parts = parts.ffill()
        parts.index = pd.to_datetime(parts.index)
        return choose.ensemble_curve(parts / parts.iloc[0], list(parts.columns))

    replayed, zeroed_line = _replayed(0), _replayed(1)
    report = {
        "dry_run": dry,
        "window": [start, end],
        "measured": [str(ensemble.index[0].date()), str(ensemble.index[-1].date())],
        "frozen": str(frozen_path),
        "code_commit": _commit(),
        "data_snapshot": search.data_snapshot(through=end),
        "configs": configs,
        "verdict": verdict,
        "jump_scan": {
            "ensemble_cagr_replayed": float(metrics.cagr(replayed)),
            "ensemble_cagr_big_days_zeroed": float(metrics.cagr(zeroed_line)),
        },
        "pickable_names_by_year": _pickable(start, end),
    }
    result_path.write_text(json.dumps(report, indent=1, default=str))
    (out / result_path.with_suffix(".md").name).write_text(markdown(report))
    echo(f"wrote {result_path}")
    return report


def _commit() -> str:
    import subprocess

    done = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
        cwd=Path(__file__).parent,
    )
    return done.stdout.strip()


def _pickable(start: str, end: str) -> dict[str, int]:
    """Point-in-time members that carry a curated tag, per year (before the liquidity gate)."""
    from . import api
    from .categories import broad, liquidity

    tagged = set().union(*broad.load_stock_groups(api.CATEGORIES_CURATED_DIR).values())
    members = liquidity.turnover_rank_members_by_year()
    years = range(int(start[:4]), int(end[:4]) + 1)
    return {str(y): len(set(members.get(y, ())) & tagged) for y in years}


def _pct(x) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.1%}"


def markdown(report: dict) -> str:
    v = report["verdict"]
    title = "Dry run (already-seen window)" if report["dry_run"] else "One-shot 2012-2016 backcast"
    lines = [
        f"# BL-010 Phase 6: {title}",
        "",
        f"Window {report['window'][0]} to {report['window'][1]}; measured "
        f"{report['measured'][0]} to {report['measured'][1]}. The four frozen configs, equal "
        "capital reset each April, pre-tax, Rs 2 lakh each, as criteria addendum 5 fixes.",
        "",
        "| | CAGR | Max drawdown | Excess (pts) | Drawdown multiple | Verdict |",
        "|---|---|---|---|---|---|",
        f"| **Ensemble** | {_pct(v['ensemble']['cagr'])} | {_pct(v['ensemble']['mdd'])} | | | "
        f"**{'passes' if v['passes'] else 'fails'}** |",
    ]
    for name, b in v["benchmarks"].items():
        lines.append(
            f"| {name} | {_pct(b['cagr'])} | {_pct(b['mdd'])} | {b['excess_pts']:+.1f} | "
            f"{b['dd_multiple']:.2f} | {'passes' if b['passes'] else 'fails'} |"
        )
    for name, r in v["reported"].items():
        if r:
            lines.append(f"| {name} (reported) | {_pct(r['cagr'])} | {_pct(r['mdd'])} | | | |")
    lines += [
        "",
        "Pass: against each benchmark, CAGR at least 5 points higher and max drawdown no deeper "
        "than 1.5x its own.",
        "",
        "| Config | CAGR | Max drawdown | First trade | Trades | Replay reconciles | Big days "
        "| CAGR without them |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for c in report["configs"]:
        lines.append(
            f"| `{c['id']}` | {_pct(c['cagr'])} | {_pct(c['mdd'])} | {c['first_trade']} | "
            f"{c['trades']} | {c['replay_reconciles']} | {c['big_days']} | "
            f"{_pct(c['cagr_without_big_days'])} |"
        )
    j = report["jump_scan"]
    lines += [
        "",
        f"Jump scan (reported): ensemble {_pct(j['ensemble_cagr_replayed'])} replayed from raw "
        f"data, {_pct(j['ensemble_cagr_big_days_zeroed'])} with unexplained >20% days set to zero.",
        "",
        "Pickable names (point-in-time members with a curated tag, before the liquidity gate): "
        + ", ".join(f"{y}: {n}" for y, n in report["pickable_names_by_year"].items())
        + ".",
    ]
    return "\n".join(lines) + "\n"
