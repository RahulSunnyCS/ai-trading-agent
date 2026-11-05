"""BL-209: two accounts trading T1, today's layout against the split one (exploratory, in-sample).

Today: each account trades every core pick; Shoonya (Finvasia) also takes the Dir x2 lot on a
non-expiry day (`live_lots.lots_for_day`), Angel One trades 1 lot each.
Split: the same lots per strategy across both accounts, regrouped by the live rule
(`rotation/account_split.split`). The odd pick (the Dir on a 1 Dir + 2 Widesl day, the third Widesl
on a 3-Widesl day) trades 1 lot on each account, Shoonya keeping the Dir x2 extra lot; the like
pair goes one per account at both accounts' lots. Two splits: "pick" sends the first of the pair in
pick order to Shoonya (the first replay); "re-entry" sends the pair member with a re-entry to
Shoonya, the first in pick order otherwise (the owner's rule, 2026-11-04: re-entries are more
orders and Shoonya's are cheaper).

Each account runs under its own book stop: Rs 9,000 + the MTM SL of every lot beyond three (the
live T1 rule, BL-194). Paper, before slippage. Brokerage per trade is two orders, flat whatever the
lots (one order carries both lots), plus 18 % GST: Rs 20 an order on Angel One, Rs 5 on Shoonya
(owner, 2026-11-04). The other charges scale with the lots and are the same in both layouts.

Picks: the T1 journal from 2026-10-19, re-derived before (`research/common/adaptive_picks.py`),
the Buy add-on left out.

    uv run python research/bl209/two_accounts.py research/bl209/out/days.jsonl
"""

from __future__ import annotations

import csv
import json
import random
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "common"))
from adaptive_picks import picks_for  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import account_split, labels, portfolio, store  # noqa: E402
from option_backtesting.rotation.live_lots import lots_for_day  # noqa: E402
from option_backtesting.rotation.score import is_dir  # noqa: E402

ROOT = data_dir()
BOOK_STOP = 9000.0
GST = 1.18
PER_ORDER = {"angelone": 20.0, "finvasia": 5.0}
FIRST, LAST = date(2024, 1, 1), date(2026, 11, 4)

_trades: dict[str, dict[str, int]] = {}
_mtmsl: dict[str, float] = {}


def n_trades(name: str, day: str) -> int:
    if name not in _trades:
        with store.slipped(0.0):
            path = store.read_path(store.result_path(name, ROOT))
            with open(path) as f:
                _trades[name] = {
                    r["day"]: int(float(r["n_trades"] or 0)) for r in csv.DictReader(f)
                }
    return _trades[name].get(day, 0)


def mtmsl(name: str) -> float:
    if name not in _mtmsl:
        m = re.search(r"MTMSL(\d+)", labels.label(name).params)
        _mtmsl[name] = float(m.group(1)) if m else 3000.0
    return _mtmsl[name]


def stop_for(book: dict[str, int]) -> float:
    extra = max(0, sum(book.values()) - 3)
    if not extra:
        return BOOK_STOP
    heavy = max(book, key=lambda n: (book[n], is_dir(n)))
    return BOOK_STOP + extra * mtmsl(heavy)


def run(book: dict[str, int], day: date, loaded: dict) -> tuple[float, str | None]:
    members = [
        portfolio.Member(n, lots, portfolio.one_lot_path(ROOT, day, n, loaded))
        for n, lots in book.items()
        if lots
    ]
    b = portfolio.apply_book(members, stop_for(book))
    return b.gross_with, b.stop_label


def brokerage(book: dict[str, int], day: str, broker: str) -> float:
    return sum(2 * PER_ORDER[broker] * GST * n_trades(n, day) for n, lots in book.items() if lots)


def replay(out: Path) -> list[dict]:
    attrs = store.read_days(ROOT, "weekdays")
    rows = []
    for d, names in sorted(picks_for("t1", ROOT, FIRST, LAST).items()):
        core = [n for n in names if "_buy" not in n]
        a = attrs.get(d) or {}
        dte = {"NIFTY": a.get("dte_n"), "SENSEX": a.get("dte_s")} if a else None
        s_now = lots_for_day(core, dte, on=True)
        a_now = {n: 1 for n in core}
        books_by = {"now": {"finvasia": s_now, "angelone": a_now}}
        for key, reentry in (("pick", lambda n: False), ("reent", account_split.has_reentry)):
            books_by[key] = account_split.split(
                core, {"finvasia": s_now, "angelone": a_now}, reentry=reentry
            )
        loaded: dict = {}  # one day's market data: never shared across days
        ds = d.isoformat()
        try:
            books = {
                k: [run(v["finvasia"], d, loaded), run(v["angelone"], d, loaded)]
                for k, v in books_by.items()
            }
        except Exception as e:  # a day that cannot be replayed is listed, never zero
            rows.append({"day": ds, "error": f"{type(e).__name__}: {e}"})
            continue
        fees = {
            k: brokerage(v["finvasia"], ds, "finvasia") + brokerage(v["angelone"], ds, "angelone")
            for k, v in books_by.items()
        }
        rows.append(
            {
                "day": ds,
                "shape": f"{sum(map(is_dir, core))}D{sum(not is_dir(n) for n in core)}W",
                "shoonya_lots": sum(s_now.values()),
                **{f"{k}_gross": round(sum(g for g, _ in v), 2) for k, v in books.items()},
                **{f"{k}_brokerage": round(v, 2) for k, v in fees.items()},
                **{f"{k}_stops": [s for _, s in v if s] for k, v in books.items()},
                "moved": books_by["pick"] != books_by["reent"],
                "shoonya_new": books_by["reent"]["finvasia"],
                "angel_new": books_by["reent"]["angelone"],
            }
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return rows


def stats(series: list[tuple[date, float]]) -> dict:
    total = peak = dd = 0.0
    for _, v in series:
        total += v
        peak = max(peak, total)
        dd = max(dd, peak - total)
    last = series[-1][0] - timedelta(days=365)
    return {
        "total": round(total),
        "per_day": round(total / len(series)),
        "max_dd": -round(dd),
        "worst_day": round(min(v for _, v in series)),
        "last_12m": round(sum(v for d, v in series if d > last)),
    }


def block_interval(diffs: list[float], block: int = 5, n: int = 5000, seed: int = 209):
    rng = random.Random(seed)
    k = len(diffs) // block
    means = []
    for _ in range(n):
        sample = []
        for _ in range(k):
            i = rng.randrange(len(diffs) - block + 1)
            sample.extend(diffs[i : i + block])
        means.append(sum(sample) / len(sample))
    means.sort()
    return round(means[int(0.05 * n)]), round(means[int(0.95 * n)])


def main() -> None:
    out = Path(sys.argv[1])
    rows = [r for r in replay(out) if "error" not in r]
    layouts = (("now", "today"), ("pick", "split, pick order"), ("reent", "split, re-entry"))
    net = {
        k: [(date.fromisoformat(r["day"]), r[f"{k}_gross"] - r[f"{k}_brokerage"]) for r in rows]
        for k, _ in layouts
    }
    print(f"{len(rows)} days, {rows[0]['day']} .. {rows[-1]['day']}")
    for k, label in layouts:
        print(label, stats(net[k]))
    for a, b in (("now", "pick"), ("now", "reent"), ("pick", "reent")):
        diffs = [y - x for (_, x), (_, y) in zip(net[a], net[b], strict=True)]
        gross = sum(r[f"{b}_gross"] - r[f"{a}_gross"] for r in rows) / len(rows)
        fees = sum(r[f"{a}_brokerage"] - r[f"{b}_brokerage"] for r in rows) / len(rows)
        print(
            f"{b} - {a}: {sum(diffs) / len(diffs):+.0f}/day, 90% {block_interval(diffs)};"
            f" brokerage saved {fees:+.0f}/day, book stops {gross:+.0f}/day"
        )
    print("account stops:", {k: sum(len(r[f"{k}_stops"]) for r in rows) for k, _ in layouts})
    print("days the re-entry rule moved a pick:", sum(r["moved"] for r in rows))
    shapes: dict[str, int] = {}
    for r in rows:
        shapes[r["shape"]] = shapes.get(r["shape"], 0) + 1
    print("shapes", shapes, "Shoonya 4-lot days", sum(r["shoonya_lots"] > 3 for r in rows))


if __name__ == "__main__":
    main()
