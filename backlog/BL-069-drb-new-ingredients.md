# BL-069 — New ingredients for DRB's ranking: family-pooled recent, overnight gap, longer fit lookbacks, spacing, streak shapes, sit-out gates

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-067 / BL-068 |
| **Status** | Done — no ingredient beats the baseline; family-pooled recent (F = 0.5) makes recent-only nearly as good |
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
- **Result (2026-10-10, gross, 202 selection days; yardstick ₹1,07,880; bases A ₹4,30,868 / −₹68,294 and
  R ₹3,15,861 / −₹1,00,936 reproduce):** no ingredient passes on base A; one passes on base R.
  Reading of the registered clause "gross within 5%": gross not more than 5% *below* the base.

  | Ingredient | Row | Gross | Max DD | Win % | Verdict |
  |---|---|---|---|---|---|
  | B1 family-pooled recent | A, F = 0.5 | 4,06,246 | −73,960 | 61.4 | drop (−6%, deeper) |
  | | A, F = 1.0 | 2,17,408 | −1,01,145 | 60.9 | drop |
  | | **R, F = 0.5** | **4,05,396** | **−62,354** | 59.9 | **keep** (+₹89,535 vs R, below the yardstick; DD −38%; BL-057 verdict PASS) |
  | B2 overnight gap | A, added 30/20/20/15/15 | 4,23,865 | −73,886 | 62.9 | drop (below base, deeper) |
  | | A, replaces VIX 33/25/25/0/17 | 4,07,197 | −57,902 | 62.4 | drop (−5.5%, DD −15% < 20%) |
  | B3 fit lookbacks | A, 21:50 + 63:50 | 4,97,335 | −75,155 | 65.4 | drop (+₹66,467 < yardstick; DD deeper) |
  | | A, 63:50 + 126:50 | 4,86,867 | −61,058 | 63.9 | drop (+₹56,000 < yardstick; DD −11% < 20%) |
  | B4 spacing 90 min | A | 4,32,012 | −65,174 | 59.9 | drop (no effect: +₹1,144) |
  | | R | 3,13,899 | −1,04,842 | 57.4 | drop |
  | B6 streak shapes | A tiers / ewm3 / accel | 3,14,944 / 3,99,185 / 3,01,988 | −80,074 / −94,553 / −89,378 | 63.4 / 62.9 / 62.4 | drop all three |
  | | R tiers / ewm3 | 2,85,442 / 2,91,834 | −88,802 / −1,26,934 | 59.9 / 58.9 | drop |
  | B7 positive-recent only | A | 4,12,846 | −66,292 | 61.4 | drop (5 days affected; the dropped picks were net winners, −₹4,650 raw → −₹22,672 gated) |
  | B7 streak gate 5 | A | 3,28,834 | −64,663 | 62.4 | drop (per lot-day ₹310 < ₹329; DD −5%) |
  | B7 both | A | 3,13,414 | −65,238 | 61.4 | drop |
  | B7 positive-recent / gate | R | 3,12,773 / 2,66,849 | −1,04,024 / −81,460 | 58.4 / 58.4 | drop (gate: DD −19.3%, one point short; per lot-day ₹254 vs ₹240) |

  - **Label placebos for the fit-type ingredients.** B2 true-label ₹4,23,865 against 10 shuffles
    (₹1,21,260 → ₹3,79,129, mean ₹2,15,000): above all 10. B3 (21/63) true-label ₹4,97,335 against 10
    shuffles (₹73,629 → ₹3,25,172, mean ₹1,89,000): above all 10. Both are "real" under the placebo test
    but fail the keep rule against base A (gain below one yardstick).
  - **The sit-out gate is wrong, as registered it would be.** The streak gate cut size on 72 days on which
    the ungated basket made **+₹2,04,067 (₹2,834 a day, above its ₹2,133 average)**: in this year,
    after a losing 5-day stretch the basket did *better* than usual, not worse. The owner's intuition
    ("when I lose I keep losing") is not what the basket's own P&L showed here.
  - **The 126-day recent row (BL-068), fixed:** ₹2,37,930 / −₹80,792 (was ₹1,97,194; negative-slice bug
    in the first 63 selection days). The ladder is still monotone: 5 d ₹4,16,677 → 10 d ₹4,03,911 → 21 d
    ₹3,02,439 → 42 d ₹2,60,132 → 63 d ₹2,55,242 → 126 d ₹2,37,930.
  - **B5 combined:** only one row passed, so there is nothing to combine; it is the R + family 0.5 row.
  - **Caveat from BL-071 part A:** in Jan–Aug 2025 the recent criterion did not help (baseline −₹1,26,882
    vs no-recent), so a "keep" here is a candidate for that slice and the forward journal, nothing more.
    Scripts `research/bl069/run_all.py`; outputs `research/bl069/out/summary.csv`.

## Risks

Eleven ingredient rows on one year: a "keep" is a candidate for the forward journal only. The B7 gates
change lots per day, so gross is not comparable with the ungated bases; per-lot-day is the comparator.

## Open questions

None.

## Log

- 2026-10-10 — created; ingredients and read-outs registered before any BL-069 run.
- 2026-10-10 — 42 runs done; Result above. 126-day row of BL-068 corrected here.
