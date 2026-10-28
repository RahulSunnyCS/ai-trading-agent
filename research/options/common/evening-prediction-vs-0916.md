# Options: the evening prediction against the 09:16 pick

**Status:** Tested · **Last updated:** 2026-10-26

## What it is

Each evening the result message lists tomorrow's strategies: the 09:16 ranking re-run on the stored
results with the market's last VIX close standing in for the opening VIX (`rotation/tomorrow.py`).
The 09:16 job (`rotation/pick.py`) runs the same ranking with the real 09:15 VIX open. History
through the previous session and the weekday and days-to-expiry labels are the same in this study, so
the only difference is which VIX band the day is put in. Live, days to expiry also come from different
sources (the reference calendar in the evening, the listed contracts at 09:16), which differed on 1 of
476 days here. The evening uploads (16:40 AlgoTest, 16:45
Quantiply) act on the prediction; the 09:18 / 09:19 top-ups act on the real pick.

## Live value

List C (Adaptive) on Core-298, three core strategies a day. The expiring-index rule
([BL-122][bl122]) exists from 2026-10-19 only and is not applied in this study.

## Tested

| Item | Question | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-180 | Does the pick made on the real open earn more than the one made on the previous close? | Core-298, 431 days, 2025-01-10 → 2026-10-23, net, 1 lot a strategy | **The open does not help.** Mean difference +₹1 a day, 90% interval −₹45 to +₹50; halves −₹4 and +₹9 | [BL-180][bl180] |
| BL-180 | Same on Core-298 plus the T1 variants (in-sample) | 431 days, same window | **The open does not help.** −₹62 a day, interval −₹127 to −₹7, driven by 13 days | [BL-180][bl180] |

## What we know

- **The prediction is right on 97% of days.** The VIX band differs between the previous close and
  the open on 3.2% of days (14 of 431); the three picks differ on 12 days (Core) or 13 (T1). Eleven
  of the 12 Core changes are VIX gaps under 0.3 points (the VIX sat next to a band edge), so which
  side it lands on is close to a coin flip. Only 3 days had a gap of 0.5 points or more.
- **The 09:16 pick earned the same as the prediction.** Core: ₹878.5 a day predicted, ₹879.8 actual
  (win days 57.5% and 57.3%). Over the 12 days they differed, the prediction made −₹830 a day and
  the open −₹782. The whole 21 months differ by about +₹580 in total. Pre-registered reading: the
  prediction is good enough (interval inside ±₹150 a day); the open helps is rejected (the interval
  includes zero and the two halves have opposite signs).
- **T1 reads slightly worse on the open, on a small base.** ₹1,578.6 predicted against ₹1,516.2
  actual, a difference whose interval (−₹127 to −₹7) is wholly below zero. All of it comes from 13
  days (the picks differ by ₹23 to ₹7,926 on those days, both ways), a 5-day block bootstrap on so
  few non-zero days is fragile, and the T1 universe is in-sample. It does not show the open hurts;
  it shows no gain.
- **The forward record agrees.** On the 9 recorded days (2026-10-12 → 23) prediction and actual picks
  are the same set every day. The study's reconstructed pick equals the journal entry on 7 of 9; the
  two differences are 19 and 22 October, expiring-index days, where the study does not apply BL-122.
- **Bias, stated in the item:** list C's weights were tuned with the real open, so the open arm is the
  one they were fitted to. That leans towards the open and it still did not win.
- **Not tested, a lead only:** keeping the evening picks when the open lands within a small distance of
  a band edge. It would affect about 3% of days; it was registered as *will not run*.

## Two-year view (addendum, owner request)

Same test from 2024-11-08 (the 22nd stored session) instead of 2025-01-10. The 63-session rule is
relaxed to 21 for the first 42 days, labelled *short history*: a live list could not pick them
under its registered rule, so they are noisier and not forward evidence.

| Universe | Days | Picks differ | Predicted / actual, ₹ a day | Mean difference, 90% interval | Registered reading |
|---|---|---|---|---|---|
| Core-298 (Adaptive Classic) | 473 | 14 (97.0% same) | 785.3 / 766.9 | −18.4 [−73.4, +32.8] | open helps: rejected; prediction good enough: yes |
| + T1 variants (Adaptive Tuned, in-sample) | 473 | 15 (96.8% same) | 1,490.6 / 1,410.2 | −80.4 [−160.1, −10.0] | open helps: rejected; good enough: not shown (lower end passes −₹150) |

Mean difference per half-year (days, changed days), the open minus the prediction:

| Half-year | Core-298 | + T1 |
|---|---|---|
| 2024 H2 (35 days, short history) | −₹265 (2) | −₹320 (2) |
| 2025 H1 (122) | +₹70 (4) | −₹76 (4) |
| 2025 H2 (125) | −₹77 (4) | +₹3 (4) |
| 2026 H1 (119) | +₹25 (2) | −₹119 (3) |
| 2026 H2 so far (72) | −₹18 (2) | −₹51 (2) |

- **The open does not win overall.** In both universes the pooled difference is zero or negative;
  Core is slightly positive in two half-years (+₹70, +₹25) and no half-year is clearly positive for
  both. The short-history stretch drives most of the Core move
  (−₹221 a day over 42 days with 2 changed days; the registered stretch alone is +₹1.3).
- **T1 leans negative.** The open does worse than the evening picks in four of five half-years. 15
  changed days carry it, so it is a lean, not a finding.
- **Before 2024-11-08 there is nothing to test:** the rotation store begins on 2024-10-09 and a
  ranking needs history.

## Correction

The first run (2026-10-26) took the previous *stored* day as the "previous session". One day, 2026-09-25, follows a September data gap, so its prediction used a close 10 days old. The script now requires the true previous trading day and drops a day whose stored history stops short (1 day dropped). Both results are in the item's Log; the verdicts did not change.

## Open

Nothing blocking. The rotation store begins on 2024-10-09, so two years is the longest window.

[bl122]: ../../../backlog/BL-122-expiring-index-only-rule.md
[bl180]: ../../../backlog/BL-180-evening-prediction-vs-0916-pick.md
