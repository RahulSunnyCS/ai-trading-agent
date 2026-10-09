# BL-059 — Whole-day start-time curve: NIFTY and SENSEX Widesl, Dir ATM and Buy from 12:02 to 15:02

| | |
|---|---|
| **Priority** | P2 — options research; may widen the BL-057/058 universe later |
| **Status** | In progress (descriptive; same already-seen window, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-054 (NIFTY variants 09:17–11:47), BL-056 (SENSEX variants, breakdown script) |
| **TODO.md row** | — |

## Context

BL-054 and BL-056 tested 11 start times (09:17–11:47) for three families on NIFTY and SENSEX.
The owner (2026-10-09 chat) wants the start time extended every 15 minutes to 15:15, to see the
whole-day curve for each index and family before concluding what the window should be.

## Goal

For each index × family: average P&L, win rate and drawdown by start time across the whole
session, with the stability of each start time across the two halves of the year, so the
shape of the day can be read without chasing single best cells.

## Out of scope

Any change to the frozen BL-058 forward rule (66 variants, 09:17–11:47); a rotation over the
larger universe (that needs its own block after this curve is read); any skip or sizing rule.

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** none; descriptive.
- **Universe:** the 66 existing variants plus **78 new**: 13 start times 12:02, 12:17, 12:32,
  12:47, 13:02, 13:17, 13:32, 13:47, 14:02, 14:17, 14:32, 14:47, 15:02 (15:17 is past the owner's
  15:15 limit) × {Widesl, Dir ATM, Buy} × {NIFTY, SENSEX}, built exactly as in BL-054 / BL-056
  (NIFTY Widesl OTM1; SENSEX Widesl OTM2; Dir ATM; Buy with its range window = start + 10 minutes).
  Exits unchanged: Widesl and Dir 15:28, Buy 15:14. 1 lot, today's lot size, 1-minute bars, usable
  days, 2024-10-09 → 2026-10-08, before charges.
- **Known limits, kept as specified:** Buy from 14:47 has under 30 minutes; **Buy at 15:02 has a
  10-minute range window ending 15:12 and exits 15:14**, so it can barely trade and is expected
  to be degenerate. Widesl and Dir at 15:02 have 26 minutes. The cells are reported, flagged
  `late`.
- **Analysis window:** 2025-09-01 → 2026-10-08 (one expiry regime per index, as BL-056); the full
  two years are run so a later block needs no re-run. Weekend sessions dropped.
- **Outputs:** (1) per index × family × all 24 start times: days, total, average per day, win %,
  worst day, drawdown of the days chained (labelled as such); (2) first half vs second half of
  the window (split at the midpoint day) for each start time and the rank correlation between
  halves per index × family; (3) the BL-056 tables (weekday, days to expiry, VIX band) for the
  new start times, family means over the 13 new slots and over the 24; thin cells (< 30 days)
  flagged.
- **Pass / kill rule:** none. Reconciliation only: each variant's cell totals equal its total; the
  09:17–11:47 variants equal the BL-054 / BL-056 results.
- **Hold-out:** none (owner override, same window).
- **Will not run:** a rotation over 144 variants, any rule, slots after 15:02, other windows,
  Widesl OTM1/OTM2 alternatives, charges.
- **Result:** (after the run)

### Phase 1 — Generate and run the 78 variants (about an hour, 8 in parallel)
- Done when: 78 result files, one day set per index, matching the existing variants' day sets.

### Phase 2 — Analysis and report
- Done when: the tables above are in `research/bl059/out/` and the summary is in Result.

## Risks

- Late-session options decay fast and bars are thin; 1-minute fills near the close are the least
  trustworthy part of the engine's assumptions. Read late-slot P&L as indicative.
- 144 variants × several dimensions is a lot of cells; nothing is concluded from a single cell.

## Log

- 2026-10-09 — created from the owner's request; override: same already-seen window.
