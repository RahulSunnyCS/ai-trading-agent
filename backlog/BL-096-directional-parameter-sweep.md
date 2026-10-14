# BL-096 — Directional stop, re-entry, trailing and exit sweep

| | |
|---|---|
| **Priority** | P2 — improve the understanding of the existing Directional family without changing the live baseline |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-11 |
| **Depends on** | BL-034, BL-058 |
| **TODO.md row** | 3.10.23 |

## Context

The existing Directional family is a two-leg short CE+PE strategy, not the
separate Buy family. The committed rotation universe contains 100 Directional
variants: NIFTY and SENSEX × ATM and ITM1 × 25 start times from 09:17 through
15:17. They currently use a 21% per-leg stop, one cost re-entry, a ₹3,000
overall MTM stop and a 15:28 exit.

## Goal

Produce a reproducible two-year parameter map for all 100 existing Directional
variants, with the current 21% / ₹3,000 / cost×1 / 15:28 setup kept as the
baseline. Do not modify live strategy files or adopt a winner automatically.

## Out of scope

- Asymmetric CE/PE rules; both legs share the same tested stop and re-entry rule.
- New moneyness families, ranking changes or live rotation changes.
- Full-period selection without a chronological holdout.

## Registered experiment

- **Universe:** `N_dir_*`, `N_ditm1_*`, `S_dir_*` and `S_ditm1_*` (100 files).
- **Dates:** 2024-10-09 through 2026-10-09 using common approved sessions;
  fit through 2025-10-08 and chronological holdout from 2025-10-09.
- **Primary:** leg SL `{10,15,21,25,30,35}%`, MTM SL
  `{₹2,000,₹2,500,₹3,000,₹3,500,₹4,000}`, exit
  `{14:50,15:00,15:10,15:20,15:28}`.
- **Secondary:** re-entry `{none,cost×1,cost×2,asap×1,asap×2}`;
  cutoff `{none,11:00,12:00,13:00}`; trailing
  `{none,[5%,5%],[10%,5%],[15%,5%]}`. Do not run the unrestricted secondary
  Cartesian product.
- **Look-ahead control:** each configuration sees only its day's bars from entry
  through exit; the holdout is not used to select a candidate.
- **Decision rule:** descriptive only. A candidate is stable only if fit net
  improves without worse fit drawdown and the improvement direction persists on
  holdout. The current baseline remains the live choice.

### Registered full-diagnostic extension

- **Universe:** all 15,000 registered primary cells across the 100 NIFTY/SENSEX
  ATM/ITM1 bases: SL `{10,15,21,25,30,35}%`, MTM SL
  `{₹2,000,₹2,500,₹3,000,₹3,500,₹4,000}`, and exit
  `{14:50,15:00,15:10,15:20,15:28}`.
- **Secondary setting:** primary baseline only — RE COST×1, no cutoff and no
  trail. This keeps the extension at 15,000 rows; it does not multiply the
  primary grid by the exploratory secondary variants.
- **Diagnostics:** the same trade-ledger fields as the 1,200-row run,
  including median P&L, Ulcer Index, CVaR95, expectancy, profit factor,
  CE/PE, leg-SL, re-entry and exit-reason diagnostics.
- **Charges:** ₹20 per order, with two orders per completed fill plus the
  registered option charges: STT on the sell side (0.10% through 2026-03-31,
  0.15% from 2026-04-01), NSE/BSE exchange transaction charge, SEBI/IPFT,
  stamp duty on the buy side and 18% GST on brokerage plus exchange/SEBI/IPFT.
  These charges are applied from each simulated trade's entry/exit premium;
  no look-ahead or holdout-derived rate is used.

## Evaluation contract — Directional-specific metrics

Every variation reports:

- **Core:** holdout net return after costs, average and median daily P&L,
  maximum drawdown, Ulcer Index, worst day, 95% CVaR, expectancy per day and
  per trade, profit factor, payoff ratio, win rate, losing streak and recovery
  time.
- **Stop behaviour:** overall MTM-stop frequency, per-leg SL-hit frequency,
  re-entry count, re-entry contribution before and after costs, and exit-reason
  mix.
- **Leg diagnostics:** CE and PE contribution, one-leg-stopped versus both-leg
  survival days, per-leg MAE/MFE and whether a parameter's improvement comes
  from only one leg. These are diagnostics, not permission to introduce
  asymmetric rules in this experiment.
- **Stability:** fit-to-holdout degradation, NIFTY/SENSEX split, ATM/ITM1 split,
  and early/midday/afternoon entry bands.

For Directional, return must be read together with MTM-stop frequency, tail
loss, CVaR, drawdown and Ulcer Index. Win rate alone is not sufficient because
short two-leg positions can hide occasional large losses.

## Results

The machine-readable primary result is
`packages/option-backtesting/research/bl096/results/primary_summary.csv`.
The time-band qualified list is [BL-096 Directional qualified list](BL-096-directional-qualified-list.md).
The primary sweep completed 15,000 rows across 488 common sessions; secondary
validation completed 4,400 exploratory rows on the shortlist and does not alter
saved strategy files. Exact trade-ledger diagnostics are now available for the
decision shortlist in
`packages/option-backtesting/research/bl096/results/diagnostic_metrics.csv`:
1,200 rows across 100 bases, four primary cells and three secondary variants per
cell. These are pre-cost results because the registered YAMLs have
`cost_per_order_inr: 0`; a cost-adjusted pass is still required before a live
choice.

The full-primary diagnostic extension is running at
`packages/option-backtesting/research/bl096/results/primary_diagnostics_charged.csv`.
It will contain 15,000 rows with post-charge net P&L and the same detailed
trade-ledger metrics as the shortlist run.

Shortlist readout (mean across the 100 bases, holdout 2025-10-09 to
2026-10-09):

- **25% / ₹4,000 / RE COST×2 / no trail:** ₹83,541 total, ₹348/day, 62.8%
  positive days, max drawdown -₹17,242, Ulcer ₹5,384, 95% daily CVaR -₹3,738,
  trade expectancy ₹130, MTM-stop frequency 5.2%.
- **30% / ₹4,000 / trail [10%,5%] / RE COST×1:** ₹82,490 total, ₹344/day,
  62.9% positive days, max drawdown -₹16,976, Ulcer ₹5,185, CVaR -₹3,603,
  expectancy ₹137, MTM-stop frequency 4.3%. This is the best balanced tail-risk
  candidate despite slightly lower return.
- **25% / ₹4,000 / baseline RE COST×1 / no trail:** ₹81,783 total, ₹341/day,
  63.4% positive days, max drawdown -₹18,650, Ulcer ₹5,967, CVaR -₹3,769,
  expectancy ₹136. This has the highest win rate among the top return cells but
  weaker drawdown and Ulcer metrics.

CE contributed more than PE in all three candidates; for example, the first
candidate contributed approximately ₹58,616 CE versus ₹24,925 PE. These
rankings are before brokerage/statutory charges and slippage.

## Risks

- The grid contains many trials; fit/holdout separation is required.
- Wider stops can reduce stop frequency while increasing tail losses.
- Re-entry increases turnover and must be checked after charges and slippage.
- Engine/AlgoTest parity work is still incomplete for some re-entry details.

## Log

- 2026-10-11 — pre-registered from the owner's request; primary sweep completed.
- 2026-10-12 — evaluation contract expanded to include tail-risk, expectancy,
  leg-wise and stability metrics; exact diagnostics completed for the 1,200-row
  decision shortlist. The full 4,400-row secondary grid retains core metrics;
  its expensive trade-ledger diagnostics are not run yet.
- 2026-10-11 — secondary screen completed: 4,400 rows across four primary
  settings and 11 secondary variants. The shortlist was revised after viewing
  primary holdout results to include the strongest 25–30% / ₹4,000 cells;
  therefore this secondary comparison is exploratory, not an independent
  confirmatory holdout. No live or saved strategy file was changed.
- 2026-10-12 — registered and launched the full-primary diagnostic extension:
  all 15,000 primary cells, baseline RE COST×1/no cutoff/no trail, detailed
  trade-ledger metrics and ₹20/order plus statutory-charge modeling. The run is
  in progress; no live or saved strategy file is changed.
- 2026-10-12 — charged shortlist run completed
  (`research/bl096/results/shortlist_charged.csv`, 1,200 rows, 488 sessions,
  holdout 2025-10-09 → 2026-10-09, ₹20/order + statutory charges, before
  slippage). Mean over the 100 bases, net ₹/day (pre-charge in brackets):
  21%/₹3,000 baseline 151 (313); 25%/₹3,500 175 (331); 25%/₹4,000 184 (341);
  30%/₹4,000 170 (320); 30%/₹4,000 + trail [10,5] **187** (344, DD -₹22.4k,
  Ulcer ₹8.6k — best balanced). Charges are ₹36–42k/yr per strategy.
  Findings: (a) RE COST×2 is net-neutral (+₹7–12 gross, ~₹2k/yr more charges)
  with a small drawdown/Ulcer benefit; (b) trail helps only with the widest SL
  (30%) and is mixed elsewhere (hurts NIFTY morning 21%, helps SENSEX morning);
  (c) the baseline 21%/₹3,000 is the weakest cell, 25%/₹4,000 is +₹33/day with
  shallower DD; (d) 13:00–15:30 entries net ₹1–76/day, ~breakeven before
  slippage; (e) full 15k charged grid: exit 15:28 ₹136/day vs 15:10 ₹62, 15:20
  ₹45, 15:00 ₹32, 14:50 -₹23 (15:20 < 15:10 is odd; check late-bar fills);
  net rises monotonically with MTM up to ₹4,000, the grid edge. Caveat: the
  shortlist was chosen after viewing holdout, so these numbers are optimistic.
  Open: extend MTM past ₹4,000 (needs a committed pre-registration first).
- 2026-10-14 — Phase 3 (interactions, robustness) superseded by BL-104's full-factorial grid; the holdout used here was later spent by BL-099.
