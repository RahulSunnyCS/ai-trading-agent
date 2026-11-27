# BL-247 — MCX commodity Dir and Widesl: does a 15:30 entry beat 17:05?

| | |
|---|---|
| **Priority** | P2 — the owner asked for it; a follow-up to BL-218, not on the month's Momentum path |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-27 |
| **Depends on** | BL-218 (the sweep, its engine grid and MCX charges), BL-148 (the data) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-218 swept MCX mini options with Dir and Widesl entering at 17:05, 18:00, 19:00 and 20:00. The
owner (2026-11-27): commodity trading is available from 15:30, when NSE closes, so the research
should cover a 15:30 entry as well. BL-218's grid is fixed by its SHA, so this is a new item.

## Goal

For each root × family × week, a registered answer to "is entering at 15:30 better than entering
at 17:05, everything else the same?", with a findings entry either way.

## Out of scope

Live trading and any paper journal; the Buy families; standard contracts; any change to BL-218's
verdicts or to the BL-219 / BL-242 forward tests.

## Plan

### Phase 0 — Pre-register (committed before any run)

**What has been seen before this registration.** BL-218's results for the 17:05–20:00 entries, both
halves. No return of any 15:30 entry has been computed. On 2026-11-27 trading activity alone (no
strategy, no P&L) was compared at 15:30, 16:00, 17:05 and 18:00 on the fit year's expiry weeks:
crude and natural gas were about as liquid at 15:30 as at 17:05; gold and silver depend heavily on
which strike is picked.

- **Hypothesis:** a 15:30 entry is no better than a 17:05 entry for Dir or Widesl on any of the
  four minis. The default if nothing passes is BL-218's grid as it stands (no 15:30 entry).
- **Universe:** as BL-218, unchanged: CRUDEOILM, NATGASMINI, GOLDM, SILVERM; expiry week (sessions
  E-4..E0) and week before (E-9..E-5); fit = expiries 2024-11-01 → 2025-10-31, test = expiries
  2025-11-01 → 2026-10-31; the expiring contract, strikes off the settling future from the contract
  calendar, 1 lot at today's lot size; sessions `data_quality` excludes count as due and not run.
- **Execution:** as BL-218: the legwise engine on the MCX grid, 1% slippage on every fill, MCX
  charges from `research/common/mcx_charges.py`, "close" = 23:15 (23:40 on a 23:55-close day).
- **Cells:** each 15:30 cell is paired with the cell identical but for a 17:05 entry; both are run
  by the same code on the same data.

  | Family | Axes (all but entry) | Pairs |
  |---|---|---|
  | Dir (sell CE + PE) | strike ITM1/ATM × leg SL 15/21/30% × re-entry none/cost×1 × exit 22:00/close | 24 |
  | Widesl (sell CE + PE) | strike OTM1/OTM2 × leg SL 80/115/150% × trail none/15-10% × exit 22:00/close | 24 |

  4 roots × 2 families × 2 weeks = **16 cohorts**.
- **Measure:** one number a cohort-session, so no cell is picked: D = the mean over the cohort's 24
  pairs of (net at 15:30 − net at 17:05), in rupees a lot. A cell that does not enter counts as 0.
- **Prices-live gate (computed first, before any P&L is read):** at each entry time, the share of
  sold legs whose own contract had not traded in the 15 minutes before the entry minute. A cohort
  where that share is over 20% at either time is **not judged: prices not live**, and no verdict is
  claimed for it.
- **Pass (fit half):** mean D > 0, **and** the 5th percentile of mean D over 2,000 resamples of whole
  expiries (seed 20261127) > 0, **and** the cohort's mean net at 15:30 > 0.
- **Consistency (test half, passing cohorts only):** mean D > 0 and mean 15:30 net > 0. BL-218 has
  already read this year at later entry times, so it is a second look, **not** an unseen test.
- **Verdict:** a cohort passing both is "15:30 worth a forward paper test", never a live setting;
  every other judged cohort is "no better than 17:05". With 16 cohorts at a one-sided 5% about one
  pass is expected by chance, so a single pass is weak evidence and the verdict says so.
- **Reported, not decided on:** the per-cell table; entry rates and coverage at both times; net at
  0% and 0.5% slippage; the largest share of net from one expiry.
- **Look-ahead check:** strikes and entries read only bars that end by the decision minute (the
  engine's price-at-T rule, as BL-218); the settling future comes from the contract calendar; the
  exit uses the published close; the gate reads only bars before the entry minute.
- **Survivorship:** as BL-218: every contract in the frozen BL-148 manifest; a strike with no price
  at entry is a no-trade, never dropped.
- **Hold-out:** nothing after expiry 2026-10-31 is read, so the sessions BL-219 and BL-242 are
  testing forward stay unseen. Confirmation, if any, is forward only.
- **Will not run:** other entry times (16:00, 16:30), the Buy families, other strikes or stops,
  picking a best 15:30 cell, a decision at 0% or 0.5% slippage, the next-month expiry — each needs
  `override: <reason>` in the Log.

### Phase 1 — Code

- **Tasks:** `packages/option-backtesting/research/bl247/` (grid, runner, gate, scorer); a test that
  pins the pair counts and the grid SHA.
- **Done when:** the tests pass, the SHA is in the Log, and one session is hand-checked at 15:30
  (fills against the raw chain and the future).

### Phase 2 — Gate and fit half

- **Tasks:** the prices-live gate for all 16 cohorts, written to a file; then the fit half.
- **Done when:** each cohort is marked not judged, failed or passed.

### Phase 3 — Test half and verdict

- **Tasks:** passing cohorts only; update `research/options/strategies/{directional,widesl}/`
  `mcx-commodities.md` and the entry-time pages in the same commit.
- **Done when:** every cohort has a line in the Log.

## Risks

- About 60 sessions a cohort a year: the test can say "not shown" far more often than "yes".
- The bid-ask spread at 15:30 on mini options is not measured; 1% slippage may understate it, more
  so before the US session opens.
- Gold's strike step is finer than where its volume sits. On 2025-08-22 the 98,900 call traded about
  15 lots in the day against about 51,000 for the 99,000 call. The gate above keeps this item from
  judging such a cohort; whether it affects BL-218's gold result or BL-219 has **not** been checked.

## Open questions

None open.

## Log

- 2026-11-27 — created and pre-registered from the owner's request ("start with our research in
  3:30 PM also"); the owner confirmed the scope ("Yes, register it"): Dir and Widesl, the four
  minis, compared against 17:05. Nothing run.
