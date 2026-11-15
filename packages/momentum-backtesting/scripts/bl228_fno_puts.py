"""BL-228: buy the puts of the weakest-momentum F&O stocks whose own trend is down, one lot each,
swapped weekly, against cash.

Registered in backlog/BL-228-fno-falling-stock-puts.md (Phase 0). Twelve books: N 5 / 10 x ATM /
OTM1 / OTM2 x always / gated (NIFTY below its 200-session average at the previous week's close).
The weak list is read at the previous week's close from Broad's `fno` universe frame (adjusted
weekly closes, split segments apart, point-in-time F&O list and tradability gate): Momentum's
rank-sum over 1 / 4 / 13 / 26 / 52-week returns, the N lowest, kept where the 26-week return is
below zero and the close below its 40-week average. Contracts, fills, costs, slippage and tax are
BL-226's (`bl226_options_book.py`), sized at one lot per stock.

`learn` scores the learning trades only (exits by 2024-06-28) and writes no confirmation trade;
`confirm --book <id>` scores the named books on the confirmation weeks, after the learning read is
committed in the item.

    MOMENTUM_DATA_DIR=<copy> uv run python scripts/bl228_fno_puts.py learn --out <dir>
    ... confirm --out <dir> --book N5-ATM-always [--book ...]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bl226_options_book as ob  # noqa: E402

HORIZONS = (1, 4, 13, 26, 52)
TREND_WEEKS = 26
AVERAGE_WEEKS = 40
NIFTY_AVERAGE = 200
NS = (5, 10)
MONEYNESS = ("ATM", "OTM1", "OTM2")
FORMS = ("always", "gated")
MAX_DD = -0.40
FIRST_ENTRY = pd.Timestamp("2020-01-01")


def book_ids() -> list[str]:
    return [f"N{n}-{m}-{f}" for n in NS for m in MONEYNESS for f in FORMS]


#: Phase 0b: the mirror pool (each stock's chart and its inverse ranked together), ATM only.
MIRROR_IDS = [f"N{n}-ATM-mirror" for n in NS]


# ---------------------------------------------------------------------------------------------
# The weak list
# ---------------------------------------------------------------------------------------------


def weak_list(
    prices: pd.DataFrame, membership: pd.DataFrame, to_base: dict[str, str], n: int
) -> dict[pd.Timestamp, list[str]]:
    """{signal week: the base symbols of the n weakest eligible columns whose own trend is down},
    from closes up to that week only (every input is a trailing window)."""
    prices = prices.sort_index()
    member = membership.reindex(index=prices.index, columns=prices.columns).fillna(False)
    rets = {h: prices / prices.shift(h) - 1 for h in HORIZONS}
    eligible = member.astype(bool)
    for r in rets.values():
        eligible &= r.notna()
    score = sum(r.where(eligible).rank(axis=1, ascending=True) for r in rets.values())
    average = prices.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    down = (rets[TREND_WEEKS] < 0) & (prices < average)
    out = {}
    for week in prices.index:
        s = score.loc[week].dropna()
        if s.empty:
            out[week] = []
            continue
        s = s.sort_index().sort_values(kind="mergesort")  # ties by column name, stable
        weakest = [c for c in s.index[:n] if bool(down.at[week, c])]
        names = []
        for c in weakest:
            b = to_base.get(c, c.split("#", 1)[0])
            if b not in names:
                names.append(b)
        out[week] = names
    return out


def mirror_list(
    prices: pd.DataFrame, membership: pd.DataFrame, to_base: dict[str, str], n: int
) -> dict[pd.Timestamp, list[str]]:
    """Phase 0b. {signal week: "SYMBOL|CE" or "SYMBOL|PE"}: every eligible column and its inverse
    (1 / price) ranked together on the rank-sum of their 1 / 4 / 13 / 26 / 52-week log returns
    (an inverse's log return is minus the stock's), the n highest kept where the chart picked has
    its own trend up (26-week log return above zero, close above its own 40-week average)."""
    prices = prices.sort_index()
    member = membership.reindex(index=prices.index, columns=prices.columns).fillna(False)
    logp = np.log(prices)
    rets = {h: logp - logp.shift(h) for h in HORIZONS}
    eligible = member.astype(bool)
    for r in rets.values():
        eligible &= r.notna()
    inv_cols = ["~" + c for c in prices.columns]
    score = None
    for r in rets.values():
        both = pd.concat(
            [r.where(eligible), (-r).where(eligible).set_axis(inv_cols, axis=1)], axis=1
        )
        ranked = both.rank(axis=1, ascending=True)
        score = ranked if score is None else score + ranked
    inverse = 1 / prices
    up = (rets[TREND_WEEKS] > 0) & (
        prices > prices.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    )
    up_inv = (rets[TREND_WEEKS] < 0) & (
        inverse > inverse.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    )
    out = {}
    for week in prices.index:
        s = score.loc[week].dropna()
        s = s.sort_index().sort_values(ascending=False, kind="mergesort")
        picked = []
        for c in s.index[:n]:
            col, right = (c[1:], "PE") if c.startswith("~") else (c, "CE")
            if not bool((up_inv if right == "PE" else up).at[week, col]):
                continue
            item = f"{to_base.get(col, col.split('#', 1)[0])}|{right}"
            if item not in picked:
                picked.append(item)
        out[week] = picked
    return out


def universe():
    from momentum_backtesting.categories import broad
    from momentum_backtesting.categories.liquidity import LiquidityConfig
    from momentum_backtesting.config import DATA_DIR

    u = broad.load_stock_universe_frame(
        stocks_data_dir=DATA_DIR / "stocks",
        categories_data_dir=DATA_DIR / "categories",
        liquidity=LiquidityConfig(min_turnover_cr=2.0, floor_ratio=0.25, min_price=30.0),
        universe="fno",
    )
    return u.frame, u.stock_membership, u.column_to_base_symbol


def bans() -> set[tuple[pd.Timestamp, str]]:
    df = pd.read_parquet(ob.root() / "lake" / "eod" / "fno_universe" / "bans.parquet")
    return {(pd.Timestamp(d), s) for d, s in zip(df["date"], df["symbol"], strict=True)}


def entry_lists(weak: dict, all_sessions, banned, gate_down: dict | None):
    """{entry day: symbols}: the signal week's list entered on the next week's rebalance day,
    banned names dropped; with `gate_down`, only where it says the market was falling at the
    signal week's last session. Every rebalance day is kept (an empty list holds nothing) so each
    entry has its exit."""
    weeks = sorted(weak)
    out, skipped = {}, 0
    for w0, w1 in zip(weeks[:-1], weeks[1:], strict=True):
        d = ob.rebalance_day(w1, all_sessions)
        if d is None or d < FIRST_ENTRY:
            continue
        names = weak[w0]
        if gate_down is not None and not gate_down.get(w0, False):
            names = []
        kept = [s for s in names if (d, s.split("|", 1)[0]) not in banned]
        skipped += len(names) - len(kept)
        out[d] = kept
    return out, skipped


def nifty_down(weeks, all_sessions) -> dict[pd.Timestamp, bool]:
    nifty = ob.nifty_closes()
    sma = nifty.rolling(NIFTY_AVERAGE, min_periods=NIFTY_AVERAGE).mean()
    out = {}
    for w in weeks:
        d = ob.rebalance_day(w, all_sessions)
        if d is None:
            continue
        a, c = sma.asof(d), nifty.asof(d)
        out[w] = bool(a == a and c < a)
    return out


# ---------------------------------------------------------------------------------------------
# The book: BL-226's run_book at one lot per stock (and a NaN premium refused)
# ---------------------------------------------------------------------------------------------


def run_one_lot(picks_by_day, moneyness, all_sessions, chains, spots, lots, slip_mult=1.0):
    days = sorted(picks_by_day)
    trades = []
    counts = dict.fromkeys(("settle_entry", "settle_exit", "no_contract", "thin", "no_spot",
                            "no_exit_row", "exit_no_price"), 0)  # fmt: skip
    slip = ob.SLIPPAGE[moneyness] * slip_mult
    for d0, d1 in zip(days[:-1], days[1:], strict=True):
        rows0, rows1 = chains.get(d0, {}), chains.get(d1, {})
        for item in picks_by_day[d0]:
            sym, right = item.split("|", 1) if "|" in item else (item, "PE")
            spot = spots.at[d0, sym] if (sym in spots.columns and d0 in spots.index) else np.nan
            if not spot > 0:
                counts["no_spot"] += 1
                continue
            chain = ob.Chain(rows0.get(sym, ob.EMPTY), lots)
            expiry = chain.pick_expiry(sym, d0, all_sessions)
            if expiry is None:
                counts["no_contract"] += 1
                continue
            r = chain.rows
            side = r[(r["expiry"] == expiry) & (r["option_type"] == right)]
            strikes = np.sort(side["strike"].unique())
            if len(strikes) == 0:
                counts["no_contract"] += 1
                continue
            step = ob.OFFSET[moneyness] * (1 if right == "CE" else -1)
            i = int(np.argmin(np.abs(strikes - spot))) + step
            if not 0 <= i < len(strikes):
                counts["no_contract"] += 1
                continue
            k = strikes[i]
            row = side[side["strike"] == k].iloc[0]
            lot = lots.get((d0, sym, expiry))
            if lot is None or not lot > 0:
                counts["no_contract"] += 1
                continue
            if not row["oi"] >= ob.MIN_OI_LOTS * lot:
                counts["thin"] += 1
                continue
            traded = row["contracts"] > 0
            p0 = row["close"] if traded else row["settle"]
            if not p0 > 0:  # NaN or zero refused
                counts["no_contract"] += 1
                continue
            counts["settle_entry"] += 0 if traded else 1
            r1 = rows1.get(sym, ob.EMPTY)
            ex = r1[(r1["expiry"] == expiry) & (r1["option_type"] == right) & (r1["strike"] == k)]
            exit_traded = False
            if ex.empty:
                counts["no_exit_row"] += 1
                p1 = 0.0  # booked at zero: the registered harsh reading
            else:
                e = ex.iloc[0]
                exit_traded = bool(e["contracts"] > 0)
                p1 = e["close"] if exit_traded else e["settle"]
                counts["settle_exit"] += 0 if exit_traded else 1
                if not p1 >= 0:
                    counts["exit_no_price"] += 1
                    p1 = 0.0
            qty = lot
            buy = p0 * (1 + slip) * qty
            sell = max(p1 * (1 - slip), 0.0) * qty
            cost = ob.costs(buy, sell, d1)
            spot1 = spots.at[d1, sym] if (sym in spots.columns and d1 in spots.index) else np.nan
            trades.append({
                "entry": d0, "exit": d1, "symbol": sym, "right": right, "expiry": expiry,
                "strike": k, "spot": spot, "spot_exit": spot1, "lot": lot, "p0": p0, "p1": p1,
                "entry_traded": traded, "exit_traded": exit_traded, "no_exit_row": ex.empty,
                "buy": buy, "sell": sell, "costs": cost, "pnl": sell - buy - cost,
            })  # fmt: skip
    return pd.DataFrame(trades), counts


def score(trades: pd.DataFrame, weeks: list[pd.Timestamp]) -> dict:
    """The book against cash on `weeks`: weekly after-tax P&L on Rs 10 lakh."""
    week = ob.weekly_after_tax(trades, weeks) if len(trades) else pd.Series(0.0, index=weeks)
    eq = pd.concat([pd.Series([ob.CAPITAL]), ob.CAPITAL + week.cumsum()]).reset_index(drop=True)
    ret = (week / ob.CAPITAL).to_numpy()
    lo, hi = ob.block_bootstrap_lb(ret)
    total = float(week.sum())
    dd = ob.max_dd(eq)
    t = trades
    n = len(t)
    wins = t[t["pnl"] > 0]["pnl"] if n else pd.Series(dtype=float)
    losses = t[t["pnl"] <= 0]["pnl"] if n else pd.Series(dtype=float)
    return {
        "weeks": len(weeks),
        "weeks_with_positions": int(t["entry"].nunique()) if n else 0,
        "trades": n,
        "pnl_after_tax_rs": round(total),
        "return_after_tax": round(total / ob.CAPITAL, 4),
        "mdd": round(dd, 4),
        "weekly_90": [round(lo, 5), round(hi, 5)],
        "pnl_before_tax_rs": round(float(t["pnl"].sum())) if n else 0,
        "costs_rs": round(float(t["costs"].sum())) if n else 0,
        "win_rate": round(float((t["pnl"] > 0).mean()), 3) if n else math.nan,
        "payoff": round(float(wins.mean() / -losses.mean()), 2)
        if len(wins) and len(losses) and losses.mean() < 0
        else math.nan,
        "premium_per_week_rs": round(float(t.groupby("entry")["buy"].sum().mean())) if n else 0,
        "zero_booked": int(t["no_exit_row"].sum()) if n else 0,
        "passes": bool(total > 0 and lo > 0 and dd >= MAX_DD),
    }


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------


def build(out: Path, *, mirror: bool = False):
    all_sessions = ob.sessions()
    prices, membership, to_base = universe()
    weeks = list(prices.index)
    down = nifty_down(weeks, all_sessions)
    banned = bans()
    lists, skipped = {}, {}
    for n in NS:
        if mirror:
            m = mirror_list(prices, membership, to_base, n)
            lists[(n, "mirror")], skipped[(n, "mirror")] = entry_lists(
                m, all_sessions, banned, None
            )
            continue
        weak = weak_list(prices, membership, to_base, n)
        for form in FORMS:
            lists[(n, form)], skipped[(n, form)] = entry_lists(
                weak, all_sessions, banned, down if form == "gated" else None
            )
    days = sorted(set().union(*[set(v) for v in lists.values()]))
    symbols = {s.split("|", 1)[0] for v in lists.values() for x in v.values() for s in x}
    rows = ob.option_rows(days, symbols)
    chains: dict = {d: {} for d in days}
    for (d, sym), g in rows.groupby(["date", "symbol"]):
        chains.setdefault(d, {})[sym] = g
    spots = ob.spot_closes(days)
    lots = ob.lot_sizes()
    meta = {
        "down_weeks_by_year": pd.Series(down).groupby(lambda w: w.year).sum().astype(int).to_dict(),
        "weeks_by_year": pd.Series(down).groupby(lambda w: w.year).size().to_dict(),
        "banned_skips": {f"N{n}-{f}": v for (n, f), v in skipped.items()},
    }
    if mirror:
        meta["put_share_by_year"] = {}
        for (n, _), lst in lists.items():
            by_year: dict[int, list[bool]] = {}
            for d, v in lst.items():
                by_year.setdefault(d.year, []).extend(s.endswith("|PE") for s in v)
            meta["put_share_by_year"][f"N{n}"] = {
                y: round(float(np.mean(v)), 3) if v else None for y, v in sorted(by_year.items())
            }
    (out / ("meta-mirror.json" if mirror else "meta.json")).write_text(
        json.dumps(meta, indent=1, default=str)
    )
    return lists, days, all_sessions, chains, spots, lots


def run_all(out: Path, *, confirm_books: list[str] | None, mirror: bool = False):
    out.mkdir(parents=True, exist_ok=True)
    lists, days, all_sessions, chains, spots, lots = build(out, mirror=mirror)
    suffix = "-mirror" if mirror else ""
    learn_w = [d for d in days if d <= ob.LEARN_END]
    conf_w = [d for d in days if d >= ob.CONFIRM_START]
    results = {}
    learn_books = MIRROR_IDS if mirror else book_ids()
    for bid in learn_books if confirm_books is None else confirm_books:
        n, money, form = bid.split("-")
        picks = lists[(int(n[1:]), form)]
        for variant, slip in (("base", 1.0), ("slip2x", 2.0)):
            trades, counts = run_one_lot(picks, money, all_sessions, chains, spots, lots, slip)
            tag = f"{bid}|{variant}"
            if confirm_books is None:
                tl = trades[trades["exit"] <= ob.LEARN_END] if len(trades) else trades
                tl.to_csv(out / f"trades-learn-{bid}-{variant}.csv", index=False)
                results[tag] = {"learning": score(tl, learn_w)}
            else:
                tc = trades[trades["entry"] >= ob.CONFIRM_START] if len(trades) else trades
                tc.to_csv(out / f"trades-confirm-{bid}-{variant}.csv", index=False)
                results[tag] = {"counts": counts, "confirmation": score(tc, conf_w)}
            print(tag, json.dumps(results[tag]), flush=True)
    name = ("learning" if confirm_books is None else "confirmation") + suffix + ".json"
    (out / name).write_text(json.dumps(results, indent=1, default=str))


def carried(out: Path, *, mirror: bool = False) -> list[str]:
    res = json.loads((out / ("learning-mirror.json" if mirror else "learning.json")).read_text())
    ok = [(k.split("|")[0], v["learning"]) for k, v in res.items()
          if k.endswith("|base") and v["learning"]["passes"]]  # fmt: skip
    ok.sort(key=lambda kv: -kv[1]["pnl_after_tax_rs"] / max(abs(kv[1]["mdd"]), 1e-9))
    return [k for k, _ in ok[:3]]


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("learn", "carried", "confirm"):
        a = sub.add_parser(cmd)
        a.add_argument("--out", required=True)
        a.add_argument("--mirror", action="store_true", help="Phase 0b's mirror-pool books.")
        if cmd == "confirm":
            a.add_argument("--book", action="append", required=True)
    args = p.parse_args()
    out = Path(args.out)
    if args.cmd == "learn":
        run_all(out, confirm_books=None, mirror=args.mirror)
        print("carried:", carried(out, mirror=args.mirror))
    elif args.cmd == "carried":
        print(carried(out, mirror=args.mirror))
    else:
        unknown = set(args.book) - set(MIRROR_IDS if args.mirror else book_ids())
        if unknown:
            raise SystemExit(f"unknown book(s): {sorted(unknown)}")
        run_all(out, confirm_books=args.book, mirror=args.mirror)


if __name__ == "__main__":
    main()
