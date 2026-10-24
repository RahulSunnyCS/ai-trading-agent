# Momentum: signal delay, fill time, tracking and premium warning

**Status:** Tested · **Last updated:** 2026-10-24

## What it is

When a signal is traded, at what price, and what the P&L is measured on.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `signal_delay` | 0 weeks (API range 0 to 4) | Trade N weeks after the signal | M, TODO 3.9.23 |
| `execution` | `fri_close` (`mon_open`, `mon_10am`) | Fill time. `mon_10am` falls back to the open where no 10:00 prices exist | M, TODO 3.9.23, 3.9.18 |
| `track` | `index` in Config / API; `etf` in Live | P&L on the index or on the traded ETF | M, package README, TODO 3.9.23 |
| `premium_warn_pct` | 1.0 (2.0 international) | The live job flags a buy whose ETF trades above NAV. Premium drag is a steady cost for momentum buying | R |

## Live value

- ETF rotation: delay 0, Friday close, `track = "etf"`, premium warnings 1.0 / 2.0
  (`live_config.toml`). The weekly job sends a 14:40 preview so the trade can be placed near the
  close.
- Broad: new runs default to delay 0 (owner, 2026-10-05). The search spaces and the frozen
  ensemble pin `signal_delay = 1`
  ([`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)). The
  engine fills Broad only at a Friday close; there is no Monday-open option yet.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | `signal_delay` 1 | ETF and Broad (every week simulated), 28 rolling 3-year windows | ETF: trade on the signal week. **Broad: a one-week delay wins** | ETF median -1.5 (14 / 11 / 7%). Broad 35.5% / 1.21 / -20.2%, rolling 89 / 96 / 79%, median +4.1, consistent with one-week reversal in individual stocks |
| TODO 3.9.18, 3.9.23 | `execution="mon_open"` | ETF | Friday close stays | CAGR better in 79% of windows but Sharpe in 36%, MaxDD in 7% (-31.2%) |
| `mbt tracking` (package README), TODO 3.9.23 | `track` index vs ETF | ETF live config | The live job tracks the ETF | ETF gap +0.72 CAGR points a year (index track 25.0% vs ETF 25.8%), past the owner's 0.5 threshold |
| [BL-010](../../../backlog/BL-010-momentum-evaluation-review.md) Phase 2 step 7 | the same Broad decisions filled at Friday close and at the next open | six configs at delay 0 | Flag tripped (finding E13) | Costs a delay-0 run 1.0 point of CAGR on average, over 1 point on two of six. Threshold committed in [`bl010_criteria_addendum_1.json`](../../../packages/momentum-backtesting/search_spaces/bl010_criteria_addendum_1.json) before the step ran |
| [BL-161](../../../backlog/BL-161-favourites-score-and-friday-fill.md) (written as BL-056) | each favourite at `signal_delay` 0 against its saved 1, nothing else changed | the 14 individual favourite configs (Broad), 2017-01-06 to 2026-10-02, pre-tax; registered rule: delay "matters" if the median absolute change in CAGR is above 1 pt (BL-010 E13's threshold) | Delay matters, no fixed direction | Median absolute change 3.4 pts (signed -1.1); single configs move from -7.1 (Five Sectors Monthly) to +6.9 pts (Four Sectors, Four Lookbacks); 8 of 14 are worse at delay 0 on each of CAGR, max drawdown, Martin and Sharpe. Delay 0 here fills at the same Friday close the ranking used, so it is an upper bound, not a tradable fill. [`bl161_summary.json`](../../../packages/momentum-backtesting/search_spaces/bl161_summary.json) |
| BL-010 Log, 2026-10-05 | one-week delay on the default Broad run (pre-point-in-time) | 2017-01 to 2026-10 | Descriptive | 53.2% as shipped; 44.3% with a one-week delay; 40.3% with circuit locks, the tradability filter and the delay together |

## What we know

- On ETFs, trading at the Friday close the ranking used is right; waiting a week or buying at
  Monday's open is worse.
- On Broad, a one-week delay helps by about 4 points, like trading every 2 or 4 weeks: all three
  cut the same churn ([cadence](cadence.md)).
- A Broad signal can first be traded at Monday's open (Friday's stock data arrives at 19:30 IST).
  BL-010's rule: if Monday-open costs more than 1 point, the fix is a Monday-fill option, not a
  week's delay. The option is planned in
  [BL-036](../../../backlog/BL-036-momentum-ui-from-bl010.md) Phase 2.
- **A one-week shift moves a single config by several points either way** (BL-161: median
  absolute change 3.4 pts of CAGR, from -7.1 to +6.9 across the 14 favourites). That is timing
  luck, which is why one Friday's CAGR cannot be read to within a few points and why splitting a
  config across every Friday ([cadence](cadence.md)) is the fair comparison. The delay-0 side of
  that test is the untradable same-close fill; the planned Friday 14:30 trade should be judged on
  the journal's live fills, not on it.
- The BL-084 and BL-085 stop tests bracketed the Monday open between a same-Friday and a
  next-Friday fill ([Broad stop-loss](../strategies/broad/stop.md)).

## Not yet tested

- A Monday-open fill option for Broad, as an engine setting with its own scenario (BL-036 Phase 2).

## In plain words

**Signal delay = 0 and trade at Friday close.** We assume you can trade at the same close the
ranking used. The live weekly job sends a 14:40 preview so you can trade near the close.
Measured: on ETFs, waiting a week or buying at Monday's open is worse, so trading on Friday is
right. On Broad, waiting one week is better (about 4 points a year): individual stocks that
just jumped tend to give a little back the next week (TODO 3.9.23).

**Track = index (backtest) vs ETF (live job).** The backtest ranks on the index. The live job
measures profit on the ETF you would actually hold, because the gap was measured at about
0.72 points a year (past the 0.5 threshold you set).

## Related

- [Cadence](cadence.md), [skip-month](skip-month.md), [costs](costs.md).
