# Momentum: entry gates and the defensive filter

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Rules that block fresh buys (holdings are untouched) or move money to cash when something looks
weak. All opt-in, off by default.

| Setting | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `exclude_high_vol` (API, ETF only) | 0 = off | Never freshly buy the most volatile fraction of the ranked instruments (26-week weekly volatility, `levers.high_vol_mask`); holdings untouched | M, TODO 3.9.23 |
| `defensive` | `off` (modes `ranked`, `filter`) | `ranked`: cash and gilt compete in the ranking. `filter`: hold only names whose `filter_lookback` (13-week) return beats cash | M, TODO 3.9.23, 3.9.18 |
| 52-week-high gate (`levers.below_high52_mask`) | not default | No fresh buy more than 15% below the 52-week high | M, TODO 3.9.23 |
| Smoothness gate (`levers.choppy_mask`) | not default | No fresh buy if fewer than half of the last 26 weekly returns were up | M, TODO 3.9.23 |
| Trend / breadth gates (`levers.trend_gate_mask`, `breadth_gate_mask`) | not default | No fresh buys while Nifty 50 is below its 40-week average, or while fewer than 40% of names are above theirs | M, TODO 3.9.23 |

Stock-level gates tested on Broad under BL-050 (R1: beat Nifty 500 TRI; M1: overextension; V3:
quiet-or-building turnover) are on the [Broad filters](../strategies/broad/filters.md) page.

## Live value

None of these is on in `live_config.toml` or the Broad defaults. `exclude_high_vol` is a
dashboard option (Position limits, "Skip most volatile % (new buys)", ETF only) and is not wired
into the weekly Telegram job (TODO 3.9.23).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | `exclude_high_vol` 20%; plateau of exclude 10-40% x vol over 13 / 26 / 52 weeks | ETF and Broad, 2017-01 to 2026-09, 28 rolling 3-year windows | **The one robust ETF win**; a disaster on stocks | ETF 20%: 27.9% / 1.12 / -29.1%, rolling 89 / 93 / 100%, median +2.1, deflated Sharpe 0.998. All 12 plateau settings beat the baseline on Sharpe in 71-96% of windows. Broad 16.4%, median -16.1 |
| TODO 3.9.18, 3.9.23 | `defensive="filter"` | ETF | Rejected again | ETF 23.7% / 0.93 / -25.8%, rolling 29 / 39 / 57%, median -1.6 |
| TODO 3.9.23 dry run | 52-week-high gate (15%); blended-rank version | ETF and Broad | Marginal both ways; not adopted. The blended rank loses | ETF rolling 64 / 61 / 7%, median +0.3; Broad 50 / 54 / 86%, median +0.1. Blended rank: ETF median -4.1 |
| TODO 3.9.23 dry run | Smoothness gate | ETF and Broad | Rejected | ETF flat (median 0.0), Broad median -5.9 |
| TODO 3.9.23 dry run | Trend gate, breadth gate | ETF and Broad | Rejected, consistent with the defensive filter | ETF -1.3 / -1.7, Broad -5.9 / -14.1 median |

## What we know

- `exclude_high_vol` mostly keeps out Realty (80% of weeks) and PSU Bank (76%), so the ETF edge
  leans on a few sectors. On stocks the volatile names are the momentum winners, so it is ETF
  only.
- Every "stay out of weak markets" rule tried (cash hurdle, trend, breadth, smoothness) lost or
  did nothing. The cash hurdle has now been rejected twice.
- Adopting `exclude_high_vol=0.2` for the live ETF strategy is an open owner decision (it also
  needs `weekly.py` to pass the mask).

## Not yet tested

- `exclude_high_vol` forward in the journal next to the live ETF strategy.

## In plain words

**Skip the most jumpy ETFs (new, ETF only, off by default).** Never freshly buy the most
volatile fifth of the ETFs that week. In practice that mostly keeps out Realty and PSU Bank,
which tend to spike and fall back. Measured: about 2 points a year more, smoother, and better
in about 9 of every 10 stretches, whichever exact setting is used. On individual stocks it is
the opposite and loses badly, because there the jumpy stocks are the winners (TODO 3.9.23).

**Defensive mode (off by default).** Whether cash or bonds can be held when everything looks
weak. Measured: the "only hold things that beat cash" filter did not help (TODO 3.9.8, 3.9.18).

**Other "stay out of weak markets" ideas.** Stop buying when Nifty is below its 40-week
average, or when most stocks are below theirs; only buy things near their 52-week high; only
buy things that rose smoothly. All measured, none helped (TODO 3.9.23).

## Related

- [Sizing and exposure overlays](sizing.md) (volatility targeting, dispersion timing),
  [Broad filters](../strategies/broad/filters.md),
  [sector relative strength](../strategies/etf-rotation/sector-rs.md).
