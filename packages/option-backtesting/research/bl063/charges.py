"""BL-063: the rotations after brokerage and statutory charges (model pre-registered in
backlog/BL-063-rotation-after-charges.md).

    uv run --no-project --with pandas --with numpy python research/bl063/charges.py

Reads the trades recorded by trades.py, checks every pair's re-run P&L against the stored per-day
result, charges every trade, and prints the monthly and total after-charges tables for the BL-062
whole-day rotation and the BL-057 morning rotation. Writes out/daily_charges.csv for the chart."""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

CAP = 1_300_000
BROKERAGE_PER_LOT_ORDER = 13.0  # owner's assumption: ₹13 per lot per order
STT_SELL = [("2000-01-01", 0.0010), ("2026-04-01", 0.0015)]  # options sell side, on premium
EXCHANGE = {"N": 0.0003503, "S": 0.000325}  # NSE / BSE options transaction charge, both sides
SEBI, IPFT_NSE, STAMP_BUY, GST = 0.000001, 0.000005, 0.00003, 0.18
PLATFORM_FEE = (
    19.0  # optional: AlgoTest per-strategy fee per day (₹75 for 4 strategies in the sheet)
)
PICKS = {  # rotation -> (daily picks file, lots traded in each picked strategy)
    "whole_day": ("daily_picks_min2_core5_buy2_whole_day.csv", 1),  # DRB-5W2 (BL-062)
    "morning66": ("daily_picks.csv", 1),
    "DRB-6W2": ("daily_picks_min2_core6_buy2_whole_day.csv", 1),  # BL-064
    "DRB-6W3": ("daily_picks_min3_core6_buy2_whole_day.csv", 1),
    "DRB-6W2L2": (
        "daily_picks_min2_core6_buy2L2_whole_day.csv",
        2,
    ),  # BL-065: 3 strategies of 2 lots
    "DRB-6W3L2": ("daily_picks_min3_core6_buy2L2_whole_day.csv", 2),
    # BL-065 second block: the same basket on the list without the closest-premium Widesl
    "DRB-6W3L2/OTM": ("daily_picks_min3_core6_buy2L2_whole_day_otm_only.csv", 2),
}


def stt_rate(day: str) -> float:
    return [rate for start, rate in STT_SELL if day >= start][-1]


def trade_charges(
    index: str,
    day: str,
    position: str,
    qty: int,
    entry: float,
    exit_: float,
    per_trip: bool = False,
):
    sell = (entry if position == "sell" else exit_) * qty
    buy = (exit_ if position == "sell" else entry) * qty
    both = sell + buy
    brokerage = BROKERAGE_PER_LOT_ORDER * (1 if per_trip else 2)  # 1 lot; entry order + exit order
    stt = stt_rate(day) * sell
    exch = EXCHANGE[index] * both
    sebi = SEBI * both
    ipft = IPFT_NSE * both if index == "N" else 0.0
    stamp = STAMP_BUY * buy
    gst = GST * (brokerage + exch + sebi + ipft)
    return dict(
        brokerage=brokerage, stt=stt, exchange=exch, sebi_ipft=sebi + ipft, stamp=stamp, gst=gst
    )


def main() -> None:
    records = {}
    for file in sorted(HERE.glob("trades_*.jsonl")):
        for line in file.read_text().splitlines():
            r = json.loads(line)
            records[(r["v"], r["day"])] = r
    print(f"{len(records)} (variant, day) pairs with trades")
    # reconciliation: the re-run gross equals the stored per-day result for every pair
    stored: dict = {}
    worst = 0.0
    for (name, day), r in records.items():
        if name not in stored:
            stored[name] = (
                pd.read_csv(varlib.variant_file(name, "results"), parse_dates=["day"])
                .set_index("day")
                .net
            )
        assert r["gross"] is not None, (name, day)
        worst = max(worst, abs(r["gross"] - stored[name].loc[pd.Timestamp(day)]))
    assert worst < 0.5, worst
    print(
        f"reconciliation: re-run gross equals the stored P&L on every pair (largest difference ₹{worst:.4f})"
    )

    pair_charges = {}
    for (name, day), r in records.items():
        total = dict.fromkeys(("brokerage", "stt", "exchange", "sebi_ipft", "stamp", "gst"), 0.0)
        trip = dict(total)
        for position, qty, entry, exit_, _leg in r["trades"]:
            for k, v in trade_charges(name[0], day, position, qty, entry, exit_).items():
                total[k] += v
            for k, v in trade_charges(
                name[0], day, position, qty, entry, exit_, per_trip=True
            ).items():
                trip[k] += v
        pair_charges[(name, day)] = (total, trip, len(r["trades"]))

    out_rows = []
    for rot, (file, per) in PICKS.items():
        picks = pd.read_csv(HERE.parent / "bl057" / file, parse_dates=["day"])
        for row in picks.itertuples():
            names = row.core_A.split(",") + (row.buy.split(",") if isinstance(row.buy, str) else [])
            day = row.day.date().isoformat()
            tot = dict.fromkeys(("brokerage", "stt", "exchange", "sebi_ipft", "stamp", "gst"), 0.0)
            per_lot_total = trip_total = 0.0
            for n in names:
                c, t, _ = pair_charges[(n, day)]
                gst_other = c["gst"] - GST * c["brokerage"]  # GST on exchange + SEBI + IPFT
                # owner (2026-10-09): brokerage is a flat fee per ORDER, so a 2-lot order pays it once;
                # STT, exchange, SEBI, IPFT and stamp follow the quantity traded
                for k in ("stt", "exchange", "sebi_ipft", "stamp"):
                    tot[k] += c[k] * per
                tot["brokerage"] += c["brokerage"]
                tot["gst"] += GST * c["brokerage"] + gst_other * per
                # sensitivity: the broker charges per LOT per order (a 2-lot order pays twice)
                per_lot_total += per * sum(
                    c[k] for k in tot
                )  # every component scales with the lots
                t_gst_other = t["gst"] - GST * t["brokerage"]
                trip_total += (1 + GST) * t["brokerage"] + per * (
                    t["stt"] + t["exchange"] + t["sebi_ipft"] + t["stamp"] + t_gst_other
                )
            flat_brokerage = tot["brokerage"]
            out_rows.append(
                dict(
                    rotation=rot,
                    day=row.day,
                    gross=row.pnl_A,
                    lots=len(names) * per,
                    strategies=len(names),
                    flat_brokerage=flat_brokerage,
                    charges=sum(tot.values()),
                    charges_per_lot_brokerage=per_lot_total,
                    charges_per_trip_brokerage=trip_total,
                    platform_fee=PLATFORM_FEE
                    * len(names),  # AlgoTest's fee is per strategy, not per lot
                    **tot,
                )
            )
    D = pd.DataFrame(out_rows)
    (HERE / "out").mkdir(exist_ok=True)
    D.to_csv(HERE / "out" / "daily_charges.csv", index=False)

    def dd(s):
        eq = np.cumsum(s.to_numpy())
        return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())

    print(
        f"\nassumptions: brokerage ₹{BROKERAGE_PER_LOT_ORDER:g} per lot per order (entry and exit = 2 orders a trade), STT 0.10% sell side "
        "(0.15% from 1 Apr 2026), exchange 0.03503% NSE / 0.0325% BSE both sides, SEBI ₹10/crore, NSE IPFT ₹50/crore, "
        "stamp 0.003% buy side, GST 18% on brokerage + exchange + SEBI + IPFT; 1 lot per variant, no slippage"
    )
    for rot in PICKS:
        d = D[D.rotation == rot].set_index("day")
        d["net"] = d.gross - d.charges
        m = d.groupby(d.index.to_period("M")).agg(
            days=("gross", "size"),
            gross=("gross", "sum"),
            charges=("charges", "sum"),
            net=("net", "sum"),
            lots=("lots", "sum"),
        )
        print(f"\n{'=' * 100}\n{rot}: monthly, ₹13,00,000 base\n{'=' * 100}")
        print(
            f"{'month':>9} {'days':>4} {'lots':>5} | {'gross ₹':>9} {'gross %':>7} | {'charges ₹':>9} {'% of gross':>10} | {'NET ₹':>9} {'NET %':>6}"
        )
        for p, x in m.iterrows():
            print(
                f"{p.strftime('%b %Y'):>9} {int(x.days):>4} {int(x.lots):>5} | {x.gross:>9,.0f} {100 * x.gross / CAP:>6.1f}% | {x.charges:>9,.0f} {100 * x.charges / x.gross if x.gross > 0 else float('nan'):>9.0f}% | {x.net:>9,.0f} {100 * x.net / CAP:>5.1f}%"
            )
        t = d[
            [
                "gross",
                "charges",
                "net",
                "brokerage",
                "stt",
                "exchange",
                "sebi_ipft",
                "stamp",
                "gst",
                "platform_fee",
                "charges_per_trip_brokerage",
            ]
        ].sum()
        lots = d.lots.sum()
        print(
            f"{'TOTAL':>9} {len(d):>4} {int(lots):>5} | {t.gross:>9,.0f} {100 * t.gross / CAP:>6.1f}% | {t.charges:>9,.0f} {100 * t.charges / t.gross:>9.0f}% | {t.net:>9,.0f} {100 * t.net / CAP:>5.1f}%"
        )
        print(
            f"charges by item (₹): brokerage {t.brokerage:,.0f} | STT {t.stt:,.0f} | exchange {t.exchange:,.0f} | SEBI+IPFT {t.sebi_ipft:,.0f} | stamp {t.stamp:,.0f} | GST {t.gst:,.0f}"
        )
        print(
            f"charges per lot-day ₹{t.charges / lots:,.0f}; per day ₹{t.charges / len(d):,.0f}; max drawdown gross {dd(d.gross):,.0f} ({100 * dd(d.gross) / CAP:.1f}%) -> net {dd(d.net):,.0f} ({100 * dd(d.net) / CAP:.1f}%)"
        )
        print(
            f"months positive after charges: {(m.net > 0).sum()} of {len(m)}; worst month {100 * m.net.min() / CAP:.2f}%"
        )
        print(
            f"sensitivity: brokerage ₹13 per round trip instead of per order -> charges ₹{t.charges_per_trip_brokerage:,.0f}, net ₹{t.gross - t.charges_per_trip_brokerage:,.0f} ({100 * (t.gross - t.charges_per_trip_brokerage) / CAP:.1f}%)"
        )
        print(
            f"sensitivity: plus AlgoTest platform fee ₹{PLATFORM_FEE:g} a strategy-day -> extra ₹{t.platform_fee:,.0f}, net ₹{t.net - t.platform_fee:,.0f} ({100 * (t.net - t.platform_fee) / CAP:.1f}%)"
        )


if __name__ == "__main__":
    main()
