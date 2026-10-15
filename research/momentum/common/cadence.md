# Momentum: rebalance cadence, phase and tranches

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

How often the strategy trades, and on which Fridays.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `rebalance` | `weekly` (`monthly`) | Monthly trades only on the last week of each month | M, TODO 3.9.23 |
| `rebalance_every` / `rebalance_offset` | 1 / 0 (Config, API) | Trade every K weeks, on the Fridays whose calendar week number since 2016-01-01 is the offset mod K | M, TODO 3.9.23 |
| Overlapping tranches (`tranches.py`) | research tool | K pots, each trading on its own phase, averaged | M, TODO 3.9.23 |
| `split_fridays` (BL-087, "All Fridays") | off (API) | Runs every offset 0..K-1 with capital / K and reports one account, equal capital restored each April | M, BL-085 L2 |
| `sell_every_week` | off (Config, buffer rule) | On a slow cadence, sell a dropped-rank holding the week it is due; new buys and trims still wait | M, TODO 3.9.23 follow-up |

## Live value

- ETF rotation: weekly (`live_config.toml`).
- Broad search: `rebalance_every` one of 1, 2, 4, with `rebalance_offset_raw` 0 to 3
  ([`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)). The
  frozen ensemble: three configs every 4 weeks, one every 2, each on a frozen offset
  ([`bl010_phase6_frozen.json`](../../../packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | `rebalance="monthly"` | ETF and Broad (every week simulated), 28 rolling 3-year windows | ETF loses; Broad wins on return with deeper drawdowns | ETF median -2.3 (21 / 32 / 25%). Broad 39.1% / 1.32 / -25.1%, rolling 75 / 82 / 36%, median +4.1 |
| TODO 3.9.23 dry run | every 2 and 4 weeks, as 2- and 4-tranche blends | same | Weekly is right for ETFs. **Broad every 2 or 4 weeks wins nearly every window** | ETF every 2: 24.1% / 0.94 / -31.1%, rolling 18 / 14 / 25%, median -2.8. Broad every 2: 36.3% / 1.25 / -19.8%, rolling 100 / 100 / 68%, median +5.0. Broad every 4: 37.2% / 1.29 / -20.0%, 96 / 96 / 64%, +5.2 |
| TODO 3.9.23 | phase luck | ETF live config at K=4; Broad every 2 | Start-date luck is large; judge by the blend | ETF phases spread 4.6 to 7.9 CAGR points at K=4. Broad every-2 phase 0 +1.4 vs phase 1 +8.5 median |
| TODO 3.9.23 follow-up | `sell_every_week` on | Broad every 2 and 4 weeks (blends); ETF every 2 | Off, not recommended: it reverses the cadence's own edge | Broad every 2: 36.3% / 1.25 / -19.8% to 27.9% / 1.01 / -18.0% (median +5.0 to -3.4, CAGR win share 100% to 7%). Broad every 4: 37.2% / 1.29 / -20.0% to 21.9% / 0.87 / -16.6% (+5.2 to -10.3). ETF every 2: -2.8 to -2.2 median |
| [BL-085](../../../backlog/BL-085-momentum-improvement-levers.md) L1 | every 4, 6, 8, 13 weeks, against each strategy's own 2 or 4 | 11 Broad strategies, after tax at Rs 5 lakh; FY2018-22, FY2023-26 | Killed | Every 6: +0.9 then -2.4. Every 8: +0.2 then -6.2. Every 13: -0.7 then -8.2. In the 2023-26 run-up, waiting longer cost far more than the tax it saved |
| BL-085 L2 / [BL-087](../../../backlog/BL-087-momentum-all-fridays-split.md) | own Friday vs money split across all Fridays | 10 Broad configs, 2017-2026, after tax at Rs 5 lakh | Report only (no pass rule): removes calendar luck, does not raise the average | Split: worst fall -27.6% against -31.1% for the typical single Friday and -35.7% for the unluckiest; Ulcer 9.9% vs 10.8%; CAGR 31.5% against 27.5% to 33.9% for single Fridays. Shallower in 10 of 10 configs in both windows |

## What we know

- On Broad, everything that trades less wins: every 2 weeks, every 4 weeks, monthly, or a
  one-week [signal delay](execution.md). All cut the same thing: the weekly Broad baseline buys
  about 115 names a year and holds each 3.6 weeks on average.
- Slower still (6 to 13 weeks) does not help after tax (BL-085 L1).
- Which Fridays you trade is luck. Five Sectors Monthly alone runs from 34.6% to 44.8% purely by
  calendar (BL-087). BL-010 found the search picked each winner's lucky Friday (F6). Phase 4 then
  scored each config as the mean of its offset tranches; the aggressive winner sat 5.8 points
  away from its phase average and was killed as a finalist (the rule allowed 3).
- Splitting money across all Fridays is the only result in BL-085 that improved every strategy.
  It is a measurement, not a pre-registered test. It is built as `split_fridays` (BL-087).
- `weekly.py` did not know about a K-week cadence when TODO 3.9.23 was written, so it was not set
  in `live_config.toml`.

## Not yet tested

- The ETF rotation split across Fridays at a slow cadence (ETF weekly already wins).

## In plain words

**Weekly, every 2 weeks, or monthly.** Weekly is the default, and now there is an every-2 and
every-4-weeks option too. Measured, and the answer depends on what you trade (TODO 3.9.23):

- ETFs: weekly wins. Every 2 weeks costs about 3 points a year.
- Broad (stocks): every 2 weeks wins in every stretch tested, about 5 points a year more with
  a better ride. Weekly trading buys about 115 stocks a year and holds each for under a month,
  which is mostly churn.
- Which Fridays you pick matters a lot: the two possible every-2-weeks schedules differed by
  7 points a year on Broad, by pure luck of the calendar. So the fair comparison splits the
  money into two halves trading on alternate Fridays, and that is the number quoted above.

## Related

- [Execution](execution.md), [tax](tax.md), [Broad strategy](../strategies/broad/README.md).
