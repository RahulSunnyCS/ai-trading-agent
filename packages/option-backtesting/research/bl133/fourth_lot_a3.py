"""BL-133 Amendment 3: on a one-index expiry day, 3 lots of the expiring index's picks (today's
rule) vs 4 lots of the other index's picks (its Dir at two lots), under the book stop.

As registered in backlog/BL-133 Amendment 3 (descriptive, in-sample). Needs Amendment 2's per-day
rows (`out/fourth_lot_a2_rows_2026-10-28.json`, from `fourth_lot_a2.py`) for the whole-book view.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl133/fourth_lot_a3.py
"""

from __future__ import annotations

import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np
from fourth_lot import BROKERAGE, WINDOWS, read
from fourth_lot_a2 import BOOK_STOP, metrics, mtmsl

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, expiry, pick, portfolio
from option_backtesting.rotation.readout import block_bootstrap_mean
from option_backtesting.rotation.variants import is_dir, track_names, variant_names

HERE = Path(__file__).parent
A2_ROWS = HERE / "out" / "fourth_lot_a2_rows_2026-10-28.json"
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261029, 0.90
ARMS = ("E3", "O3", "O4", "U3")
OTHER = {"NIFTY": "SENSEX", "SENSEX": "NIFTY"}


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(np.asarray(x, dtype=float), RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "mean": m,
        "ci90": [lo, hi],
        "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


def run(root: Path, names: list[str], book: str) -> tuple[dict[str, dict], int]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    stored: dict[str, dict] = {}

    def trades(n: str, d: date) -> int | None:
        if n not in stored:
            stored[n] = read(n, root)
        got = stored[n].get(d)
        return None if got is None else got[1]

    stop0 = BOOK_STOP[book]
    lo0, hi0 = WINDOWS["two_years"]
    rows: dict[str, dict] = {}
    both_expiry = 0
    for d in rec.days_available():
        if not lo0 <= d <= hi0:
            continue
        a = rec.attrs[d]
        if "0" not in (str(a["dte_n"]), str(a["dte_s"])):
            continue
        idx = expiry.expiring_index(a["dte_n"], a["dte_s"])
        if idx is None:
            both_expiry += 1
            continue
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for key, cols, comp, picks in pick._rank(hist, d, daylog._number(a.get("vix_open")), dte):
            if key != "C":
                continue
            other = OTHER[idx]
            exp_core = list(expiry.filter_picks(comp, cols, picks, idx).core)
            oth = expiry.filter_picks(comp, cols, picks, other)
            oth_core = list(oth.core)
            score = {n: float(comp[j]) for j, n in enumerate(cols)}
            dirs = sorted((n for n in oth_core if is_dir(n)), key=lambda n: (-score[n], n))
            if dirs:
                o4, extra = [(m, 2 if m == dirs[0] else 1) for m in oth_core], dirs[0]
            else:
                extra = expiry.filtered_runners_up(comp, cols, oth, other).get("dir")
                o4 = [(m, 1) for m in oth_core] + ([(extra, 1)] if extra else [])
            arms = {
                "E3": ([(m, 1) for m in exp_core], None),
                "O3": ([(m, 1) for m in oth_core], None),
                "O4": (o4, extra),
                "U3": ([(m, 1) for m in picks.core], None),
            }
            try:
                if extra is None:
                    raise portfolio.PortfolioStopError("no Dir of the other index")
                loaded: dict = {}
                need = {m for members, _ in arms.values() for m, _ in members}
                paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in need}
                n_tr = {m: trades(m, d) for m in need}
                if any(v is None for v in n_tr.values()):
                    raise portfolio.PortfolioStopError("a stored result is missing")
            except portfolio.PortfolioStopError as e:
                print(f"  {book} {d}: skipped ({e})")
                continue
            row = {"day": d.isoformat(), "expiring": idx, "arms": {}}
            for k, (members, x) in arms.items():
                bd = portfolio.apply_book(
                    [portfolio.Member(m, lots, paths[m]) for m, lots in members],
                    stop0 + (mtmsl(x) if x else 0.0),
                )
                row["arms"][k] = {
                    "net": bd.gross_with - sum(2 * n_tr[m] * BROKERAGE for m, _ in members),
                    "stop_hit": bd.stop_minute is not None,
                    "lots": sum(lots for _, lots in members),
                    "picks": [m for m, _ in members],
                }
            rows[d.isoformat()] = row
    return rows, both_expiry


def summarise(rows: dict[str, dict], a2: dict[str, dict], both_expiry: int) -> dict:
    out = {}
    for wname, (lo, hi) in WINDOWS.items():
        sub = [r for k, r in sorted(rows.items()) if lo.isoformat() <= k <= hi.isoformat()]
        w: dict = {
            "days": len(sub),
            "both_expiry_days_left_out": both_expiry if wname == "two_years" else None,
        }
        series = {k: np.array([r["arms"][k]["net"] for r in sub]) for k in ARMS}
        for k in ARMS:
            lots = np.array([r["arms"][k]["lots"] for r in sub], dtype=float)
            hits = np.array([r["arms"][k]["stop_hit"] for r in sub])
            w[k] = metrics(series[k], lots, hits)
            if k != "E3":
                w[k]["vs_E3"] = interval(series[k] - series["E3"])
            w[k]["by_expiring_index"] = {
                ix: {
                    "days": int(sum(r["expiring"] == ix for r in sub)),
                    "per_day": float(np.mean([r["arms"][k]["net"] for r in sub if r["expiring"] == ix])),
                    "vs_E3": float(np.mean([r["arms"][k]["net"] - r["arms"]["E3"]["net"] for r in sub if r["expiring"] == ix])),
                    "loss_day_share": float(np.mean([r["arms"][k]["net"] < 0 for r in sub if r["expiring"] == ix])),
                }
                for ix in ("NIFTY", "SENSEX")
            }  # fmt: skip
        # whole book: these expiry-day arms + Amendment 2's Dx2 on non-expiry days
        days = sorted(d for d in a2 if lo.isoformat() <= d <= hi.isoformat())
        dx2 = {
            d: a2[d]["arms"]["Dx2"]["gross_stop"] - a2[d]["arms"]["Dx2"]["brokerage"] for d in days
        }
        whole = {}
        for k in ARMS:
            net = np.array([rows[d]["arms"][k]["net"] if d in rows else dx2[d] for d in days])
            lots = np.array(
                [
                    rows[d]["arms"][k]["lots"] if d in rows else a2[d]["arms"]["Dx2"]["lots"]
                    for d in days
                ],
                dtype=float,
            )
            whole[k] = metrics(net, lots, np.zeros(len(days), bool))
        w["whole_book_with_Dx2_normal_days"] = whole
        out[wname] = w
    return out


def main() -> None:
    root = data_dir()
    a2 = json.loads(A2_ROWS.read_text())
    report = {}
    for book, names in (
        ("core_298", variant_names()),
        ("t1", [*variant_names(), *track_names("t1")]),
    ):
        rows, both = run(root, names, book)
        e3_vs_a2 = max(
            abs(rows[d]["arms"]["E3"]["net"] - (a2[book][d]["arms"]["B3"]["gross_stop"] - a2[book][d]["arms"]["B3"]["brokerage"]))
            for d in rows
        )  # fmt: skip
        print(
            f"{book}: {len(rows)} one-index expiry days, {both} both-expiry left out; E3 vs A2 B3 max diff {e3_vs_a2:.2f}"
        )
        report[book] = summarise(rows, a2[book], both)
    report["note"] = (
        "net after brokerage under the book stop; one-index expiry days only; whole book adds Amendment 2's Dx2 on non-expiry days"
    )
    (HERE / "fourth_lot_a3_2026-10-28.json").write_text(json.dumps(report, indent=1) + "\n")
    for book in ("core_298", "t1"):
        for wname, w in report[book].items():
            print(f"== {book} {wname}: {w['days']} expiry days")
            for k in ARMS:
                x = w[k]
                v = x.get("vs_E3")
                vs = (
                    f" | vs E3 {v['mean']:+.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}]"
                    if v
                    else ""
                )
                ix = " ".join(
                    f"{i}-exp {b['per_day']:+.0f} ({b['days']}d, loss {b['loss_day_share']:.0%})"
                    for i, b in x["by_expiring_index"].items()
                )
                print(
                    f"  {k}: {x['per_day']:+6.0f}/d DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} "
                    f"loss {x['loss_day_share']:.0%} R/DD {x['return_over_drawdown'] or 0:.1f} stops {x['book_stop_days']}{vs} || {ix}"
                )
            for k, x in w["whole_book_with_Dx2_normal_days"].items():
                print(
                    f"  whole book {k}+Dx2: {x['per_day']:+6.0f}/d DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} R/DD {x['return_over_drawdown'] or 0:.1f}"
                )


if __name__ == "__main__":
    main()
