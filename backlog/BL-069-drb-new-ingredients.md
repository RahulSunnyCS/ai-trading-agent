# BL-069 — New ingredients for DRB's ranking: family-pooled recent, overnight gap, longer fit lookbacks, spacing, streak shapes, sit-out gates

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-067 / BL-068 |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-065 (DRB-6W3L2), BL-067 (weight map), BL-068 (recent controls and placebo) |
| **TODO.md row** | — |

## Context

BL-067/068 showed DRB-6W3L2's edge is its **recent return** criterion (short-term momentum: the last 5–10
sessions, gone if the latest 5 are skipped, reversed when inverted, stable across both halves of the
year), while weekday / days-to-expiry / VIX-band fit did not beat a scrambled-label placebo (true baseline
₹4,30,868 against shuffles of mean ₹2,39,636, sd ₹1,07,880, one of 20 above it). The owner (2026-10-10
chat) asked what else might matter, pointing at streaks ("when I win I keep winning, when I lose I keep
losing"), a sharper recent window, and sitting out ("no trade is also a trade"). Four further
ingredients came from reading the whole conversation. All run on the same already-seen year.

## Goal

For each ingredient a keep / drop verdict under the rule below, on both the baseline weighting and on
recent-only (100/0/0/0), which is the honest base if the fit criteria are noise.

## Out of scope

The unseen years (BL-071), the no-stop universe (BL-070), charges beyond the one final pair, live changes.

## Plan

### Phase 0 — Pre-register
All runs are DRB-6W3L2 as BL-065 (248 variants, 3 strategies × 2 lots, at least 2 Widesl, Buy add-on,
window 2025-09-01 → 2026-10-08, 202 selection days). Base A = 33/25/25/17 (₹4,30,868 / −₹68,294);
base R = recent-only 100/0/0/0 (₹3,15,861 / −₹1,00,936). Gross; net ≈ gross − ₹81k (BL-067: ₹80.2–82.7k
on every row), with one charges pass for the final candidate. **Noise yardstick: one label-shuffle sd =
₹1,07,880** (BL-068; replaces the ₹1.05 lakh estimate).

| ID | Ingredient | Flag | Runs on A | Runs on R |
|---|---|---|---|---|
| B1 | Family-pooled recent: recent = (1−F) × own + F × mean of the same index + family over all start times | `--recent-family 0.5`, `1.0` | 2 | `0.5` |
| B2 | Overnight gap as a fifth fit criterion: \|09:15 open − previous collected close\| of the variant's index, bands g0 < 0.3% ≤ g1 < 0.7% ≤ g2 | `--weights 30,20,20,15,15` (added), `33,25,25,0,17` (replaces VIX) | 2 + 10 shuffles | — |
| B3 | Fit lookbacks without the 5-day window | `--fit-lookbacks 21:50,63:50`, `63:50,126:50` | 2 + 10 shuffles of the first | — |
| B4 | Spacing: no two core picks from the same index + family with start times within 90 minutes | `--min-gap 90` | 1 | 1 |
| B6 | Streak shapes of recent: tiers (50% last 5, 30% days 6–10, 20% days 11–21), ewm3 (half-life 3 sessions over the last 21), accel (last 5 minus the 5 before) | `--recent-shape tiers\|ewm3\|accel` | 3 | `tiers`, `ewm3` |
| B7 | Sit-out gates: (a) a core pick is traded only if its recent score > 0 (none qualify = whole day out, Buy included); (b) streak gate: half size (1 lot per strategy) when the ungated basket's last 5 days sum below 0; (c) both | `--require-positive-recent`, `--streak-gate 5` | 3 | `a`, `b` |
| B5 | Combined: every ingredient that passes its read-out, on its base | — | 1 (conditional) | 1 (conditional) |

- **Corrections made while implementing (before any run):** the spacing is **90** minutes, not 60, because
  the motivating pair (NIFTY OTM1 Widesl 11:17 and 12:32 on 2026-10-01) is 75 minutes apart; the gap
  band edges and the 5-day streak window are fixed here and not tuned.
- **Read-out, B1 / B4 / B6:** *keep* if gross beats its base by more than 1 yardstick (₹1,07,880) **and**
  max drawdown is no deeper; or if max drawdown improves by ≥ 20% with gross within 5% of the base.
  Otherwise *drop*.
- **Read-out, B7:** gross will fall (fewer lot-days). *Keep* if gross per lot-day rises **and** max
  drawdown improves by ≥ 20%. Report the number of affected days and what the ungated basket made on
  them: if it made money on the days the gate cut, the gate is wrong.
- **Read-out, B2 / B3 (fit-type):** *real* only if the true-label run is above **all 10** of its shuffled
  runs **and** passes the keep rule against base A. Otherwise *drop*.
- **Look-ahead:** the gap is the day's 09:15 open against the previous collected close (known before the
  09:17 entry); family means, shapes and gates read only earlier rows; the streak gate reads the ungated
  basket's own earlier P&L.
- **Hold-out:** none (owner override, as BL-053 → BL-068). **Will not run:** other gap bands, other
  family weights, other lookback pairs, other spacing, other gate windows, any ingredient not listed.
- **Side fix (BL-068):** the 126-day recent row was computed with a window that read nothing for the
  first 63 selection days (negative-index slice); it is re-run with the fix and BL-068 is amended.
- **Result:** pending.

## Risks

Eleven ingredient rows on one year: a "keep" is a candidate for the forward journal only. The B7 gates
change lots per day, so gross is not comparable with the ungated bases; per-lot-day is the comparator.

## Open questions

None.

## Log

- 2026-10-10 — created; ingredients and read-outs registered before any BL-069 run.
