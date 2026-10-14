# Momentum: score (ranksum, voladj, blend, and the variants tried)

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

How the per-window returns become one ordering of names.

| Setting | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `score` | `ranksum` (Config, API) | `ranksum`: sum of the weighted window ranks ([lookbacks](lookbacks.md)). `voladj`: 6-month and 12-month return divided by 26-week volatility, z-scored and summed (NSE Momentum index method). `blend`: average of both ranks | M, TODO 3.9.23 |
| `Config.voladj_lookbacks` (BL-086) | off | `voladj` follows the selected lookbacks and weights: per lookback, return / 26-week volatility, z-scored, weighted | M, BL-086 |
| `score="residual"` (BL-085 L6) | off; Broad's global ranking only (`categories/residual.py`) | Regress each stock's weekly return on Nifty 50 TRI and its category's equal-weight return over the trailing 52 weeks; rank on the sum of the last 26 weekly residuals divided by their std, skipping the latest 4 weeks | M, BL-085 |
| Grouped tilt (`reversal_tilt`, `reversal_screen_pct`; Broad: `broad_reversal_tilt`) | 0 = off (API) | Two separate rank-sums: short lookbacks (1/4/13 weeks) and long lookbacks (26/52 weeks, worst-first), each turned into a percentile, blended as `short_pct + tilt x long_pct`. A fresh 52-week low is never freshly bought. The screen first keeps only the top share by short-term momentum | M, TODO 3.9.23 follow-up |

The `voladj` "skip the latest month" setting, and the bug that makes it a 30/56-week window, are
on the [skip-month](skip-month.md) page.

## Live value

- ETF rotation: `ranksum` (`live_config.toml`); grouped tilt off.
- Broad search: `score` is a heavy dimension (`voladj`, `blend`, `ranksum`) in
  [`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml). 2,600 of
  round 7's 8,003 configs use `voladj`. The frozen ensemble: three `voladj`, one `blend`
  ([`bl010_phase6_frozen.json`](../../../packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | `voladj`, `blend` vs `ranksum` | ETF and Broad, 2017-01 to 2026-09, 28 rolling 3-year windows | ETF `voladj` a tax-efficient candidate, not a clear win; ETF `blend` loses; Broad `blend` wins most, fork caveat | ETF `voladj` 26.4% / 1.09 / -26.1%, rolling 64 / 68 / 68%, median +1.5, only 7 buys a year (45-week average hold), but it trails in the last 5 years (30.4% vs 33.0%) and 3 years (31.1% vs 39.9%). ETF `blend` median -1.4. Broad `blend` 34.1% / 1.11 / -26.7%, rolling 68 / 61 / 61%, median +4.3 |
| TODO 3.9.23 follow-up | grouped tilt 0.3, 0.5 (with a 30% screen), 1.0 | ETF and Broad, same windows | ETF: wins most at 0.3 to 0.5; Broad: loses at every setting | ETF tilt 0.3: 30.6% / 1.33 / -22.8%, +18.0 over Nifty 50 TRI, against the tilt-0 control's 27.8% / 1.14 / -26.3% / +15.2; rolling median +1.9, wins most (68% / 96% of windows); beats the live strategy (25.8% / 0.99 / -30.5%) outright. Tilt 0.5 with the 30% screen: 30.5% / 1.33 / -20.1%, MaxDD better in 82% of windows (vs 50%). Tilt 1.0 overshoots: 16.2% / 0.64. Broad: CAGR win share 0-3.6%, Sharpe 0-14%, MaxDD shallower in 64-93% |
| [BL-086](../../../backlog/BL-086-voladj-follows-lookbacks.md) | lookback-following `voladj` (skip only lookbacks of 26 weeks or more) | 10 Broad strategies (the 11 of BL-084 less the rank-sum one), after tax at Rs 5 lakh; choose FY2018-22, confirm FY2023-26 | Killed | Choose: -12.2 pts median CAGR, 0 of 10 not worse, worst fall 9.6 pts deeper; confirm: -1.4 pts, 3 of 10, 3.5 pts deeper. Pre-tax median -15.0. [`bl086_criteria.json`](../../../packages/momentum-backtesting/search_spaces/bl086_criteria.json), [`bl086_result.json`](../../../packages/momentum-backtesting/search_spaces/bl086_result.json). Skip-rule variants: [skip-month](skip-month.md) |
| [BL-085](../../../backlog/BL-085-momentum-improvement-levers.md) L6 | residual momentum vs each config's own score | 11 Broad strategies, after tax at Rs 5 lakh; FY2018-22, FY2023-26 | Killed | -16.4 then -29.5 pts; less pain 0 of 11 in both windows; worst fall 12.7 and 25.4 pts deeper. [`bl085_result.json`](../../../packages/momentum-backtesting/search_spaces/bl085_result.json), [write-up](../../../packages/momentum-backtesting/docs/bl085-levers-2026-10-09.md) |

## What we know

- **`voladj` ignores `lookbacks` and `weights`.** It always uses the 26/52-week returns over
  26-week volatility. In round 7 the 15 lookback x weight combinations give the same stock
  ranking for every `voladj` config; in 882 of them (stock tilt off) the two settings have no
  effect at all, and in the rest lookbacks only feed the stock tilt. Five top-10 names that
  described those inert settings were renamed (`docs/top-strategies-2026-10-08.md`).
- **Making `voladj` follow the lookbacks hurt every strategy** (6 to 21 points on FY2018-22).
  Not a code bug: at 26/52 weeks with equal weights the variant reproduces today's score. The
  short lookbacks favour stocks that just jumped, and those reverse: on sampled weeks for Five
  Sectors Monthly the variant's top 30 had risen 13.1% over the last 4 weeks (7.3% for today's
  score) and then fell 4.4% over the next 4 (0.9%); the two top-30 lists shared 9 names.
- **Residual momentum, as defined, removes the momentum.** The regression keeps an intercept (as
  in Blitz, Huij and Martens 2011), so a stock's whole-year outperformance goes into the
  intercept. The residual top 30 had a median 52-week return of 3%, -3% and 34% on three sampled
  dates against 265%, 65% and 184% for the momentum top 30. A version without the intercept is a
  different question. BL-050's residual tilt (M2) failed its screen too: see
  [Broad filters](../strategies/broad/filters.md).
- **Grouped tilt is the strongest ETF finding of TODO 3.9.23**, and the owner decision on it is
  still pending ([BL-088](../../../backlog/BL-088-own-history-sector-relative-strength.md)
  Context). It is not pre-registered beyond the rolling-window rule. On Broad it does not help:
  the momentum leaders, not the beaten-down names, drive stock returns.
- The BL-085 and BL-086 JSON files still say BL-054 and BL-055 (renumbered 2026-10-10, contents
  unchanged).

## Not yet tested

- Residual momentum without an intercept.
- Grouped tilt adopted on the live ETF strategy (an owner decision, not a test).

## In plain words

The score turns "how much did it go up over each window" into one league table. The default adds
up the places from each window. `voladj` divides the climb by how bumpy it was, so a smooth riser
beats a jumpy one. On ETFs `voladj` trades far less (about 7 buys a year) but did worse in the
last three and five years. Asking `voladj` to use each config's own windows, or stripping out the
market and sector move first (residual momentum), both made the Broad strategies much worse.
Preferring ETFs that were beaten down over the long run, among those strong in the short run,
helped the ETF strategy in most stretches; it hurt on stocks.

## Related

- [Lookbacks and weights](lookbacks.md), [skip-month](skip-month.md),
  [reversal sleeve](reversal-sleeve.md), [sector relative strength](../strategies/etf-rotation/sector-rs.md).
