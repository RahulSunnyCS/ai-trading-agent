# Momentum: sizing and exposure overlays

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

Rules that change how much money goes into each buy, or how much of the portfolio is invested at
all. All opt-in, off by default.

| Setting | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `momentum_sizing` (+ `_window` 10, `_floor` 0.0) | False | Scale fresh buys by the weighted recent win rate of closed trades | M, TODO 3.9.23 |
| `mass_exit_throttle` (+ `_fraction` 0.5; threshold 0.5) | False | Withhold a fraction of fresh capital when more than 50% of held categories exit in one week | M, TODO 3.9.20 |
| `mass_exit_response` | `off` (`throttle`, `halve_top_n`) | Broad Momentum response variants | M, TODO 3.9.20 |
| Volatility targeting (`levers.vol_target`, post-hoc) | not built into the engine | Hold min(1, target / trailing 26-week strategy vol) of the strategy, the rest in the liquid fund | M, TODO 3.9.23 |
| Dispersion timing (`levers.dispersion_timing`, post-hoc) | not default | Half exposure when the spread of 13-week returns is in its bottom 20% | M, TODO 3.9.23 |
| `Config.weight_by="inverse_vol"` (+ `vol_window`) | `equal` | Each buy week's money split in proportion to 1 / trailing 26-week weekly-return std across the names bought, then the position cap as usual | M, BL-085 L5 |
| ETF blend (BL-085 L3) | not a setting | Hold 75% or 50% of the money in Broad and the rest in the ETF rotation, rebalanced to target each April | M, BL-085 L3 |

## Live value

All off. The Broad search fixes `momentum_sizing = false` ("can lock the strategy in cash",
TODO 3.9.25) in
[`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml). Round 1
searched `momentum_sizing` and the three `mass_exit_*` settings
([`round1_A.toml`](../../../packages/momentum-backtesting/search_spaces/round1_A.toml)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | `momentum_sizing` on | ETF and Broad, 28 rolling 3-year windows | Rejected | ETF median -2.5 (4 / 7 / 89%), Broad median -9.3 (7 / 11 / 61%) |
| TODO 3.9.20 | `mass_exit_throttle`, `mass_exit_response` | Broad (gapped engine) | Rejected: no repeatable edge | TODO 3.9.20 |
| TODO 3.9.23 dry run | Volatility target ETF 15%, Broad 20% | ETF and Broad | A risk dial | ETF 15%: 20.7% / 0.91 / -28.9% (MaxDD better in 86% of windows, CAGR in 4%). Broad 20%: 28.1% / 1.04 / -16.6% (MaxDD better in 86%, median -3.8). Ignores tax on the extra trades |
| TODO 3.9.23 dry run | Dispersion timing | ETF and Broad | Rejected | ETF -0.6, Broad -2.8 median |
| [BL-085](../../../backlog/BL-085-momentum-improvement-levers.md) L5 | inverse-vol vs equal | 11 Broad strategies, after tax at Rs 5 lakh; FY2018-22, FY2023-26 | Killed | CAGR -1.4 then -0.4 pts; less pain 2 then 6 of 11; worst fall 0.4 and 0.2 pts shallower |
| BL-085 L3 | 75% and 50% Broad with the ETF rotation | 11 Broad strategies, pre-tax from stored curves | Killed on the return floor | 75%: -5.8 pts on FY2018-22 and -1.4 on FY2023-26, smoother in 11 of 11. 50%: -11.7 and -3.0 |
| [BL-025](../../../backlog/BL-025-live-money-rules.md) | Drawdown cut / exit with five ways back in (R1-R5) vs holding through | Four Sectors Monthly (followed), 4 sleeves + blend + 17 lot ramps, 2017-01-06 to 2026-10-23, post-F6 ranking | None passes (≤35% worst fall everywhere and ≤3 pts CAGR given up) | Only R1 (−20 cut / −30 exit, no way back) keeps falls within 35%, giving up 28.7 pts on the blend; R5 gives up 2.5 but the blend falls −36.1%. [`bl025_rules_result.json`](../../../packages/momentum-backtesting/search_spaces/bl025_rules_result.json) |

BL-085 files: [`bl085_criteria.json`](../../../packages/momentum-backtesting/search_spaces/bl085_criteria.json),
[`bl085_criteria_addendum_1.json`](../../../packages/momentum-backtesting/search_spaces/bl085_criteria_addendum_1.json),
[`bl085_result.json`](../../../packages/momentum-backtesting/search_spaces/bl085_result.json),
[write-up](../../../packages/momentum-backtesting/docs/bl085-levers-2026-10-09.md).
**Mismatch:** `bl085_criteria.json` and its addendum say `"item": "BL-054"`, and
`bl085_result.json` lists `bl054_criteria.json` as its committed rules. BL-085 was renumbered from
BL-054 on 2026-10-10 (the options item kept that number); the files were renamed and their
contents left unchanged. The generated output stays in `data/search/round7_A/bl054/`.

## What we know

- A drawdown exit with no way back in caps the fall but gives up most of the return: on the
  followed strategy it exited near the 2020 and 2022 lows (BL-025). Every way back in tried
  lets at least one sleeve fall past 35%. Registered test, pre-tax, today's category tags.
- Every sizing rule tried gives up return. The ones that make falls shallower (volatility
  targeting, the ETF blend) are risk dials: they buy the shallower fall with lost return.
- Inverse-vol sizing tilts money away from the fastest movers, which is where these strategies
  earn (BL-085). BL-010 Phase 5 had asked for it to be tested next to equal weight.
- The mass-exit week was not shifted by `signal_delay` (BL-010 bug E6, a look-ahead when the
  throttle is on); BL-010 Phase 1a fixed E1 to E8. The 3.9.20 verdict was on the gapped engine.
- The ETF curve used (the `defensive="filter"` run in `data/backtests/compare.xlsx`, pre-tax) made
  only 13.7% a year in FY2018-22, so mixing it into Broad made every strategy smoother and much
  poorer.

## Not yet tested

- Volatility targeting after tax (the overlay ignores tax on its extra trades).

## In plain words

**Momentum sizing (off).** Buy smaller after a losing streak. Measured and rejected: it gave up
about 4 to 5 points of yearly return without reliably reducing risk (TODO 3.9.8, 3.9.18).

**Mass-exit throttle (off).** If more than half the holdings exit in one week, hold back some
cash. Measured and rejected (TODO 3.9.20).

Scaling the whole portfolio down when it gets bumpy (volatility targeting) does make falls
shallower, but costs return about one for one: it is a comfort dial, not extra profit.

## Related

- [Caps](caps.md), [gates](gates.md), [Broad stop-loss](../strategies/broad/stop.md),
  [reversal sleeve](reversal-sleeve.md) (another way to hold part of the money elsewhere).
