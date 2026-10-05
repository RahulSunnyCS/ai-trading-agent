"""Studies on a replayed run (BL-010 Phase 2, steps 3 and 5 to 7).

Each takes a bundle, the raw market data and the reconciling replay, and answers one question
with the replay's own numbers:

  big_days / unadjusted_actions   which days inside a holding could be a data artefact
  contribution                    where the profit came from: stocks, years
  realism                         could a real account of this size have placed these orders
  monday_open                     what filling a day later, at the next open, costs

Like replay.py, nothing here may import from the backtest. Pass levels are the ones committed
in search_spaces/bl010_criteria.json and bl010_criteria_addendum_1.json.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from pathlib import Path

from .replay import (
    BUYS,
    FULL_SELL,
    Market,
    Replayed,
    Sizing,
    cagr,
    decisions,
    max_drawdown,
    replay,
)

# --- pass levels (bl010_criteria.json: phase_2_arithmetic) --------------------------------------
BIG_DAY = 0.20  # jump_scan.flag_abs_daily_move
JUMP_KILL_CAGR_PTS = 0.02  # jump_scan.kill_if_cagr_moves_pts
JUMP_KILL_TOP_CONTRIBUTORS = 20  # jump_scan.kill_if_top20_contributor_flagged
TOP5_SHARE_FLAG = 0.5  # contribution_flags.top5_share_of_log_return
SINGLE_YEAR_FLAG = 0.4  # contribution_flags.single_year_share
PARTICIPATION_FLAG = 0.05  # realism.flag_participation
PARTICIPATION_CAP = 0.01  # realism.report_cagr_at_participation_cap
MONDAY_OPEN_FLAG_PTS = 0.01  # addendum 1: flag_if_cagr_falls_by_more_than_pts


def symbol_of(bundle: dict, name: str) -> str:
    """The company behind an instrument name: `SYM#2` is still `SYM`."""
    asset = bundle["assets"].get(name)
    if asset is None:
        return name
    return asset["symbol"] if asset["kind"] == "stock" else asset["instrument"]


def holding_spans(reconciled: Replayed) -> dict[str, list[tuple[date, date | None]]]:
    """For each instrument, every stretch it was held: (day bought, day sold or None)."""
    spans: dict[str, list[tuple[date, date | None]]] = {}
    opened: dict[str, date] = {}
    for fill in reconciled.fills:
        if fill.action in BUYS and fill.held_before <= 0:
            opened[fill.asset] = fill.price_day
        elif fill.action == FULL_SELL and fill.asset in opened:
            spans.setdefault(fill.asset, []).append((opened.pop(fill.asset), fill.price_day))
    for name, start in opened.items():
        spans.setdefault(name, []).append((start, None))
    return spans


def holdings(bundle: dict, reconciled: Replayed) -> list[dict]:
    """Every stock holding from first purchase to final sale, with what it made (in multiples
    of the starting capital, after costs and tax). One still held at the end is valued at the
    last weekly price and marked `still_held`."""
    out: list[dict] = []
    open_: dict[str, dict] = {}
    for fill in reconciled.fills:
        if bundle["assets"][fill.asset]["kind"] != "stock":
            continue
        trip = open_.setdefault(
            fill.asset, {"asset": fill.asset, "buys": [], "paid": 0.0, "got": 0.0}
        )
        if fill.action in BUYS:
            trip["buys"].append(fill)
            trip["paid"] += fill.amount
            continue
        trip["got"] += fill.amount - fill.cost - fill.tax
        if fill.action == FULL_SELL:
            trip.update(still_held=False, exit=fill.price_day, exit_week=fill.week)
            trip.update(exit_price=fill.price, exit_raw=fill.raw_price, order=fill.index)
            trip["profit"] = trip["got"] - trip["paid"]
            out.append(open_.pop(fill.asset))
    last = max(reconciled.marks)
    for name, trip in open_.items():
        q = reconciled.marks[last].get(name)
        if q is None or not trip["buys"]:
            continue
        trip.update(still_held=True, exit=q.day, exit_week=last, exit_price=q.price)
        trip.update(exit_raw=q.raw, order=None)
        trip["profit"] = trip["got"] + reconciled.positions.get(name, 0.0) - trip["paid"]
        out.append(trip)
    for trip in out:
        first = trip.pop("buys")[0]
        trip.update(entry=first.price_day, entry_week=first.week)
        trip.update(entry_price=first.price, entry_raw=first.raw_price)
    return out


# --- step 5: where the profit came from ---------------------------------------------------------


def contribution(bundle: dict, reconciled: Replayed) -> dict:
    """Profit by company and by year.

    A week's profit is split between instruments in rupees. To add weeks up into a share of
    the whole compounded return, each week's rupee profit is scaled so the week's pieces sum
    to that week's log return (log returns add across weeks; plain returns do not)."""
    weeks = sorted(reconciled.equity)
    by_company: dict[str, float] = {}
    rupees: dict[str, float] = {}
    by_year: dict[int, float] = {}
    by_fy: dict[str, float] = {}
    # The category a holding was opened through, as the backtest labelled its first buy.
    by_category: dict[str, float] = {}
    category_of: dict[str, str] = {}
    opened: dict[date, list[tuple[str, str]]] = {}
    for fill in reconciled.fills:
        label = bundle["claims"]["fills"][fill.index].get("category")
        if fill.action in BUYS and fill.held_before <= 0 and label:
            opened.setdefault(fill.week, []).append((fill.asset, label))
    for before, week in zip(weeks, weeks[1:], strict=False):
        category_of.update(dict(opened.get(before, [])))
        start, end = reconciled.equity[before], reconciled.equity[week]
        change = end / start - 1
        log_return = math.log(end / start)
        scale = (log_return / change if abs(change) > 1e-12 else 1.0) / start
        for name, pnl in reconciled.pnl.get(week, {}).items():
            company = symbol_of(bundle, name)
            by_company[company] = by_company.get(company, 0.0) + pnl * scale
            rupees[company] = rupees.get(company, 0.0) + pnl
            category = category_of.get(name, "(none recorded)")
            by_category[category] = by_category.get(category, 0.0) + pnl * scale
        by_year[week.year] = by_year.get(week.year, 0.0) + log_return
        fy_start = week.year if week.month >= 4 else week.year - 1
        label = f"FY{fy_start}-{(fy_start + 1) % 100:02d}"
        by_fy[label] = by_fy.get(label, 0.0) + log_return

    total = math.log(reconciled.equity[weeks[-1]] / reconciled.equity[weeks[0]])
    ranked = sorted(by_company, key=lambda c: -by_company[c])
    by_rupees = sorted(rupees, key=lambda c: -rupees[c])
    top5 = sum(by_company[c] for c in ranked[:5]) / total
    top_year = max(by_year, key=lambda y: by_year[y])
    top_fy = max(by_fy, key=lambda y: by_fy[y])
    return {
        "total_log_return": total,
        "top5_share": top5,
        "top5": ranked[:5],
        "top_by_rupee_profit": [
            {
                "company": c,
                "profit_x_capital": rupees[c],
                "share_of_log_return": by_company[c] / total,
            }
            for c in by_rupees[:JUMP_KILL_TOP_CONTRIBUTORS]
        ],
        "worst_by_rupee_profit": [
            {
                "company": c,
                "profit_x_capital": rupees[c],
                "share_of_log_return": by_company[c] / total,
            }
            for c in by_rupees[-5:]
        ],
        "companies_traded": len(by_company),
        "by_calendar_year": {str(y): by_year[y] / total for y in sorted(by_year)},
        "by_financial_year": {y: by_fy[y] / total for y in sorted(by_fy)},
        "by_category": {
            c: by_category[c] / total for c in sorted(by_category, key=lambda c: -by_category[c])
        },
        "largest_year": {"year": top_year, "share": by_year[top_year] / total},
        "largest_financial_year": {"year": top_fy, "share": by_fy[top_fy] / total},
        "flags": {
            "top5_over_half": top5 > TOP5_SHARE_FLAG,
            "one_year_over_40pct": max(by_year[top_year], by_fy[top_fy]) / total > SINGLE_YEAR_FLAG,
        },
    }


# --- step 3: days inside a holding that could be a data artefact ---------------------------------


def big_days(bundle: dict, market: Market, reconciled: Replayed) -> list[dict]:
    """Every day a held stock's price, as the backtest saw it (adjusted for confirmed splits
    and bonuses), moved more than 20% from the previous trading day.

    Most NSE stocks cannot move more than 20% in a day, so such a day is one of: a real move in
    a stock with no price band, a restart after a demerger or suspension, a split or bonus the
    adjustment missed, or bad data. Each needs a look."""
    out = []
    for name, spans in holding_spans(reconciled).items():
        asset = bundle["assets"][name]
        if asset["kind"] != "stock":
            continue
        history = market.stocks.get(asset["symbol"])
        if history is None:
            continue
        first = date.fromisoformat(asset["from"]) if asset.get("from") else None
        until = date.fromisoformat(asset["until"]) if asset.get("until") else None
        for start, end in spans:
            for previous, bar in zip(history.bars, history.bars[1:], strict=False):
                if bar.day <= start or (end is not None and bar.day > end):
                    continue
                if (first and previous.day < first) or (until and bar.day >= until):
                    continue
                before = previous.close / history.adjustment(previous.day)
                move = bar.close / history.adjustment(bar.day) / before - 1
                if abs(move) > BIG_DAY:
                    out.append(
                        {
                            "asset": name,
                            "symbol": asset["symbol"],
                            "day": str(bar.day),
                            "previous_day": str(previous.day),
                            "days_between": (bar.day - previous.day).days,
                            "raw_previous_close": previous.close,
                            "raw_close": bar.close,
                            "move": move,
                            "held_from": str(start),
                            "held_until": str(end) if end else None,
                        }
                    )
    return sorted(out, key=lambda row: (row["day"], row["asset"]))


_BONUS = re.compile(r"bonus[^0-9]{0,40}?(\d+)\s*:\s*(\d+)", re.IGNORECASE)
_FACE_VALUE = re.compile(
    r"from\s+r[se]\.?\s*(\d+(?:\.\d+)?)[^0-9]{0,40}?to\s+r[se]\.?\s*(\d+(?:\.\d+)?)", re.IGNORECASE
)
_OTHER_KINDS = ("demerger", "scheme of arrangement", "rights", "capital reduction", "consolidation")


def load_action_feed(folder: Path) -> list[dict]:
    """The exchange's corporate-action filings as cached on disk (`ca_<year>.json`), reduced to
    what changes a share count: (symbol, isin, ex-date, kind, shares multiple, subject)."""
    out = []
    for path in sorted(Path(folder).glob("ca_*.json")):
        for row in json.loads(path.read_text(encoding="utf-8")):
            subject = str(row.get("subject") or "")
            try:
                ex_date = datetime.strptime(str(row.get("exDate")), "%d-%b-%Y").date()
            except ValueError:
                continue
            lower = subject.lower()
            factor, kinds = 1.0, []
            # A bonus paid in preference shares or debentures adds no equity shares.
            other_paper = any(word in lower for word in ("ncrps", "preference", "debenture"))
            bonus = None if other_paper else _BONUS.search(subject)
            if bonus and int(bonus.group(2)) > 0:
                factor *= (int(bonus.group(1)) + int(bonus.group(2))) / int(bonus.group(2))
                kinds.append("bonus")
            if "split" in lower or "sub-division" in lower or "subdivision" in lower:
                face = _FACE_VALUE.search(subject)
                if face and float(face.group(2)) > 0:
                    factor *= float(face.group(1)) / float(face.group(2))
                    kinds.append("split")
            kinds += [k for k in _OTHER_KINDS if k in lower]
            if not kinds:
                continue
            out.append(
                {
                    "symbol": str(row.get("symbol") or "").strip().upper(),
                    "isin": str(row.get("isin") or "").strip().upper(),
                    "ex_date": ex_date,
                    "kinds": kinds,
                    "factor": factor if abs(factor - 1) > 1e-9 else None,
                    "subject": subject.strip(),
                }
            )
    return out


def filed_actions(
    bundle: dict, market: Market, reconciled: Replayed, feed: list[dict]
) -> tuple[list[dict], list[dict]]:
    """Corporate actions the exchange filed with an ex-date inside a holding.

    Returns (share-count actions, other actions). A share-count action (split, bonus) should
    appear in the adjustment factors with the same multiple; `adjusted` says whether it does.
    One that does not was booked by the backtest as a real fall of `booked_as`. Filings that
    share an ex-date are one event (a bonus and a split together multiply). Other actions
    (demerger, rights, a scheme) move value the price series cannot follow."""
    events: dict[tuple[str, date], dict] = {}
    for row in feed:
        event = events.setdefault(
            (row["symbol"], row["ex_date"]), {"factor": 1.0, "kinds": [], "subjects": []}
        )
        event["factor"] *= row["factor"] or 1.0
        event["kinds"] += [k for k in row["kinds"] if k not in event["kinds"]]
        if row["subject"] not in event["subjects"]:
            event["subjects"].append(row["subject"])

    counted, other = [], []
    for name, spans in holding_spans(reconciled).items():
        asset = bundle["assets"][name]
        if asset["kind"] != "stock":
            continue
        history = market.stocks.get(asset["symbol"])
        for (symbol, ex_date), event in events.items():
            if symbol != asset["symbol"]:
                continue
            for start, end in spans:
                if ex_date <= start or (end is not None and ex_date > end):
                    continue
                entry = {
                    "asset": name,
                    "symbol": symbol,
                    "ex_date": str(ex_date),
                    "kinds": event["kinds"],
                    "subject": "; ".join(event["subjects"]),
                    "held_from": str(start),
                    "held_until": str(end) if end else None,
                }
                if abs(event["factor"] - 1) < 1e-9:
                    other.append(entry)
                    continue
                ours = [
                    factor
                    for day, factor in (history.factors if history else [])
                    if abs((day - ex_date).days) <= 3
                ]
                applied = math.prod(ours) if ours else None
                entry["filed_multiple"] = event["factor"]
                entry["applied_multiple"] = applied
                entry["adjusted"] = (
                    applied is not None and abs(applied / event["factor"] - 1) <= 0.02
                )
                if not entry["adjusted"]:
                    entry["booked_as"] = (applied or 1.0) / event["factor"] - 1
                counted.append(entry)

    def in_order(row: dict) -> tuple[str, str]:
        return row["ex_date"], row["asset"]

    return sorted(counted, key=in_order), sorted(other, key=in_order)


def jump_scan(
    bundle: dict, market: Market, reconciled: Replayed, feed: list[dict] | None = None
) -> dict:
    """Step 3: the big days, the filed actions, and what the result is without those days."""
    days = big_days(bundle, market, reconciled)
    profile = contribution(bundle, reconciled)
    top = {row["company"] for row in profile["top_by_rupee_profit"]}
    for row in days:
        row["top_contributor"] = row["symbol"] in top

    shares = decisions(reconciled)
    base = replay(bundle, market, Sizing(shares=shares))
    zeroed: dict[str, list[tuple[date, float]]] = {}
    for row in days:
        zeroed.setdefault(row["symbol"], []).append((date.fromisoformat(row["day"]), row["move"]))
    without = replay(bundle, market, Sizing(shares=shares, zeroed=zeroed)) if zeroed else base
    change = cagr(without.equity) - cagr(base.equity)

    counted, other = (
        filed_actions(bundle, market, reconciled, feed) if feed is not None else ([], [])
    )
    # A split or bonus the adjustment missed shows as a fall that never happened. Taking that
    # one day's fall back out is the same as applying the missing factor.
    missed: dict[str, list[tuple[date, float]]] = {}
    for row in counted:
        if not row["adjusted"]:
            fall = (date.fromisoformat(row["ex_date"]), row["booked_as"])
            if fall not in missed.setdefault(row["symbol"], []):
                missed[row["symbol"]].append(fall)
    repaired = replay(bundle, market, Sizing(shares=shares, zeroed=missed)) if missed else base
    return {
        "big_days": days,
        "cagr": cagr(base.equity),
        "cagr_without_big_days": cagr(without.equity),
        "cagr_change_pts": change * 100,
        "filed_share_count_actions": counted,
        "filed_other_actions": other,
        "cagr_with_missed_actions_adjusted": cagr(repaired.equity),
        "missed_actions_cost_pts": (cagr(repaired.equity) - cagr(base.equity)) * 100,
        "kill": {
            "top_contributor_has_a_big_day": any(row["top_contributor"] for row in days),
            "cagr_moves_over_2pts": abs(change) > JUMP_KILL_CAGR_PTS,
            "share_count_action_not_adjusted": any(not row["adjusted"] for row in counted),
        },
    }


# --- step 6: could a real account have placed these orders ---------------------------------------


def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def realism(bundle: dict, market: Market, reconciled: Replayed) -> dict:
    """Each stock order against how much of that stock usually trades in a day, at the run's
    own capital, then the result when buys are whole shares and capped at 1% of a day's trade.

    The portfolio compounds, so the same strategy that starts with a few lakh places orders
    of tens of lakh years later. This is where that shows."""
    capital = float(bundle["settings"]["capital"])
    rows = []
    for fill in reconciled.fills:
        asset = bundle["assets"][fill.asset]
        if asset["kind"] != "stock":
            continue
        history = market.stocks.get(asset["symbol"])
        typical = history.median_turnover(fill.price_day) if history else None
        if not typical:
            continue
        rupees = fill.amount * capital
        rows.append(
            {
                "week": str(fill.week),
                "action": fill.action,
                "asset": fill.asset,
                "rupees": rupees,
                "median_daily_turnover": typical,
                "participation": rupees / typical,
            }
        )
    shares_of_day = [row["participation"] for row in rows]
    by_year: dict[str, float] = {}
    for row in rows:
        year = row["week"][:4]
        by_year[year] = max(by_year.get(year, 0.0), row["participation"])

    shares = decisions(reconciled)
    base = replay(bundle, market, Sizing(shares=shares))
    whole = replay(bundle, market, Sizing(shares=shares, whole_shares=True))
    capped = replay(
        bundle,
        market,
        Sizing(shares=shares, whole_shares=True, participation_cap=PARTICIPATION_CAP),
    )
    capped_5 = replay(
        bundle,
        market,
        Sizing(shares=shares, whole_shares=True, participation_cap=PARTICIPATION_FLAG),
    )
    last = max(reconciled.equity)

    def idle(run: Replayed) -> float:
        return sum(abs(c) / run.equity[w] for w, c in run.cash.items()) / len(run.cash)

    return {
        "capital_rs": capital,
        "final_portfolio_rs": reconciled.equity[last] * capital,
        "stock_orders": len(rows),
        "over_1pct": sum(p > PARTICIPATION_CAP for p in shares_of_day),
        "over_5pct": sum(p > PARTICIPATION_FLAG for p in shares_of_day),
        "median": _percentile(shares_of_day, 0.5) if shares_of_day else None,
        "p95": _percentile(shares_of_day, 0.95) if shares_of_day else None,
        "max": max(shares_of_day, default=None),
        "max_by_year": dict(sorted(by_year.items())),
        "largest": sorted(rows, key=lambda r: -r["participation"])[:10],
        "cagr": cagr(base.equity),
        "cagr_whole_shares": cagr(whole.equity),
        "cagr_whole_shares_1pct_cap": cagr(capped.equity),
        "cagr_whole_shares_5pct_cap": cagr(capped_5.equity),
        "max_drawdown": max_drawdown(base.equity),
        "max_drawdown_1pct_cap": max_drawdown(capped.equity),
        "average_unspent_share_1pct_cap": idle(capped),
        "average_unspent_share_5pct_cap": idle(capped_5),
        "flag_any_order_over_5pct": any(p > PARTICIPATION_FLAG for p in shares_of_day),
    }


# --- step 7: filling at the next open instead of the close ---------------------------------------


def monday_open(bundle: dict, market: Market, reconciled: Replayed) -> dict:
    """The same decisions filled twice: at the week's close, as the backtest assumes, and at
    the next trading day's open, the first moment an order decided on that close can trade."""
    shares = decisions(reconciled)
    at_close = replay(bundle, market, Sizing(shares=shares))
    at_open = replay(bundle, market, Sizing(shares=shares, fill_at="next_open"))
    close_price = {f.index: f for f in at_close.fills}
    gaps = {"buy": [], "sell": []}
    no_open = 0
    for fill in at_open.fills:
        other = close_price.get(fill.index)
        if other is None or bundle["assets"][fill.asset]["kind"] == "liquid_fund":
            continue
        if fill.price_day <= fill.week:
            no_open += 1  # did not trade in the following week: filled at the carried close
            continue
        side = "buy" if fill.action in BUYS else "sell"
        gaps[side].append((fill.price / other.price - 1, other.amount))

    def weighted(rows: list[tuple[float, float]]) -> float | None:
        weight = sum(w for _g, w in rows)
        return sum(g * w for g, w in rows) / weight if weight else None

    change = cagr(at_open.equity) - cagr(at_close.equity)
    return {
        "signal_delay": bundle["settings"].get("signal_delay"),
        "cagr_at_close": cagr(at_close.equity),
        "cagr_at_next_open": cagr(at_open.equity),
        "cagr_change_pts": change * 100,
        "max_drawdown_at_close": max_drawdown(at_close.equity),
        "max_drawdown_at_next_open": max_drawdown(at_open.equity),
        "max_drawdown_change_pts": (max_drawdown(at_open.equity) - max_drawdown(at_close.equity))
        * 100,
        "average_gap_on_buys": weighted(gaps["buy"]),
        "average_gap_on_sells": weighted(gaps["sell"]),
        "orders_repriced": len(gaps["buy"]) + len(gaps["sell"]),
        "orders_with_no_open_that_week": no_open,
        "flag_cagr_falls_over_1pt": change < -MONDAY_OPEN_FLAG_PTS,
    }


def baseline_matches(bundle: dict, market: Market, reconciled: Replayed) -> float:
    """How far "the same decisions at the same prices" lands from the reconciliation: the
    what-if machinery's own error, which has to be nil before its answers mean anything."""
    again = replay(bundle, market, Sizing(shares=decisions(reconciled)))
    return max(abs(again.equity[w] / reconciled.equity[w] - 1) for w in reconciled.equity)


STUDIES = {
    "contribution": lambda bundle, market, mine, feed: contribution(bundle, mine),
    "jumps": lambda bundle, market, mine, feed: jump_scan(bundle, market, mine, feed),
    "realism": lambda bundle, market, mine, feed: realism(bundle, market, mine),
    "monday-open": lambda bundle, market, mine, feed: monday_open(bundle, market, mine),
}


def headline(name: str, result: dict) -> str:
    """One line a person can read, for the terminal."""
    if name == "contribution":
        year = result["largest_financial_year"]
        return (
            f"top five companies {result['top5_share']:.0%} of the compounded return "
            f"({', '.join(result['top5'])}); largest year {year['year']} {year['share']:.0%}"
        )
    if name == "jumps":
        missed = [a for a in result["filed_share_count_actions"] if not a["adjusted"]]
        return (
            f"{len(result['big_days'])} days over 20% while held "
            f"(without them CAGR {result['cagr_change_pts']:+.2f} pts); "
            f"{len(missed)} filed splits or bonuses missed "
            f"(adjusting them {result['missed_actions_cost_pts']:+.2f} pts)"
        )
    if name == "realism":
        return (
            f"{result['over_5pct']} of {result['stock_orders']} orders over 5% of a day's trade "
            f"(largest {result['max']:.1%}); CAGR {result['cagr']:.2%}, whole shares "
            f"{result['cagr_whole_shares']:.2%}, and a 1% cap "
            f"{result['cagr_whole_shares_1pct_cap']:.2%}"
        )
    return (
        f"CAGR filled at the close {result['cagr_at_close']:.2%}, at the next open "
        f"{result['cagr_at_next_open']:.2%} ({result['cagr_change_pts']:+.2f} pts)"
    )
