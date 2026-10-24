# Momentum: score (ranksum, voladj, blend, and the variants tried)

**Status:** Tested · **Last updated:** 2026-10-24

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
| [BL-161](../../../backlog/BL-161-favourites-score-and-friday-fill.md) (written as BL-056) | each favourite re-run with `ranksum` and `blend` in place of its saved score, nothing else changed (the signal-delay half is on [execution](execution.md)) | the 14 individual favourite configs (11 `voladj`, 2 `blend`, 1 `ranksum`), Broad, delay 1, 2017-01-06 to 2026-10-02, pre-tax; registered rule: median change in Martin > 0 and Martin better on at least 8 of the 11 `voladj` favourites and median max-drawdown change no worse than -3 pts | Killed | Martin better on 1 of 11 for `ranksum` (median change -2.08, max drawdown 6.9 pts deeper, CAGR -8.0 pts) and 2 of 11 for `blend` (-1.20, 5.7 pts deeper, -4.1 pts). Medians over all 14 at delay 1: `voladj` 40.5% CAGR / -31.3% / Martin 3.75, `blend` 36.9% / -38.4% / 2.92, `ranksum` 33.8% / -41.4% / 2.06. [`bl161_summary.json`](../../../packages/momentum-backtesting/search_spaces/bl161_summary.json), [`bl161_results.jsonl`](../../../packages/momentum-backtesting/search_spaces/bl161_results.jsonl) |
| [BL-086](../../../backlog/BL-086-voladj-follows-lookbacks.md) | lookback-following `voladj` (skip only lookbacks of 26 weeks or more) | 10 Broad strategies (the 11 of BL-084 less the rank-sum one), after tax at Rs 5 lakh; choose FY2018-22, confirm FY2023-26 | Killed | Choose: -12.2 pts median CAGR, 0 of 10 not worse, worst fall 9.6 pts deeper; confirm: -1.4 pts, 3 of 10, 3.5 pts deeper. Pre-tax median -15.0. [`bl086_criteria.json`](../../../packages/momentum-backtesting/search_spaces/bl086_criteria.json), [`bl086_result.json`](../../../packages/momentum-backtesting/search_spaces/bl086_result.json). Skip-rule variants: [skip-month](skip-month.md) |
| [BL-085](../../../backlog/BL-085-momentum-improvement-levers.md) L6 | residual momentum vs each config's own score | 11 Broad strategies, after tax at Rs 5 lakh; FY2018-22, FY2023-26 | Killed | -16.4 then -29.5 pts; less pain 0 of 11 in both windows; worst fall 12.7 and 25.4 pts deeper. [`bl085_result.json`](../../../packages/momentum-backtesting/search_spaces/bl085_result.json), [write-up](../../../packages/momentum-backtesting/docs/bl085-levers-2026-10-09.md) |
| [BL-115](../../../backlog/BL-115-own-history-stock-features-winners-losers.md) | owner's absolute score: sum of each own lookback's average weekly return (return / weeks), no ranking against other stocks, as a trade-level separator (not a replacement rank) | Trio Fortnightly and Four Sectors Monthly, No Tilt, 2017-2022, 892 trades, outcome = return over Nifty 500 TRI | Killed (passes in Four Sectors only) | Four Sectors rho +0.15, t 3.9, worst fifth 60% vs 49% losers; Trio rho +0.08, t 1.7. Within the same decision week +0.18 / +0.08. The 13- and 26-week parts carry it (rho +0.16 / +0.17 in Four Sectors); 4 and 52 weeks little. [`bl115_result.json`](../../../packages/momentum-backtesting/search_spaces/bl115_result.json) |
| [BL-116](../../../backlog/BL-116-broad-sector-position-and-score.md) H2 | the chosen sector's own average-weekly score (mean of its members' scores) as a separator of picks | Trio and Four Sectors Monthly, No Tilt, 2017-2022 | Killed | rho +0.12 (t 1.7) and -0.09 (t -1.1); about half the picks had no score (fewer than 3 members with a year of prices); +0.81 / +0.74 correlated with the stock's own score. [`bl116_result.json`](../../../packages/momentum-backtesting/search_spaces/bl116_result.json) |

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
- **Swapping the score on the favourites does not help.** Under the BL-161 rule neither
  `ranksum` nor `blend` beat `voladj` on the 11 `voladj` favourites (they win 1 and 2 of 11). The
  `voladj` lead is mostly shallower drawdowns (median max drawdown -31.3% against -38.4%
  and -41.4%). Caveat as registered: those favourites were chosen while they ran `voladj`, so their
  other settings suit it, and under `ranksum` their saved lookbacks and weights apply for the first
  time (nobody tuned them); the result is a screen, not proof. It was run on 2026-10-09 against the
  engine's `voladj` of that day (the 30/56-week window described on [skip-month](skip-month.md)),
  before BL-086 ran (BL-086 ran and was killed the same day, 2026-10-09).
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
Swapping the favourites' score for the plain rank-sum or the blend also lost: it was better on
only 1 and 2 of the 11 `voladj` favourites, with deeper drawdowns.
Preferring ETFs that were beaten down over the long run, among those strong in the short run,
helped the ETF strategy in most stretches; it hurt on stocks.

## Related

- [Lookbacks and weights](lookbacks.md), [skip-month](skip-month.md),
  [reversal sleeve](reversal-sleeve.md), [sector relative strength](../strategies/etf-rotation/sector-rs.md).
