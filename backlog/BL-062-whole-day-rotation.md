# BL-062 — Daily rotation over the whole day (start times 09:17 to 15:17), with closest-premium Widesl

| | |
|---|---|
| **Priority** | P2 — options research; extends BL-057 and BL-061 |
| **Status** | In progress (descriptive; same already-seen window, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-057 (the rule), BL-059 (late-session variants), BL-060 and BL-061 (closest-premium Widesl) |
| **TODO.md row** | — |

## Context

BL-057 and BL-061 rotated over start times 09:17–11:47 only. BL-059 showed the afternoon is
not worse than the morning for Widesl and Dir, and BL-060 showed the SENSEX closest-premium
Widesl at all 24 start times. The owner (2026-10-09 chat) asked to add variants until 15:30 and run
the dynamic rotation again over the whole day.

## Goal

The rotation's P&L, monthly return and drawdown with the whole-day candidate list, and how its lots
spread over the day, over the strike rules (OTM vs closest premium) and over weekday, days to
expiry and VIX band.

## Out of scope

Changes to the frozen BL-058 forward rule, other Widesl minimums, the 3-lot version, tuning any
weight, charges.

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** none; descriptive. The questions are whether the larger, whole-day list helps
  relative to BL-057 and BL-061, and where in the day the picks go.
- **Universe (248 variants):** start times every 15 minutes from 09:17 to **15:17** (25 times;
  15:32 would be after the close). For each of NIFTY and SENSEX: Widesl with the OTM strike (NIFTY
  OTM1, SENSEX OTM2), Dir ATM, and Buy; plus closest-premium Widesl (NIFTY ₹80 and ₹100, SENSEX
  ₹250 and ₹320). Per start time: 8 Widesl/Dir variants of OTM type + closest-premium ones = 2 OTM
  Widesl + 4 closest-premium Widesl + 2 Dir = 8 core variants, plus 2 Buy variants. **Buy is not run at
  15:17**: it exits at 15:14, before that start time. 25 × 8 core + 24 × 2 Buy = 248.
  Built exactly as in BL-054 / 056 / 059 / 060 / 061 (`research/common/varlib.py`); exits unchanged
  (Widesl and Dir 15:28, Buy 15:14), so a 15:17 start trades for 11 minutes and a 15:02 start for 26.
  1 lot, today's lot size, 1-minute bars, usable days, 2024-10-09 → 2026-10-08 run; rotation window
  2025-09-01 → 2026-10-08, selection from the 64th day, common days of both indices, before charges.
- **New backtests (34):** NIFTY ₹80 and ₹100 at the 13 start times 12:02–15:02 and at 15:17 (28);
  15:17 for NIFTY and SENSEX Widesl and Dir (4); SENSEX ₹250 and ₹320 at 15:17 (2). All other
  per-day results already exist (BL-054, 056, 059, 060, 061).
- **Rule:** BL-057's first block unchanged except the list: four criteria and weights 33 / 25 / 25 /
  17, same lookbacks, percentile ranks across the 248; core = top 5 of the 200 Widesl and Dir
  variants; "Widesl" for the at-least-2 minimum means any Widesl, OTM or closest premium; Buy add-on
  = up to 2 Buy variants in the overall top 10 of the 248.
- **Look-ahead check and comparators:** as BL-057 (R random picks from the larger list under the same
  constraint, E equal weight over the 200, B2 the live 3 Widesl + 2 Dir mix); BL-057's and BL-061's
  rotations are shown beside it.
- **Outputs:** (1) total, drawdown, worst day, monthly return in ₹ and % of ₹13 lakh, beside BL-057
  and BL-061; (2) share of core lots by strike rule, by family, by start-time window (09:17–09:47 |
  10:02–10:47 | 11:02–11:47 | 12:02–13:47 | 14:02–15:17), by weekday, own-index days to expiry and VIX
  band; (3) average P&L per lot by start-time window and strike rule.
- **Pass / kill rule:** BL-057's, read from this run, reported but not the point.
- **Hold-out:** none (owner override, same window).
- **Will not run:** other minimums, 3-lot version, other premiums, Buy at 15:17, any tuning.
- **Known limits:** late fills use 1-minute prices without spreads; Buy after 14:47 cannot trade; a
  bigger list dilutes percentile ranks and the "top 10" Buy trigger (reported as is).
- **Result:** (after the run)

### Phase 1 — The 34 new backtests (8 in parallel)
### Phase 2 — `rotate.py --whole-day` and the report

## Risks

- Many variants are close relatives (same entry minute ± 15, similar legs), so the rotation may mostly
  trade one position several ways.
- Same already-looked-at year; exploratory only.

## Log

- 2026-10-09 — created from the owner's request ("add variants till 3:30"): 15:17 is the last 15-minute
  start before 15:30.
