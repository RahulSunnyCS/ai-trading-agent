"""Weekly momentum rotation backtest.

Each Friday close:
  1. Rank every eligible instrument on each lookback's return (1 = best). An instrument is
     eligible once it has history for the longest lookback.
  2. Score = weighted sum of those ranks; lowest score is the strongest momentum.
  3. Sell a holding once its rank is worse than `exit_rank` (or, in `filter` mode, once its
     return over `filter_lookback` no longer beats cash).
  4. Reinvest, according to the portfolio rule.
Trades execute at that same Friday close (or `signal_delay` weeks after the signal), paying
`cost_pct` on each side.

Portfolio rules:
  buffer  (default) Hold everything bought until its rank passes `exit_rank`, so the number
          of holdings floats between `top_n` and `exit_rank`. Sale proceeds are split equally
          across the current top N - topping up ones already held, buying the rest. A name
          that enters the top N when nothing was sold either waits for the next sale
          (`entry="wait"`) or is bought at once by trimming every holding by the same
          percentage (`entry="make_room"`). No ETF may exceed `max_position` of the portfolio:
          buys and top-ups stop at the cap (the excess goes to the other top-N names, or waits in
          the liquid fund), and a holding that grows past the cap by more than `cap_band` is
          trimmed back to it.
  slots   Exactly `top_n` equal slots at the start, each compounding on its own: a sale's
          proceeds buy the best-ranked name not held, and nothing is ever topped up.

Defensive modes:
  off     always invested in the ranked instruments
  ranked  cash and gilt are ranked alongside everything else and can be held
  filter  only buy or keep an instrument whose `filter_lookback` return beats cash; money
          with nowhere to go waits in the liquid fund
"""

import copy
import functools
import math
import operator
from dataclasses import dataclass, field
from typing import Literal

import pandas as pd

from .tax import DEBT, TaxLedger, TaxRules

CASH = "Cash (liquid fund)"
GILT = "Gilt 8-13 yr"
BENCHMARK = "Nifty 50"
IDLE = "Idle cash"  # money parked in the liquid fund because nothing qualified
_POOL = "__pool__"  # the buffer rule's idle-money position, priced as the liquid fund
MIN_TRADE = 0.005  # don't move parked cash for less than 0.5% of the portfolio

DefensiveMode = Literal["off", "ranked", "filter"]
PortfolioRule = Literal["buffer", "slots"]
EntryRule = Literal["wait", "make_room"]


@dataclass(frozen=True)
class Config:
    lookbacks: tuple[int, ...] = (1, 4, 13, 26, 52)
    weights: tuple[float, ...] | None = None  # None = equal weights
    top_n: int = 5
    exit_rank: int = 10
    cost_pct: float = 0.10  # per side, in percent
    defensive: DefensiveMode = "off"
    filter_lookback: int = 13
    start: str = "2017-01-01"
    include_optional: bool = False
    # Weeks between the close the signal is computed on and the close we trade at. 0 trades
    # at the signal's own close (slightly optimistic); 1 acts a full week late (pessimistic).
    signal_delay: int = 0
    end: str | None = None  # last week of the backtest (None = latest data)
    tax: TaxRules | None = None  # None = pre-tax
    # Exactly which instruments to rank (None = every `core` one, plus `optional` if
    # include_optional). Defensive instruments listed here are ranked only in `ranked` mode;
    # the liquid fund is always used for idle money whether listed or not.
    universe: tuple[str, ...] | None = None
    benchmark: str = BENCHMARK
    portfolio: PortfolioRule = "buffer"
    entry: EntryRule = "wait"  # buffer rule only
    # Largest share of the portfolio one ETF may hold (buffer rule only; None = no cap). A
    # holding is trimmed back to the cap only once it passes cap + cap_band, so small drifts
    # above the cap don't cause a trade (and a tax bill) every week.
    max_position: float | None = 0.35
    cap_band: float = 0.05

    def __post_init__(self) -> None:
        if self.weights is not None and len(self.weights) != len(self.lookbacks):
            raise ValueError("weights must have one value per lookback")
        if self.weights is not None and any(w < 0 for w in self.weights):
            raise ValueError("weights can't be negative")
        if self.exit_rank < self.top_n:
            raise ValueError("exit_rank must be >= top_n, or a new buy would be sold at once")
        if self.defensive not in ("off", "ranked", "filter"):
            raise ValueError(f"unknown defensive mode {self.defensive!r}")
        if self.portfolio not in ("buffer", "slots"):
            raise ValueError(f"unknown portfolio rule {self.portfolio!r}")
        if self.entry not in ("wait", "make_room"):
            raise ValueError(f"unknown entry rule {self.entry!r}")
        if self.max_position is not None and not 0 < self.max_position <= 1:
            raise ValueError("max_position must be between 0 and 1 (e.g. 0.35 for 35%)")
        if self.cap_band < 0:
            raise ValueError("cap_band can't be negative")

    @property
    def label(self) -> str:
        cap = f"-cap{round(self.max_position * 100)}" if self.max_position else ""
        rule = f"buffer-{self.entry}{cap}" if self.portfolio == "buffer" else "slots"
        return (
            f"{rule}_{self.defensive}_top{self.top_n}_exit{self.exit_rank}_"
            f"lb{'-'.join(map(str, self.lookbacks))}"
        )


@dataclass
class Result:
    config: Config
    equity: pd.Series  # portfolio value, 1.0 at the start
    benchmark: pd.Series  # config.benchmark, 1.0 at the start
    cash: pd.Series  # liquid fund, 1.0 at the start
    # Share of the portfolio in each instrument after each week's trades (IDLE = parked cash).
    weights: pd.DataFrame
    # Slots rule: what each slot held each week. Buffer rule: the list of holdings each week.
    holdings: pd.DataFrame
    trades: pd.DataFrame
    ranks: pd.DataFrame  # final rank per instrument per week (NaN = not eligible)
    scores: pd.DataFrame  # composite score per instrument per week
    ranked_names: list[str] = field(default_factory=list)
    tax_ledger: TaxLedger | None = None
    open_positions: pd.DataFrame = field(default_factory=pd.DataFrame)
    idle_value: float = 0.0  # money parked in the liquid fund at the end


def ranked_universe(names: dict[str, str], config: Config) -> list[str]:
    """names maps instrument -> include (core/optional/defensive)."""
    if config.universe is not None:
        unknown = sorted(set(config.universe) - set(names))
        if unknown:
            raise ValueError(f"unknown instruments {unknown}")
        chosen = [n for n in config.universe if names[n] != "defensive"]
        if config.defensive == "ranked":
            chosen += [n for n in config.universe if names[n] == "defensive"]
        return chosen
    allowed = {"core"} | ({"optional"} if config.include_optional else set())
    chosen = [n for n, include in names.items() if include in allowed]
    if config.defensive == "ranked":
        chosen += [n for n in (CASH, GILT) if n in names]
    return chosen


def compute_ranks(prices: pd.DataFrame, config: Config) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(final rank, composite score) per instrument per week. Only uses prices up to each week."""
    weights = config.weights or tuple(1.0 for _ in config.lookbacks)
    returns = {k: prices / prices.shift(k) - 1 for k in config.lookbacks}
    eligible = functools.reduce(operator.and_, (r.notna() for r in returns.values()))

    score = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    for weight, k in zip(weights, config.lookbacks, strict=True):
        rank_k = returns[k].where(eligible).rank(axis=1, ascending=False, method="min")
        score = score + weight * rank_k
    score = score.where(eligible)

    # Ties on score are broken by the middle lookback's return, then by name, so a run is
    # reproducible regardless of column order.
    tie_break = returns[config.lookbacks[len(config.lookbacks) // 2]]
    final = pd.DataFrame(index=prices.index, columns=prices.columns, dtype=float)
    for week in prices.index:
        row = score.loc[week].dropna()
        order = sorted(row.index, key=lambda n: (row[n], -tie_break.at[week, n], n))
        final.loc[week, order] = range(1, len(order) + 1)
    return final, score


RankCache = dict[tuple, tuple[pd.DataFrame, pd.DataFrame]]


@dataclass
class _Sim:
    """What both portfolio rules share: prices, ranks, costs, tax and the trade log."""

    prices: pd.DataFrame
    ranks: pd.DataFrame
    filter_ret: pd.DataFrame
    config: Config
    ledger: TaxLedger | None
    tax_classes: dict[str, str]
    trade_rows: list[dict] = field(default_factory=list)

    @property
    def cost(self) -> float:
        return self.config.cost_pct / 100

    def price(self, asset: str, week: pd.Timestamp) -> float:
        return self.prices.at[week, CASH if asset in (_POOL, IDLE) else asset]

    def rank(self, week: pd.Timestamp, asset: str) -> float:
        return self.ranks.at[week, asset] if asset in self.ranks.columns else float("nan")

    def passes_filter(self, name: str, week: pd.Timestamp) -> bool:
        if self.config.defensive != "filter":
            return True
        mine, cash = self.filter_ret.at[week, name], self.filter_ret.at[week, CASH]
        return pd.notna(mine) and pd.notna(cash) and mine > cash

    def exit_reason(self, asset: str, week: pd.Timestamp) -> str | None:
        """Why a holding must be sold this week, or None to keep it."""
        rank = self.rank(week, asset)
        if pd.isna(rank):
            return "ineligible"
        if rank > self.config.exit_rank:
            return f"rank {int(rank)} > {self.config.exit_rank}"
        if not self.passes_filter(asset, week):
            return f"{self.config.filter_lookback}w return below cash"
        return None

    def top_names(self, week: pd.Timestamp) -> list[str]:
        """The current top N that may be bought, best first."""
        ranks = self.ranks.loc[week].dropna().sort_values()
        return [
            n for n in ranks.index if ranks[n] <= self.config.top_n and self.passes_filter(n, week)
        ]

    def tax(self, asset: str, gain: float, held_days: int) -> float:
        if self.ledger is None:
            return 0.0
        tax_class = self.tax_classes.get(CASH if asset in (_POOL, IDLE) else asset, DEBT)
        return self.ledger.sale(tax_class, gain, held_days)

    def record(self, week, action, asset, reason, value, slot=None, tax=0.0, **extra) -> None:
        self.trade_rows.append(
            {
                "week": week,
                "action": action,
                "slot": slot,
                "asset": asset,
                "rank": self.rank(week, asset),
                "value": value,
                "reason": reason,
                "tax": tax,
                **extra,
            }
        )

    def exit_details(self, asset, week, since, entry_value, value) -> dict:
        return {
            "entry_week": since,
            "entry_value": entry_value,
            "weeks_held": (week - since).days / 7,
            "price_return": self.price(asset, week) / self.price(asset, since) - 1,
            "position_return": value / entry_value - 1 if entry_value else float("nan"),
        }


@dataclass
class _Outcome:
    equity: dict
    weights: dict
    holdings: pd.DataFrame
    open_positions: pd.DataFrame
    ledger: TaxLedger | None
    idle_value: float = 0.0


def run_backtest(
    prices: pd.DataFrame,
    includes: dict[str, str],
    config: Config,
    tax_classes: dict[str, str] | None = None,
    rank_cache: RankCache | None = None,
) -> Result:
    """`rank_cache` lets a sweep reuse the (slow) ranking when only top_n/exit/mode differ."""
    names = ranked_universe(includes, config)
    missing = [n for n in [*names, CASH, config.benchmark] if n not in prices]
    if missing:
        raise ValueError(f"weekly closes are missing {missing}")
    if config.tax is not None and tax_classes is None:
        raise ValueError("tax needs tax_classes (instrument -> equity/gold_silver/...)")

    key = (tuple(names), config.lookbacks, config.weights)
    if rank_cache is not None and key in rank_cache:
        ranks, scores = rank_cache[key]
    else:
        ranks, scores = compute_ranks(prices[names], config)
        if rank_cache is not None:
            rank_cache[key] = (ranks, scores)
    filter_ret = prices / prices.shift(config.filter_lookback) - 1
    if config.signal_delay:
        ranks = ranks.shift(config.signal_delay)
        scores = scores.shift(config.signal_delay)
        filter_ret = filter_ret.shift(config.signal_delay)

    in_window = ranks.index >= pd.Timestamp(config.start)
    if config.end:
        in_window &= ranks.index <= pd.Timestamp(config.end)
    enough = ranks.notna().sum(axis=1).to_numpy() >= config.top_n
    weeks = list(ranks.index[in_window & enough])
    if len(weeks) < 2:
        raise ValueError("not enough history to run from the chosen start date")

    sim = _Sim(
        prices=prices,
        ranks=ranks,
        filter_ret=filter_ret,
        config=config,
        ledger=TaxLedger(config.tax) if config.tax is not None else None,
        tax_classes=tax_classes or {},
    )
    outcome = _run_slots(sim, weeks) if config.portfolio == "slots" else _run_buffer(sim, weeks)

    equity_series = pd.Series(outcome.equity, name="strategy")
    span = equity_series.index

    def normalised(series: pd.Series, name: str) -> pd.Series:
        s = series.reindex(span)
        return (s / s.iloc[0]).rename(name)

    trades = pd.DataFrame(sim.trade_rows)
    if not trades.empty:
        trades["week"] = pd.to_datetime(trades["week"])
    weights = pd.DataFrame.from_dict(outcome.weights, orient="index").fillna(0.0)
    weights.index.name = "week"
    return Result(
        config=config,
        equity=equity_series,
        benchmark=normalised(prices[config.benchmark], config.benchmark),
        cash=normalised(prices[CASH], CASH),
        weights=weights,
        holdings=outcome.holdings,
        trades=trades,
        ranks=ranks.loc[span],
        scores=scores.loc[span],
        ranked_names=names,
        tax_ledger=outcome.ledger,
        open_positions=outcome.open_positions,
        idle_value=outcome.idle_value,
    )


def _run_slots(sim: _Sim, weeks: list[pd.Timestamp]) -> _Outcome:
    config, cost = sim.config, sim.cost
    # Each slot: asset (None = money not yet invested), value, "held" | "parked", `since` (when
    # the current position began) and `basis` (what it cost, after buying costs) for tax.
    slots = [
        {"asset": None, "value": 1.0 / config.top_n, "kind": "parked", "since": None, "basis": 0.0}
    ]
    slots += [dict(slots[0]) for _ in range(config.top_n - 1)]
    equity = {weeks[0]: 1.0}
    weights, holdings_rows = {}, []

    def realise(slot, week) -> float:
        """Sell the slot's position: costs, then tax on the gain. Returns the tax paid."""
        slot["value"] *= 1 - cost
        if slot["since"] is None:
            return 0.0
        tax = sim.tax(slot["asset"], slot["value"] - slot["basis"], (week - slot["since"]).days)
        slot["value"] -= tax
        return tax

    for i, week in enumerate(weeks[:-1]):
        # 1. Sells.
        for slot_no, slot in enumerate(slots, start=1):
            asset = slot["asset"]
            if slot["kind"] != "held":
                continue
            reason = sim.exit_reason(asset, week)
            if reason is None:
                continue
            value_before = slot["value"]
            details = sim.exit_details(asset, week, slot["since"], slot["basis"], value_before)
            if asset == CASH:
                # A ranked-mode cash holding dropping out stays in the same liquid fund - it's
                # only relabelled as parked, so there's no trade, no cost and no tax.
                sim.record(week, "SELL", asset, reason, value_before, slot_no, 0.0, **details)
                slot["kind"] = "parked"
                continue
            tax = realise(slot, week)
            sim.record(week, "SELL", asset, reason, value_before, slot_no, tax, **details)
            slot["value"] *= 1 - cost  # park the proceeds in the liquid fund
            slot.update(asset=CASH, kind="parked", since=week, basis=slot["value"])

        # 2. Buys: best-ranked names within the top N that aren't already held.
        held = {s["asset"] for s in slots if s["kind"] == "held"}
        candidates = [n for n in sim.top_names(week) if n not in held]
        for slot_no, slot in enumerate(slots, start=1):
            if slot["kind"] == "held":
                continue
            if candidates:
                name = candidates.pop(0)
                if slot["asset"] == name:  # cash already parked in the liquid fund
                    slot["kind"] = "held"
                else:
                    if slot["asset"] is not None:  # leaving the liquid fund
                        realise(slot, week)
                    slot["value"] *= 1 - cost
                    slot.update(asset=name, kind="held", since=week, basis=slot["value"])
                rank = int(sim.rank(week, name))
                sim.record(week, "BUY", name, f"rank {rank}", slot["value"], slot_no)
            elif slot["asset"] is None:
                slot["value"] *= 1 - cost
                slot.update(asset=CASH, kind="parked", since=week, basis=slot["value"])

        total = sum(s["value"] for s in slots)
        row: dict[str, float] = {}
        for s in slots:
            key = s["asset"] if s["kind"] == "held" else IDLE
            row[key] = row.get(key, 0.0) + s["value"] / total
        weights[week] = row
        holdings_rows.append(
            {
                "week": week,
                **{
                    f"slot {j + 1}": (s["asset"] if s["kind"] == "held" else f"({CASH})")
                    for j, s in enumerate(slots)
                },
                "in_cash_slots": sum(s["kind"] == "parked" for s in slots),
            }
        )

        # 3. Hold for the week.
        nxt = weeks[i + 1]
        for slot in slots:
            asset = slot["asset"]
            slot["value"] *= sim.price(asset, nxt) / sim.price(asset, week)
        equity[nxt] = sum(s["value"] for s in slots)

    last = weeks[-1]
    open_positions = pd.DataFrame(
        [
            {
                "slot": slot_no,
                "asset": slot["asset"],
                "value": slot["value"],
                "rank": sim.rank(last, slot["asset"]),
                **sim.exit_details(
                    slot["asset"], last, slot["since"], slot["basis"], slot["value"]
                ),
            }
            for slot_no, slot in enumerate(slots, start=1)
            if slot["kind"] == "held"
        ]
    )

    ledger = sim.ledger
    if ledger is not None:
        # Final value is what you'd have after selling everything: open positions' unrealised
        # gains are taxed too, otherwise they'd escape tax while buy-and-hold Nifty is taxed.
        closing = copy.deepcopy(ledger)
        total = 0.0
        for slot in slots:
            proceeds = slot["value"] * (1 - cost)
            if slot["since"] is not None and slot["asset"] is not None:
                tax_class = sim.tax_classes.get(slot["asset"], DEBT)
                days = (last - slot["since"]).days
                proceeds -= closing.sale(tax_class, proceeds - slot["basis"], days)
            total += proceeds
        equity[last] = total
        ledger = closing

    return _Outcome(
        equity, weights, pd.DataFrame(holdings_rows).set_index("week"), open_positions, ledger
    )


def _run_buffer(sim: _Sim, weeks: list[pd.Timestamp]) -> _Outcome:
    """Positions are lists of lots - one per purchase - so each top-up keeps its own date and
    cost for tax. A lot is {units, since, basis}; basis is the rupee cost after buying costs."""
    config, cost = sim.config, sim.cost
    lots: dict[str, list[dict]] = {}
    uninvested = 1.0  # starting money, not yet in anything
    equity = {weeks[0]: 1.0}
    weights, holdings_rows = {}, []

    def value(asset: str, week) -> float:
        return sum(lot["units"] for lot in lots.get(asset, [])) * sim.price(asset, week)

    def buy(asset: str, amount: float, week) -> None:
        net = amount * (1 - cost)
        lots.setdefault(asset, []).append(
            {"units": net / sim.price(asset, week), "since": week, "basis": net}
        )

    cap = config.max_position

    def portfolio_value(week) -> float:
        return sum(value(a, week) for a in lots)

    def room(name: str, total: float, week) -> float:
        """How much more `name` can take before it reaches the cap."""
        if cap is None:
            return math.inf
        return max(cap * total - value(name, week), 0.0)

    def sell(asset: str, fraction: float, week) -> tuple[float, float, float]:
        """Sell `fraction` of every lot. Returns (gross value, net proceeds, tax)."""
        price = sim.price(asset, week)
        gross = tax = 0.0
        for lot in lots[asset]:
            units, basis = lot["units"] * fraction, lot["basis"] * fraction
            lot_gross = units * price
            gross += lot_gross
            tax += sim.tax(asset, lot_gross * (1 - cost) - basis, (week - lot["since"]).days)
            lot["units"] -= units
            lot["basis"] -= basis
        if fraction >= 1 - 1e-12:
            del lots[asset]
        return gross, gross * (1 - cost) - tax, tax

    for i, week in enumerate(weeks[:-1]):
        proceeds, uninvested = uninvested, 0.0

        # 1. Sell whatever has dropped out.
        for asset in [a for a in lots if a != _POOL]:
            reason = sim.exit_reason(asset, week)
            if reason is None:
                continue
            position = lots[asset]
            since = min(lot["since"] for lot in position)
            basis = sum(lot["basis"] for lot in position)
            value_before = value(asset, week)
            details = sim.exit_details(asset, week, since, basis, value_before)
            _, net, tax = sell(asset, 1.0, week)
            sim.record(week, "SELL", asset, reason, value_before, tax=tax, **details)
            proceeds += net

        # 2. Trim anything that has grown past the cap by more than the band, back to the cap.
        if cap is not None:
            total = portfolio_value(week) + proceeds
            for asset in [a for a in lots if a != _POOL]:
                share = value(asset, week) / total
                if share > cap + config.cap_band:
                    gross, net, tax = sell(asset, 1 - cap / share, week)
                    reason = f"above the {cap:.0%} cap ({share:.0%})"
                    sim.record(week, "TRIM", asset, reason, gross, tax=tax)
                    proceeds += net

        # 3. Split the money equally across the current top N, but never past the cap. Parked
        #    cash joins in as soon as there's room for it.
        tops = sim.top_names(week)
        total = portfolio_value(week) + proceeds
        if tops and _POOL in lots:
            need = sum(room(name, total, week) for name in tops) - proceeds
            if need > MIN_TRADE * total:
                gross, net, tax = sell(_POOL, min(1.0, need / value(_POOL, week)), week)
                sim.record(week, "UNPARK", CASH, "back into the top N", gross, tax=tax)
                proceeds += net
        if proceeds > 1e-12:
            left = proceeds
            if tops:
                total = portfolio_value(week) + proceeds
                rooms = {name: room(name, total, week) for name in tops}
                given = dict.fromkeys(tops, 0.0)
                active = [name for name in tops if rooms[name] > 1e-12]
                while left > 1e-12 and active:  # equal shares; a capped name's excess spreads on
                    share = left / len(active)
                    still = []
                    for name in active:
                        give = min(share, rooms[name] - given[name])
                        given[name] += give
                        left -= give
                        if rooms[name] - given[name] > 1e-12:
                            still.append(name)
                    active = still
                for name in tops:
                    if given[name] > 1e-12:
                        action = "ADD" if name in lots else "BUY"
                        buy(name, given[name], week)
                        rank = int(sim.rank(week, name))
                        sim.record(week, action, name, f"rank {rank}", given[name])
            if left > 1e-12:
                buy(_POOL, left, week)
                reason = (
                    f"top N all at the {cap:.0%} cap" if tops else "nothing in the top N qualifies"
                )
                sim.record(week, "PARK", CASH, reason, left)

        # 4. Make room: a top-N name still not held is bought now, funded by trimming every
        #    holding by the same percentage, sized as an equal share of the portfolio (capped).
        if config.entry == "make_room":
            for name in tops:
                if name in lots:
                    continue
                holders = list(lots)
                count = sum(1 for a in holders if a != _POOL)
                fraction = 1 / (count + 1) if cap is None else min(1 / (count + 1), cap)
                raised = 0.0
                for asset in holders:
                    gross, net, tax = sell(asset, fraction, week)
                    shown = CASH if asset == _POOL else asset
                    sim.record(week, "TRIM", shown, f"make room for {name}", gross, tax=tax)
                    raised += net
                buy(name, raised, week)
                rank = int(sim.rank(week, name))
                sim.record(week, "BUY", name, f"rank {rank} (made room)", raised)

        total = sum(value(a, week) for a in lots)
        weights[week] = {(IDLE if a == _POOL else a): value(a, week) / total for a in lots}
        held = sorted(a for a in lots if a != _POOL)
        holdings_rows.append(
            {
                "week": week,
                "holdings": ", ".join(held),
                "count": len(held),
                "idle_share": weights[week].get(IDLE, 0.0),
            }
        )

        nxt = weeks[i + 1]
        equity[nxt] = sum(value(a, nxt) for a in lots)

    last = weeks[-1]
    rows = []
    for asset, position in lots.items():
        if asset == _POOL:
            continue
        since = min(lot["since"] for lot in position)
        basis = sum(lot["basis"] for lot in position)
        current = value(asset, last)
        rows.append(
            {
                "slot": None,
                "asset": asset,
                "value": current,
                "rank": sim.rank(last, asset),
                "lots": len(position),
                **sim.exit_details(asset, last, since, basis, current),
            }
        )
    open_positions = pd.DataFrame(rows)
    idle_value = value(_POOL, last) if _POOL in lots else 0.0

    ledger = sim.ledger
    if ledger is not None:
        closing = copy.deepcopy(ledger)
        total = 0.0
        for asset, position in lots.items():
            price = sim.price(asset, last)
            tax_class = sim.tax_classes.get(CASH if asset == _POOL else asset, DEBT)
            for lot in position:
                net = lot["units"] * price * (1 - cost)
                total += net - closing.sale(
                    tax_class, net - lot["basis"], (last - lot["since"]).days
                )
        equity[last] = total
        ledger = closing

    return _Outcome(
        equity,
        weights,
        pd.DataFrame(holdings_rows).set_index("week"),
        open_positions,
        ledger,
        idle_value,
    )
