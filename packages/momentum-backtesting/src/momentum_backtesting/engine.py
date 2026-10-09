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

Signal vs fill prices: ranks and the defensive filter always use `prices` (the underlying
index). `trade_prices`, when given, is what every buy, sell and holding is valued at - the ETF
actually traded (`track="etf"`), and/or the price at the chosen `execution` time (Friday close,
next Monday's open, or ~10:00 on Monday). trade_prices is indexed by *signal* week: row W holds
the price a trade decided on at W's close fills at. See trade_prices.py for how it's built.

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
from typing import TYPE_CHECKING, Literal

import numpy as np
import pandas as pd

from .tax import DEBT, TaxLedger, TaxRules

CASH = "Cash (liquid fund)"
GILT = "Gilt 8-13 yr"
BENCHMARK = "Nifty 50"
IDLE = "Idle cash"  # money parked in the liquid fund because nothing qualified
_POOL = "__pool__"  # the buffer rule's idle-money position, priced as the liquid fund
if TYPE_CHECKING:  # categories imports this module: type-only, no cycle at run time
    from .categories.daily_moves import DailyMoves

MIN_TRADE = 0.005  # don't move parked cash for less than 0.5% of the portfolio
_LIQUID_FUND = frozenset({CASH, _POOL, IDLE})  # every name the liquid fund goes by

DefensiveMode = Literal["off", "ranked", "filter"]
PortfolioRule = Literal["buffer", "slots"]
EntryRule = Literal["wait", "make_room"]
Track = Literal["index", "etf"]
Execution = Literal["fri_close", "mon_open", "mon_10am"]
Score = Literal["ranksum", "voladj", "blend", "residual"]
Rebalance = Literal["weekly", "monthly"]
CostModel = Literal["flat", "itemised"]

# Itemised cost model (cost_model="itemised"): NSE cash-market equity-delivery rates, India, as
# best I could verify (SEBI/NSE schedules + broker rate cards) - "settings, not facts", same
# caveat as tax.py's rates. Every rate is a fraction of trade value except the DP charge, which
# is a flat per-sell rupee amount converted to a fraction via `config.capital`.
STT_RATE = 0.001  # Securities Transaction Tax, 0.1% each side on equity delivery
STAMP_DUTY_BUY_RATE = 0.00015  # stamp duty, 0.015%, buy side only
EXCHANGE_FEES_RATE = 0.00004  # exchange transaction charge + SEBI fee + GST, ~0.004% each side
DP_CHARGE_RS = 16.0  # flat depository participant charge per SELL (approx.; varies by DP)
DP_CHARGE_FRACTION_CAP = 0.05  # cap so a dust-sized sell doesn't get an absurd cost fraction
# Itemised model, money moving into the liquid fund (parked cash, or cash held as a ranked
# defensive): a liquid mutual fund pays stamp duty on purchase and nothing else - no STT, no
# exchange fees, no slippage, no DP charge, and no exit load from the 7th day (the engine's
# shortest holding period is one week).
LIQUID_FUND_STAMP_DUTY_RATE = 0.00005


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
    # Buffer rule only. Largest share of the portfolio one GROUP of positions may hold together
    # (None = no cap). Needs `run_backtest`'s `groups` table to say which group each position
    # belongs to that week - without it there is nothing to cap and this is inert. Broad Momentum
    # uses it so two stocks picked from the same category can't add up to a bigger bet than one
    # category is meant to be. Same trim mechanic as `max_position`: a group is trimmed back to
    # the cap only once it passes cap + `cap_band`.
    max_group: float | None = None
    # Buffer rule only. Shrinks how much of each week's freshly available cash goes into new/
    # top-up buys when recent closed trades have mostly lost, ramping back to full size as they
    # recover. See _win_rate_multiplier. Off by default - opt-in.
    momentum_sizing: bool = False
    # momentum_sizing only. How many of the most-recent closed trades feed the weighted win-rate
    # score (weights count down from `momentum_sizing_window` to 1 - see _win_rate_multiplier).
    # A shorter window reacts faster to a fresh streak but is noisier; a longer one is steadier
    # but slower to recover after a bad patch.
    momentum_sizing_window: int = 10
    # momentum_sizing only. Floor on the multiplier - 0.0 means an all-loss recent streak can
    # deploy nothing (full cash); a higher floor (e.g. 0.3) keeps at least that fraction invested
    # even at the worst recent win rate, for a less aggressive de-risking curve.
    momentum_sizing_floor: float = 0.0
    # Buffer rule only (TODO.md 3.9.20). A SEPARATE, independently-toggled de-risking response
    # from momentum_sizing above: instead of a rolling win/loss tally (found to be a diluted,
    # noisy signal across many idiosyncratic per-position closes - see momentum_sizing's own
    # rejection note in TODO.md 3.9.8), this reacts to a synchronized MASS exit - more than half
    # of what was held coming into a week dropping out in that same week's own ranking, a
    # coherent portfolio-wide breadth signal. The set of weeks this fired on is per-run computed
    # data, not a setting - it's passed to `run_backtest`'s own `mass_exit_weeks` argument (same
    # reasoning as `external_ranks`/`trade_prices`/`membership`), never stored on `Config`. Off
    # by default - opt-in, like momentum_sizing. See categories/broad.py's
    # `compute_category_selection_mass_exit` for how the trigger itself is detected (that same
    # function also implements the OTHER response variant, "halve_top_n", entirely outside
    # engine.py - see its own docstring for why that needs no Config field at all).
    mass_exit_throttle: bool = False
    # mass_exit_throttle only. Fraction of that week's fresh capital withheld into cash on a
    # flagged week (0.5 = deploy half, park the rest - the brief's own "under-deploy fresh
    # capital" example). Stacks with momentum_sizing if both happen to be on: applied to whatever
    # is left after momentum_sizing's own reservation, not to the original `proceeds`.
    mass_exit_throttle_fraction: float = 0.5
    # What P&L is measured on (the ranking always uses the index): the index itself, or the ETF
    # you'd actually trade. And when the trade fills. Anything but index + fri_close needs
    # `trade_prices` passed to run_backtest.
    track: Track = "index"
    execution: Execution = "fri_close"
    # Ranking method: ranksum (today's weighted-rank-sum of return lookbacks), voladj (NSE-style
    # risk-adjusted 6m/12m z-score composite), or blend (average of the two ranks, re-ranked).
    score: Score = "ranksum"
    voladj_skip_recent_month: bool = True  # voladj/blend only
    # voladj/blend only (BL-055). False (default): NSE's method, 26- and 52-week returns over
    # 26-week volatility, ignoring `lookbacks`/`weights`. True: one component per selected
    # lookback, weighted by `weights` (see _compute_ranks_voladj).
    voladj_lookbacks: bool = False
    # voladj_lookbacks only (BL-055 addendum 1): which lookbacks skip the latest 4 weeks when
    # `voladj_skip_recent_month` is on: "long" (26 weeks or more, the first variant), "all", "none".
    voladj_skip: Literal["long", "all", "none"] = "long"
    # Trade only on the last week-in-`weeks` of each calendar month (rebalance="monthly"); the
    # weekly mark-to-market/hold step always runs regardless of this setting.
    rebalance: Rebalance = "weekly"
    # rebalance="weekly" only: trade every `rebalance_every` weeks instead of every week, on the
    # weeks whose calendar week number (Fridays since CADENCE_EPOCH) is `rebalance_offset` mod
    # `rebalance_every`. Anchored to the calendar, not the run's first week, so one offset always
    # trades on the same Fridays whatever `start` is - which is what lets overlapping tranches
    # (tranches.py) and rolling windows compare like with like. 1 = every week (the default).
    rebalance_every: int = 1
    rebalance_offset: int = 0
    # Buffer rule only (TODO 3.9.23 follow-up). With `rebalance_every > 1`, sell a holding that
    # dropped past `exit_rank` EVERY week instead of waiting for the next cadence week; new buys,
    # cap trims and make_room still wait for the cadence - only exits move faster. Proceeds from
    # an off-cadence sell sit idle (the liquid fund) until the next buy week. False (default)
    # keeps everything, sells included, on the cadence.
    sell_every_week: bool = False
    # Buffer rule with `tax` only (TODO 3.9.23, experiment 6). A holding whose oldest lot is in
    # gain and turns long-term within `tax_hold_weeks` weeks is kept while its rank is at most
    # `exit_rank + tax_hold_band`, instead of being sold short-term for a marginal rank slip.
    # 0 (default) = off.
    tax_hold_band: int = 0
    tax_hold_weeks: int = 0
    # A week is only simulated when at least this many names are ranked; 0 (default) means
    # `top_n`, the original rule, which is right for ETF/stock history warm-up. A derived rank
    # table that is legitimately thin some weeks (Broad Momentum ranks only the picks of the
    # categories held) needs 1: with the default, those weeks are silently skipped - nothing is
    # sold or bought and the curve jumps several weeks at once (TODO 3.9.23).
    min_ranked: int = 0
    # Buffer rule only (BL-053). A stop-loss checked EVERY week, whatever `rebalance_every` is:
    # a holding is sold once its weekly close is `stop_from_buy` or more below its average buy
    # price (0.20 = a 20% fall), or `stop_from_peak` or more below its highest weekly close since
    # it was first bought. None (default) = off; both None leaves the engine exactly as before.
    # `stop_delay` 0 sells at the close the fall is seen on; 1 sells a week later, at the next
    # close (the stop is judged on the earlier week's prices). A lower-circuit lock blocks the
    # sale until it lifts. A stock stopped out is not bought back that same week.
    stop_from_buy: float | None = None
    stop_from_peak: float | None = None
    # Where the money goes on a week that is not a rebalance week: "cash" waits (uninvested)
    # until the next rebalance; "top" buys the best-ranked name that may be bought and is not
    # held, up to the position cap (the rest waits). On a rebalance week the proceeds always
    # join that week's normal reinvestment.
    stop_proceeds: Literal["cash", "top"] = "cash"
    stop_delay: int = 0
    # "daily" (BL-054 L4): the stop is checked on every trading day's close, and a triggered
    # stop sells at the NEXT session's open (a lower-circuit lock delays it). Needs `daily` moves
    # passed to run_backtest and stop_delay 0. "weekly" is the BL-053 behaviour.
    stop_granularity: Literal["weekly", "daily"] = "weekly"
    # Buffer rule only (BL-054 L5). How a buy week's money is split across the names that get
    # it: "equal" (default) or "inverse_vol", in proportion to 1 / the standard deviation of each
    # name's last `vol_window` weekly returns up to the signal week (a name without that history
    # gets the median weight). The position and group caps apply as before.
    weight_by: Literal["equal", "inverse_vol"] = "equal"
    vol_window: int = 26
    # flat = cost_pct on both sides (today's model, unchanged). itemised = STT/stamp duty/
    # exchange fees/slippage/DP charge - see the rate constants above `Config`.
    cost_model: CostModel = "flat"
    capital: float = 1_000_000.0  # itemised cost_model only: sizes the flat per-sell DP charge
    slippage_bps: float = 5.0  # itemised cost_model only

    def __post_init__(self) -> None:
        if self.weights is not None and len(self.weights) != len(self.lookbacks):
            raise ValueError("weights must have one value per lookback")
        if self.weights is not None and any(not math.isfinite(w) for w in self.weights):
            raise ValueError("weights must be finite numbers")
        # Negative weights are allowed on purpose: `score = score + weight * rank_k` in
        # _compute_ranks_ranksum means a negative weight on a lookback rewards instruments
        # that ranked WORST on it (rank_k close to N) instead of best - e.g. weight -1 on the
        # 26/52-week lookbacks alongside positive weight on 1/4-week lookbacks hunts for
        # longer-term laggards that are turning up recently (a reversal signal), rather than
        # pure momentum. Only an all-zero weight vector is rejected - every score would be 0
        # and the ranking would be entirely tie-break-driven.
        if self.weights is not None and all(w == 0 for w in self.weights):
            raise ValueError("at least one weight must be non-zero")
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
        if self.max_group is not None and not 0 < self.max_group <= 1:
            raise ValueError("max_group must be between 0 and 1 (e.g. 0.30 for 30%)")
        if self.cap_band < 0:
            raise ValueError("cap_band can't be negative")
        if self.track not in ("index", "etf"):
            raise ValueError(f"unknown track {self.track!r}")
        if self.execution not in ("fri_close", "mon_open", "mon_10am"):
            raise ValueError(f"unknown execution {self.execution!r}")
        if self.score not in ("ranksum", "voladj", "blend", "residual"):
            raise ValueError(f"unknown score {self.score!r}")
        if self.rebalance not in ("weekly", "monthly"):
            raise ValueError(f"unknown rebalance {self.rebalance!r}")
        if self.rebalance_every < 1:
            raise ValueError("rebalance_every must be at least 1")
        if self.rebalance_every > 1 and self.rebalance != "weekly":
            raise ValueError("rebalance_every only applies to rebalance='weekly'")
        if not 0 <= self.rebalance_offset < self.rebalance_every:
            raise ValueError("rebalance_offset must be between 0 and rebalance_every - 1")
        if self.sell_every_week and self.portfolio != "buffer":
            raise ValueError("sell_every_week needs portfolio='buffer'")
        for name in ("stop_from_buy", "stop_from_peak"):
            level = getattr(self, name)
            if level is not None and not 0 < level < 1:
                raise ValueError(f"{name} must be between 0 and 1 (e.g. 0.20 for a 20% fall)")
        if self.stop_proceeds not in ("cash", "top"):
            raise ValueError(f"unknown stop_proceeds {self.stop_proceeds!r}")
        if self.stop_delay not in (0, 1):
            raise ValueError("stop_delay must be 0 or 1")
        if self.voladj_skip not in ("long", "all", "none"):
            raise ValueError(f"unknown voladj_skip {self.voladj_skip!r}")
        if self.weight_by not in ("equal", "inverse_vol"):
            raise ValueError(f"unknown weight_by {self.weight_by!r}")
        if self.weight_by == "inverse_vol" and self.portfolio != "buffer":
            raise ValueError("weight_by='inverse_vol' needs portfolio='buffer'")
        if self.vol_window < 4:
            raise ValueError("vol_window must be at least 4 weeks")
        if self.stop_granularity not in ("weekly", "daily"):
            raise ValueError(f"unknown stop_granularity {self.stop_granularity!r}")
        if self.stop_granularity == "daily" and (not self.has_stop or self.stop_delay != 0):
            raise ValueError("a daily stop needs a stop level and stop_delay 0")
        if self.has_stop and self.portfolio != "buffer":
            raise ValueError("a stop-loss needs portfolio='buffer'")
        if self.min_ranked < 0:
            raise ValueError("min_ranked can't be negative")
        if self.tax_hold_band < 0 or self.tax_hold_weeks < 0:
            raise ValueError("tax_hold_band and tax_hold_weeks can't be negative")
        if self.cost_model not in ("flat", "itemised"):
            raise ValueError(f"unknown cost_model {self.cost_model!r}")
        if self.capital <= 0:
            raise ValueError("capital must be positive")
        if self.slippage_bps < 0:
            raise ValueError("slippage_bps can't be negative")
        if self.momentum_sizing_window < 1:
            raise ValueError("momentum_sizing_window must be at least 1")
        if not 0 <= self.momentum_sizing_floor <= 1:
            raise ValueError("momentum_sizing_floor must be between 0 and 1")
        if not 0 <= self.mass_exit_throttle_fraction <= 1:
            raise ValueError("mass_exit_throttle_fraction must be between 0 and 1")

    @property
    def has_stop(self) -> bool:
        return self.stop_from_buy is not None or self.stop_from_peak is not None

    @property
    def needs_trade_prices(self) -> bool:
        return self.track != "index" or self.execution != "fri_close"

    @property
    def label(self) -> str:
        cap = f"-cap{round(self.max_position * 100)}" if self.max_position else ""
        cap += f"-gcap{round(self.max_group * 100)}" if self.max_group else ""
        rule = f"buffer-{self.entry}{cap}" if self.portfolio == "buffer" else "slots"
        fills = f"_{self.track}-{self.execution}" if self.needs_trade_prices else ""
        score = f"_{self.score}" if self.score != "ranksum" else ""
        rebalance = f"_{self.rebalance}" if self.rebalance != "weekly" else ""
        if self.rebalance_every > 1:
            rebalance += f"_every{self.rebalance_every}o{self.rebalance_offset}"
        if self.sell_every_week:
            rebalance += "_sellweekly"
        if self.tax_hold_band:
            rebalance += f"_taxhold{self.tax_hold_band}w{self.tax_hold_weeks}"
        if self.min_ranked:
            rebalance += f"_minranked{self.min_ranked}"
        if self.has_stop:
            buy = f"b{round(self.stop_from_buy * 100)}" if self.stop_from_buy else ""
            peak = f"p{round(self.stop_from_peak * 100)}" if self.stop_from_peak else ""
            rebalance += f"_stop{buy}{peak}{self.stop_proceeds}d{self.stop_delay}"
            rebalance += "_daily" if self.stop_granularity == "daily" else ""
        if self.weight_by == "inverse_vol":
            rebalance += f"_ivol{self.vol_window}"
        cost_model = f"_{self.cost_model}" if self.cost_model != "flat" else ""
        return (
            f"{rule}_{self.defensive}_top{self.top_n}_exit{self.exit_rank}_"
            f"lb{'-'.join(map(str, self.lookbacks))}{fills}{score}{rebalance}{cost_model}"
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
    """(final rank, composite score) per instrument per week. Only uses prices up to each week.
    Dispatches on `config.score`; see _compute_ranks_{ranksum,voladj,blend} below."""
    if config.score == "ranksum":
        return _compute_ranks_ranksum(prices, config)
    if config.score == "voladj":
        return _compute_ranks_voladj(prices, config)
    if config.score == "residual":
        raise ValueError(
            "score='residual' needs factor returns: Broad builds it in "
            "categories.residual (compute_universe_base)"
        )
    return _compute_ranks_blend(prices, config)


def _rank_from_score(
    score: pd.DataFrame, tie_break: pd.DataFrame | None, higher_is_better: bool
) -> pd.DataFrame:
    """Convert a per-week score into ascending ranks 1..N (1 = best), skipping instruments whose
    score is NaN that week. Ties are broken by `tie_break` (higher wins) if given, then by name.

    One `np.lexsort` per week over (score, -tie_break, name). This used to be a Python `sorted()`
    with a pandas `.loc` lookup per instrument per comparison — ~640k lookups for Broad Momentum's
    755 stocks × 820 weeks, about half the whole request (~45 s). Same strict total order, so the
    ranks are identical (pinned against the old implementation in tests/test_engine.py)."""
    sign = -1.0 if higher_is_better else 1.0
    values = score.to_numpy(dtype=float)
    tie = None if tie_break is None else tie_break.reindex_like(score).to_numpy(dtype=float)
    # Names compare as strings (code-point order), exactly as the old tuple key did.
    name_order = np.argsort(np.asarray(score.columns, dtype=str), kind="stable")
    name_rank = np.empty(len(name_order), dtype=np.int64)
    name_rank[name_order] = np.arange(len(name_order))

    out = np.full(values.shape, np.nan)
    for i in range(values.shape[0]):
        present = np.flatnonzero(~np.isnan(values[i]))
        if present.size == 0:
            continue
        keys = [name_rank[present]]  # lexsort: the LAST key is the primary one
        if tie is not None:
            keys.append(-tie[i, present])
        keys.append(sign * values[i, present])
        out[i, present[np.lexsort(keys)]] = np.arange(1, present.size + 1)
    return pd.DataFrame(out, index=score.index, columns=score.columns)


def _compute_ranks_ranksum(
    prices: pd.DataFrame, config: Config
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Today's default: weighted sum of per-lookback ranks (1 = best return); lowest score wins."""
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
    final = _rank_from_score(score, tie_break, higher_is_better=False)
    return final, score


def _compute_ranks_voladj(
    prices: pd.DataFrame, config: Config
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """NSE-style volatility-adjusted momentum: 6m and 12m returns each divided by trailing 26-week
    return volatility, cross-sectionally z-scored, then summed. Higher composite = stronger
    momentum. `voladj_skip_recent_month` computes the returns as of 4 weeks ago (skip-the-most-
    recent-month convention); vol itself is always the latest trailing 26-week window."""
    if config.voladj_lookbacks:
        return _compute_ranks_voladj_lookbacks(prices, config)
    s = 4 if config.voladj_skip_recent_month else 0
    ret_6m = prices / prices.shift(s + 26) - 1
    ret_12m = prices / prices.shift(s + 52) - 1
    vol = prices.pct_change().rolling(26).std()
    # Eligibility needs 52+s weeks of price history (the longer of the two lookbacks), the same
    # idea as the ranksum path's `eligible` mask.
    eligible = functools.reduce(operator.and_, (r.notna() for r in (ret_6m, ret_12m, vol)))

    safe_vol = vol.where(vol > 0)  # 0 or NaN vol -> NaN component, never a divide-by-zero
    comp_6m = (ret_6m / safe_vol).where(eligible)
    comp_12m = (ret_12m / safe_vol).where(eligible)

    def zscore(component: pd.DataFrame) -> pd.DataFrame:
        # mean/std are per-week, across whatever instruments have a value that week - NaN
        # (ineligible, or a zero-vol guard hit) is excluded automatically by pandas' skipna.
        mean = component.mean(axis=1)
        std = component.std(axis=1)
        return component.sub(mean, axis=0).div(std, axis=0)

    score = (zscore(comp_6m) + zscore(comp_12m)).where(eligible)
    final = _rank_from_score(score, tie_break=ret_6m, higher_is_better=True)
    return final, score


def _cross_zscore(component: pd.DataFrame) -> pd.DataFrame:
    """Per-week z-score across the names with a value that week (NaN excluded)."""
    return component.sub(component.mean(axis=1), axis=0).div(component.std(axis=1), axis=0)


def _compute_ranks_voladj_lookbacks(
    prices: pd.DataFrame, config: Config
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """BL-055 (`voladj_lookbacks=True`): one volatility-adjusted component per selected lookback
    L, the L-week return (measured 4 weeks back when L >= 26 and the skip-month flag is on, the
    NSE convention for its 6- and 12-month returns; else to the latest close) over the trailing
    26-week volatility, z-scored across names, summed with the lookback weights (equal when
    None). The skip is a true skip, so with lookbacks (26, 52) it is NSE's method as published,
    which the default score below does not implement (it widens the window instead)."""
    vol = prices.pct_change().rolling(26).std()
    safe_vol = vol.where(vol > 0)
    rets = []
    for lookback in config.lookbacks:
        skips = {"long": lookback >= 26, "all": True, "none": False}[config.voladj_skip]
        skip = 4 if config.voladj_skip_recent_month and skips else 0
        # A true skip: the return from (skip + lookback) weeks ago to `skip` weeks ago. (The
        # default voladj score above computes prices / prices.shift(skip + 26), a 30-week return
        # that still includes the latest month; see BL-055's log.)
        rets.append(prices.shift(skip) / prices.shift(skip + lookback) - 1)
    eligible = functools.reduce(operator.and_, (r.notna() for r in (*rets, vol)))
    weights = config.weights or (1.0,) * len(rets)
    score = None
    for weight, ret in zip(weights, rets, strict=True):
        part = weight * _cross_zscore((ret / safe_vol).where(eligible))
        score = part if score is None else score + part
    score = score.where(eligible)
    final = _rank_from_score(score, tie_break=rets[-1], higher_is_better=True)
    return final, score


def _compute_ranks_blend(prices: pd.DataFrame, config: Config) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Average of the ranksum and voladj final ranks (lower = better in both), re-ranked to a
    fresh 1..N ordering. Only instruments eligible in both sub-rankings get a blended rank."""
    ranksum_final, _ = _compute_ranks_ranksum(prices, config)
    voladj_final, _ = _compute_ranks_voladj(prices, config)
    both_eligible = ranksum_final.notna() & voladj_final.notna()
    avg_rank = ((ranksum_final + voladj_final) / 2).where(both_eligible)
    final = _rank_from_score(avg_rank, tie_break=None, higher_is_better=False)
    return final, avg_rank


RankCache = dict[tuple, tuple[pd.DataFrame, pd.DataFrame]]


class _Grid:
    """A week x column table read by position (BL-005 Phase 3).

    `DataFrame.at[week, column]` costs about ten microseconds a call, and a Broad backtest makes
    some 200,000 of them (a price, a rank, a lock flag, a group per holding per week), which was
    about 40% of its run time. This holds the same values as one array plus two label-to-position
    dicts, so `at` is two dict lookups and an index. It returns exactly what `.at` returns (the
    array's own scalar of the frame's dtype), so no result moves; a missing week or column raises
    KeyError as `.at` does. It needs unique labels (`_grid` falls back to `_FrameGrid` for a table
    that has repeats, so such a table behaves as it always did)."""

    __slots__ = ("cols", "rows", "values")

    def __init__(self, frame: pd.DataFrame) -> None:
        self.values = frame.to_numpy()
        self.rows = {week: i for i, week in enumerate(frame.index)}
        self.cols = {name: j for j, name in enumerate(frame.columns)}

    def at(self, week: pd.Timestamp, name: str):
        return self.values[self.rows[week], self.cols[name]]

    def has(self, name: str) -> bool:
        return name in self.cols


class _FrameGrid:
    """The `_Grid` interface over the DataFrame itself, for a table with a repeated label. A
    repeated label makes `.at` return a Series, which is only a problem if that label is read, so
    the table must not be refused up front: an unread duplicate used to be harmless."""

    __slots__ = ("frame",)

    def __init__(self, frame: pd.DataFrame) -> None:
        self.frame = frame

    def at(self, week: pd.Timestamp, name: str):
        return self.frame.at[week, name]

    def has(self, name: str) -> bool:
        return name in self.frame.columns


def _grid(frame: pd.DataFrame | None) -> _Grid | _FrameGrid | None:
    if frame is None:
        return None
    if frame.index.is_unique and frame.columns.is_unique:
        return _Grid(frame)
    return _FrameGrid(frame)


@dataclass
class _Sim:
    """What both portfolio rules share: prices, ranks, costs, tax and the trade log."""

    prices: pd.DataFrame
    ranks: pd.DataFrame
    filter_ret: pd.DataFrame
    config: Config
    ledger: TaxLedger | None
    tax_classes: dict[str, str]
    # week x company_id booleans; an instrument absent from its columns (e.g. an ETF/benchmark)
    # is always eligible to buy. None (default) disables the gate entirely.
    membership: pd.DataFrame | None = None
    # Weeks on which sells/buys may happen (rebalance="monthly" restricts this to month-end
    # weeks; the default "weekly" is every processed week).
    trade_weeks: frozenset[pd.Timestamp] = field(default_factory=frozenset)
    trade_rows: list[dict] = field(default_factory=list)
    # mass_exit_throttle only (TODO.md 3.9.20) - the weeks an external, per-run computation (see
    # categories/broad.py) flagged as a synchronized mass exit. None (default) means no such
    # computation was supplied - `config.mass_exit_throttle` has nothing to key off and is
    # effectively inert even if turned on, same as `membership=None` disabling that gate.
    mass_exit_weeks: frozenset[pd.Timestamp] | None = None
    # max_group only: week x instrument table of group labels (a NaN/None cell = not in any group
    # that week). Per-week because a stock's group is whichever held category it was picked
    # through, which changes as categories rotate.
    groups: pd.DataFrame | None = None
    # week x instrument booleans; True = may not be BOUGHT that week (e.g. share price above the
    # affordability ceiling). Never forces a sale: a holding stays until its rank says sell, and
    # may still be topped up, so a stock that grows past the ceiling is simply held through.
    no_buy: pd.DataFrame | None = None
    # Circuit locks, fill-week aligned (NOT shifted by signal_delay: they describe the day the
    # trade would actually fill). uc_locked = stuck at the upper circuit, so nobody sells it to
    # you: it may not be bought. lc_locked = stuck at the lower circuit, so nobody buys it from
    # you: a holding may not be sold, trimmed or traded away until the lock lifts. Both None
    # (default) leave the engine exactly as before.
    uc_locked: pd.DataFrame | None = None
    lc_locked: pd.DataFrame | None = None
    # Daily stop only (BL-054): per-day moves, open gaps and lock flags. See DailyMoves.
    daily: "DailyMoves | None" = None
    # inverse_vol only: week x name, 1 / trailing weekly-return std at the signal week.
    inv_vol: pd.DataFrame | None = None
    # The tables above, read by position (see `_Grid`). Built once, here: nothing replaces a table
    # on a sim after it is made.
    _prices: _Grid | _FrameGrid = field(init=False, repr=False)
    _ranks: _Grid | _FrameGrid = field(init=False, repr=False)
    _filter_ret: _Grid | _FrameGrid = field(init=False, repr=False)
    _membership: _Grid | _FrameGrid | None = field(init=False, repr=False)
    _groups: _Grid | _FrameGrid | None = field(init=False, repr=False)
    _no_buy: _Grid | _FrameGrid | None = field(init=False, repr=False)
    _uc_locked: _Grid | _FrameGrid | None = field(init=False, repr=False)
    _lc_locked: _Grid | _FrameGrid | None = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._prices = _grid(self.prices)
        self._ranks = _grid(self.ranks)
        self._filter_ret = _grid(self.filter_ret)
        self._membership = _grid(self.membership)
        self._groups = _grid(self.groups)
        self._no_buy = _grid(self.no_buy)
        self._uc_locked = _grid(self.uc_locked)
        self._lc_locked = _grid(self.lc_locked)

    def sell_blocked(self, asset: str, week: pd.Timestamp) -> bool:
        return (
            self._lc_locked is not None
            and self._lc_locked.has(asset)
            and bool(self._lc_locked.at(week, asset))
        )

    def group(self, week: pd.Timestamp, asset: str) -> str | None:
        """The group `asset` counts toward that week, or None (ungrouped / no table supplied)."""
        if self._groups is None or not self._groups.has(asset):
            return None
        label = self._groups.at(week, asset)
        return label if isinstance(label, str) else None

    def buy_cost(self, value_fraction: float, asset: str | None = None) -> float:
        """Cost fraction charged on a buy of size `value_fraction` of the 1.0-normalised
        portfolio. `asset` only matters to the itemised model, which prices the liquid fund as
        a mutual fund rather than a listed share (see LIQUID_FUND_STAMP_DUTY_RATE)."""
        if self.config.cost_model == "flat":
            return self.config.cost_pct / 100
        if asset in _LIQUID_FUND:
            return LIQUID_FUND_STAMP_DUTY_RATE
        slippage = self.config.slippage_bps / 10000
        return STT_RATE + STAMP_DUTY_BUY_RATE + EXCHANGE_FEES_RATE + slippage

    def sell_cost(self, value_fraction: float, asset: str | None = None) -> float:
        """Cost fraction charged on a sell of size `value_fraction` of the 1.0-normalised
        portfolio. `asset`: as for `buy_cost`."""
        if self.config.cost_model == "flat":
            return self.config.cost_pct / 100
        if asset in _LIQUID_FUND:
            return 0.0
        slippage = self.config.slippage_bps / 10000
        return STT_RATE + EXCHANGE_FEES_RATE + slippage + self._dp_charge_fraction(value_fraction)

    def _dp_charge_fraction(self, value_fraction: float) -> float:
        """The flat per-sell DP charge, expressed as a fraction of the sold value (capped so a
        dust-sized sell doesn't produce an absurd cost fraction)."""
        if value_fraction <= 0:
            return 0.0
        fraction = DP_CHARGE_RS / (value_fraction * self.config.capital)
        return min(fraction, DP_CHARGE_FRACTION_CAP)

    def price(self, asset: str, week: pd.Timestamp) -> float:
        return self._prices.at(week, CASH if asset in (_POOL, IDLE) else asset)

    def rank(self, week: pd.Timestamp, asset: str) -> float:
        return self._ranks.at(week, asset) if self._ranks.has(asset) else float("nan")

    def passes_filter(self, name: str, week: pd.Timestamp) -> bool:
        if self.config.defensive != "filter":
            return True
        mine, cash = self._filter_ret.at(week, name), self._filter_ret.at(week, CASH)
        return pd.notna(mine) and pd.notna(cash) and mine > cash

    def exit_reason(self, asset: str, week: pd.Timestamp, slack: int = 0) -> str | None:
        """Why a holding must be sold this week, or None to keep it. `slack` widens the exit
        rank for this one holding (see `tax_hold_band`)."""
        if self.sell_blocked(asset, week):
            return None  # locked at the lower circuit: no buyer, so it cannot be sold this week
        rank = self.rank(week, asset)
        if pd.isna(rank):
            return "ineligible"
        if rank > self.config.exit_rank + slack:
            return f"rank {int(rank)} > {self.config.exit_rank + slack}"
        if not self.passes_filter(asset, week):
            return f"{self.config.filter_lookback}w return below cash"
        return None

    def top_names(
        self, week: pd.Timestamp, held: frozenset[str] | set[str] = frozenset()
    ) -> list[str]:
        """The current top N that may be bought, best first. Membership-gated: an instrument
        that's dropped out of the index this week (present in `membership`'s columns but False
        that week) isn't offered as a new buy. An instrument absent from `membership` altogether
        (an ETF/benchmark, or when membership tracking is off) is always eligible.

        `no_buy` gate: a name flagged that week and not in `held` is skipped, and the list is
        refilled from the next-best-ranked names (those flagged are never used as fillers) so
        the top-N slot goes to the best name that can actually be bought.

        `uc_locked` gate: nobody is selling a stock stuck at the upper circuit, so it can be
        neither bought nor topped up. A held one keeps its top-N slot (no filler is bought in
        its place) but is left out of the returned list, so it receives no money that week."""
        ranks = self.ranks.loc[week].dropna().sort_values()
        values = ranks.to_numpy()
        # Sorted best first, so the names within the top N are a prefix: find where it ends
        # instead of looking every ranked name up (there are ~760 for Broad, each week).
        within = int(np.searchsorted(values, self.config.top_n, side="right"))
        names = [n for n in ranks.index[:within] if self.passes_filter(n, week)]
        membership = self._membership
        if membership is not None:
            names = [n for n in names if not membership.has(n) or bool(membership.at(week, n))]
        gates = [g for g in (self._no_buy, self._uc_locked) if g is not None]
        if not gates:
            return names

        def blocked(n: str) -> bool:
            return any(g.has(n) and bool(g.at(week, n)) for g in gates)

        def unbuyable(n: str) -> bool:
            locked = self._uc_locked
            return locked is not None and locked.has(n) and bool(locked.at(week, n))

        out = [n for n in names if n in held or not blocked(n)]
        if len(out) >= self.config.top_n:
            return [n for n in out if not unbuyable(n)]
        for n, rank in zip(ranks.index, values, strict=True):
            if len(out) >= self.config.top_n:
                break
            if n in out or blocked(n) or not self.passes_filter(n, week):
                continue
            if membership is not None and membership.has(n) and not bool(membership.at(week, n)):
                continue
            if rank > self.config.exit_rank:
                break
            out.append(n)
        return [n for n in out if not unbuyable(n)]

    def split_weights(self, week: pd.Timestamp, names: list[str]) -> dict[str, float]:
        """Shares (summing to 1) of a buy week's money across `names`: equal, or inverse
        volatility (BL-054 L5), where a name with no usable volatility gets the median weight."""
        if self.inv_vol is None or not names:
            return {n: 1 / len(names) for n in names} if names else {}
        raw = {}
        for n in names:
            v = self.inv_vol.at[week, n] if n in self.inv_vol.columns else np.nan
            raw[n] = float(v) if np.isfinite(v) and v > 0 else np.nan
        known = [v for v in raw.values() if np.isfinite(v)]
        fill = float(np.median(known)) if known else 1.0
        weights = {n: (v if np.isfinite(v) else fill) for n, v in raw.items()}
        total = sum(weights.values())
        return {n: w / total for n, w in weights.items()}

    def best_unheld(self, week: pd.Timestamp, exclude: set[str] | frozenset[str]) -> str | None:
        """BL-053 `stop_proceeds="top"`: the best-ranked name not in `exclude` that may be bought
        this week (the same gates as `top_names`), down to `exit_rank` - a name ranked worse
        would be sold at the next rebalance. None when there is none."""
        ranks = self.ranks.loc[week].dropna().sort_values()
        gates = [g for g in (self._no_buy, self._uc_locked) if g is not None]
        membership = self._membership
        for name, rank in ranks.items():
            if rank > self.config.exit_rank:
                return None
            if name in exclude or not self.passes_filter(name, week):
                continue
            if (
                membership is not None
                and membership.has(name)
                and not bool(membership.at(week, name))
            ):
                continue
            if any(g.has(name) and bool(g.at(week, name)) for g in gates):
                continue
            return name
        return None

    def tax(self, asset: str, gain: float, held_days: int) -> float:
        if self.ledger is None:
            return 0.0
        tax_class = self.tax_classes.get(CASH if asset in (_POOL, IDLE) else asset, DEBT)
        return self.ledger.sale(tax_class, gain, held_days)

    def record(self, week, action, asset, reason, value, slot=None, tax=0.0, **extra) -> None:
        """One trade-log row. `value` is the trade's gross size in portfolio units (1.0 = the
        starting capital). Rows for a real fill also carry, via `extra`, what an independent
        replay needs: `fill_price`, `units` traded (value units / price, so rupee shares are
        `units * capital`), `prev_units` held before the trade, and `cost` paid (same units as
        `value`; excludes `tax`). A sell's `units * fill_price` is `value`; a buffer-rule buy's
        is `value - cost` (the slots rule logs a buy's value net of cost - see `_run_slots`)."""
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


def _month_end_weeks(weeks: list[pd.Timestamp]) -> frozenset[pd.Timestamp]:
    """Weeks that are the last-in-`weeks` for their calendar month: the next week in the list
    falls in a different month (or year), or there is no next week."""
    out = [
        w
        for i, w in enumerate(weeks)
        if i == len(weeks) - 1 or (weeks[i + 1].year, weeks[i + 1].month) != (w.year, w.month)
    ]
    return frozenset(out)


#: Week 0 of the `rebalance_every` calendar (the first Friday of the price history).
CADENCE_EPOCH = pd.Timestamp("2016-01-01")


def cadence_weeks(weeks: list[pd.Timestamp], every: int, offset: int) -> frozenset[pd.Timestamp]:
    """Weeks whose calendar week number since CADENCE_EPOCH is `offset` mod `every`. Weekly
    frames are Friday-labelled, so the day gap is a whole number of weeks; rounding guards a
    frame labelled on another weekday."""
    return frozenset(w for w in weeks if round((w - CADENCE_EPOCH).days / 7) % every == offset)


def run_backtest(
    prices: pd.DataFrame,
    includes: dict[str, str],
    config: Config,
    tax_classes: dict[str, str] | None = None,
    rank_cache: RankCache | None = None,
    trade_prices: pd.DataFrame | None = None,
    membership: pd.DataFrame | None = None,
    external_ranks: tuple[pd.DataFrame, pd.DataFrame] | None = None,
    mass_exit_weeks: frozenset[pd.Timestamp] | None = None,
    groups: pd.DataFrame | None = None,
    no_buy: pd.DataFrame | None = None,
    uc_locked: pd.DataFrame | None = None,
    lc_locked: pd.DataFrame | None = None,
    daily: "DailyMoves | None" = None,
) -> Result:
    """`rank_cache` lets a sweep reuse the (slow) ranking when only top_n/exit/mode differ.
    `trade_prices` (signal week x instrument) is what trades fill at and holdings are valued
    at; None means the signal prices themselves (index, Friday close). `membership` (week x
    company_id booleans) gates new buys to instruments that are actually in the index that week
    (see _Sim.top_names); None (default) disables the gate - every ranked-eligible name may be
    bought, as today.

    `external_ranks` (final rank, composite score) - both shaped week x instrument, same as
    `compute_ranks`'s own return - lets a caller supply a rank table computed OUTSIDE this
    module's own ranksum/voladj/blend scoring entirely, bypassing both `rank_cache` and
    `compute_ranks`. Added for `categories/broad.py`'s "Broad Momentum" mode: a per-week rank
    derived from a category-selection/hysteresis layer built on top of ordinary per-stock
    momentum ranks (see that module's own docstring) isn't expressible as any `Config.score`
    variant, but every downstream mechanic here - `_Sim.rank`/`exit_reason`/`top_names`, the
    buffer/slots portfolio rules, `_rank_from_score`-based ties, the `enough`-history start-date
    gate below - only ever reads the resulting (ranks, scores) DataFrames, never how they were
    produced, so no other engine.py change is needed to support an externally-computed ranking.
    Takes priority over `rank_cache` when both are given (an external rank table is never cached
    or looked up by the `(names, lookbacks, weights, score, ...)` key `rank_cache` uses - it isn't
    keyed on any of those Config fields to begin with).

    `mass_exit_weeks` (TODO.md 3.9.20) - weeks flagged by an external, per-run computation (see
    categories/broad.py's `compute_category_selection_mass_exit`) as a synchronized mass exit;
    only consulted when `config.mass_exit_throttle` is True, same "data, not a Config field"
    reasoning as `external_ranks`/`trade_prices`/`membership` above. Signal-week aligned: it is
    shifted by `signal_delay` together with the ranks.

    `groups` (week x instrument group labels, same shape as `ranks`) is what `config.max_group`
    caps against - see `_Sim.group`. It is shifted by `signal_delay` together with the ranks it
    was built alongside, so a delayed signal keeps its own week's grouping. Ignored by the
    fixed-slots rule, which is always equal-weight.

    `no_buy` (week x instrument booleans, True = not buyable that week) blocks NEW purchases only
    - see `_Sim.no_buy`. Shifted by `signal_delay` with the ranks. Broad Momentum uses it for the
    share-price ceiling, which is about whether a small budget can afford a first share.

    `uc_locked` / `lc_locked` (week x instrument booleans) model circuit locks on the day a trade
    would fill: a stock locked at the upper circuit cannot be bought, one locked at the lower
    circuit cannot be sold or trimmed (so it is held through, and marked down, until the lock
    lifts). Unlike `no_buy` they are not shifted by `signal_delay`. See
    categories/circuit_exposure.py for how they are built."""
    if config.stop_granularity == "daily" and daily is None:
        raise ValueError("stop_granularity='daily' needs daily moves (categories.daily_moves)")
    names = ranked_universe(includes, config)
    missing = [n for n in [*names, CASH, config.benchmark] if n not in prices]
    if missing:
        raise ValueError(f"weekly closes are missing {missing}")
    if config.needs_trade_prices and trade_prices is None:
        raise ValueError(
            f"track={config.track} / execution={config.execution} needs trade prices "
            "(see trade_prices.build_trade_prices)"
        )
    fills = prices if trade_prices is None else trade_prices.reindex(prices.index)
    inv_vol = None
    if config.weight_by == "inverse_vol":
        std = fills.pct_change().rolling(config.vol_window).std()
        inv_vol = (1 / std.where(std > 0)).shift(config.signal_delay)
    missing = [n for n in [*names, CASH, config.benchmark] if n not in fills]
    if missing:
        raise ValueError(f"trade prices are missing {missing}")
    if config.tax is not None and tax_classes is None:
        raise ValueError("tax needs tax_classes (instrument -> equity/gold_silver/...)")

    if external_ranks is not None:
        ranks, scores = external_ranks
    else:
        # score/voladj_skip_recent_month are in the key too: two configs that differ only in
        # ranking method must never share a cached rank table.
        key = (
            tuple(names),
            config.lookbacks,
            config.weights,
            config.score,
            config.voladj_skip_recent_month,
            config.voladj_lookbacks,
            config.voladj_skip,
        )
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
        if groups is not None:
            groups = groups.shift(config.signal_delay)
        if no_buy is not None:
            no_buy = no_buy.shift(config.signal_delay)
        if mass_exit_weeks:
            # Flagged on the week the ranking showed the mass exit; like the ranks, it is acted
            # on `signal_delay` rows later. Left unshifted it throttled the week of the signal
            # itself, a week before the delayed ranks could have been traded on.
            index = ranks.index
            at = index.get_indexer(sorted(mass_exit_weeks)) + config.signal_delay
            mass_exit_weeks = frozenset(
                index[i] for i in at if config.signal_delay <= i < len(index)
            )
    if no_buy is not None:
        no_buy = no_buy.reindex(ranks.index).fillna(False).astype(bool)
    if groups is not None:
        groups = groups.reindex(ranks.index)
    if uc_locked is not None:
        uc_locked = uc_locked.reindex(ranks.index).fillna(False).astype(bool)
    if lc_locked is not None:
        lc_locked = lc_locked.reindex(ranks.index).fillna(False).astype(bool)

    in_window = ranks.index >= pd.Timestamp(config.start)
    if config.end:
        in_window &= ranks.index <= pd.Timestamp(config.end)
    enough = ranks.notna().sum(axis=1).to_numpy() >= (config.min_ranked or config.top_n)
    weeks = list(ranks.index[in_window & enough])
    if trade_prices is not None:
        # The newest signal week may not have a fill yet (e.g. Monday hasn't happened).
        filled = fills[CASH].notna()
        weeks = [w for w in weeks if filled.at[w]]
    if len(weeks) < 2:
        raise ValueError("not enough history to run from the chosen start date")

    if config.rebalance == "weekly" and config.rebalance_every == 1:
        trade_weeks = frozenset(weeks[:-1])
    elif config.rebalance == "weekly":
        trade_weeks = cadence_weeks(
            weeks, config.rebalance_every, config.rebalance_offset
        ) & frozenset(weeks[:-1])
    else:
        trade_weeks = _month_end_weeks(weeks) & frozenset(weeks[:-1])

    sim = _Sim(
        prices=fills,
        ranks=ranks,
        filter_ret=filter_ret,
        config=config,
        ledger=TaxLedger(config.tax) if config.tax is not None else None,
        tax_classes=tax_classes or {},
        membership=membership,
        trade_weeks=trade_weeks,
        mass_exit_weeks=mass_exit_weeks,
        groups=groups,
        no_buy=no_buy,
        uc_locked=uc_locked,
        lc_locked=lc_locked,
        daily=daily,
        inv_vol=inv_vol,
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
        benchmark=normalised(fills[config.benchmark], config.benchmark),
        cash=normalised(fills[CASH], CASH),
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
    config = sim.config
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
        slot["value"] *= 1 - sim.sell_cost(slot["value"], slot["asset"])
        if slot["since"] is None:
            return 0.0
        tax = sim.tax(slot["asset"], slot["value"] - slot["basis"], (week - slot["since"]).days)
        slot["value"] -= tax
        return tax

    for i, week in enumerate(weeks[:-1]):
        if week in sim.trade_weeks:
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
                    # A ranked-mode cash holding dropping out stays in the same liquid fund -
                    # it's only relabelled as parked, so there's no trade, no cost and no tax.
                    sim.record(week, "SELL", asset, reason, value_before, slot_no, 0.0, **details)
                    slot["kind"] = "parked"
                    continue
                price = sim.price(asset, week)
                fill = {
                    "units": value_before / price,
                    "fill_price": price,
                    "cost": value_before * sim.sell_cost(value_before, asset),
                    "prev_units": value_before / price,
                }
                tax = realise(slot, week)
                sim.record(
                    week, "SELL", asset, reason, value_before, slot_no, tax, **details, **fill
                )
                # park proceeds in the liquid fund
                slot["value"] *= 1 - sim.buy_cost(slot["value"], CASH)
                slot.update(asset=CASH, kind="parked", since=week, basis=slot["value"])

            # 2. Buys: best-ranked names within the top N that aren't already held.
            held = {s["asset"] for s in slots if s["kind"] == "held"}
            candidates = [n for n in sim.top_names(week, held) if n not in held]
            for slot_no, slot in enumerate(slots, start=1):
                if slot["kind"] == "held":
                    continue
                if candidates:
                    name = candidates.pop(0)
                    price, cost = sim.price(name, week), 0.0
                    if slot["asset"] == name:  # cash already parked in the liquid fund
                        slot["kind"] = "held"
                    else:
                        if slot["asset"] is not None:  # leaving the liquid fund
                            realise(slot, week)
                        cost = slot["value"] * sim.buy_cost(slot["value"], name)
                        slot["value"] -= cost
                        slot.update(asset=name, kind="held", since=week, basis=slot["value"])
                    rank = int(sim.rank(week, name))
                    # Slots log the position's value AFTER the buying cost (unlike the buffer
                    # rule's gross `value`), so here `units * fill_price` is `value` itself.
                    fill = {
                        "units": slot["value"] / price,
                        "fill_price": price,
                        "cost": cost,
                        "prev_units": 0.0,
                    }
                    sim.record(week, "BUY", name, f"rank {rank}", slot["value"], slot_no, **fill)
                elif slot["asset"] is None:
                    slot["value"] *= 1 - sim.buy_cost(slot["value"], CASH)
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

        # 3. Hold for the week. A slot whose asset is still None (rebalance="monthly": no trade
        #    week has happened yet) hasn't been priced into anything - its value just sits idle.
        nxt = weeks[i + 1]
        for slot in slots:
            asset = slot["asset"]
            if asset is not None:
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
            proceeds = slot["value"] * (1 - sim.sell_cost(slot["value"], slot["asset"]))
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


def _win_rate_multiplier(
    trade_rows: list[dict], week: pd.Timestamp, window: int = 10, floor: float = 0.0
) -> float:
    """Position-size multiplier in [floor, 1.0] from the recent record of CLOSED trades (SELL
    rows with a `position_return`, see `_Sim.exit_details`/`record`) that closed strictly before
    `week` - no lookahead, so a SELL recorded on `week` itself doesn't count yet.

    Weight the most recent closed trade `window`, the next `window - 1`, ... down to 1 for the
    `window`-th-most-recent (fewer than `window` available: weights still start at `window` and
    count down, e.g. window=10 with 3 trades -> 10/9/8, never padded/truncated to a fixed
    `window`-slot scheme). Each trade contributes `weight * (+1 if it was a win else -1)`
    (win/loss only, not magnitude-weighted); summing gives a score in
    `[-sum(weights_used), +sum(weights_used)]`, normalised to a 0-100 "weighted win rate" (0
    contribution, i.e. an even recent split, is exactly 50%). The multiplier is
    `win_rate_pct / 50`, clamped to `[floor, 1]`: 50% (neutral, or no history yet) -> 1.0 (full
    size), 0% (an all-loss recent streak) -> `floor` (0.0 = deploy nothing this week, i.e. sit
    entirely in cash; a higher floor keeps at least that much invested even at the worst recent
    win rate), linear in between.
    """
    closed = [
        row
        for row in trade_rows
        if row["action"] == "SELL" and row["week"] < week and pd.notna(row.get("position_return"))
    ]
    if not closed:
        return 1.0
    closed.sort(key=lambda row: row["week"])
    recent = closed[-window:]  # oldest-to-newest; at most the last `window` closes before `week`
    weighted = list(zip(reversed(recent), range(window, window - len(recent), -1), strict=True))
    score = sum(weight * (1 if row["position_return"] > 0 else -1) for row, weight in weighted)
    weights_used = sum(weight for _, weight in weighted)
    win_rate_pct = (score / weights_used + 1) / 2 * 100
    return max(floor, min(1.0, win_rate_pct / 50))


def _has_room(
    name: str,
    rooms: dict[str, float],
    given: dict[str, float],
    label_of: dict[str, str | None],
    group_left: dict[str, float],
) -> bool:
    """Whether `name` can still take money this week: under its own position cap and, if it sits
    in a group, that group's shared room isn't used up either."""
    label = label_of[name]
    return rooms[name] - given[name] > 1e-12 and (label is None or group_left[label] > 1e-12)


def _run_buffer(sim: _Sim, weeks: list[pd.Timestamp]) -> _Outcome:
    """Positions are lists of lots - one per purchase - so each top-up keeps its own date and
    cost for tax. A lot is {units, since, basis}; basis is the rupee cost after buying costs."""
    config = sim.config
    lots: dict[str, list[dict]] = {}
    uninvested = 1.0  # starting money, not yet in anything
    equity = {weeks[0]: 1.0}
    weights, holdings_rows = {}, []

    def value(asset: str, week) -> float:
        return sum(lot["units"] for lot in lots.get(asset, [])) * sim.price(asset, week)

    def units_held(asset: str) -> float:
        return sum(lot["units"] for lot in lots.get(asset, []))

    def buy(asset: str, amount: float, week) -> dict:
        """Returns the fill details `sim.record` stores for an audit."""
        price, before = sim.price(asset, week), units_held(asset)
        net = amount * (1 - sim.buy_cost(amount, asset))
        lots.setdefault(asset, []).append({"units": net / price, "since": week, "basis": net})
        return {
            "units": net / price,
            "fill_price": price,
            "cost": amount - net,
            "prev_units": before,
        }

    cap = config.max_position

    def portfolio_value(week) -> float:
        return sum(value(a, week) for a in lots)

    def room(name: str, total: float, week) -> float:
        """How much more `name` can take before it reaches the cap."""
        if cap is None:
            return math.inf
        return max(cap * total - value(name, week), 0.0)

    gcap = config.max_group

    def members_by_group(week) -> dict[str, list[str]]:
        """Currently held (non-cash) positions, bucketed by the group they count toward."""
        out: dict[str, list[str]] = {}
        for asset in lots:
            label = None if asset == _POOL else sim.group(week, asset)
            if label is not None:
                out.setdefault(label, []).append(asset)
        return out

    def group_room(label: str, total: float, week) -> float:
        """How much more the group `label` can take before it reaches the group cap."""
        if gcap is None:
            return math.inf
        held = sum(value(a, week) for a in members_by_group(week).get(label, []))
        return max(gcap * total - held, 0.0)

    def absorbable(names: list[str], total: float, week) -> float:
        """The most `names` can take together, honouring the position cap and - since names in
        one group share that group's room - the group cap. math.inf when neither cap is set."""
        free, by_group = 0.0, {}
        for name in names:
            label = sim.group(week, name) if gcap is not None else None
            if label is None:
                free += room(name, total, week)
            else:
                by_group[label] = by_group.get(label, 0.0) + room(name, total, week)
        return free + sum(
            min(taken, group_room(label, total, week)) for label, taken in by_group.items()
        )

    def tax_slack(asset: str, week) -> int:
        """`tax_hold_band` when the oldest lot is in gain and turns long-term within
        `tax_hold_weeks` weeks, else 0. Inert without `tax` or for debt (never long-term)."""
        if not config.tax_hold_band or sim.ledger is None:
            return 0
        if sim.tax_classes.get(asset, DEBT) == DEBT:
            return 0
        oldest = min(lots[asset], key=lambda lot: lot["since"])
        age = (week - oldest["since"]).days
        threshold = sim.ledger.rules.long_term_days
        if not threshold - 7 * config.tax_hold_weeks < age <= threshold:
            return 0
        in_gain = oldest["units"] * sim.price(asset, week) > oldest["basis"]
        return config.tax_hold_band if in_gain else 0

    def sell(
        asset: str, fraction: float, week, price: float | None = None, day=None
    ) -> tuple[float, float, float, dict]:
        """Sell `fraction` of every lot. Returns (gross value, net proceeds, tax, fill details
        for `sim.record`). `price` and `day` override the week's fill price and date (the daily
        stop sells at a morning's open)."""
        price = sim.price(asset, week) if price is None else price
        before = units_held(asset)
        when = week if day is None else day
        # Gross first, so the itemised cost's DP-charge fraction (which depends on the total
        # value_fraction sold) is computed once and applied consistently across every lot.
        gross = sum(lot["units"] * fraction * price for lot in lots[asset])
        sell_frac = sim.sell_cost(gross, asset)
        tax = 0.0
        for lot in lots[asset]:
            units, basis = lot["units"] * fraction, lot["basis"] * fraction
            lot_gross = units * price
            tax += sim.tax(asset, lot_gross * (1 - sell_frac) - basis, (when - lot["since"]).days)
            lot["units"] -= units
            lot["basis"] -= basis
        if fraction >= 1 - 1e-12:
            del lots[asset]
        fill = {
            "units": gross / price,
            "fill_price": price,
            "cost": gross * sell_frac,
            "prev_units": before,
        }
        return gross, gross * (1 - sell_frac) - tax, tax, fill

    def stop_reason(asset: str, i: int) -> str | None:
        """Why the stop-loss sells `asset` at weeks[i], judged on the close `stop_delay` weeks
        earlier, or None. Never a reason while the sale itself is locked."""
        week = weeks[i]
        if sim.sell_blocked(asset, week):
            return None
        seen = weeks[i - config.stop_delay] if i >= config.stop_delay else None
        position = lots[asset]
        since = min(lot["since"] for lot in position)
        if seen is None or seen < since:
            return None  # bought after the week the stop looks at
        now = sim.price(asset, seen)
        if not now > 0:
            return None
        units = sum(lot["units"] for lot in position)
        if config.stop_from_buy is not None and units > 0:
            bought = sum(lot["basis"] for lot in position) / units
            fall = 1 - now / bought
            if fall >= config.stop_from_buy:
                return f"stop: {fall:.0%} below the buy price"
        if config.stop_from_peak is not None:
            peak = sim.prices.loc[since:seen, asset].max()
            fall = 1 - now / peak if peak > 0 else 0.0
            if fall >= config.stop_from_peak:
                return f"stop: {fall:.0%} below the peak"
        return None

    daily = sim.daily if config.stop_granularity == "daily" else None
    run_price: dict[str, float] = {}  # daily stop: a holding's running price
    run_peak: dict[str, float] = {}  # ... and its highest running price since it was bought
    pending: dict[str, str] = {}  # ... stops triggered, awaiting a morning they can sell in

    def daily_walk(week, nxt) -> float:
        """BL-054 L4. Walk the trading days in (week, nxt] over what is held after this week's
        trades. Each day's close can trigger a stop, which sells at the next session's open (not
        on a locked day). The running price follows the exchange's daily moves and is re-anchored
        to the weekly price at nxt, so the weekly series stays authoritative. Returns the cash
        raised, which waits for the next rebalance."""
        raised = 0.0
        for a in [a for a in run_price if a not in lots]:
            run_price.pop(a), run_peak.pop(a, None), pending.pop(a, None)
        for a in lots:
            if a != _POOL and a not in run_price:
                run_price[a] = run_peak[a] = sim.price(a, week)
        for d in daily.days_between(week, nxt):
            for a in [a for a in lots if a != _POOL and a in daily.move.columns]:
                before = run_price[a]
                if a in pending and not daily.locked.at[d, a]:
                    fill = before * (1 + daily.open_gap.at[d, a])
                    position = lots[a]
                    since = min(lot["since"] for lot in position)
                    basis = sum(lot["basis"] for lot in position)
                    value_before = units_held(a) * fill
                    note = f"{pending.pop(a)}, sold at the {d.date()} open"
                    _, net, tax, fill_info = sell(a, 1.0, week, price=fill, day=d)
                    details = {
                        "entry_week": since,
                        "entry_value": basis,
                        "weeks_held": (d - since).days / 7,
                        "price_return": fill / sim.price(a, since) - 1,
                        "position_return": value_before / basis - 1 if basis else float("nan"),
                    }
                    sim.record(week, "SELL", a, note, value_before, tax=tax, **details, **fill_info)
                    run_price.pop(a), run_peak.pop(a, None)
                    raised += net
                    continue
                price = before * (1 + daily.move.at[d, a])
                run_price[a] = price
                run_peak[a] = max(run_peak[a], price)
                if a in pending:
                    continue  # locked this morning: still waiting
                units = units_held(a)
                bought = sum(lot["basis"] for lot in lots[a]) / units if units > 0 else price
                if config.stop_from_buy is not None and 1 - price / bought >= config.stop_from_buy:
                    fall, what = 1 - price / bought, "buy price"
                elif (
                    config.stop_from_peak is not None
                    and 1 - price / run_peak[a] >= config.stop_from_peak
                ):
                    fall, what = 1 - price / run_peak[a], "peak"
                else:
                    continue
                pending[a] = f"daily stop: {fall:.0%} below the {what} at the {d.date()} close"
        for a in lots:
            weekly = sim.price(a, nxt) if a != _POOL else math.nan
            if a in run_price and weekly > 0 and run_price[a] > 0:
                run_peak[a] *= weekly / run_price[a]
                run_price[a] = weekly
        return raised

    for i, week in enumerate(weeks[:-1]):
        proceeds, uninvested = uninvested, 0.0

        is_buy_week = week in sim.trade_weeks
        stopped: set[str] = set()
        stop_net = 0.0
        if config.has_stop and daily is None:
            # 0. Stop-loss, every week (BL-053), before the rank exits.
            for asset in [a for a in lots if a != _POOL]:
                reason = stop_reason(asset, i)
                if reason is None:
                    continue
                position = lots[asset]
                since = min(lot["since"] for lot in position)
                basis = sum(lot["basis"] for lot in position)
                value_before = value(asset, week)
                details = sim.exit_details(asset, week, since, basis, value_before)
                _, net, tax, fill = sell(asset, 1.0, week)
                sim.record(week, "SELL", asset, reason, value_before, tax=tax, **details, **fill)
                proceeds += net
                stop_net += net
                stopped.add(asset)
            if stopped and not is_buy_week and config.stop_proceeds == "top":
                name = sim.best_unheld(week, set(lots) | stopped)
                if name is not None:
                    total = portfolio_value(week) + proceeds
                    amount = min(stop_net, room(name, total, week))
                    label = sim.group(week, name) if gcap is not None else None
                    if label is not None:
                        amount = min(amount, group_room(label, total, week))
                    if amount > MIN_TRADE * total:
                        fill = buy(name, amount, week)
                        rank = int(sim.rank(week, name))
                        sim.record(week, "BUY", name, f"rank {rank} (after a stop)", amount, **fill)
                        proceeds -= amount
        if is_buy_week or config.sell_every_week:
            # 1. Sell whatever has dropped out. Gated on `is_buy_week` alone when
            #    `sell_every_week` is off (the original, unchanged behaviour); with it on, this
            #    also runs on a non-cadence week - only steps 2-4 below wait for the cadence.
            for asset in [a for a in lots if a != _POOL]:
                reason = sim.exit_reason(asset, week, tax_slack(asset, week))
                if reason is None:
                    continue
                position = lots[asset]
                since = min(lot["since"] for lot in position)
                basis = sum(lot["basis"] for lot in position)
                value_before = value(asset, week)
                details = sim.exit_details(asset, week, since, basis, value_before)
                _, net, tax, fill = sell(asset, 1.0, week)
                sim.record(week, "SELL", asset, reason, value_before, tax=tax, **details, **fill)
                proceeds += net

        if is_buy_week:
            # 2. Trim anything that has grown past the cap by more than the band, back to the cap.
            if cap is not None:
                total = portfolio_value(week) + proceeds
                for asset in [a for a in lots if a != _POOL]:
                    if sim.sell_blocked(asset, week):
                        continue
                    share = value(asset, week) / total
                    if share > cap + config.cap_band:
                        gross, net, tax, fill = sell(asset, 1 - cap / share, week)
                        reason = f"above the {cap:.0%} cap ({share:.0%})"
                        sim.record(week, "TRIM", asset, reason, gross, tax=tax, **fill)
                        proceeds += net

            # 2b. Same for a whole group (e.g. a category holding two stocks): once the group
            #     is over cap + band, every member is trimmed by the same fraction.
            if gcap is not None:
                total = portfolio_value(week) + proceeds
                for label, members in members_by_group(week).items():
                    share = sum(value(a, week) for a in members) / total
                    if share > gcap + config.cap_band:
                        for asset in members:
                            if sim.sell_blocked(asset, week):
                                continue
                            gross, net, tax, fill = sell(asset, 1 - gcap / share, week)
                            reason = f"{label} above the {gcap:.0%} group cap ({share:.0%})"
                            sim.record(week, "TRIM", asset, reason, gross, tax=tax, **fill)
                            proceeds += net

            # 3. Split the money equally across the current top N, but never past the cap. Parked
            #    cash joins in as soon as there's room for it.
            tops = sim.top_names(week, frozenset(a for a in lots if a != _POOL))
            # a stopped name, or one whose daily stop sells at the next open, is not re-bought
            tops = [n for n in tops if n not in stopped and n not in pending]
            total = portfolio_value(week) + proceeds
            if tops and _POOL in lots:
                need = absorbable(tops, total, week) - proceeds
                if need > MIN_TRADE * total:
                    fraction = min(1.0, need / value(_POOL, week))
                    gross, net, tax, fill = sell(_POOL, fraction, week)
                    reason = "back into the top N"
                    sim.record(week, "UNPARK", CASH, reason, gross, tax=tax, **fill)
                    proceeds += net
            if proceeds > 1e-12:
                # Momentum sizing: reduce what's available to the split loop BEFORE it runs (not
                # inside it) - the multiplier is computed off closed trades only, once, from
                # `proceeds`, the full amount that would otherwise be deployed this week.
                reserved = 0.0
                momentum_reserved = 0.0
                if config.momentum_sizing and tops:
                    multiplier = _win_rate_multiplier(
                        sim.trade_rows,
                        week,
                        window=config.momentum_sizing_window,
                        floor=config.momentum_sizing_floor,
                    )
                    momentum_reserved = proceeds * (1 - multiplier)
                    reserved += momentum_reserved
                # Mass-exit throttle (TODO.md 3.9.20): a second, independently-toggled
                # reservation applied to whatever's left after momentum sizing's own cut (not to
                # the original `proceeds`) on a week `sim.mass_exit_weeks` flags - computed
                # entirely outside this simulation, before it ever runs.
                mass_exit_reserved = 0.0
                if (
                    config.mass_exit_throttle
                    and tops
                    and sim.mass_exit_weeks is not None
                    and week in sim.mass_exit_weeks
                ):
                    mass_exit_reserved = (proceeds - reserved) * config.mass_exit_throttle_fraction
                    reserved += mass_exit_reserved
                left = proceeds - reserved
                if tops:
                    total = portfolio_value(week) + proceeds
                    rooms = {name: room(name, total, week) for name in tops}
                    given = dict.fromkeys(tops, 0.0)
                    # Names in one group draw on that group's single remaining room.
                    label_of = {n: sim.group(week, n) if gcap is not None else None for n in tops}
                    group_left = {
                        label: group_room(label, total, week)
                        for label in {v for v in label_of.values() if v is not None}
                    }

                    active = [
                        name for name in tops if _has_room(name, rooms, given, label_of, group_left)
                    ]
                    while left > 1e-12 and active:  # equal shares; a capped name's excess spreads
                        split = sim.split_weights(week, active) if sim.inv_vol is not None else None
                        pot = left
                        still = []
                        for name in active:
                            label = label_of[name]
                            allowed = rooms[name] - given[name]
                            if label is not None:
                                allowed = min(allowed, group_left[label])
                            share = pot / len(active) if split is None else pot * split[name]
                            give = max(min(share, allowed), 0.0)
                            given[name] += give
                            left -= give
                            if label is not None:
                                group_left[label] -= give
                            if _has_room(name, rooms, given, label_of, group_left):
                                still.append(name)
                        active = still
                    for name in tops:
                        if given[name] > 1e-12:
                            action = "ADD" if name in lots else "BUY"
                            fill = buy(name, given[name], week)
                            rank = int(sim.rank(week, name))
                            sim.record(week, action, name, f"rank {rank}", given[name], **fill)
                if left > 1e-12:
                    fill = buy(_POOL, left, week)
                    if not tops:
                        reason = "nothing in the top N qualifies"
                    elif gcap is None:
                        reason = f"top N all at the {cap:.0%} cap"
                    else:
                        reason = "top N all at the position/group cap"
                    sim.record(week, "PARK", CASH, reason, left, **fill)
                if momentum_reserved > 1e-12:
                    fill = buy(_POOL, momentum_reserved, week)
                    reason = f"momentum sizing: recent win rate -> {multiplier:.0%} size deployed"
                    sim.record(week, "PARK", CASH, reason, momentum_reserved, **fill)
                if mass_exit_reserved > 1e-12:
                    fill = buy(_POOL, mass_exit_reserved, week)
                    reason = (
                        "mass exit: over half of last week's held names exited -> "
                        f"{1 - config.mass_exit_throttle_fraction:.0%} of fresh capital deployed"
                    )
                    sim.record(week, "PARK", CASH, reason, mass_exit_reserved, **fill)

            # 4. Make room: a top-N name still not held is bought now, funded by trimming every
            #    holding by the same percentage, sized as an equal share of the portfolio (capped).
            if config.entry == "make_room":
                for name in tops:
                    if name in lots:
                        continue
                    holders = list(lots)
                    count = sum(1 for a in holders if a != _POOL)
                    fraction = 1 / (count + 1) if cap is None else min(1 / (count + 1), cap)
                    label = sim.group(week, name) if gcap is not None else None
                    if label is not None:
                        total = portfolio_value(week)
                        held = sum(value(a, week) for a in members_by_group(week).get(label, []))
                        fraction = min(fraction, max(gcap - held / total, 0.0))
                        if fraction <= 1e-12:
                            continue
                    raised = 0.0
                    for asset in holders:
                        if sim.sell_blocked(asset, week):
                            continue
                        gross, net, tax, fill = sell(asset, fraction, week)
                        shown = CASH if asset == _POOL else asset
                        reason = f"make room for {name}"
                        sim.record(week, "TRIM", shown, reason, gross, tax=tax, **fill)
                        raised += net
                    fill = buy(name, raised, week)
                    rank = int(sim.rank(week, name))
                    sim.record(week, "BUY", name, f"rank {rank} (made room)", raised, **fill)
        else:
            # Not a buy week (rebalance="monthly", rebalance_every > 1, or a plain non-cadence
            # week): no new buys, cap trims or make_room. Whatever wasn't yet deployed - either
            # never invested, or just sold this week under `sell_every_week` - stays idle rather
            # than vanishing; it's added back into equity below until the next buy week.
            uninvested = proceeds

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
        if daily is not None:
            uninvested += daily_walk(week, nxt)
        equity[nxt] = sum(value(a, nxt) for a in lots) + uninvested

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
            # One sale of the whole position, so one flat depository charge, as in `sell`.
            sell_frac = sim.sell_cost(value(asset, last), asset)
            for lot in position:
                gross = lot["units"] * price
                net = gross * (1 - sell_frac)
                total += net - closing.sale(
                    tax_class, net - lot["basis"], (last - lot["since"]).days
                )
        # Cash waiting for the next rebalance (a stop's or `sell_every_week`'s proceeds) is
        # already net of tax: it belongs in the final value too.
        equity[last] = total + uninvested
        ledger = closing

    return _Outcome(
        equity,
        weights,
        pd.DataFrame(holdings_rows).set_index("week"),
        open_positions,
        ledger,
        idle_value,
    )
