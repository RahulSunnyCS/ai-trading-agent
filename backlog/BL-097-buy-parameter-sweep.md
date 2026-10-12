# BL-097 — Buy parameter sweep

| | |
|---|---|
| **Priority** | P2 — quantify whether the existing long-option Buy family has a robust improvement over its current breakout settings |
| **Status** | In progress — Phase 2 one-factor screen complete; Phase 3 pending |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-11 |
| **Depends on** | BL-009 engine verification; existing Buy rotation YAMLs |
| **TODO.md row** | — (add when the experiment is started) |

## Context

The existing Buy rotation family is a symmetric CE+PE long-option range-breakout
strategy. Its current files use closest premium ₹50, a 25% per-leg stop, a
`[1, 1]` point trail, an instrument-high breakout, a ten-minute breakout window,
a ₹2,000 overall stop, partial square-off, no re-entry, and a 15:14 exit.

The Directional sweep showed that entry time, strike style, per-leg risk and
exit time can interact. Buy strategies have additional levers—premium selection,
breakout window and trailing behaviour—so they need their own pre-registered
study rather than borrowing the Directional result.

## Goal

Identify Buy settings that improve holdout return while controlling maximum
drawdown and preserving a useful win rate across the existing NIFTY and SENSEX
Buy rotation files. Produce a reproducible comparison; do not change live or
saved strategy files automatically.

## Out of scope

- Asymmetric CE/PE parameters in the first study.
- New strategy families, moneyness rules beyond ATM/OTM1/OTM2, futures or spot
  filters.
- Unrestricted Cartesian multiplication of every parameter.
- Selecting a winner from the full two-year period without a chronological
  holdout.
- Production adoption from the research run alone.

## Plan

### Phase 0 — Pre-register

- **Hypothesis:** Buy performance is most sensitive to strike/premium selection,
  per-leg stop, trailing rule, breakout-window length and exit time; a robust
  holdout improvement should exist without relying on CE/PE asymmetry.
- **Universe:** all existing `N_buy_*.yaml` and `S_buy_*.yaml` rotation files
  (NIFTY and SENSEX, 25 entry times per underlying). Use the point-in-time
  collected option chain and index data already used by the leg-wise engine.
- **Date range:** 2024-10-09 through 2026-10-09, using the common
  data-quality-approved sessions. Fit period: 2024-10-09 through 2025-10-08.
  Holdout period: 2025-10-09 through 2026-10-09.
- **Look-ahead check:** closest-premium strikes are selected only from prices
  available at the strategy entry time; the breakout range ends before the
  breakout decision; no future-day or future-period result is used in a
  candidate's parameters. Any missing or excluded session is logged rather
  than zero-filled.
- **Baseline:** closest premium ₹50; per-leg SL 25%; trail `[1,1]` points;
  instrument high; breakout window entry + 10 minutes; overall MTM SL ₹2,000;
  partial square-off; no re-entry; exit 15:14.
- **Pass rule:** a candidate must beat the same-base baseline on holdout net
  return, have holdout maximum drawdown no worse by more than 5%, lose no more
  than 2 percentage points of holdout win rate, and improve or match net return
  on at least 60% of the Buy files. Report the result separately by NIFTY vs
  SENSEX, early/midday/afternoon entry band and any available strategy subtype.
- **Kill rule:** no adoption if the apparent gain is fit-only, depends on one
  underlying or one time band, worsens holdout drawdown materially, or fails the
  per-file stability rule.
- **Will not run:** CE-only/PE-only parameter differences, asymmetric breakout
  windows, target-based variants not present in the current Buy family, or a
  full interaction grid before one-factor screening. Running one of these needs
  a dated override in this item's Log.

### Phase 1 — Baseline and engine parity

- Run every current Buy file on the registered date range with its saved
  settings.
- Confirm the saved strategy fields and generated breakout window match the
  engine's interpretation.
- Store a baseline summary with daily net, win rate, maximum drawdown, entry-hit
  rate and the number of days with neither leg entering.

**Done when:** baseline output is reproducible and no strategy file is modified.

### Phase 2 — One-factor screen

Apply one change at a time around the baseline, keeping both legs identical.

| Parameter | Registered values |
|---|---|
| Strike selection | ATM, OTM1 (OTM), OTM2 |
| Closest premium | ₹30, ₹40, ₹50, ₹60, ₹75, ₹100 |
| Per-leg SL | 15%, 20%, 25%, 30%, 35%, 40% |
| Overall MTM SL | ₹1,000, ₹1,500, ₹2,000, ₹2,500, ₹3,000, ₹4,000 |
| Trail | none, `[0.5,0.5]`, `[1,1]`, `[2,1]`, `[3,1]` points |
| Range-formation window | entry + 5, +10, +15, +20, +30 minutes |
| Breakout gap/buffer | 0%, 0.5%, 1%, 2% above the range high |
| Breakout validity | range end +15, +30, +60, +120 minutes; no entry after the deadline |
| Exit time | 14:50, 15:00, 15:10, 15:14, 15:20, 15:28 |
| Breakout source | instrument high, underlying high |
| Re-entry after SL | none, RE COST ×1, RE ASAP ×1, RE COST ×2 |
| Square-off | partial, complete |

The baseline row is deduplicated rather than run repeatedly. A trailing-percent
follow-up (`[5,2.5]`, `[10,5]`, `[15,5]`) is reserved for Phase 3 if point
trailing shows a stable signal. The current schema supports the range window
and source, but not a gap or validity deadline; those two fields require a
small schema/engine extension before their registered rows can run. Their
baseline is zero gap and validity through the configured exit.

**Run size and priority:** this is 44 one-factor configurations including the
baseline (43 new variations), across 50 Buy files and 488 common sessions:
2,200 file/config result rows and about 1.07 million day-level simulations.
The full Cartesian product would be 12,441,600 configurations and is not
registered. The highest-priority levers are strike/premium selection, leg SL,
MTM SL, range-formation time, breakout gap/validity and exit time. Trail,
re-entry, source and square-off are second-stage levers unless the first group
shows no usable candidate.

**Done when:** all registered one-factor rows have fit and holdout summaries,
invalid configurations are explicit, and no full-period ranking is used to
choose the Phase 3 candidates.

### Phase 3 — Interactions and robustness

- Select at most five candidates using fit-period net return, drawdown and win
  rate only.
- Add and validate `gap` and `valid_until` semantics before running those rows:
  a high breakout must cross `range_high × (1 + gap%)`, and a breakout after
  `valid_until` must be recorded as no entry. A gapped opening bar must use the
  same adverse-fill convention as the existing breakout rule.
- Test the selected candidates with the reserved trailing-percent values and
  the most plausible two-way interactions: SL × MTM, premium × breakout window,
  range-window × gap, and trail × exit time.
- Repeat the comparison by NIFTY/SENSEX and by early (<11:00), midday
  (11:00–12:59) and afternoon (13:00 onward) entry bands.
- Evaluate the top candidates on the untouched holdout once, then freeze the
  result table.

Cap Phase 3 at 35 additional configurations: at most 15 reserved
trailing-percent checks (three per candidate) plus at most 20 targeted
two-factor checks. This keeps the total registered screen at no more than 79
configurations, rather than silently expanding into a new Cartesian search.

**Done when:** a candidate either passes the Phase 0 rule or is killed with a
  written reason; no strategy YAML is replaced as part of the experiment.

### Evaluation contract — Buy-specific metrics

Every variation must report the common scorecard plus Buy-specific diagnostics:

- **Core:** holdout net return after costs, average and median daily P&L,
  maximum drawdown, Ulcer Index, worst day, 95% CVaR, expectancy per day,
  expectancy per entered trade, profit factor, payoff ratio, win rate,
  losing streak and recovery time.
- **Entry quality:** entry-hit rate, no-entry-day rate, CE-only/PE-only/both-leg
  entry counts, time to breakout, breakout follow-through rate and false-
  breakout rate.
- **Exit quality:** SL exits, trail exits, time exits, average hold time,
  maximum favourable/adverse excursion, and each leg's contribution.
- **Stability:** fit-to-holdout degradation, NIFTY/SENSEX split, entry-time
  bands and strike/premium family split. No-entry days remain in daily metrics;
  trade expectancy is separately conditioned on days that entered.

Return, drawdown, Ulcer Index and CVaR are the primary gates. Win rate is
secondary to payoff and entry-hit rate for Buy because a high win rate with few
breakout entries is not sufficient evidence.

### Phase 4 — Read-out

- Publish the full CSV plus a short Markdown read-out with baseline deltas.
- Include return, drawdown, win rate, profit factor, entry-hit rate,
  no-entry-day rate and worst-day loss.
- If a candidate passes, propose a separate owner decision before any saved or
  live configuration changes.

## Risks

- Long-option results are sensitive to the no-entry rate; a high win rate can
  hide a strategy that rarely trades.
- A premium target may be feasible for one underlying but poorly collected for
  another; coverage and invalid days must be reported.
- A gap or validity deadline can reduce the number of entries sharply; entry-hit
  rate and no-entry-day rate are therefore first-class outcomes, not filters.
- Trail and breakout-window combinations can create many correlated trials;
  the staged screen and chronological holdout limit data snooping but do not
  eliminate it.
- The existing engine/AlgoTest parity work is still in progress for some
  re-entry and breakout details; any unresolved parity issue is a limitation,
  not a tuning opportunity.

## Open questions

- Whether the owner wants the ₹100 premium row retained if chain coverage is
  insufficient on either underlying.
- Whether the breakout gap should later also be tested in absolute points
  (`0.5`, `1`, `2`) after the percentage-gap screen, since points are easier to
  interpret for a fixed premium but less comparable across strikes.
- Whether the final comparison should include execution charges and slippage,
  or remain at the current zero-cost research convention.

## Results — 2026-10-12

Phase 2 completed with the registered post-charge model (₹20 per order, STT,
exchange charges, SEBI/IPFT, stamp duty and GST; no slippage). The run produced
2,304 rows across 48 Buy variants and 488 common sessions: 2,258 valid rows and
46 invalid rows. The implementation includes the gap and validity-window arms,
so it contains 48 one-factor variants rather than the 44 estimated in the
initial plan text.

- Raw results: `packages/option-backtesting/research/bl097/results/buy_sweep_postcharge.csv`
- Checkpoints: `packages/option-backtesting/research/bl097/checkpoints/buy/`
- Qualified report: `backlog/BL-097-buy-qualified-list-post-charge.md`

The best-ranked rows are still negative after charges in all six broad
underlying/time-band sections. This is a screening result, not a final engine
or adoption decision; the targeted interaction phase is not yet run.

## Log

- 2026-10-11 — plan created from the existing Buy YAML baseline and the
  requested variation study.
- 2026-10-12 — Phase 2 one-factor sweep completed with post-charge accounting;
  report generated. Phase 3 remains pending.
