"""BL-025's registered drawdown-rule test (backlog/BL-025, Experiments, "2026-10-28 - Drawdown
rules with a way back in"; numbers in `search_spaces/bl025_rules_criteria.json`).

Research only. Nothing here trades, reads the live-rules file, or reaches the weekly check. The
code holds the mechanics; every number (the lines, the average's length, the rebound, X, the
35% limit) is read from the criteria file, never restated.

The registered mechanics, and where each lives:

- `decide`: the size path of one candidate over one object's **model curve** (full size, never
  the money held). The decision is made on Friday t's close from closes up to and including t
  only: the high is a running maximum since the object's first week or the last return to full
  size, the moving average is the mean of closes t-39..t (undefined before 40 closes exist), the
  low is the lowest close since the action. A week that crosses both lines goes straight to 0;
  while at half size the exit line is measured from the same high.
- `simulate`: the money held. The size decided at t applies from the return t -> t+1 (asserted:
  look-ahead check 3). A size change sells or buys that share of every holding and nothing else
  trades, so between changes the invested part follows the model curve and the rest earns the
  weekly table's `Cash (liquid fund)` series. Costs are the engine's itemised rates at Rs 2 lakh.
- `measures` / `judge`: the registered measures and the pass / kill / tie-break rule.

Clarifications recorded in the BL-025 Log before the run (mechanical, not chosen from results):
"the action" is the latest size change (the cut while at half, the exit while at zero) and "since
the action" counts that Friday's own close; the high after a return to full size starts at the
close of the Friday the return is decided; a Friday at half size on which the exit line and the
way back are both met has no registered order, so `decide` raises `Unregistered` rather than
choose; the last Friday's decision has no next return and books no trade.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import choose, metrics
from .engine import (
    _LIQUID_FUND,
    DP_CHARGE_FRACTION_CAP,
    DP_CHARGE_RS,
    EXCHANGE_FEES_RATE,
    LIQUID_FUND_STAMP_DUTY_RATE,
    STAMP_DUTY_BUY_RATE,
    STT_RATE,
)
from .tax import EQUITY, TaxLedger, TaxRules

CRITERIA_PATH = Path(__file__).resolve().parents[2] / "search_spaces" / "bl025_rules_criteria.json"

FULL, HALF, ZERO = 1.0, 0.5, 0.0

#: How each registered candidate gets back to full size. The kind is code; every number comes
#: from the criteria file. "none" = R0 (no lines at all).
_KINDS = {
    "R0_hold_through": "none",
    "R1_as_written": "never",
    "R2_back_at_the_high": "high",
    "R3_trend_back": "sma",
    "R4_rebound_back": "rebound",
    "R5_owner_band_trend_back": "sma",
}


class Unregistered(RuntimeError):
    """A case the pre-registration does not decide. The run stops and the case is reported."""


def load_criteria(path: Path = CRITERIA_PATH) -> dict:
    return json.loads(Path(path).read_text())


@dataclass(frozen=True)
class Candidate:
    key: str
    cut: float | None
    exit: float | None
    back: str  # none | never | high | sma | rebound
    sma_weeks: int | None = None
    rebound: float | None = None

    @property
    def label(self) -> str:
        return self.key.split("_", 1)[0]


def candidates(criteria: dict | None = None) -> list[Candidate]:
    """The six scored candidates, R0-R5, in the registered order. N is never scored."""
    criteria = criteria or load_criteria()
    raw = criteria["candidates"]
    out = []
    for key, kind in _KINDS.items():
        spec = raw[key]
        sma = spec.get("sma_weeks")
        if spec.get("back_to_full") == "as R3":  # R5 takes R3's way back with its own lines
            sma = sma or raw["R3_trend_back"]["sma_weeks"]
        out.append(
            Candidate(
                key=key,
                cut=spec.get("cut_half_at"),
                exit=spec.get("exit_at"),
                back=kind,
                sma_weeks=sma if kind == "sma" else None,
                rebound=spec.get("rebound") if kind == "rebound" else None,
            )
        )
    scored = [k for k, v in raw.items() if v.get("backtested", True)]
    if sorted(scored) != sorted(_KINDS):
        raise ValueError(f"the criteria's scored candidates {scored} are not R0-R5")
    return out


# --- the size path --------------------------------------------------------------------------


@dataclass(frozen=True)
class Action:
    i: int  # the Friday (position in the curve) the decision is made on
    kind: str  # cut | exit | back
    before: float
    after: float


def decide(curve: np.ndarray | pd.Series, cand: Candidate) -> tuple[np.ndarray, list[Action]]:
    """The size decided at each Friday's close (`sizes[t]` applies from the return t -> t+1)
    and the size changes. Reads `curve[: t + 1]` only at step t (look-ahead check 1 and 2)."""
    c = np.asarray(curve, dtype=float)
    n = len(c)
    sizes = np.empty(n)
    actions: list[Action] = []
    state = FULL
    high = -math.inf  # running max since the first week or the last return to full size
    low = math.inf  # lowest close since the action
    below = False  # closed below the average on some Friday since the action
    csum = np.concatenate([[0.0], np.cumsum(c)])

    def sma(t: int) -> float | None:
        w = cand.sma_weeks
        if w is None or t + 1 < w:  # fewer than w closes since the object's first week
            return None
        return float((csum[t + 1] - csum[t + 1 - w]) / w)

    def way_back(t: int, prev_high: float) -> bool:
        if cand.back == "never":
            return False
        if cand.back == "high":
            return bool(c[t] >= prev_high)
        if cand.back == "sma":
            avg = sma(t)
            return bool(below and avg is not None and c[t] > avg)
        if cand.back == "rebound":
            return bool(c[t] >= (1 + cand.rebound) * min(low, c[t]))
        raise ValueError(cand.back)

    for t in range(n):
        if not np.isfinite(c[t]) or c[t] <= 0:
            raise ValueError(f"model curve has no usable close at position {t}")
        prev_high = high
        high = max(high, c[t])
        dd = c[t] / high - 1
        new, kind = state, None
        if cand.back == "none":
            pass
        elif state == FULL:
            if dd <= -cand.exit:  # a week that crosses both lines goes straight to 0
                new, kind = ZERO, "exit"
            elif dd <= -cand.cut:
                new, kind = HALF, "cut"
        else:
            back = way_back(t, prev_high)
            exit_hit = state == HALF and dd <= -cand.exit
            if exit_hit and back:
                raise Unregistered(
                    f"{cand.label}: at position {t} the exit line and the way back are both met "
                    "at half size; the pre-registration gives no order"
                )
            if exit_hit:
                new, kind = ZERO, "exit"
            elif back:
                new, kind = FULL, "back"
        if kind is not None:
            actions.append(Action(t, kind, state, new))
            state = new
            if new == FULL:
                high = c[t]  # the high is measured again from this Friday's close
                low, below = math.inf, False
            else:  # a new action: the low and the average test start from this close
                low = c[t]
                avg = sma(t)
                below = bool(avg is not None and c[t] < avg)
        elif state != FULL:
            low = min(low, c[t])
            avg = sma(t)
            if avg is not None and c[t] < avg:
                below = True
        sizes[t] = state
    return sizes, actions


def delayed(sizes: np.ndarray, weeks: int = 1) -> np.ndarray:
    """The reported-only variant: every action `weeks` later (the owner acts a week late)."""
    if weeks <= 0:
        return sizes.copy()
    out = np.empty_like(sizes)
    out[:weeks] = FULL
    out[weeks:] = sizes[:-weeks]
    return out


def delayed_actions(actions: list[Action], n: int, weeks: int = 1) -> list[Action]:
    """The actions of `delayed(sizes, weeks)`: each one `weeks` later, dropped past the curve."""
    return [Action(a.i + weeks, a.kind, a.before, a.after) for a in actions if a.i + weeks < n]


def prefix_check(curve: np.ndarray | pd.Series, cand: Candidate) -> list[int]:
    """Look-ahead check 1: the positions t where the size path computed on the curve cut at t
    differs from the full run's path up to t (empty = passes)."""
    c = np.asarray(curve, dtype=float)
    full, _ = decide(c, cand)
    bad = []
    for t in range(len(c)):
        cut, _ = decide(c[: t + 1], cand)
        if not np.array_equal(cut, full[: t + 1]):
            bad.append(t)
    return bad


# --- holdings, costs and tax ----------------------------------------------------------------


@dataclass
class Component:
    """One engine run inside an object (a sleeve, or a lot of a ramp): its model equity, its
    weights after each week's trades, and its trade log for the tax lots."""

    equity: pd.Series
    weights: pd.DataFrame
    trades: pd.DataFrame
    tax_classes: dict[str, str] = field(default_factory=dict)
    _lots_cache: dict = field(default_factory=dict, repr=False)

    def weights_at(self, week: pd.Timestamp) -> pd.Series:
        rows = self.weights.loc[:week]
        if not len(rows):
            return pd.Series(dtype=float)
        row = rows.iloc[-1]
        return row[row > 0]

    def lots_at(self, week: pd.Timestamp) -> dict[str, list[dict]]:
        """The open tax lots after `week`'s trades, rebuilt from the trade log the way the
        buffer rule keeps them: a buy adds a lot {units, since, basis}, a sale takes the same
        fraction of every lot."""
        if week in self._lots_cache:
            return self._lots_cache[week]
        lots: dict[str, list[dict]] = {}
        rows = self.trades[self.trades["week"] <= week] if len(self.trades) else self.trades
        for row in rows.itertuples(index=False):
            asset, action = row.asset, row.action
            if asset in _LIQUID_FUND:
                continue  # the liquid fund: the overlay never sells it, so no lot is needed
            if action in ("BUY", "ADD"):
                lots.setdefault(asset, []).append(
                    {"units": float(row.units), "since": row.week, "basis": row.value - row.cost}
                )
            elif action in ("SELL", "TRIM", "STOP"):
                held = lots.get(asset, [])
                before = sum(lot["units"] for lot in held)
                fraction = min(float(row.units) / before, 1.0) if before > 0 else 1.0
                for lot in held:
                    lot["units"] *= 1 - fraction
                    lot["basis"] *= 1 - fraction
                if fraction >= 1 - 1e-9:
                    lots.pop(asset, None)
            elif action in ("PARK", "UNPARK"):
                continue
            else:
                raise ValueError(f"unknown trade action {action!r}")
        self._lots_cache[week] = lots
        return lots


@dataclass(frozen=True)
class Rates:
    """The engine's itemised rates (round7_A.toml: cost_model itemised, slippage 15 bps)."""

    slippage_bps: float

    @property
    def sell(self) -> float:
        return STT_RATE + EXCHANGE_FEES_RATE + self.slippage_bps / 10000

    @property
    def buy(self) -> float:
        return STT_RATE + STAMP_DUTY_BUY_RATE + EXCHANGE_FEES_RATE + self.slippage_bps / 10000

    def dp(self, value_rs: float) -> float:
        """The flat per-sell DP charge on one scrip, capped as the engine caps it."""
        if value_rs <= 0:
            return 0.0
        return min(DP_CHARGE_RS, DP_CHARGE_FRACTION_CAP * value_rs)


class Book:
    """What an object holds each week: its components and each one's share of the object's
    model value. A sleeve is one component with share 1; the blend four, weighted as
    `choose.ensemble_curve` weights them; a ramp its lots, weighted by value."""

    def __init__(self, components: list[Component], shares: pd.DataFrame, rates: Rates) -> None:
        self.components = components
        self.shares = shares  # week x component position, rows sum to 1
        self.rates = rates

    def holdings(self, week: pd.Timestamp) -> dict[str, float]:
        """Each non-liquid asset's share of the object's model value after `week`'s trades."""
        out: dict[str, float] = {}
        for j, comp in enumerate(self.components):
            share = float(self.shares.at[week, j]) if week in self.shares.index else 0.0
            if share <= 0:
                continue
            for asset, w in comp.weights_at(week).items():
                if asset in _LIQUID_FUND:
                    continue
                out[asset] = out.get(asset, 0.0) + share * float(w)
        return out

    def sell_cost(self, week: pd.Timestamp, q: float, invested_rs: float) -> tuple[float, float]:
        """(cost in rupees, equity value sold) for selling `q` of every holding."""
        held = self.holdings(week)
        sold = {a: q * invested_rs * w for a, w in held.items()}
        total = sum(sold.values())
        cost = total * self.rates.sell + sum(self.rates.dp(v) for v in sold.values())
        # the equity proceeds go into the liquid fund (stamp duty only); the model's own idle
        # share is already in it and does not trade
        cost += (total - cost) * LIQUID_FUND_STAMP_DUTY_RATE
        return cost, total

    def buy_cost(self, week: pd.Timestamp, cash_rs: float) -> tuple[float, float]:
        """(cost in rupees, equity value bought) for putting `cash_rs` back into every holding
        (the model's own idle share stays in the liquid fund, which costs nothing to sell)."""
        equity_share = sum(self.holdings(week).values())
        bought = cash_rs * equity_share
        return bought * self.rates.buy, bought

    def sale_tax(self, week: pd.Timestamp, q: float, invested_rs: float) -> float:
        """The estimated tax of selling `q` of every holding, from each component's open tax
        lots on `week` (tax.py's rules; losses offset gains within this sale only). Reported,
        never deducted: the money held is pre-tax."""
        sales: list[tuple[str, float, int]] = []
        for j, comp in enumerate(self.components):
            share = float(self.shares.at[week, j]) if week in self.shares.index else 0.0
            equity = float(comp.equity.get(week, np.nan))
            if share <= 0 or not equity > 0:
                continue
            k = invested_rs * share / equity  # rupees per model unit
            weights = comp.weights_at(week)
            for asset, lots in comp.lots_at(week).items():
                units = sum(lot["units"] for lot in lots)
                value = float(weights.get(asset, 0.0)) * equity
                if units <= 0 or value <= 0:
                    continue
                for lot in lots:
                    lot_value = lot["units"] / units * value
                    gain = q * k * (lot_value * (1 - self.rates.sell) - lot["basis"])
                    held_days = (week - lot["since"]).days
                    sales.append((comp.tax_classes.get(asset, EQUITY), gain, held_days))
        ledger = TaxLedger(TaxRules())
        # the sale's losses first, so they offset its gains (tax.py's set-off rules)
        return sum(ledger.sale(*s) for s in sorted(sales, key=lambda s: s[1] > 0))


# --- the money held -------------------------------------------------------------------------


@dataclass
class Trade:
    week: pd.Timestamp
    before: float
    after: float
    traded_rs: float
    cost_rs: float
    tax_rs: float


@dataclass
class Money:
    value: pd.Series  # rupees, after the Friday's trade
    in_force: np.ndarray  # the size each week's return was earned at (position t: t-1 -> t)
    trades: list[Trade]


def simulate(
    model: pd.Series,
    cash: pd.Series,
    sizes: np.ndarray,
    book: Book | None = None,
    capital: float = 200_000.0,
) -> Money:
    """The money held under `sizes`. The size decided at Friday t multiplies the return from t
    to t+1, never the return ending at t (look-ahead check 3, asserted below)."""
    weeks = model.index
    m = model.to_numpy(dtype=float)
    k = cash.reindex(weeks).to_numpy(dtype=float)
    if np.isnan(k).any():
        raise ValueError("the cash series does not cover every week of the model curve")
    n = len(m)
    invested, idle = capital, 0.0
    current, decided_at = FULL, -1
    values = np.empty(n)
    in_force = np.full(n, np.nan)
    trades: list[Trade] = []
    for t in range(n):
        if t > 0:
            assert decided_at < t, "a size decided at t must not touch the return ending at t"
            invested *= m[t] / m[t - 1]
            idle *= k[t] / k[t - 1]
            in_force[t] = current
        target = float(sizes[t])
        if target != current and t < n - 1:  # the last Friday's decision has no next return
            week = weeks[t]
            if target < current:
                q = 1 - target / current
                cost, traded = book.sell_cost(week, q, invested) if book else (0.0, 0.0)
                tax = book.sale_tax(week, q, invested) if book else 0.0
                idle += q * invested - cost
                invested -= q * invested
            else:
                cost, traded = book.buy_cost(week, idle) if book else (0.0, 0.0)
                tax = 0.0
                invested += idle - cost
                idle = 0.0
            trades.append(Trade(week, current, target, traded, cost, tax))
            current, decided_at = target, t
        values[t] = invested + idle
    return Money(pd.Series(values, index=weeks), in_force, trades)


# --- objects ----------------------------------------------------------------------------------


def blend_shares(curves: pd.DataFrame) -> pd.DataFrame:
    """Each sleeve's share of `choose.ensemble_curve`'s blend (equal capital, reset each
    April), after the Friday's reset."""
    from . import groups

    weeks = curves.index
    resets = groups.reset_weeks(weeks)
    out = pd.DataFrame(index=weeks, columns=range(curves.shape[1]), dtype=float)
    for i, start in enumerate(resets):
        end = resets[i + 1] if i + 1 < len(resets) else weeks[-1]
        span = curves.loc[start:end]
        rel = span / span.iloc[0]
        part = rel.div(rel.sum(axis=1), axis=0)
        part.columns = range(curves.shape[1])
        out.loc[part.index] = part.to_numpy()  # a reset week takes the new segment's equal split
    return out


def lot_shares(lots: list[pd.Series], weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """Each lot's share of a ramp by value (lots are equal, 1.0 at their own first week)."""
    frame = pd.concat([lot.reindex(weeks) for lot in lots], axis=1)
    frame.columns = range(len(lots))
    return frame.div(frame.sum(axis=1), axis=0).fillna(0.0)


# --- measures ---------------------------------------------------------------------------------


def falls(model: pd.Series, depth: float) -> list[dict]:
    """The model curve's falls of `depth` or more: peak, lowest close, recovery (the first
    close back at the peak, or None)."""
    dd = metrics.drawdown(model)
    out, i, idx = [], 0, model.index
    values = dd.to_numpy()
    n = len(values)
    while i < n:
        if values[i] < 0:
            start = i
            while i < n and values[i] < 0:
                i += 1
            seg = dd.iloc[start:i]
            if seg.min() <= -depth:
                low = seg.idxmin()
                out.append(
                    {
                        "peak": idx[start - 1],
                        "low": low,
                        "depth": float(seg.min()),
                        "recovered": idx[i] if i < n else None,
                    }
                )
        i += 1
    return out


def _weeks(a: pd.Timestamp, b: pd.Timestamp) -> int:
    return round((b - a).days / 7)


def measures(
    model: pd.Series,
    money: Money,
    actions: list[Action],
    reference: Money,
    *,
    fall_depth: float,
    exit_window_weeks: int,
) -> dict:
    """The registered measures for one candidate on one object. `reference` is R0's money."""
    v = money.value
    depth, peak, trough = metrics.max_drawdown(v)
    weeks = model.index
    in_force = money.in_force[1:]
    n = len(in_force)
    cagr, ref_cagr = float(choose.cagr(v)), float(choose.cagr(reference.value))
    out = {
        "end_wealth": float(v.iloc[-1] / v.iloc[0]),
        "cagr": cagr,
        "give_up_pts": (ref_cagr - cagr) * 100,
        "worst_fall": float(depth),
        "worst_fall_peak": str(peak.date()),
        "worst_fall_date": str(trough.date()),
        "weeks": n,
        "weeks_half": int((in_force == HALF).sum()),
        "weeks_zero": int((in_force == ZERO).sum()),
        "share_half": float((in_force == HALF).sum() / n) if n else 0.0,
        "share_zero": float((in_force == ZERO).sum() / n) if n else 0.0,
        "size_changes": len(money.trades),
        "costs_rs": float(sum(t.cost_rs for t in money.trades)),
        "tax_rs_estimated": float(sum(t.tax_rs for t in money.trades)),
        "trades": [
            {
                "week": str(t.week.date()),
                "from": t.before,
                "to": t.after,
                "traded_rs": round(t.traded_rs, 2),
                "cost_rs": round(t.cost_rs, 2),
                "tax_rs_estimated": round(t.tax_rs, 2),
            }
            for t in money.trades
        ],
        "actions": [
            {"week": str(weeks[a.i].date()), "kind": a.kind, "from": a.before, "to": a.after}
            for a in actions
        ],
    }
    # Per fall of the model curve: what the rules did in it and the CAGR given up in it.
    episodes = falls(model, fall_depth)
    ratio = np.log(reference.value / v)
    years = (weeks[-1] - weeks[0]).days / 365.25
    total = float(ratio.iloc[-1] - ratio.iloc[0])
    bounds = [weeks[0]] + [e["peak"] for e in episodes] + [weeks[-1]]
    segments = []
    for a, b in zip(bounds[:-1], bounds[1:], strict=True):
        segments.append(float(ratio.loc[b] - ratio.loc[a]))
    gap = out["give_up_pts"]
    fall_rows = []
    for k, e in enumerate(episodes):
        end = e["recovered"] if e["recovered"] is not None else weeks[-1]
        inside = [a for a in actions if e["peak"] < weeks[a.i] <= end]
        cuts = [a for a in inside if a.kind == "cut"]
        exits = [a for a in inside if a.kind == "exit"]
        backs = [a for a in actions if a.kind == "back" and e["low"] < weeks[a.i] <= end]
        delta = segments[k + 1]
        fall_rows.append(
            {
                "peak": str(e["peak"].date()),
                "low": str(e["low"].date()),
                "depth": e["depth"],
                "recovered": str(e["recovered"].date()) if e["recovered"] is not None else None,
                "cut_without_exit": bool(cuts) and not exits,
                "cuts_weeks_to_low": [_weeks(weeks[a.i], e["low"]) for a in cuts],
                "exits_weeks_to_low": [_weeks(weeks[a.i], e["low"]) for a in exits],
                "exits_within_window_before_low": sum(
                    0 <= _weeks(weeks[a.i], e["low"]) <= exit_window_weeks for a in exits
                ),
                "returns_to_full": [
                    {
                        "week": str(weeks[a.i].date()),
                        "weeks_from_low": _weeks(e["low"], weeks[a.i]),
                        "model_rise_from_low": float(model.iloc[a.i] / model.loc[e["low"]] - 1),
                    }
                    for a in backs
                ],
                "segment": [str(bounds[k + 1].date()), str(bounds[k + 2].date())],
                "give_up_log_per_year": delta / years * 100,
                "give_up_pts_allocated": gap * delta / total if abs(total) > 1e-12 else 0.0,
            }
        )
    out["falls"] = fall_rows
    out["before_first_fall"] = {
        "segment": [str(bounds[0].date()), str(bounds[1].date())],
        "give_up_log_per_year": segments[0] / years * 100,
        "give_up_pts_allocated": gap * segments[0] / total if abs(total) > 1e-12 else 0.0,
    }
    out["cuts_not_followed_by_exit"] = sum(f["cut_without_exit"] for f in fall_rows)
    return out


def judge(scores: dict, criteria: dict, qualifying: list[str]) -> dict:
    """The registered pass / kill / tie-break rule. `scores[cand][object]` holds `measures`;
    objects are 'sleeve_0'..'sleeve_3', 'blend' and 'ramp_<first Friday>'."""
    rule = criteria["pass"]["replaces_current_rules_only_if_all"]
    max_fall = rule["worst_fall_of_money_held_max"]
    max_give = rule["cagr_give_up_vs_hold_through_max_pts"]
    out: dict = {"candidates": {}, "qualifying_ramps": qualifying}
    for cand, objects in scores.items():
        falls_ok = {o: m["worst_fall"] >= -max_fall for o, m in objects.items()}
        a = all(falls_ok.values())
        blend_give = objects["blend"]["give_up_pts"]
        ramp_gives = [objects[o]["give_up_pts"] for o in qualifying]
        median = float(np.median(ramp_gives)) if ramp_gives else math.nan
        judged_median = len(qualifying) >= 3
        row = {
            "a_worst_fall_ok": a,
            "a_failed_on": sorted(o for o, ok in falls_ok.items() if not ok),
            "blend_give_up_pts": blend_give,
            "ramp_median_give_up_pts": median,
            "ramp_median_judged": judged_median,
            "worst_ramp_fall": min(
                (m["worst_fall"] for o, m in objects.items() if "ramp" in o), default=math.nan
            ),
        }
        if cand.startswith("R0"):
            row["b_give_up_ok"] = None  # zero by definition: R0 is judged by (a) only
            row["verdict"] = "pass" if a else "kill"
        else:
            b = blend_give <= max_give and (not judged_median or median <= max_give)
            row["b_give_up_ok"] = bool(b)
            row["verdict"] = "pass" if a and b else "kill"
        out["candidates"][cand] = row
    passing = [
        c for c, r in out["candidates"].items() if r["verdict"] == "pass" and not c.startswith("R0")
    ]
    order = ["R1", "R2", "R4", "R3", "R5"]
    named = None
    if passing:
        best = max(passing, key=lambda c: scores[c]["blend"]["end_wealth"])
        near = [
            c
            for c in passing
            if scores[best]["blend"]["cagr"] - scores[c]["blend"]["cagr"] <= 0.01 + 1e-12
        ]
        named = min(near, key=lambda c: order.index(c.split("_", 1)[0]))
        out["best_end_wealth"] = best
        out["within_one_point"] = near
    out["passing"] = passing
    out["named"] = named
    r0 = next(c for c in out["candidates"] if c.startswith("R0"))
    out["r0_passes_a"] = out["candidates"][r0]["verdict"] == "pass"
    return out
