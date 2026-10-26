# Options: the evening prediction against the 09:16 pick

**Status:** Tested · **Last updated:** 2026-10-26

## What it is

Each evening the result message lists tomorrow's strategies: the 09:16 ranking re-run on the stored
results with the market's last VIX close standing in for the opening VIX (`rotation/tomorrow.py`).
The 09:16 job (`rotation/pick.py`) runs the same ranking with the real 09:15 VIX open. History
through the previous session and the weekday and days-to-expiry labels are the same, so the only
difference is which VIX band the day is put in. The evening uploads (16:40 AlgoTest, 16:45
Quantiply) act on the prediction; the 09:18 / 09:19 top-ups act on the real pick.

## Live value

List C (Adaptive) on Core-298, three core strategies a day. The expiring-index rule
([BL-122][bl122]) exists from 2026-10-19 only and is not applied in this study.

## Tested

| Item | Question | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-165 | Does the pick made on the real open earn more than the one made on the previous close? | Core-298, 431 days, 2025-01-10 → 2026-10-23, net, 1 lot a strategy | **The open does not help.** Mean difference +₹1 a day, 90% interval −₹45 to +₹50; halves −₹4 and +₹9 | [BL-165][bl165] |
| BL-165 | Same on Core-298 plus the T1 variants (in-sample) | 431 days, same window | **The open does not help.** −₹62 a day, interval −₹127 to −₹7, driven by 13 days | [BL-165][bl165] |

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

## Correction

The first run (2026-10-26) took the previous *stored* day as the "previous session". One day, 2026-09-25, follows a September data gap, so its prediction used a close 10 days old. The script now requires the true previous trading day and drops a day whose stored history stops short (1 day dropped). Both results are in the item's Log; the verdicts did not change.

## Open

Nothing blocking. A longer window would need the lake's VIX close before 2025-01, which the
rotation store does not cover.

[bl122]: ../../../backlog/BL-122-expiring-index-only-rule.md
[bl165]: ../../../backlog/BL-165-evening-prediction-vs-0916-pick.md
