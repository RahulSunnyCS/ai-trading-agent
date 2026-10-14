# BL-098 — Widesl parameter sweep

| | |
|---|---|
| **Priority** | P2 — measure whether the wide short-strangle family is robust to strike, premium and risk-control choices |
| **Status** | In progress — Phase 2 one-factor screen complete; Phase 3 pending |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-11 |
| **Depends on** | BL-009 engine verification; existing Widesl rotation YAMLs |
| **TODO.md row** | — (add when the experiment is started) |

## Context

Widesl is the short CE+PE wide-strangle family. The existing rotation files
cover 150 variants: NIFTY OTM1, NIFTY closest premium ₹80 and ₹100, SENSEX
OTM2, and SENSEX closest premium ₹250 and ₹320, each at 25 entry times.

The current risk template is exit 15:28, partial square-off, a ₹2,500 overall
MTM stop, and a 115% per-leg stop trailed by `[15,10]%`. SENSEX's saved
baseline has a small existing CE/PE difference (114% CE and 115% PE). The
first sweep preserves that baseline but does not introduce new CE/PE-asymmetric
rules.

## Goal

Find Widesl settings that improve holdout return while controlling drawdown and
preserving a useful win rate across NIFTY and SENSEX, without confusing a
premium-family effect with a risk-control effect. Produce a reproducible
comparison; do not replace the saved rotation files automatically.

## Out of scope

- New CE/PE-asymmetric stops, trails, re-entry counts or exits in the first pass.
- Buy or Directional strategy parameters, range-breakout rules, or directional
  filters.
- Unrestricted Cartesian multiplication of every strike, premium and risk
  control.
- Selecting a winner from the full two-year period without a chronological
  holdout.
- Production adoption from the research run alone.

## Plan

### Phase 0 — Pre-register

- **Hypothesis:** Widesl performance is sensitive to distance/premium family,
  per-leg stop, trail, overall MTM stop and exit time; a robust holdout region
  should exist around, or clearly away from, the current 115% / ₹2,500 / 15:28
  template.
- **Universe:** all existing `N_wide_*.yaml`, `N_p80_*.yaml`,
  `N_p100_*.yaml`, `S_wide_*.yaml`, `S_p250_*.yaml` and `S_p320_*.yaml`
  files. These are the point-in-time NIFTY and SENSEX Widesl families already
  represented in the rotation universe.
- **Date range:** 2024-10-09 through 2026-10-09, using the common
  data-quality-approved sessions. Fit period: 2024-10-09 through 2025-10-08.
  Holdout period: 2025-10-09 through 2026-10-09.
- **Look-ahead check:** the strike or closest-premium contract is selected from
  the chain available at that day's entry time; no future-day result selects a
  family or setting. Excluded or missing sessions are logged rather than
  zero-filled.
- **Baseline:** preserve each file's saved strike/premium family and saved
  per-leg stops; trail `[15,10]%`; overall MTM SL ₹2,500; partial square-off;
  no re-entry; exit 15:28.
- **Pass rule:** a candidate must beat its same-family baseline on holdout net
  return, have holdout maximum drawdown no worse by more than 5%, lose no more
  than 2 percentage points of holdout win rate, and improve or match net return
  on at least 60% of the relevant files. Report NIFTY/SENSEX, strike family and
  early/midday/afternoon entry bands separately.
- **Kill rule:** no adoption if the gain is fit-only, exists only for one
  underlying or one premium family, materially worsens drawdown, or disappears
  after charges/slippage sensitivity.
- **Will not run:** new CE/PE asymmetry, target-based exits not in the current
  family, exotic re-entry/lock rules, or full Cartesian search. Running one
  requires a dated override in this item's Log.

### Phase 1 — Baseline and family characterization

- Re-run all 150 existing files with their saved settings.
- Report each family separately: OTM1/OTM2, closest premium, NIFTY/SENSEX,
  entry-time band, daily net, win rate, maximum drawdown, worst day and stop
  days.
- Verify that the SENSEX 114%/115% saved leg difference is preserved in the
  baseline and is not accidentally normalized.

**Done when:** baseline output is reproducible and the six existing family
groups have a clear comparator table.

### Phase 2 — Core one-factor risk screen

Keep each file's strike/premium family fixed and change one control at a time,
with both legs changed symmetrically for the new candidate rows.

| Parameter | Registered values |
|---|---|
| Per-leg SL | 80%, 90%, 100%, 110%, 115%, 120%, 130%, 140%, 150% |
| Overall MTM SL | none, ₹1,000, ₹1,500, ₹2,000, ₹2,500, ₹3,000, ₹3,500, ₹4,000 |
| Trail | none, `[5,5]%`, `[10,5]%`, `[15,10]%`, `[20,10]%`, `[20,15]%` |
| Exit time | 14:50, 15:00, 15:10, 15:20, 15:28 |
| Re-entry after SL | none, RE COST ×1, RE COST ×2, RE ASAP ×1, RE ASAP ×2 |
| Re-entry cutoff | none, 11:00, 12:00, 13:00; only paired with re-entry rows |
| Square-off | partial, complete |

The existing premium/moneyness families are the first strike-selection screen.
If a core family is promising, the follow-up family screen tests:

- NIFTY: OTM1, OTM2, OTM3, closest premium ₹60/₹80/₹100/₹120.
- SENSEX: OTM1, OTM2, OTM3, closest premium ₹200/₹250/₹320/₹400.

The percentage trail is the primary form because it is comparable across
premium levels. Point trails are reserved for a later targeted check.

**Done when:** all core one-factor rows have fit and holdout summaries, invalid
configurations are explicit, and no candidate is selected using full-period
performance.

### Phase 3 — Targeted interactions and robustness

- Select at most five candidates using fit-period results only.
- Test only the most plausible interactions: strike/premium family × SL,
  SL × MTM, MTM × trail, and MTM × exit.
- Test the selected candidates with the family follow-up values and, if useful,
  point trails `[1,1]`, `[2,1]`, `[3,1]` points.
- Repeat the read-out by NIFTY/SENSEX, family and entry-time band.
- Evaluate the final shortlist once on the untouched holdout, then freeze the
  table.

Cap Phase 3 at 40 additional configurations. No new CE/PE-asymmetric arm is
  allowed without a dated override.

### Evaluation contract — Widesl-specific metrics

Every variation must report the common scorecard plus Widesl tail-risk
diagnostics:

- **Core:** holdout net return after costs, return on margin/risk capital,
  average and median daily P&L, maximum drawdown, Ulcer Index, worst day,
  95% CVaR, expectancy per day and per trade, profit factor, payoff ratio,
  win rate, losing streak and recovery time.
- **Tail and stop behaviour:** MTM-stop frequency, per-leg stop frequency,
  both-legs-survive versus one-leg-stopped days, maximum loss relative to the
  average win, skewness/tail ratio and maximum favourable/adverse excursion.
- **Turnover:** re-entry count, orders per day, re-entry contribution before
  and after costs, and slippage sensitivity.
- **Stability:** fit-to-holdout degradation, NIFTY/SENSEX split, each
  OTM/premium family, and early/midday/afternoon entry bands.

For Widesl, tail loss, CVaR, maximum drawdown and Ulcer Index are higher
priority than win rate. A high win rate cannot compensate for a materially
worse loss tail.

### Phase 4 — Costs and read-out

- Apply the repository's current brokerage/statutory-cost assumptions to the
  shortlisted settings.
- Report net return, maximum drawdown, win rate, profit factor, worst day,
  stop-day rate and per-file stability.
- If a candidate passes, make a separate owner decision before any saved or
  live configuration change.

## Risks

- Wide short options can show a high win rate while hiding a small number of
  very large loss days; worst day and drawdown must be first-class metrics.
- Premium-family comparisons can be distorted by different contract coverage or
  liquidity; invalid and no-trade days must remain visible.
- Very wide per-leg stops may make the overall MTM stop the effective stop, so
  per-leg and overall stop effects must be read together.
- Re-entry can increase turnover and charges substantially; gross improvements
  do not pass until the cost read-out.
- The engine/AlgoTest parity work is still incomplete for some re-entry details;
  unresolved parity is a limitation, not a tuning opportunity.

## Open questions

- Whether OTM3 has sufficient collected-chain coverage for both underlyings.
- Whether the owner wants the ₹400 SENSEX and ₹120 NIFTY premium rows retained
  if coverage is thin.
- Whether the final shortlist should use historical lot sizing and explicit
  slippage, or retain the current Widesl convention of today's lot sizing and
  zero slippage for the first comparison.

## Results — 2026-10-12

Phase 2 completed with the registered post-charge model (₹20 per order, STT,
exchange charges, SEBI/IPFT, stamp duty and GST; no slippage). The run produced
4,950 rows across 33 Widesl variants, 150 base files and 488 common sessions:
4,920 valid rows and 30 invalid rows.

- Raw results: `packages/option-backtesting/research/bl097/results/widesl_sweep_postcharge.csv`
- Checkpoints: `packages/option-backtesting/research/bl097/checkpoints/widesl/`
- Qualified report: `backlog/BL-098-widesl-qualified-list-post-charge.md`
- Index-level top-four report: `backlog/BL-098-widesl-index-qualified-list-post-charge.md`

There are positive post-charge pockets in some NIFTY OTM1 and SENSEX premium
families, especially in selected time bands, but drawdown/tail risk and
near-one profit factors require the Phase 3 robustness checks before adoption.

## Log

- 2026-10-11 — plan created from the six existing Widesl family groups.
- 2026-10-12 — Phase 2 one-factor sweep completed with post-charge accounting;
  report generated. Phase 3 remains pending.
- 2026-10-14 — Phase 3 superseded by BL-102 (full grid with strike ATM–OTM3 and premium as an axis).
