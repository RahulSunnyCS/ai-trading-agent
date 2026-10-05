"""Check the lake's prices against a source outside this repo (BL-010 Phase 2 step 2).

The replay proves the arithmetic given the lake. This asks whether the lake itself is right,
for a handful of holdings: Yahoo Finance's daily history for the same NSE symbol, fetched
fresh, compared on the entry day, the exit day and every split or bonus in between.

Yahoo's closes are adjusted for later splits and bonuses, and it lists those events, so a
close multiplied by the later ratios is the price the share actually traded at. Yahoo does not
always apply a recent event to its whole history (TRENT's June 2026 bonus reached its 2026
prices but not its 2024 ones), so the raw comparison tries each combination of the later
ratios and reports which one Yahoo had applied. A holding passes when both raw closes match
and Yahoo lists the same changes of share count inside the holding as the lake applied.

Like replay.py, nothing here may import from the backtest.
"""

from __future__ import annotations

import json
import math
import random
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from .replay import Market, Replayed
from .studies import contribution, filed_actions, holdings, symbol_of

PASS_TOL = 0.005  # bl010_criteria.json: hand_checked_trades.tol
_IST = timedelta(hours=5, minutes=30)


def yahoo_url(symbol: str, start: date, end: date) -> str:
    def stamp(day: date) -> int:
        return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())

    ticker = urllib.parse.quote(f"{symbol}.NS")
    return (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?period1={stamp(start)}&period2={stamp(end + timedelta(days=1))}"
        "&interval=1d&events=div%2Csplits"
    )


def chart_page(symbol: str) -> str:
    """A page a person can open to see the same series."""
    return f"https://finance.yahoo.com/quote/{urllib.parse.quote(symbol + '.NS')}/history/"


@dataclass
class Outside:
    closes: dict[date, float]  # adjusted for later splits and bonuses (not always all of them)
    volumes: dict[date, float]
    splits: list[tuple[date, float]]  # (ex-date, new shares per old share)

    def raw(self, day: date, near: float | None = None) -> tuple[float, list[str]] | None:
        """What a share actually traded at on `day`, and the later events Yahoo had applied to
        that close. With `near` (the lake's raw close) the combination of later events that
        lands closest to it is used; without it, all of them."""
        if day not in self.closes:
            return None
        later = [(ex_date, multiple) for ex_date, multiple in self.splits if ex_date > day]
        best = None
        for mask in range(1 << len(later)) if near else [(1 << len(later)) - 1]:
            applied = [event for i, event in enumerate(later) if mask >> i & 1]
            price = self.closes[day] * math.prod(multiple for _d, multiple in applied)
            miss = abs(price / near - 1) if near else 0.0
            if best is None or miss < best[0]:
                best = (miss, price, [str(d) for d, _m in applied])
        return best[1], best[2]


def parse(payload: dict) -> Outside:
    result = payload["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    closes, volumes = {}, {}
    for stamp, close, volume in zip(
        result.get("timestamp") or [], quote["close"], quote["volume"], strict=True
    ):
        if close is None:
            continue
        day = (datetime.fromtimestamp(stamp, UTC) + _IST).date()
        closes[day], volumes[day] = float(close), float(volume or 0)
    splits = []
    for event in (result.get("events") or {}).get("splits", {}).values():
        day = (datetime.fromtimestamp(event["date"], UTC) + _IST).date()
        splits.append((day, float(event["numerator"]) / float(event["denominator"])))
    return Outside(closes, volumes, sorted(splits))


def fetch(symbol: str, start: date, end: date | None = None) -> Outside:
    """Daily history from `start` to today. Always to today, whatever `end` says: Yahoo applies
    a recent split only to a response whose window reaches it, so a window that stops short
    comes back on an older share count than the lake's (seen on TRENT's June 2026 bonus)."""
    del end
    request = urllib.request.Request(
        yahoo_url(symbol, start, date.today()), headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return parse(json.load(response))


def _same_changes(ours: list[tuple[date, float]], theirs: list[tuple[date, float]]) -> bool:
    if len(ours) != len(theirs):
        return False
    return all(
        abs((mine[0] - other[0]).days) <= 3 and abs(mine[1] / other[1] - 1) <= 0.02
        for mine, other in zip(sorted(ours), sorted(theirs), strict=True)
    )


def check_holding(
    market: Market, symbol: str, entry: date, exit_: date, outside: Outside | None = None
) -> dict:
    """One holding against the outside source: the raw close at both ends, every change of
    share count on the way, and the return that follows from them."""
    outside = outside or fetch(symbol, entry - timedelta(days=7))
    history = market.stocks[symbol]
    rows = {}
    for label, day in (("entry", entry), ("exit", exit_)):
        bar = history.last_on_or_before(day, None, None)
        ours_raw = bar.close if bar and bar.day == day else None
        theirs = outside.raw(day, near=ours_raw)
        later = [str(d) for d, _m in outside.splits if d > day]
        rows[label] = {
            "day": str(day),
            "lake_raw_close": ours_raw,
            "outside_raw_close": theirs[0] if theirs else None,
            "raw_gap": (ours_raw / theirs[0] - 1) if ours_raw and theirs else None,
            "outside_close_as_served": outside.closes.get(day),
            "later_events_outside_had_not_applied": (
                [d for d in later if d not in theirs[1]] if theirs else None
            ),
            "stand_in_close": bool(bar.synthetic) if bar else None,
        }
    ours_between = [(d, f) for d, f in history.factors if entry < d <= exit_]
    theirs_between = [(d, f) for d, f in outside.splits if entry < d <= exit_]
    ends = (rows["entry"], rows["exit"])
    our_return = their_return = None
    if all(r["lake_raw_close"] and r["outside_raw_close"] for r in ends):
        ours_multiple = math.prod(f for _d, f in ours_between)
        theirs_multiple = math.prod(f for _d, f in theirs_between)
        our_return = ends[1]["lake_raw_close"] * ours_multiple / ends[0]["lake_raw_close"] - 1
        their_return = (
            ends[1]["outside_raw_close"] * theirs_multiple / ends[0]["outside_raw_close"] - 1
        )
    gaps = [abs(r["raw_gap"]) for r in ends if r["raw_gap"] is not None]
    same = _same_changes(ours_between, theirs_between)
    return {
        "symbol": symbol,
        **rows,
        "lake_share_changes": [(str(d), f) for d, f in ours_between],
        "outside_share_changes": [(str(d), f) for d, f in theirs_between],
        "share_changes_agree": same,
        "lake_return": our_return,
        "outside_return": their_return,
        "source": chart_page(symbol),
        "passed": len(gaps) == 2 and max(gaps) <= PASS_TOL and same,
    }


def check_day(market: Market, symbol: str, day: date, outside: Outside | None = None) -> dict:
    """One day's move against the outside source (for the big days of step 3)."""
    outside = outside or fetch(symbol, day - timedelta(days=10))
    history = market.stocks[symbol]
    i = history.days.index(day)
    before, bar = history.bars[i - 1], history.bars[i]
    ours = (
        bar.close / history.adjustment(bar.day) / (before.close / history.adjustment(before.day))
        - 1
    )
    theirs = None
    if before.day in outside.closes and day in outside.closes:
        theirs = outside.closes[day] / outside.closes[before.day] - 1
    return {
        "symbol": symbol,
        "day": str(day),
        "previous_day": str(before.day),
        "lake_move": ours,
        "outside_move": theirs,
        "outside_volume": outside.volumes.get(day),
        "source": chart_page(symbol),
        "passed": theirs is not None and abs((1 + ours) / (1 + theirs) - 1) <= PASS_TOL,
    }


# --- the sample of holdings to check -------------------------------------------------------------

Run = tuple[dict, Market, Replayed]  # a bundle, its market data, its reconciling replay
SAMPLE_SEED = 20261005


def pick_sample(
    runs: dict[str, Run],
    feed: list[dict],
    primary: str,
    also: list[tuple[str, str, date, str]] = (),
    seed: int = SAMPLE_SEED,
) -> list[dict]:
    """Ten holdings, chosen by rule before any outside price is fetched:

    5  the five companies that made the most money in the `primary` run, each one's most
       profitable holding
    2  holdings that span a filed split or bonus: the first one the lake adjusted for and
       the first it missed, looking through the runs in the order given
    +  `also`: holdings named by the caller as (run, instrument, a day inside it, why)
    2  drawn at random from every closed stock holding of every run"""
    trips = {label: holdings(bundle, mine) for label, (bundle, _market, mine) in runs.items()}
    picked, seen = [], set()

    def add(why: str, label: str, trip: dict) -> bool:
        key = (label, trip["asset"], trip["entry"])
        if key in seen:
            return False
        seen.add(key)
        picked.append({"why": why, "run": label, **trip})
        return True

    bundle, market, mine = runs[primary]
    top = [
        row["company"]
        for row in contribution(bundle, mine)["top_by_rupee_profit"]
        if row["company"] in market.stocks
    ][:5]
    for company in top:
        own = [t for t in trips[primary] if symbol_of(bundle, t["asset"]) == company]
        add(
            f"one of the five largest contributors of the {primary} run",
            primary,
            max(own, key=lambda t: t["profit"]),
        )

    adjusted = missed = False
    for label, (bundle, market, mine) in runs.items():
        counted, _other = filed_actions(bundle, market, mine, feed)
        for row in counted:
            trip = next(
                (
                    t
                    for t in trips[label]
                    if t["asset"] == row["asset"] and str(t["entry"]) == row["held_from"]
                ),
                None,
            )
            if trip is None:
                continue
            what = f"{row['subject'].strip()}, ex-date {row['ex_date']}"
            if row["adjusted"] and not adjusted:
                adjusted = add(f"spans a filed action the lake adjusted for ({what})", label, trip)
            if not row["adjusted"] and not missed:
                missed = add(f"spans a filed action the lake missed ({what})", label, trip)

    for label, name, day, why in also:
        trip = next(
            t for t in trips[label] if t["asset"] == name and t["entry"] <= day <= t["exit"]
        )
        add(why, label, trip)

    pool = sorted(
        ((label, t) for label in runs for t in trips[label] if not t["still_held"]),
        key=lambda item: (item[0], item[1]["order"]),
    )
    rng, drawn = random.Random(seed), 0
    while drawn < 2:
        label, trip = rng.choice(pool)
        drawn += add("drawn at random", label, trip)
    return picked


def check_sample(
    picked: list[dict], runs: dict[str, Run], days: list[tuple[str, date]] = (), pause: float = 1.0
) -> dict:
    """Fetch the outside history for each picked holding (and each extra single day) and
    compare. Network errors are recorded on the row, never raised."""
    out: dict = {"holdings": [], "days": []}
    for trip in picked:
        bundle, market, _mine = runs[trip["run"]]
        symbol = symbol_of(bundle, trip["asset"])
        try:
            result = check_holding(market, symbol, trip["entry"], trip["exit"])
        except Exception as error:  # noqa: BLE001 - a row that could not be checked is a finding
            result = {
                "symbol": symbol,
                "error": f"{type(error).__name__}: {error}",
                "passed": False,
            }
        out["holdings"].append({**trip, "check": result})
        time.sleep(pause)
    market = next(iter(runs.values()))[1]
    for symbol, day in days:
        own = next((m for _b, m, _r in runs.values() if symbol in m.stocks), market)
        try:
            result = check_day(own, symbol, day)
        except Exception as error:  # noqa: BLE001
            result = {
                "symbol": symbol,
                "day": str(day),
                "error": f"{type(error).__name__}: {error}",
                "passed": False,
            }
        out["days"].append(result)
        time.sleep(pause)
    return out


def worksheet(checked: dict) -> str:
    """The checked sample as a Markdown table a person can re-check from, with links."""

    def money(value: float | None) -> str:
        return "n/a" if value is None else f"{value:,.2f}"

    def pct(value: float | None) -> str:
        return "n/a" if value is None else f"{value:+.2%}"

    header = (
        "# | Run | Stock | Bought | Lake close | Outside close | Sold | Lake close | "
        "Outside close | Share changes (lake / outside) | Return (lake / outside) | Result | "
        "Why chosen"
    )
    lines = [f"| {header} |", "|" + "---|" * 13]
    for i, trip in enumerate(checked["holdings"], 1):
        check = trip["check"]
        if "error" in check:
            blank = " | " * 8
            lines.append(
                f"| {i} | {trip['run']} | {trip['asset']} |{blank}| "
                f"could not check: {check['error']} | {trip['why']} |"
            )
            continue
        entry, exit_ = check["entry"], check["exit"]
        ours = ", ".join(f"x{f:g} on {d}" for d, f in check["lake_share_changes"]) or "none"
        theirs = ", ".join(f"x{f:g} on {d}" for d, f in check["outside_share_changes"]) or "none"
        sold = exit_["day"] + (" (still held)" if trip["still_held"] else "")
        lines.append(
            f"| {i} | {trip['run']} | [{trip['asset']}]({check['source']}) | {entry['day']} | "
            f"{money(entry['lake_raw_close'])} | {money(entry['outside_raw_close'])} | {sold} | "
            f"{money(exit_['lake_raw_close'])} | {money(exit_['outside_raw_close'])} | "
            f"{ours} / {theirs} | {pct(check['lake_return'])} / {pct(check['outside_return'])} | "
            f"{'pass' if check['passed'] else '**fail**'} | {trip['why']} |"
        )
    if checked["days"]:
        lines += [
            "",
            "| Day | Stock | Move in the lake | Move outside | Result |",
            "|---|---|---|---|---|",
        ]
        for row in checked["days"]:
            if "error" in row:
                lines.append(
                    f"| {row['day']} | {row['symbol']} | | | could not check: {row['error']} |"
                )
                continue
            lines.append(
                f"| {row['day']} | [{row['symbol']}]({row['source']}) | {pct(row['lake_move'])} | "
                f"{pct(row['outside_move'])} | {'pass' if row['passed'] else '**fail**'} |"
            )
    return "\n".join(lines)
